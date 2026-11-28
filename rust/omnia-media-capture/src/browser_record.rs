//! Pure-Rust (`#![forbid(unsafe_code)]`, zero external image crates) browser session recorder:
//! - Median-cut 256-color GIF89a encoder with red/white click-marker overlays and frame-hash dedup
//! - Pure-Rust RFC 1950/1951 PNG->RGB8 decoder (stored, fixed Huffman, and dynamic Huffman)
//! - Secret-redacted Playwright TypeScript (`replay.spec.ts`) & `steps.json` code generator

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// Maximum frames retained in a single [`SessionRecorder`] recording.
pub const MAX_RECORDED_FRAMES: usize = 600;
/// Maximum total recording duration cap in milliseconds (`120 s`).
pub const MAX_RECORDING_DURATION_MS: u64 = 120_000;

/// One RGB8 frame for [`encode_gif`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GifFrame {
    pub width: u16,
    pub height: u16,
    /// Tightly packed RGB8 pixels (`width * height * 3` bytes).
    pub rgb: Vec<u8>,
    /// Delay in centiseconds (`10` = `100 ms`).
    pub delay_cs: u16,
    /// Optional click coordinates `(x, y)` to overlay a red/white target marker.
    pub click: Option<(u16, u16)>,
}

/// Paints a high-contrast red/white circular crosshair click marker onto an RGB8 image buffer.
pub fn draw_click_marker(rgb: &mut [u8], width: u16, height: u16, cx: u16, cy: u16) {
    let w = width as i32;
    let h = height as i32;
    let x0 = cx as i32;
    let y0 = cy as i32;
    let radius = 10i32;

    for dy in -radius..=radius {
        let y = y0 + dy;
        if y < 0 || y >= h {
            continue;
        }
        for dx in -radius..=radius {
            let x = x0 + dx;
            if x < 0 || x >= w {
                continue;
            }
            let d2 = dx * dx + dy * dy;
            let color = if d2 <= 9 {
                Some([239u8, 68, 68]) // inner red dot
            } else if (49..=81).contains(&d2) {
                Some([255u8, 255, 255]) // crisp white ring
            } else if (82..=100).contains(&d2) {
                Some([220u8, 38, 38]) // outer red ring
            } else {
                None
            };
            if let Some(c) = color {
                let idx = ((y * w + x) * 3) as usize;
                if idx + 2 < rgb.len() {
                    rgb[idx] = c[0];
                    rgb[idx + 1] = c[1];
                    rgb[idx + 2] = c[2];
                }
            }
        }
    }
}

/// Encodes one or more RGB8 [`GifFrame`]s into a valid looping GIF89a byte stream using
/// pure-Rust median-cut 256-color quantization and LZW compression (zero external deps).
pub fn encode_gif(frames: &[GifFrame]) -> Result<Vec<u8>, String> {
    if frames.is_empty() {
        return Err("cannot encode empty GIF frame list".to_string());
    }
    let width = frames[0].width;
    let height = frames[0].height;
    if width == 0 || height == 0 {
        return Err("GIF frame dimensions must be nonzero".to_string());
    }
    let expected_len = (width as usize) * (height as usize) * 3;
    for (idx, frame) in frames.iter().enumerate() {
        if frame.width != width || frame.height != height {
            return Err(format!(
                "GIF frame {idx} dimensions {}x{} do not match {}x{}",
                frame.width, frame.height, width, height
            ));
        }
        if frame.rgb.len() != expected_len {
            return Err(format!(
                "GIF frame {idx} RGB byte length {} != expected {expected_len}",
                frame.rgb.len()
            ));
        }
    }

    let mut out = Vec::with_capacity(4096);
    // Header: GIF89a
    out.extend_from_slice(b"GIF89a");
    // Logical Screen Descriptor (no global color table; each frame carries a local 256-color palette)
    out.extend_from_slice(&width.to_le_bytes());
    out.extend_from_slice(&height.to_le_bytes());
    out.push(0x70); // 8-bit color resolution, no GCT
    out.push(0x00); // background color index
    out.push(0x00); // pixel aspect ratio

    // NETSCAPE2.0 infinite loop application extension
    out.extend_from_slice(&[
        0x21, 0xFF, 0x0B, b'N', b'E', b'T', b'S', b'C', b'A', b'P', b'E', b'2', b'.', b'0', 0x03,
        0x01, 0x00, 0x00, 0x00,
    ]);

    for frame in frames {
        let mut pixels = frame.rgb.clone();
        if let Some((cx, cy)) = frame.click {
            draw_click_marker(&mut pixels, width, height, cx, cy);
        }
        let (palette, indices) = quantize_median_cut_256(&pixels);

        // Graphic Control Extension
        out.extend_from_slice(&[0x21, 0xF9, 0x04, 0x04]);
        let delay = frame.delay_cs.max(2);
        out.extend_from_slice(&delay.to_le_bytes());
        out.push(0x00); // transparent index (unused)
        out.push(0x00); // block terminator

        // Image Descriptor with Local Color Table (256 entries => size field 7)
        out.push(0x2C);
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&width.to_le_bytes());
        out.extend_from_slice(&height.to_le_bytes());
        out.push(0x87); // LCT flag | 2^(7+1)=256 colors

        // Local Color Table (256 * 3 bytes)
        for rgb in &palette {
            out.extend_from_slice(rgb);
        }

        // LZW Image Data (minimum code size = 8)
        out.push(8);
        let compressed = lzw_encode_gif(&indices, 8);
        for chunk in compressed.chunks(255) {
            out.push(chunk.len() as u8);
            out.extend_from_slice(chunk);
        }
        out.push(0x00); // sub-block terminator
    }

    // GIF Trailer
    out.push(0x3B);
    Ok(out)
}

/// Median-cut 256-color quantizer mapping RGB8 pixels into `(palette[256], indices)`.
fn quantize_median_cut_256(rgb: &[u8]) -> ([[u8; 3]; 256], Vec<u8>) {
    let px_count = rgb.len() / 3;
    // Build 5-5-5 RGB histogram (32,768 bins) for fast deterministic median-cut.
    let mut counts = vec![0u32; 32_768];
    for p in rgb.as_chunks::<3>().0 {
        let key = (((p[0] as usize) >> 3) << 10)
            | (((p[1] as usize) >> 3) << 5)
            | ((p[2] as usize) >> 3);
        counts[key] = counts[key].saturating_add(1);
    }

    let mut initial: Vec<(u16, u32)> = counts
        .iter()
        .enumerate()
        .filter_map(|(k, &c)| (c > 0).then_some((k as u16, c)))
        .collect();
    if initial.is_empty() {
        initial.push((0, 1));
    }

    let mut boxes: Vec<Vec<(u16, u32)>> = vec![initial];
    while boxes.len() < 256 {
        let best = boxes
            .iter()
            .enumerate()
            .filter(|(_, b)| b.len() > 1)
            .max_by_key(|(_, b)| box_range_score(b))
            .map(|(i, _)| i);
        let Some(idx) = best else {
            break;
        };
        let mut bx = boxes.swap_remove(idx);
        let axis = box_longest_axis(&bx);
        bx.sort_unstable_by_key(|(k, _)| channel5(*k, axis));
        let total: u64 = bx.iter().map(|(_, c)| *c as u64).sum();
        let half = total / 2;
        let mut acc = 0u64;
        let mut split = 1usize;
        for (i, (_, c)) in bx.iter().enumerate() {
            acc += *c as u64;
            if acc >= half && i + 1 < bx.len() {
                split = (i + 1).max(1);
                break;
            }
        }
        let right = bx.split_off(split);
        boxes.push(bx);
        boxes.push(right);
    }

    let mut palette = [[0u8; 3]; 256];
    let mut lut = vec![0u8; 32_768];
    for (pi, bx) in boxes.iter().enumerate().take(256) {
        let (mut sr, mut sg, mut sb, mut total) = (0u64, 0u64, 0u64, 0u64);
        for &(k, c) in bx {
            let w = c as u64;
            sr += (((k >> 10) & 31) as u64 * 255 / 31) * w;
            sg += (((k >> 5) & 31) as u64 * 255 / 31) * w;
            sb += ((k & 31) as u64 * 255 / 31) * w;
            total += w;
            lut[k as usize] = pi as u8;
        }
        let denom = total.max(1);
        palette[pi] = [
            (sr / denom) as u8,
            (sg / denom) as u8,
            (sb / denom) as u8,
        ];
    }

    let mut indices = Vec::with_capacity(px_count);
    for p in rgb.as_chunks::<3>().0 {
        let key = (((p[0] as usize) >> 3) << 10)
            | (((p[1] as usize) >> 3) << 5)
            | ((p[2] as usize) >> 3);
        indices.push(lut[key]);
    }
    (palette, indices)
}

#[inline]
fn channel5(key: u16, axis: u8) -> u8 {
    match axis {
        0 => ((key >> 10) & 31) as u8,
        1 => ((key >> 5) & 31) as u8,
        _ => (key & 31) as u8,
    }
}

fn box_bounds(bx: &[(u16, u32)]) -> ([u8; 3], [u8; 3]) {
    let mut lo = [31u8; 3];
    let mut hi = [0u8; 3];
    for &(k, _) in bx {
        for axis in 0..3u8 {
            let v = channel5(k, axis);
            lo[axis as usize] = lo[axis as usize].min(v);
            hi[axis as usize] = hi[axis as usize].max(v);
        }
    }
    (lo, hi)
}

fn box_longest_axis(bx: &[(u16, u32)]) -> u8 {
    let (lo, hi) = box_bounds(bx);
    let dr = hi[0] - lo[0];
    let dg = hi[1] - lo[1];
    let db = hi[2] - lo[2];
    if dg >= dr && dg >= db {
        1
    } else if dr >= db {
        0
    } else {
        2
    }
}

fn box_range_score(bx: &[(u16, u32)]) -> u64 {
    let (lo, hi) = box_bounds(bx);
    let span = ((hi[0] - lo[0]) as u64)
        .max((hi[1] - lo[1]) as u64)
        .max((hi[2] - lo[2]) as u64);
    let weight: u64 = bx.iter().map(|(_, c)| *c as u64).sum();
    span * 1_000_000 + weight.min(999_999)
}

/// Variable-width LSB-first GIF LZW compressor (code size `8`, max 12-bit codes with clear reset).
fn lzw_encode_gif(indices: &[u8], min_code_size: u8) -> Vec<u8> {
    let clear_code: u16 = 1 << min_code_size;
    let eoi_code: u16 = clear_code + 1;
    let mut code_size = min_code_size + 1;
    let mut next_code = eoi_code + 1;

    // Flat hash table: key = (prefix << 8) | suffix -> code
    let mut table: std::collections::HashMap<u32, u16> = std::collections::HashMap::with_capacity(4096);
    let mut out = Vec::with_capacity(indices.len() / 2 + 16);
    let mut bit_buf: u32 = 0;
    let mut bit_len: u8 = 0;

    let mut emit = |code: u16, width: u8| {
        bit_buf |= (code as u32) << bit_len;
        bit_len += width;
        while bit_len >= 8 {
            out.push((bit_buf & 0xFF) as u8);
            bit_buf >>= 8;
            bit_len -= 8;
        }
    };

    emit(clear_code, code_size);
    if indices.is_empty() {
        emit(eoi_code, code_size);
        if bit_len > 0 {
            out.push((bit_buf & 0xFF) as u8);
        }
        return out;
    }

    let mut prefix = indices[0] as u16;
    for &byte in &indices[1..] {
        let key = ((prefix as u32) << 8) | (byte as u32);
        if let Some(&existing) = table.get(&key) {
            prefix = existing;
        } else {
            emit(prefix, code_size);
            if next_code < 4096 {
                table.insert(key, next_code);
                next_code += 1;
                if next_code > (1u16 << code_size) && code_size < 12 {
                    code_size += 1;
                }
            } else {
                emit(clear_code, code_size);
                table.clear();
                code_size = min_code_size + 1;
                next_code = eoi_code + 1;
            }
            prefix = byte as u16;
        }
    }
    emit(prefix, code_size);
    emit(eoi_code, code_size);
    if bit_len > 0 {
        out.push((bit_buf & 0xFF) as u8);
    }
    out
}

/// Pure-Rust PNG decoder (`#![forbid(unsafe_code)]`, zero external crates) supporting 8-bit
/// non-interlaced RGB, RGBA, Grayscale, Grayscale+Alpha, and Indexed-color PNGs (stored, fixed
/// Huffman, and dynamic Huffman DEFLATE streams).
pub fn decode_png_rgb(png_bytes: &[u8]) -> Result<(u32, u32, Vec<u8>), String> {
    const SIG: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if png_bytes.len() < 33 || &png_bytes[..8] != SIG {
        return Err("invalid PNG signature".to_string());
    }
    let mut pos = 8usize;
    let mut width = 0u32;
    let mut height = 0u32;
    let mut color_type = 0u8;
    let mut palette: Vec<[u8; 3]> = Vec::new();
    let mut idat = Vec::new();
    let mut saw_ihdr = false;

    while pos + 12 <= png_bytes.len() {
        let len = u32::from_be_bytes([
            png_bytes[pos],
            png_bytes[pos + 1],
            png_bytes[pos + 2],
            png_bytes[pos + 3],
        ]) as usize;
        let kind = &png_bytes[pos + 4..pos + 8];
        let data_start = pos + 8;
        let data_end = data_start
            .checked_add(len)
            .ok_or_else(|| "PNG chunk length overflow".to_string())?;
        if data_end + 4 > png_bytes.len() {
            return Err("truncated PNG chunk".to_string());
        }
        let data = &png_bytes[data_start..data_end];
        match kind {
            b"IHDR" => {
                if data.len() != 13 {
                    return Err("invalid IHDR length".to_string());
                }
                width = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);
                height = u32::from_be_bytes([data[4], data[5], data[6], data[7]]);
                let bit_depth = data[8];
                color_type = data[9];
                let compression = data[10];
                let filter = data[11];
                let interlace = data[12];
                if compression != 0 || filter != 0 || interlace != 0 {
                    return Err("unsupported PNG compression/filter/interlace mode".to_string());
                }
                if bit_depth != 8 {
                    return Err(format!("unsupported PNG bit depth {bit_depth} (expected 8)"));
                }
                saw_ihdr = true;
            }
            b"PLTE" => {
                for c in data.as_chunks::<3>().0 {
                    palette.push([c[0], c[1], c[2]]);
                }
            }
            b"IDAT" => idat.extend_from_slice(data),
            b"IEND" => break,
            _ => {}
        }
        pos = data_end + 4;
    }

    if !saw_ihdr || width == 0 || height == 0 || width > 16_384 || height > 16_384 {
        return Err("missing or out-of-range PNG IHDR".to_string());
    }
    let bpp: usize = match color_type {
        0 => 1, // Grayscale
        2 => 3, // RGB
        3 => 1, // Indexed
        4 => 2, // Grayscale + Alpha
        6 => 4, // RGBA
        other => return Err(format!("unsupported PNG color type {other}")),
    };

    let raw = zlib_inflate(&idat)?;
    let row_bytes = (width as usize)
        .checked_mul(bpp)
        .ok_or_else(|| "PNG row overflow".to_string())?;
    let expected_raw = (row_bytes + 1)
        .checked_mul(height as usize)
        .ok_or_else(|| "PNG image size overflow".to_string())?;
    if raw.len() < expected_raw {
        return Err(format!(
            "inflated PNG data too short: {} < {expected_raw}",
            raw.len()
        ));
    }

    let mut prev_row = vec![0u8; row_bytes];
    let mut cur_row = vec![0u8; row_bytes];
    let mut rgb = Vec::with_capacity((width as usize) * (height as usize) * 3);

    for y in 0..(height as usize) {
        let base = y * (row_bytes + 1);
        let filter_type = raw[base];
        let scan = &raw[base + 1..base + 1 + row_bytes];
        for i in 0..row_bytes {
            let a = if i >= bpp { cur_row[i - bpp] } else { 0 };
            let b = prev_row[i];
            let c = if i >= bpp { prev_row[i - bpp] } else { 0 };
            cur_row[i] = match filter_type {
                0 => scan[i],
                1 => scan[i].wrapping_add(a),
                2 => scan[i].wrapping_add(b),
                3 => scan[i].wrapping_add(((a as u16 + b as u16) >> 1) as u8),
                4 => scan[i].wrapping_add(paeth_predictor(a, b, c)),
                other => return Err(format!("invalid PNG scanline filter {other}")),
            };
        }
        match color_type {
            0 => {
                for &g in &cur_row {
                    rgb.extend_from_slice(&[g, g, g]);
                }
            }
            2 => rgb.extend_from_slice(&cur_row),
            3 => {
                for &idx in &cur_row {
                    let c = palette.get(idx as usize).copied().unwrap_or([0, 0, 0]);
                    rgb.extend_from_slice(&c);
                }
            }
            4 => {
                for p in cur_row.as_chunks::<2>().0 {
                    rgb.extend_from_slice(&[p[0], p[0], p[0]]);
                }
            }
            6 => {
                for p in cur_row.as_chunks::<4>().0 {
                    rgb.extend_from_slice(&[p[0], p[1], p[2]]);
                }
            }
            _ => unreachable!(),
        }
        std::mem::swap(&mut prev_row, &mut cur_row);
    }

    Ok((width, height, rgb))
}

#[inline]
fn paeth_predictor(a: u8, b: u8, c: u8) -> u8 {
    let a = a as i32;
    let b = b as i32;
    let c = c as i32;
    let p = a + b - c;
    let pa = (p - a).abs();
    let pb = (p - b).abs();
    let pc = (p - c).abs();
    if pa <= pb && pa <= pc {
        a as u8
    } else if pb <= pc {
        b as u8
    } else {
        c as u8
    }
}

/// Pure-Rust RFC 1950 zlib + RFC 1951 DEFLATE inflate (stored, fixed Huffman, dynamic Huffman).
fn zlib_inflate(data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < 6 {
        return Err("zlib stream too short".to_string());
    }
    let cmf = data[0];
    let flg = data[1];
    if (cmf & 0x0F) != 8 {
        return Err(format!("unsupported zlib compression method {}", cmf & 0x0F));
    }
    if !(((cmf as u16) << 8) | (flg as u16)).is_multiple_of(31) {
        return Err("invalid zlib header checksum".to_string());
    }
    let mut start = 2usize;
    if (flg & 0x20) != 0 {
        start += 4; // FDICT
    }
    if start >= data.len() {
        return Err("truncated zlib header".to_string());
    }
    deflate_inflate(&data[start..data.len().saturating_sub(4)])
}

struct BitReader<'a> {
    data: &'a [u8],
    byte_pos: usize,
    bit_buf: u64,
    bit_count: u8,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self {
            data,
            byte_pos: 0,
            bit_buf: 0,
            bit_count: 0,
        }
    }

    fn fill(&mut self, need: u8) {
        while self.bit_count < need && self.byte_pos < self.data.len() {
            self.bit_buf |= (self.data[self.byte_pos] as u64) << self.bit_count;
            self.byte_pos += 1;
            self.bit_count += 8;
        }
    }

    fn read_bits(&mut self, n: u8) -> Result<u32, String> {
        if n == 0 {
            return Ok(0);
        }
        self.fill(n);
        if self.bit_count < n {
            return Err("unexpected EOF in deflate stream".to_string());
        }
        let val = (self.bit_buf & ((1u64 << n) - 1)) as u32;
        self.bit_buf >>= n;
        self.bit_count -= n;
        Ok(val)
    }

    fn align_byte(&mut self) {
        let drop = self.bit_count % 8;
        self.bit_buf >>= drop;
        self.bit_count -= drop;
    }

    fn read_u16_le_aligned(&mut self) -> Result<u16, String> {
        self.align_byte();
        let lo = self.read_bits(8)? as u16;
        let hi = self.read_bits(8)? as u16;
        Ok(lo | (hi << 8))
    }

    fn read_bytes_aligned(&mut self, len: usize, out: &mut Vec<u8>) -> Result<(), String> {
        self.align_byte();
        let mut remaining = len;
        while remaining > 0 && self.bit_count >= 8 {
            out.push((self.bit_buf & 0xFF) as u8);
            self.bit_buf >>= 8;
            self.bit_count -= 8;
            remaining -= 1;
        }
        if self.byte_pos + remaining > self.data.len() {
            return Err("unexpected EOF in stored deflate block".to_string());
        }
        out.extend_from_slice(&self.data[self.byte_pos..self.byte_pos + remaining]);
        self.byte_pos += remaining;
        Ok(())
    }
}

struct HuffTable {
    max_bits: u8,
    /// `(symbol, bit_len)` indexed by reversed bit code of width `max_bits`
    entries: Vec<(u16, u8)>,
}

impl HuffTable {
    fn from_lengths(lengths: &[u8]) -> Result<Self, String> {
        let max_bits = lengths.iter().copied().max().unwrap_or(0);
        if max_bits == 0 {
            return Ok(Self {
                max_bits: 1,
                entries: vec![(0, 0); 2],
            });
        }
        if max_bits > 15 {
            return Err("Huffman code length > 15".to_string());
        }
        let mut bl_count = [0u32; 16];
        for &l in lengths {
            if l > 0 {
                bl_count[l as usize] += 1;
            }
        }
        let mut next_code = [0u32; 16];
        let mut code = 0u32;
        for bits in 1..=(max_bits as usize) {
            code = (code + bl_count[bits - 1]) << 1;
            next_code[bits] = code;
        }

        let size = 1usize << max_bits;
        let mut entries = vec![(0u16, 0u8); size];
        for (sym, &len) in lengths.iter().enumerate() {
            if len == 0 {
                continue;
            }
            let c = next_code[len as usize];
            next_code[len as usize] += 1;
            let rev = reverse_bits(c, len) as usize;
            let step = 1usize << len;
            let mut idx = rev;
            while idx < size {
                entries[idx] = (sym as u16, len);
                idx += step;
            }
        }
        Ok(Self { max_bits, entries })
    }

    fn decode(&self, br: &mut BitReader<'_>) -> Result<u16, String> {
        br.fill(self.max_bits);
        let mask = (1u64 << self.max_bits) - 1;
        let idx = (br.bit_buf & mask) as usize;
        let (sym, len) = self.entries[idx];
        if len == 0 || br.bit_count < len {
            return Err("invalid Huffman code in deflate stream".to_string());
        }
        br.bit_buf >>= len;
        br.bit_count -= len;
        Ok(sym)
    }
}

#[inline]
fn reverse_bits(mut v: u32, bits: u8) -> u32 {
    let mut r = 0u32;
    for _ in 0..bits {
        r = (r << 1) | (v & 1);
        v >>= 1;
    }
    r
}

fn deflate_inflate(data: &[u8]) -> Result<Vec<u8>, String> {
    const LEN_BASE: [u16; 29] = [
        3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115,
        131, 163, 195, 227, 258,
    ];
    const LEN_EXTRA: [u8; 29] = [
        0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
    ];
    const DIST_BASE: [u16; 30] = [
        1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
        2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
    ];
    const DIST_EXTRA: [u8; 30] = [
        0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12,
        13, 13,
    ];
    const CL_ORDER: [usize; 19] = [
        16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
    ];
    const MAX_INFLATE_BYTES: usize = 128 * 1024 * 1024;

    let mut br = BitReader::new(data);
    let mut out = Vec::new();

    loop {
        let bfinal = br.read_bits(1)?;
        let btype = br.read_bits(2)?;
        match btype {
            0 => {
                let len = br.read_u16_le_aligned()? as usize;
                let nlen = br.read_u16_le_aligned()?;
                if (len as u16) != !nlen {
                    return Err("stored deflate block length mismatch".to_string());
                }
                if out.len().saturating_add(len) > MAX_INFLATE_BYTES {
                    return Err("PNG inflate output exceeds 128 MiB limit".to_string());
                }
                br.read_bytes_aligned(len, &mut out)?;
            }
            1 | 2 => {
                let (lit_table, dist_table) = if btype == 1 {
                    let mut lit = [0u8; 288];
                    lit[0..144].fill(8);
                    lit[144..256].fill(9);
                    lit[256..280].fill(7);
                    lit[280..288].fill(8);
                    let dist = [5u8; 32];
                    (HuffTable::from_lengths(&lit)?, HuffTable::from_lengths(&dist)?)
                } else {
                    let hlit = br.read_bits(5)? as usize + 257;
                    let hdist = br.read_bits(5)? as usize + 1;
                    let hclen = br.read_bits(4)? as usize + 4;
                    let mut cl_lens = [0u8; 19];
                    for i in 0..hclen {
                        cl_lens[CL_ORDER[i]] = br.read_bits(3)? as u8;
                    }
                    let cl_table = HuffTable::from_lengths(&cl_lens)?;
                    let total = hlit + hdist;
                    let mut lens = Vec::with_capacity(total);
                    while lens.len() < total {
                        let sym = cl_table.decode(&mut br)?;
                        match sym {
                            0..=15 => lens.push(sym as u8),
                            16 => {
                                let prev = *lens
                                    .last()
                                    .ok_or_else(|| "deflate repeat with no previous".to_string())?;
                                let rep = br.read_bits(2)? as usize + 3;
                                lens.resize((lens.len() + rep).min(total), prev);
                            }
                            17 => {
                                let rep = br.read_bits(3)? as usize + 3;
                                lens.resize((lens.len() + rep).min(total), 0);
                            }
                            18 => {
                                let rep = br.read_bits(7)? as usize + 11;
                                lens.resize((lens.len() + rep).min(total), 0);
                            }
                            _ => return Err("invalid code-length symbol".to_string()),
                        }
                    }
                    (
                        HuffTable::from_lengths(&lens[..hlit])?,
                        HuffTable::from_lengths(&lens[hlit..])?,
                    )
                };

                loop {
                    let sym = lit_table.decode(&mut br)?;
                    if sym < 256 {
                        if out.len() >= MAX_INFLATE_BYTES {
                            return Err("PNG inflate output exceeds 128 MiB limit".to_string());
                        }
                        out.push(sym as u8);
                    } else if sym == 256 {
                        break;
                    } else {
                        let li = (sym - 257) as usize;
                        if li >= LEN_BASE.len() {
                            return Err("invalid deflate length symbol".to_string());
                        }
                        let length =
                            LEN_BASE[li] as usize + br.read_bits(LEN_EXTRA[li])? as usize;
                        let di = dist_table.decode(&mut br)? as usize;
                        if di >= DIST_BASE.len() {
                            return Err("invalid deflate distance symbol".to_string());
                        }
                        let dist = DIST_BASE[di] as usize + br.read_bits(DIST_EXTRA[di])? as usize;
                        if dist == 0 || dist > out.len() {
                            return Err("deflate back-reference out of range".to_string());
                        }
                        if out.len().saturating_add(length) > MAX_INFLATE_BYTES {
                            return Err("PNG inflate output exceeds 128 MiB limit".to_string());
                        }
                        for _ in 0..length {
                            let b = out[out.len() - dist];
                            out.push(b);
                        }
                    }
                }
            }
            _ => return Err(format!("invalid deflate block type {btype}")),
        }
        if bfinal == 1 {
            break;
        }
    }
    Ok(out)
}

/// Pre-action DOM probe script capturing stable Playwright locators and password sensitivity.
pub const PROBE_ELEMENT_JS: &str = r#"(function(target){
  if (!target || target.nodeType !== 1) return null;
  const tag = (target.tagName || '').toLowerCase();
  const type = (target.getAttribute('type') || '').toLowerCase();
  const isPassword = (tag === 'input' && type === 'password') ||
    (target.getAttribute('autocomplete') || '').toLowerCase().includes('password');
  const role = target.getAttribute('role') || (
    tag === 'button' ? 'button' :
    tag === 'a' && target.hasAttribute('href') ? 'link' :
    tag === 'textarea' ? 'textbox' :
    tag === 'select' ? 'combobox' :
    tag === 'input' ? (type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : type === 'submit' ? 'button' : 'textbox') :
    ''
  );
  const labelEl = target.labels && target.labels[0];
  const label = (target.getAttribute('aria-label') || (labelEl ? labelEl.innerText : '') || '').trim();
  const name = (label || target.innerText || target.getAttribute('title') || target.value || '').trim().slice(0, 80);
  const placeholder = (target.getAttribute('placeholder') || '').trim();
  const testId = (target.getAttribute('data-testid') || target.getAttribute('data-test-id') || '').trim();
  const id = (target.id || '').trim();
  const parts = [];
  let cur = target;
  while (cur && cur.nodeType === 1 && parts.length < 5) {
    let seg = cur.tagName.toLowerCase();
    if (cur.id) { parts.unshift('#' + CSS.escape(cur.id)); break; }
    let idx = 1;
    let sib = cur.previousElementSibling;
    while (sib) { if (sib.tagName === cur.tagName) idx++; sib = sib.previousElementSibling; }
    parts.unshift(seg + ':nth-of-type(' + idx + ')');
    cur = cur.parentElement;
  }
  return { tag, role, name, label, placeholder, testId, id, cssPath: parts.join(' > '), isPassword };
})"#;

/// Element locator metadata captured before executing a recorded browser step.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ElementProbe {
    pub tag: String,
    pub role: Option<String>,
    pub name: Option<String>,
    pub label: Option<String>,
    pub placeholder: Option<String>,
    pub test_id: Option<String>,
    pub id: Option<String>,
    pub css_path: Option<String>,
    /// Chain of outer iframe CSS selectors when the target resides inside iframe(s).
    pub frame_selectors: Vec<String>,
    pub is_password: bool,
}

impl ElementProbe {
    /// Emits the highest-reliability Playwright locator expression (`getByRole` > `getByLabel` >
    /// `getByPlaceholder` > `getByTestId` > `#id` > CSS path), wrapping any outer `frameLocator`s.
    #[must_use]
    pub fn to_playwright_locator(&self) -> String {
        let mut root = String::from("page");
        for frame_sel in &self.frame_selectors {
            root.push_str(&format!(".frameLocator({})", js_str(frame_sel)));
        }
        if let (Some(role), Some(name)) = (
            non_empty(self.role.as_deref()),
            non_empty(self.name.as_deref()),
        ) {
            return format!(
                "{root}.getByRole({}, {{ name: {} }})",
                js_str(role),
                js_str(name)
            );
        }
        if let Some(label) = non_empty(self.label.as_deref()) {
            return format!("{root}.getByLabel({})", js_str(label));
        }
        if let Some(ph) = non_empty(self.placeholder.as_deref()) {
            return format!("{root}.getByPlaceholder({})", js_str(ph));
        }
        if let Some(tid) = non_empty(self.test_id.as_deref()) {
            return format!("{root}.getByTestId({})", js_str(tid));
        }
        if let Some(id) = non_empty(self.id.as_deref()) {
            return format!("{root}.locator({})", js_str(&format!("#{id}")));
        }
        let css = non_empty(self.css_path.as_deref()).unwrap_or("body");
        format!("{root}.locator({})", js_str(css))
    }

    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "tag": self.tag,
            "role": self.role,
            "name": self.name,
            "label": self.label,
            "placeholder": self.placeholder,
            "test_id": self.test_id,
            "id": self.id,
            "css_path": self.css_path,
            "frame_selectors": self.frame_selectors,
            "is_password": self.is_password,
        })
    }
}

/// Recorded user/agent browser action for Playwright `replay.spec.ts` and `steps.json`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecordedAction {
    Navigate { url: String },
    Click { probe: ElementProbe, double: bool },
    Type { probe: ElementProbe, text: String, sensitive: bool },
    Press { key: String },
    Select { probe: ElementProbe, values: Vec<String> },
    Hover { probe: ElementProbe },
    Scroll { dx: i32, dy: i32 },
    Wait { text: Option<String>, selector: Option<String>, ms: Option<u64> },
}

/// Timestamped recorded browser step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedStep {
    pub index: usize,
    pub elapsed_ms: u64,
    pub action: RecordedAction,
}

/// Stateful browser session recorder accumulating deduplicated frames and secret-safe steps.
#[derive(Debug, Clone, Default)]
pub struct SessionRecorder {
    frames: Vec<GifFrame>,
    steps: Vec<RecordedStep>,
    last_frame_hash: Option<[u8; 32]>,
    total_elapsed_ms: u64,
}

impl SessionRecorder {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Appends a raw RGB8 frame, deduplicating identical consecutive idle frames by extending
    /// the prior frame's delay instead of duplicating pixels.
    pub fn push_rgb_frame(
        &mut self,
        width: u16,
        height: u16,
        rgb: Vec<u8>,
        delay_cs: u16,
        click: Option<(u16, u16)>,
    ) -> Result<bool, String> {
        if self.frames.len() >= MAX_RECORDED_FRAMES
            || self.total_elapsed_ms >= MAX_RECORDING_DURATION_MS
        {
            return Ok(false);
        }
        let expected = (width as usize) * (height as usize) * 3;
        if rgb.len() != expected {
            return Err(format!("frame RGB len {} != {expected}", rgb.len()));
        }
        let hash: [u8; 32] = Sha256::digest(&rgb).into();
        let delay = delay_cs.max(2);
        self.total_elapsed_ms = self.total_elapsed_ms.saturating_add(delay as u64 * 10);

        if click.is_none() && self.last_frame_hash == Some(hash) {
            if let Some(last) = self.frames.last_mut() {
                last.delay_cs = last.delay_cs.saturating_add(delay).min(500);
                return Ok(false);
            }
        }
        self.last_frame_hash = if click.is_some() { None } else { Some(hash) };
        self.frames.push(GifFrame {
            width,
            height,
            rgb,
            delay_cs: delay,
            click,
        });
        Ok(true)
    }

    /// Decodes a PNG frame (such as CDP `Page.captureScreenshot`) and appends it to the recorder.
    pub fn push_png_frame(
        &mut self,
        png_bytes: &[u8],
        delay_cs: u16,
        click: Option<(u16, u16)>,
    ) -> Result<bool, String> {
        let (w, h, rgb) = decode_png_rgb(png_bytes)?;
        let width = u16::try_from(w).map_err(|_| "PNG width exceeds GIF u16 limit".to_string())?;
        let height =
            u16::try_from(h).map_err(|_| "PNG height exceeds GIF u16 limit".to_string())?;
        self.push_rgb_frame(width, height, rgb, delay_cs, click)
    }

    pub fn push_step(&mut self, elapsed_ms: u64, action: RecordedAction) {
        let index = self.steps.len() + 1;
        self.steps.push(RecordedStep {
            index,
            elapsed_ms,
            action,
        });
    }

    #[must_use]
    pub fn frame_count(&self) -> usize {
        self.frames.len()
    }

    #[must_use]
    pub fn steps(&self) -> &[RecordedStep] {
        &self.steps
    }

    pub fn encode_gif(&self) -> Result<Vec<u8>, String> {
        encode_gif(&self.frames)
    }

    #[must_use]
    pub fn generate_playwright_spec(&self, test_name: &str) -> String {
        generate_playwright_spec(test_name, &self.steps)
    }

    #[must_use]
    pub fn steps_json(&self) -> Value {
        serialize_steps_json(&self.steps)
    }
}

/// Generates a secret-redacted Playwright `replay.spec.ts` test script from recorded steps.
///
/// Any `Type` step where `sensitive == true` or `probe.is_password == true` is replaced with
/// `process.env.OMNIA_SECRET_{n} ?? ''` so credentials are NEVER written to disk.
#[must_use]
pub fn generate_playwright_spec(test_name: &str, steps: &[RecordedStep]) -> String {
    let mut secret_vars: Vec<String> = Vec::new();
    let mut body = Vec::new();

    for step in steps {
        match &step.action {
            RecordedAction::Navigate { url } => {
                body.push(format!(
                    "  await page.goto({});",
                    js_str(&crate::browser_network::redact_url(url))
                ));
            }
            RecordedAction::Click { probe, double } => {
                let loc = probe.to_playwright_locator();
                if *double {
                    body.push(format!("  await {loc}.dblclick();"));
                } else {
                    body.push(format!("  await {loc}.click();"));
                }
            }
            RecordedAction::Type {
                probe,
                text,
                sensitive,
            } => {
                let loc = probe.to_playwright_locator();
                if *sensitive || probe.is_password {
                    let env_name = format!("OMNIA_SECRET_{}", secret_vars.len() + 1);
                    secret_vars.push(env_name.clone());
                    body.push(format!(
                        "  await {loc}.fill(process.env.{env_name} ?? '');"
                    ));
                } else {
                    body.push(format!("  await {loc}.fill({});", js_str(text)));
                }
            }
            RecordedAction::Press { key } => {
                body.push(format!("  await page.keyboard.press({});", js_str(key)));
            }
            RecordedAction::Select { probe, values } => {
                let loc = probe.to_playwright_locator();
                let list = values
                    .iter()
                    .map(|v| js_str(v))
                    .collect::<Vec<_>>()
                    .join(", ");
                body.push(format!("  await {loc}.selectOption([{list}]);"));
            }
            RecordedAction::Hover { probe } => {
                let loc = probe.to_playwright_locator();
                body.push(format!("  await {loc}.hover();"));
            }
            RecordedAction::Scroll { dx, dy } => {
                body.push(format!(
                    "  await page.mouse.wheel({dx}, {dy});"
                ));
            }
            RecordedAction::Wait { text, selector, ms } => {
                if let Some(t) = non_empty(text.as_deref()) {
                    body.push(format!(
                        "  await expect(page.getByText({})).toBeVisible();",
                        js_str(t)
                    ));
                } else if let Some(s) = non_empty(selector.as_deref()) {
                    body.push(format!(
                        "  await page.locator({}).waitFor({{ state: 'visible' }});",
                        js_str(s)
                    ));
                } else if let Some(delay) = ms {
                    body.push(format!("  await page.waitForTimeout({delay});"));
                }
            }
        }
    }

    let mut out = String::new();
    out.push_str("import { test, expect } from '@playwright/test';\n");
    if !secret_vars.is_empty() {
        out.push_str(&format!(
            "// Required secrets (redacted during recording): {}\n",
            secret_vars.join(", ")
        ));
    }
    out.push('\n');
    out.push_str(&format!(
        "test({}, async ({{ page }}) => {{\n",
        js_str(test_name)
    ));
    for line in body {
        out.push_str(&line);
        out.push('\n');
    }
    out.push_str("});\n");
    out
}

/// Serializes recorded steps into secret-free JSON (`steps.json`).
#[must_use]
pub fn serialize_steps_json(steps: &[RecordedStep]) -> Value {
    let mut secret_idx = 0usize;
    let items: Vec<Value> = steps
        .iter()
        .map(|s| {
            let action = match &s.action {
                RecordedAction::Navigate { url } => json!({
                    "kind": "navigate",
                    "url": crate::browser_network::redact_url(url),
                }),
                RecordedAction::Click { probe, double } => json!({
                    "kind": "click",
                    "double": double,
                    "probe": probe.to_json(),
                }),
                RecordedAction::Type {
                    probe,
                    text,
                    sensitive,
                } => {
                    if *sensitive || probe.is_password {
                        secret_idx += 1;
                        json!({
                            "kind": "type",
                            "sensitive": true,
                            "secret_env": format!("OMNIA_SECRET_{secret_idx}"),
                            "probe": probe.to_json(),
                        })
                    } else {
                        json!({
                            "kind": "type",
                            "sensitive": false,
                            "text": text,
                            "probe": probe.to_json(),
                        })
                    }
                }
                RecordedAction::Press { key } => json!({ "kind": "press", "key": key }),
                RecordedAction::Select { probe, values } => json!({
                    "kind": "select",
                    "values": values,
                    "probe": probe.to_json(),
                }),
                RecordedAction::Hover { probe } => json!({
                    "kind": "hover",
                    "probe": probe.to_json(),
                }),
                RecordedAction::Scroll { dx, dy } => json!({
                    "kind": "scroll",
                    "dx": dx,
                    "dy": dy,
                }),
                RecordedAction::Wait { text, selector, ms } => json!({
                    "kind": "wait",
                    "text": text,
                    "selector": selector,
                    "ms": ms,
                }),
            };
            json!({
                "index": s.index,
                "elapsed_ms": s.elapsed_ms,
                "action": action,
            })
        })
        .collect();
    json!({ "steps": items })
}

fn non_empty(s: Option<&str>) -> Option<&str> {
    s.map(str::trim).filter(|v| !v.is_empty())
}

fn js_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gradient_rgb(w: u16, h: u16, shift: u8) -> Vec<u8> {
        let mut rgb = Vec::with_capacity((w as usize) * (h as usize) * 3);
        for y in 0..h {
            for x in 0..w {
                rgb.push(((x * 7) as u8).wrapping_add(shift));
                rgb.push(((y * 11) as u8).wrapping_add(shift));
                rgb.push(((x + y) * 5) as u8);
            }
        }
        rgb
    }

    #[test]
    fn encodes_valid_gif89a_with_click_marker_and_idle_dedup() {
        let mut rec = SessionRecorder::new();
        let f1 = gradient_rgb(32, 24, 0);
        assert!(rec.push_rgb_frame(32, 24, f1.clone(), 10, None).unwrap());
        // Identical idle frame must deduplicate into prior delay instead of adding a duplicate frame.
        assert!(!rec.push_rgb_frame(32, 24, f1.clone(), 15, None).unwrap());
        assert_eq!(rec.frame_count(), 1);
        // Frame with a click marker must be retained even if base pixels match.
        assert!(rec.push_rgb_frame(32, 24, f1, 10, Some((16, 12))).unwrap());
        assert_eq!(rec.frame_count(), 2);

        let gif = rec.encode_gif().expect("encode gif");
        assert_eq!(&gif[..6], b"GIF89a");
        assert_eq!(u16::from_le_bytes([gif[6], gif[7]]), 32);
        assert_eq!(u16::from_le_bytes([gif[8], gif[9]]), 24);
        assert!(gif.windows(11).any(|w| w == b"NETSCAPE2.0"));
        assert_eq!(*gif.last().unwrap(), 0x3B);
    }

    #[test]
    fn decodes_stored_and_fixed_huffman_png_into_gif_recorder() {
        // 1. Roundtrip stored PNG produced by omnia_workspace_ops::win32_window::encode_rgba_png
        let rgba = [
            255u8, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255,
        ];
        let png = omnia_workspace_ops::win32_window::encode_rgba_png(2, 2, &rgba).expect("png");
        let (w, h, rgb) = decode_png_rgb(&png).expect("decode stored png");
        assert_eq!((w, h), (2, 2));
        assert_eq!(rgb, vec![255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]);

        let mut rec = SessionRecorder::new();
        assert!(rec.push_png_frame(&png, 10, None).unwrap());
        let gif = rec.encode_gif().expect("gif from png");
        assert_eq!(&gif[..6], b"GIF89a");

        // 2. Real fixed-Huffman compressed 1x1 red RGB PNG (standard zlib 0x78 0x9C stream)
        let compressed_1x1_png: &[u8] = &[
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00,
            0x00, 0x90, 0x77, 0x53, 0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9C, 0x63, 0xF8, 0xCF, 0xC0, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00, 0xC9, 0xFE, 0x92,
            0xEF, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ];
        let (w2, h2, rgb2) = decode_png_rgb(compressed_1x1_png).expect("decode huffman png");
        assert_eq!((w2, h2), (1, 1));
        assert_eq!(rgb2, vec![255, 0, 0]);
    }

    #[test]
    fn playwright_codegen_prioritizes_locators_handles_iframes_and_redacts_secrets() {
        let mut rec = SessionRecorder::new();
        rec.push_step(
            0,
            RecordedAction::Navigate {
                url: "https://app.example.test/login?token=fake_query_secret".to_string(),
            },
        );
        rec.push_step(
            120,
            RecordedAction::Type {
                probe: ElementProbe {
                    tag: "input".into(),
                    label: Some("Email".into()),
                    ..Default::default()
                },
                text: "user@example.test".into(),
                sensitive: false,
            },
        );
        rec.push_step(
            240,
            RecordedAction::Type {
                probe: ElementProbe {
                    tag: "input".into(),
                    placeholder: Some("Password".into()),
                    frame_selectors: vec!["iframe#auth".into()],
                    is_password: true,
                    ..Default::default()
                },
                text: "dummy_password_never_emit".into(),
                sensitive: false, // probe.is_password must still trigger redaction!
            },
        );
        rec.push_step(
            360,
            RecordedAction::Click {
                probe: ElementProbe {
                    tag: "button".into(),
                    role: Some("button".into()),
                    name: Some("Sign in".into()),
                    ..Default::default()
                },
                double: false,
            },
        );

        let spec = rec.generate_playwright_spec("login flow");
        assert!(spec.contains("await page.goto(\"https://app.example.test/login\");"));
        assert!(spec.contains("page.getByLabel(\"Email\").fill(\"user@example.test\")"));
        assert!(spec.contains(
            "page.frameLocator(\"iframe#auth\").getByPlaceholder(\"Password\").fill(process.env.OMNIA_SECRET_1 ?? '')"
        ));
        assert!(spec.contains("page.getByRole(\"button\", { name: \"Sign in\" }).click()"));
        assert!(spec.contains("OMNIA_SECRET_1"));
        assert!(!spec.contains("dummy_password_never_emit"));
        assert!(!spec.contains("fake_query_secret"));

        let steps_json = rec.steps_json().to_string();
        assert!(!steps_json.contains("dummy_password_never_emit"));
        assert!(!steps_json.contains("fake_query_secret"));
        assert!(steps_json.contains("OMNIA_SECRET_1"));
    }
}

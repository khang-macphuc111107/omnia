//! Pure-Rust image downscaling, fast `flate2` + `crc32fast` PNG encoder/decoder,
//! and SHA-256 frame hashing (zero `png` / `jpeg-encoder` external crate deps).

use std::io::{Read, Write};

use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;
use flate2::Compression;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::geometry::downscale_dims;
use crate::types::RawImage;
use crate::ComputerError;

const PNG_SIG: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];
const MAX_DECODE_DIM: u32 = 16_384;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageFormat {
    #[default]
    Png,
}

impl ImageFormat {
    pub fn media_type(self) -> &'static str {
        match self {
            ImageFormat::Png => "image/png",
        }
    }
}

/// Area-average downscale of tightly packed RGB8 to `(dw, dh)`.
pub fn resize_rgb(src: &[u8], sw: u32, sh: u32, dw: u32, dh: u32) -> Vec<u8> {
    if (sw, sh) == (dw, dh) {
        return src.to_vec();
    }
    let mut out = vec![0u8; dw as usize * dh as usize * 3];
    for dy in 0..dh {
        let y0 = (dy as u64 * sh as u64 / dh as u64) as u32;
        let y1 = (((dy as u64 + 1) * sh as u64 / dh as u64) as u32).clamp(y0 + 1, sh);
        for dx in 0..dw {
            let x0 = (dx as u64 * sw as u64 / dw as u64) as u32;
            let x1 = (((dx as u64 + 1) * sw as u64 / dw as u64) as u32).clamp(x0 + 1, sw);
            let (mut r, mut g, mut b, mut n) = (0u32, 0u32, 0u32, 0u32);
            for y in y0..y1 {
                let row = y as usize * sw as usize * 3;
                for x in x0..x1 {
                    let i = row + x as usize * 3;
                    r += src[i] as u32;
                    g += src[i + 1] as u32;
                    b += src[i + 2] as u32;
                    n += 1;
                }
            }
            let o = (dy as usize * dw as usize + dx as usize) * 3;
            out[o] = (r / n) as u8;
            out[o + 1] = (g / n) as u8;
            out[o + 2] = (b / n) as u8;
        }
    }
    out
}

fn write_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let mut hasher = crc32fast::Hasher::new();
    hasher.update(kind);
    hasher.update(data);
    out.extend_from_slice(&hasher.finalize().to_be_bytes());
}

fn encode_png_channels(
    width: u32,
    height: u32,
    pixels: &[u8],
    bpp: usize,
    color_type: u8,
) -> Result<Vec<u8>, ComputerError> {
    if width == 0 || height == 0 {
        return Err(ComputerError::Failed("empty capture".into()));
    }
    let row_bytes = (width as usize)
        .checked_mul(bpp)
        .ok_or_else(|| ComputerError::Failed("png row overflow".into()))?;
    let expected = row_bytes
        .checked_mul(height as usize)
        .ok_or_else(|| ComputerError::Failed("png size overflow".into()))?;
    if pixels.len() < expected {
        return Err(ComputerError::Failed(format!(
            "png buffer too small: need {expected}, got {}",
            pixels.len()
        )));
    }

    let mut enc = ZlibEncoder::new(Vec::with_capacity(expected / 2 + 64), Compression::fast());
    for row in pixels[..expected].chunks_exact(row_bytes) {
        enc.write_all(&[0u8])
            .and_then(|()| enc.write_all(row))
            .map_err(|e| ComputerError::Failed(format!("png zlib: {e}")))?;
    }
    let compressed = enc
        .finish()
        .map_err(|e| ComputerError::Failed(format!("png zlib finish: {e}")))?;

    let mut png = Vec::with_capacity(64 + compressed.len());
    png.extend_from_slice(&PNG_SIG);
    let mut ihdr = [0u8; 13];
    ihdr[0..4].copy_from_slice(&width.to_be_bytes());
    ihdr[4..8].copy_from_slice(&height.to_be_bytes());
    ihdr[8] = 8; // 8-bit depth
    ihdr[9] = color_type;
    write_chunk(&mut png, b"IHDR", &ihdr);
    write_chunk(&mut png, b"IDAT", &compressed);
    write_chunk(&mut png, b"IEND", &[]);
    Ok(png)
}

/// Encode tightly packed RGB8 pixels into a fast-deflate PNG.
pub fn encode_rgb_png(width: u32, height: u32, rgb: &[u8]) -> Result<Vec<u8>, ComputerError> {
    encode_png_channels(width, height, rgb, 3, 2)
}

/// Encode tightly packed RGBA8 pixels into a fast-deflate PNG.
pub fn encode_rgba_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, ComputerError> {
    encode_png_channels(width, height, rgba, 4, 6)
}

fn paeth(a: u8, b: u8, c: u8) -> u8 {
    let (a, b, c) = (i32::from(a), i32::from(b), i32::from(c));
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

/// Decoded 8-bit non-interlaced PNG image (always converted to RGB8).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedPng {
    pub width: u32,
    pub height: u32,
    pub rgb: Vec<u8>,
}

/// Decode a standard 8-bit non-interlaced RGB or RGBA PNG into RGB8 pixels.
pub fn decode_png(data: &[u8]) -> Result<DecodedPng, ComputerError> {
    if data.len() < 33 || data[..8] != PNG_SIG {
        return Err(ComputerError::Invalid("invalid PNG signature".into()));
    }
    let mut pos = 8usize;
    let mut width = 0u32;
    let mut height = 0u32;
    let mut color_type = 0u8;
    let mut saw_ihdr = false;
    let mut saw_iend = false;
    let mut idat = Vec::new();

    while pos + 12 <= data.len() {
        let len = u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]) as usize;
        let kind = &data[pos + 4..pos + 8];
        let payload_start = pos + 8;
        let payload_end = payload_start
            .checked_add(len)
            .ok_or_else(|| ComputerError::Invalid("PNG chunk length overflow".into()))?;
        let crc_end = payload_end
            .checked_add(4)
            .ok_or_else(|| ComputerError::Invalid("PNG chunk CRC overflow".into()))?;
        if crc_end > data.len() {
            return Err(ComputerError::Invalid("truncated PNG chunk".into()));
        }
        let payload = &data[payload_start..payload_end];
        let want_crc = u32::from_be_bytes([
            data[payload_end],
            data[payload_end + 1],
            data[payload_end + 2],
            data[payload_end + 3],
        ]);
        let mut h = crc32fast::Hasher::new();
        h.update(kind);
        h.update(payload);
        if h.finalize() != want_crc {
            return Err(ComputerError::Invalid("PNG chunk CRC mismatch".into()));
        }
        match kind {
            b"IHDR" => {
                if payload.len() != 13 {
                    return Err(ComputerError::Invalid("invalid PNG IHDR length".into()));
                }
                width = u32::from_be_bytes([payload[0], payload[1], payload[2], payload[3]]);
                height = u32::from_be_bytes([payload[4], payload[5], payload[6], payload[7]]);
                let bit_depth = payload[8];
                color_type = payload[9];
                let interlace = payload[12];
                if width == 0 || height == 0 || width > MAX_DECODE_DIM || height > MAX_DECODE_DIM {
                    return Err(ComputerError::Invalid("PNG dimensions out of range".into()));
                }
                if bit_depth != 8 || !matches!(color_type, 2 | 6) || interlace != 0 {
                    return Err(ComputerError::Invalid(
                        "unsupported PNG format (only 8-bit non-interlaced RGB/RGBA supported)"
                            .into(),
                    ));
                }
                saw_ihdr = true;
            }
            b"IDAT" => idat.extend_from_slice(payload),
            b"IEND" => {
                saw_iend = true;
                break;
            }
            _ => {}
        }
        pos = crc_end;
    }

    if !saw_ihdr || !saw_iend {
        return Err(ComputerError::Invalid("PNG missing IHDR or IEND".into()));
    }
    let bpp = if color_type == 6 { 4usize } else { 3usize };
    let stride = (width as usize)
        .checked_mul(bpp)
        .ok_or_else(|| ComputerError::Invalid("PNG stride overflow".into()))?;
    let expected_raw = (stride + 1)
        .checked_mul(height as usize)
        .ok_or_else(|| ComputerError::Invalid("PNG raw size overflow".into()))?;

    let mut raw = Vec::with_capacity(expected_raw);
    let mut dec = ZlibDecoder::new(&idat[..]);
    dec.by_ref()
        .take((expected_raw + 1) as u64)
        .read_to_end(&mut raw)
        .map_err(|e| ComputerError::Invalid(format!("PNG zlib decode: {e}")))?;
    if raw.len() != expected_raw {
        return Err(ComputerError::Invalid(format!(
            "PNG decoded length mismatch: expected {expected_raw}, got {}",
            raw.len()
        )));
    }

    let mut prev = vec![0u8; stride];
    let mut cur = vec![0u8; stride];
    let mut rgb = Vec::with_capacity(width as usize * height as usize * 3);

    for y in 0..height as usize {
        let base = y * (stride + 1);
        let filter = raw[base];
        let src = &raw[base + 1..base + 1 + stride];
        match filter {
            0 => cur.copy_from_slice(src),
            1 => {
                for i in 0..stride {
                    let a = if i >= bpp { cur[i - bpp] } else { 0 };
                    cur[i] = src[i].wrapping_add(a);
                }
            }
            2 => {
                for i in 0..stride {
                    cur[i] = src[i].wrapping_add(prev[i]);
                }
            }
            3 => {
                for i in 0..stride {
                    let a = if i >= bpp { u16::from(cur[i - bpp]) } else { 0 };
                    let b = u16::from(prev[i]);
                    cur[i] = src[i].wrapping_add(((a + b) / 2) as u8);
                }
            }
            4 => {
                for i in 0..stride {
                    let a = if i >= bpp { cur[i - bpp] } else { 0 };
                    let b = prev[i];
                    let c = if i >= bpp { prev[i - bpp] } else { 0 };
                    cur[i] = src[i].wrapping_add(paeth(a, b, c));
                }
            }
            _ => return Err(ComputerError::Invalid(format!("unknown PNG filter {filter}"))),
        }
        if bpp == 3 {
            rgb.extend_from_slice(&cur);
        } else {
            for px in cur.as_chunks::<4>().0 {
                rgb.extend_from_slice(&px[..3]);
            }
        }
        std::mem::swap(&mut prev, &mut cur);
    }

    Ok(DecodedPng { width, height, rgb })
}

/// Lowercase SHA-256 hex digest of captured bytes.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

pub struct Encoded {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// Downscale `img` so its long side is at most `max_side`, then encode.
pub fn encode_image(
    img: &RawImage,
    max_side: u32,
    format: ImageFormat,
) -> Result<Encoded, ComputerError> {
    if img.width == 0
        || img.height == 0
        || img.rgb.len() < img.width as usize * img.height as usize * 3
    {
        return Err(ComputerError::Failed("empty capture".into()));
    }
    let (dw, dh) = downscale_dims(img.width, img.height, max_side);
    let pixels = resize_rgb(&img.rgb, img.width, img.height, dw, dh);
    let bytes = match format {
        ImageFormat::Png => encode_rgb_png(dw, dh, &pixels)?,
    };
    Ok(Encoded {
        bytes,
        width: dw,
        height: dh,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gradient(w: u32, h: u32) -> RawImage {
        let mut rgb = Vec::new();
        for y in 0..h {
            for x in 0..w {
                rgb.extend_from_slice(&[(x % 256) as u8, (y % 256) as u8, 128]);
            }
        }
        RawImage {
            origin: (0, 0),
            width: w,
            height: h,
            rgb,
        }
    }

    #[test]
    fn resize_averages_blocks() {
        let src = [0u8, 0, 0, 100, 100, 100, 100, 100, 100, 200, 200, 200];
        assert_eq!(resize_rgb(&src, 2, 2, 1, 1), vec![100, 100, 100]);
    }

    #[test]
    fn pure_rust_png_encode_decode_roundtrip() {
        let img = gradient(64, 32);
        let enc = encode_image(&img, 32, ImageFormat::Png).unwrap();
        assert_eq!((enc.width, enc.height), (32, 16));
        assert_eq!(&enc.bytes[..8], &PNG_SIG);
        let dec = decode_png(&enc.bytes).unwrap();
        assert_eq!((dec.width, dec.height), (32, 16));
        assert_eq!(dec.rgb.len(), 32 * 16 * 3);

        // Full-res exact lossless roundtrip
        let full = encode_rgb_png(img.width, img.height, &img.rgb).unwrap();
        let dec_full = decode_png(&full).unwrap();
        assert_eq!(dec_full.rgb, img.rgb);

        // RGBA roundtrip strips alpha to RGB
        let rgba = [10u8, 20, 30, 255, 40, 50, 60, 128];
        let rgba_png = encode_rgba_png(2, 1, &rgba).unwrap();
        let dec_rgba = decode_png(&rgba_png).unwrap();
        assert_eq!(dec_rgba.rgb, vec![10, 20, 30, 40, 50, 60]);

        // Corrupt CRC rejected
        let mut bad = full.clone();
        let last = bad.len() - 1;
        bad[last] ^= 0xFF;
        assert!(decode_png(&bad).is_err());

        // Empty capture rejected
        assert!(encode_image(
            &RawImage {
                origin: (0, 0),
                width: 0,
                height: 0,
                rgb: vec![]
            },
            10,
            ImageFormat::Png
        )
        .is_err());

        assert_eq!(sha256_hex(b"").len(), 64);
    }
}

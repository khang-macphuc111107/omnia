//! Minimal GIF89a encoder: global median-cut palette, LZW, per-frame delays.
#![allow(clippy::chunks_exact_to_as_chunks)]

use std::collections::HashMap;

/// One RGBA frame, already at the canvas size.
pub struct GifFrame {
    pub rgba: Vec<u8>,
    /// Display time in centiseconds.
    pub delay_cs: u16,
}

/// 15-bit-colour median-cut palette (up to 256 entries) with a nearest-colour cache.
pub struct Palette {
    pub colors: Vec<[u8; 3]>,
    cache: HashMap<u16, u8>,
}

fn key15(r: u8, g: u8, b: u8) -> u16 {
    ((r as u16 >> 3) << 10) | ((g as u16 >> 3) << 5) | (b as u16 >> 3)
}

fn unkey(k: u16) -> [u8; 3] {
    let e = |v: u16| ((v << 3) | (v >> 2)) as u8;
    [e((k >> 10) & 31), e((k >> 5) & 31), e(k & 31)]
}

fn channel(k: u16, ch: usize) -> i32 {
    match ch {
        0 => ((k >> 10) & 31) as i32,
        1 => ((k >> 5) & 31) as i32,
        _ => (k & 31) as i32,
    }
}

impl Palette {
    /// `histogram`: 15-bit colour -> pixel count.
    pub fn from_histogram(histogram: &HashMap<u16, u32>) -> Palette {
        let mut boxes: Vec<Vec<(u16, u32)>> =
            vec![histogram.iter().map(|(k, c)| (*k, *c)).collect()];
        if boxes[0].is_empty() {
            boxes[0].push((0, 1));
        }
        while boxes.len() < 256 {
            // Split the box with the widest channel range that has more than one colour.
            let mut best: Option<(usize, usize, i32)> = None;
            for (i, b) in boxes.iter().enumerate() {
                if b.len() < 2 {
                    continue;
                }
                for ch in 0..3 {
                    let (lo, hi) = b
                        .iter()
                        .map(|(k, _)| channel(*k, ch))
                        .fold((i32::MAX, i32::MIN), |(l, h), v| (l.min(v), h.max(v)));
                    let range = hi - lo;
                    if best.is_none_or(|(_, _, r)| range > r) {
                        best = Some((i, ch, range));
                    }
                }
            }
            let Some((index, ch, _)) = best else { break };
            let mut b = boxes.swap_remove(index);
            b.sort_by_key(|(k, _)| channel(*k, ch));
            let total: u64 = b.iter().map(|(_, c)| *c as u64).sum();
            let mut acc = 0u64;
            let mut cut = 1;
            for (i, (_, c)) in b.iter().enumerate() {
                acc += *c as u64;
                if acc * 2 >= total {
                    cut = (i + 1).clamp(1, b.len() - 1);
                    break;
                }
            }
            let right = b.split_off(cut);
            boxes.push(b);
            boxes.push(right);
        }
        let colors = boxes
            .iter()
            .map(|b| {
                let total: u64 = b.iter().map(|(_, c)| *c as u64).sum::<u64>().max(1);
                let mut sum = [0u64; 3];
                for (k, c) in b {
                    let rgb = unkey(*k);
                    for i in 0..3 {
                        sum[i] += rgb[i] as u64 * *c as u64;
                    }
                }
                [
                    (sum[0] / total) as u8,
                    (sum[1] / total) as u8,
                    (sum[2] / total) as u8,
                ]
            })
            .collect();
        Palette {
            colors,
            cache: HashMap::new(),
        }
    }

    pub fn index_of(&mut self, r: u8, g: u8, b: u8) -> u8 {
        let k = key15(r, g, b);
        if let Some(i) = self.cache.get(&k) {
            return *i;
        }
        let [qr, qg, qb] = unkey(k);
        let mut best = (0usize, i32::MAX);
        for (i, c) in self.colors.iter().enumerate() {
            let d = (c[0] as i32 - qr as i32).pow(2)
                + (c[1] as i32 - qg as i32).pow(2)
                + (c[2] as i32 - qb as i32).pow(2);
            if d < best.1 {
                best = (i, d);
            }
        }
        self.cache.insert(k, best.0 as u8);
        best.0 as u8
    }
}

/// Adds a frame's pixels (every `step`th one) to a colour histogram.
pub fn sample_histogram(histogram: &mut HashMap<u16, u32>, rgba: &[u8], step: usize) {
    for px in rgba.chunks_exact(4).step_by(step.max(1)) {
        *histogram.entry(key15(px[0], px[1], px[2])).or_insert(0) += 1;
    }
}

/// Variable-width LZW as used by GIF (minimum code size 8).
pub fn lzw_encode(indices: &[u8]) -> Vec<u8> {
    const MIN: u32 = 8;
    let clear = 1u32 << MIN;
    let eoi = clear + 1;
    let mut out = Vec::with_capacity(indices.len() / 2 + 16);
    let (mut acc, mut nbits) = (0u32, 0u32);
    let emit = |code: u32, width: u32, out: &mut Vec<u8>, acc: &mut u32, nbits: &mut u32| {
        *acc |= code << *nbits;
        *nbits += width;
        while *nbits >= 8 {
            out.push((*acc & 0xFF) as u8);
            *acc >>= 8;
            *nbits -= 8;
        }
    };
    let mut table: HashMap<(u32, u8), u32> = HashMap::new();
    let mut next = eoi + 1;
    let mut width = MIN + 1;
    emit(clear, width, &mut out, &mut acc, &mut nbits);
    let mut iter = indices.iter();
    if let Some(&first) = iter.next() {
        let mut prefix = first as u32;
        for &byte in iter {
            if let Some(code) = table.get(&(prefix, byte)) {
                prefix = *code;
                continue;
            }
            emit(prefix, width, &mut out, &mut acc, &mut nbits);
            if next < 4096 {
                table.insert((prefix, byte), next);
                if next == (1 << width) && width < 12 {
                    width += 1;
                }
                next += 1;
            } else {
                emit(clear, width, &mut out, &mut acc, &mut nbits);
                table.clear();
                next = eoi + 1;
                width = MIN + 1;
            }
            prefix = byte as u32;
        }
        emit(prefix, width, &mut out, &mut acc, &mut nbits);
    }
    emit(eoi, width, &mut out, &mut acc, &mut nbits);
    if nbits > 0 {
        out.push(acc as u8);
    }
    out
}

/// Encodes frames (all `width`x`height` RGBA) as a looping GIF89a.
pub fn encode_gif(width: u16, height: u16, frames: &[GifFrame], palette: &mut Palette) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(b"GIF89a");
    out.extend_from_slice(&width.to_le_bytes());
    out.extend_from_slice(&height.to_le_bytes());
    out.extend_from_slice(&[0xF7, 0, 0]); // global table, 8 bits/channel, 256 entries
    for i in 0..256 {
        out.extend_from_slice(&palette.colors.get(i).copied().unwrap_or([0, 0, 0]));
    }
    out.extend_from_slice(&[0x21, 0xFF, 0x0B]);
    out.extend_from_slice(b"NETSCAPE2.0");
    out.extend_from_slice(&[3, 1, 0, 0, 0]); // loop forever
    for frame in frames {
        let d = frame.delay_cs.to_le_bytes();
        out.extend_from_slice(&[0x21, 0xF9, 4, 0, d[0], d[1], 0, 0]);
        out.push(0x2C);
        out.extend_from_slice(&[0, 0, 0, 0]);
        out.extend_from_slice(&width.to_le_bytes());
        out.extend_from_slice(&height.to_le_bytes());
        out.push(0);
        let indices: Vec<u8> = frame
            .rgba
            .chunks_exact(4)
            .map(|p| palette.index_of(p[0], p[1], p[2]))
            .collect();
        out.push(8);
        for chunk in lzw_encode(&indices).chunks(255) {
            out.push(chunk.len() as u8);
            out.extend_from_slice(chunk);
        }
        out.push(0);
    }
    out.push(0x3B);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reference GIF LZW decoder used to prove the encoder round-trips.
    fn lzw_decode(data: &[u8], expected: usize) -> Vec<u8> {
        let (clear, eoi) = (256u32, 257u32);
        let reset = |t: &mut Vec<Vec<u8>>| {
            t.clear();
            for i in 0..256u32 {
                t.push(vec![i as u8]);
            }
            t.push(vec![]);
            t.push(vec![]);
        };
        let mut table: Vec<Vec<u8>> = Vec::new();
        reset(&mut table);
        let (mut acc, mut nbits, mut pos) = (0u32, 0u32, 0usize);
        let mut width = 9u32;
        let mut out = Vec::new();
        let mut prev: Option<Vec<u8>> = None;
        while out.len() < expected {
            while nbits < width {
                if pos >= data.len() {
                    return out;
                }
                acc |= (data[pos] as u32) << nbits;
                pos += 1;
                nbits += 8;
            }
            let code = acc & ((1 << width) - 1);
            acc >>= width;
            nbits -= width;
            if code == clear {
                reset(&mut table);
                width = 9;
                prev = None;
                continue;
            }
            if code == eoi {
                break;
            }
            let entry = if (code as usize) < table.len() {
                table[code as usize].clone()
            } else {
                let mut p = prev.clone().unwrap();
                p.push(p[0]);
                p
            };
            out.extend_from_slice(&entry);
            if let Some(mut n) = prev.take() {
                n.push(entry[0]);
                table.push(n);
                if table.len() == (1 << width) && width < 12 {
                    width += 1;
                }
            }
            prev = Some(entry);
        }
        out
    }

    #[test]
    fn lzw_round_trips_including_table_overflow() {
        let mut data = Vec::new();
        let mut x = 12345u32;
        for i in 0..60_000u32 {
            x = x.wrapping_mul(1103515245).wrapping_add(12345);
            data.push(if i % 7 < 3 {
                (i % 5) as u8
            } else {
                (x >> 24) as u8
            });
        }
        assert_eq!(lzw_decode(&lzw_encode(&data), data.len()), data);
        let flat = vec![7u8; 10_000];
        assert_eq!(lzw_decode(&lzw_encode(&flat), flat.len()), flat);
        assert!(lzw_decode(&lzw_encode(&[]), 0).is_empty());
    }

    #[test]
    fn gif_structure_and_pixels() {
        let (w, h) = (16u16, 8u16);
        let mut a = Vec::new();
        let mut b = Vec::new();
        for i in 0..(w as usize * h as usize) {
            a.extend_from_slice(&[255, 0, 0, 255]);
            b.extend_from_slice(if i % 2 == 0 {
                &[0, 0, 255, 255]
            } else {
                &[0, 255, 0, 255]
            });
        }
        let mut hist = HashMap::new();
        sample_histogram(&mut hist, &a, 1);
        sample_histogram(&mut hist, &b, 1);
        let mut palette = Palette::from_histogram(&hist);
        let gif = encode_gif(
            w,
            h,
            &[
                GifFrame {
                    rgba: a,
                    delay_cs: 25,
                },
                GifFrame {
                    rgba: b,
                    delay_cs: 100,
                },
            ],
            &mut palette,
        );
        assert_eq!(&gif[..6], b"GIF89a");
        assert_eq!(u16::from_le_bytes([gif[6], gif[7]]), w);
        assert_eq!(u16::from_le_bytes([gif[8], gif[9]]), h);
        assert_eq!(*gif.last().unwrap(), 0x3B);
        let gce: Vec<usize> = (0..gif.len() - 8)
            .filter(|&i| gif[i..i + 3] == [0x21, 0xF9, 4])
            .collect();
        assert_eq!(gce.len(), 2);
        assert_eq!(u16::from_le_bytes([gif[gce[0] + 4], gif[gce[0] + 5]]), 25);
        assert_eq!(u16::from_le_bytes([gif[gce[1] + 4], gif[gce[1] + 5]]), 100);
        let mut p = gce[1] + 8 + 10; // graphic control block (8) + image descriptor (10)
        assert_eq!(gif[gce[1] + 8], 0x2C);
        assert_eq!(gif[p], 8);
        p += 1;
        let mut lzw = Vec::new();
        while gif[p] != 0 {
            let n = gif[p] as usize;
            lzw.extend_from_slice(&gif[p + 1..p + 1 + n]);
            p += 1 + n;
        }
        let indices = lzw_decode(&lzw, w as usize * h as usize);
        assert_eq!(indices.len(), w as usize * h as usize);
        for (i, idx) in indices.iter().enumerate() {
            let c = palette.colors[*idx as usize];
            let want = if i % 2 == 0 { [0, 0, 255] } else { [0, 255, 0] };
            assert!(
                c.iter().zip(want).all(|(a, b)| (*a as i32 - b).abs() < 12),
                "pixel {i}: {c:?}"
            );
        }
    }
}

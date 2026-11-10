//! Downscaling and PNG/JPEG encoding of captured pixels (pure Rust).

use serde::{Deserialize, Serialize};

use crate::geometry::downscale_dims;
use crate::types::RawImage;
use crate::ComputerError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageFormat {
    Png,
    #[default]
    Jpeg,
}

impl ImageFormat {
    pub fn media_type(self) -> &'static str {
        match self {
            ImageFormat::Png => "image/png",
            ImageFormat::Jpeg => "image/jpeg",
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
    jpeg_quality: u8,
) -> Result<Encoded, ComputerError> {
    if img.width == 0
        || img.height == 0
        || img.rgb.len() < img.width as usize * img.height as usize * 3
    {
        return Err(ComputerError::Failed("empty capture".into()));
    }
    let (dw, dh) = downscale_dims(img.width, img.height, max_side);
    let pixels = resize_rgb(&img.rgb, img.width, img.height, dw, dh);
    let mut bytes = Vec::new();
    match format {
        ImageFormat::Png => {
            let mut enc = png::Encoder::new(&mut bytes, dw, dh);
            enc.set_color(png::ColorType::Rgb);
            enc.set_depth(png::BitDepth::Eight);
            enc.set_compression(png::Compression::Fast);
            let mut w = enc
                .write_header()
                .map_err(|e| ComputerError::Failed(format!("png: {e}")))?;
            w.write_image_data(&pixels)
                .map_err(|e| ComputerError::Failed(format!("png: {e}")))?;
            w.finish()
                .map_err(|e| ComputerError::Failed(format!("png: {e}")))?;
        }
        ImageFormat::Jpeg => {
            let enc = jpeg_encoder::Encoder::new(&mut bytes, jpeg_quality.clamp(1, 100));
            enc.encode(&pixels, dw as u16, dh as u16, jpeg_encoder::ColorType::Rgb)
                .map_err(|e| ComputerError::Failed(format!("jpeg: {e}")))?;
        }
    }
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
    fn png_and_jpeg_roundtrip_dims() {
        let img = gradient(400, 200);
        let p = encode_image(&img, 100, ImageFormat::Png, 80).unwrap();
        assert_eq!((p.width, p.height), (100, 50));
        assert_eq!(&p.bytes[..4], &[0x89, b'P', b'N', b'G']);
        let j = encode_image(&img, 1568, ImageFormat::Jpeg, 80).unwrap();
        assert_eq!((j.width, j.height), (400, 200));
        assert_eq!(&j.bytes[..2], &[0xFF, 0xD8]);
        assert!(encode_image(
            &RawImage {
                origin: (0, 0),
                width: 0,
                height: 0,
                rgb: vec![]
            },
            10,
            ImageFormat::Png,
            80
        )
        .is_err());
    }
}

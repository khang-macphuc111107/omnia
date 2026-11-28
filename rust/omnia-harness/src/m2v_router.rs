//! Pure-Rust Model2Vec Read-Only Seek Engine (`#![forbid(unsafe_code)]`).
//!
//! Reads compact, seekable binary indexes compiled from `potion-multilingual-128M`:
//! - `m2v_vocab.bin` (`M2VV0001`): Bloom filter + bucketed SentencePiece Unigram vocabulary
//! - `m2v_embed.bin` (`M2VE0001`): per-token quantized `int8` 256-dim embedding rows (`File::seek`)
//! - `skill_vecs.bin` (`M2VS0001`): compact quantized `int8` skill matrix + metadata table
//!
//! Zero `unsafe` code, zero external ML runtimes, strict pre-allocation bounds checks on every
//! header/offset before allocating memory, and graceful `None` degradation when model binaries
//! are absent or corrupt.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// Embedding dimensionality of `potion-multilingual-128M` binary tables.
pub const M2V_DIM: usize = 256;

/// Relative home-directory path for pre-compiled `potion-multilingual-128M` seek binaries.
pub const DEFAULT_M2V_MODEL_REL_PATH: &str =
    ".gemini/config/plugins/agy-fast/models/potion-multilingual-128M";

/// Secondary external Omnia data model location.
pub const OMNIA_DATA_M2V_MODEL_DIR: &str = r"D:\OmniaData\models\potion-multilingual-128M";

const BLOOM_K: usize = 5;
const MAX_ENCODE_QUERY_BYTES: usize = 384;
const MAX_ENCODE_TOKENS: usize = 64;
const MAX_BUCKETS: usize = 1_048_576;
const MAX_BLOOM_BYTES: usize = 16_777_216;
const MAX_BUCKET_LEN: u64 = 1_048_576;
const MAX_SKILL_ROWS: usize = 200_000;

/// One ranked dense semantic hit returned by [`M2vSeekEngine::top_skills`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct M2vSkillHit {
    pub slug: String,
    pub dedup_key: String,
    pub category_id: String,
    pub cosine: f32,
}

#[derive(Debug, Clone)]
struct SkillVecRow {
    scale: f32,
    q: [i8; M2V_DIM],
    dedup_key: String,
    slug: String,
    category_id: String,
}

/// Zero-`unsafe` read-only seek engine over `M2VV0001` / `M2VE0001` / `M2VS0001` binary indexes.
pub struct M2vSeekEngine {
    vocab_file: Mutex<File>,
    vocab_file_len: u64,
    embed_file: Mutex<File>,
    num_buckets: usize,
    bloom_bits: u64,
    bloom: Vec<u8>,
    bucket_offsets: Vec<u32>,
    payload_offset: u64,
    max_piece_bytes: usize,
    unk_id: u32,
    embed_vocab_size: u32,
    embed_row_stride: u64,
    skill_rows: Vec<SkillVecRow>,
    key_to_idx: HashMap<String, usize>,
    slug_to_idx: HashMap<String, usize>,
}

impl std::fmt::Debug for M2vSeekEngine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("M2vSeekEngine")
            .field("num_skills", &self.skill_rows.len())
            .field("embed_vocab_size", &self.embed_vocab_size)
            .field("num_buckets", &self.num_buckets)
            .finish()
    }
}

/// Discovers a directory containing all three Model2Vec binary files (`m2v_vocab.bin`,
/// `m2v_embed.bin`, `skill_vecs.bin`), checking `OMNIA_M2V_MODEL_DIR`,
/// `AGY_FAST_SEMANTIC_MODEL_DIR`, `D:\OmniaData\models\potion-multilingual-128M`,
/// and the default plugin directory.
#[must_use]
pub fn discover_m2v_model_dir() -> Option<PathBuf> {
    for env_key in ["OMNIA_M2V_MODEL_DIR", "AGY_FAST_SEMANTIC_MODEL_DIR"] {
        if let Ok(raw) = std::env::var(env_key) {
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                let candidate = PathBuf::from(trimmed);
                if has_all_m2v_files(&candidate) {
                    return Some(candidate);
                }
            }
        }
    }

    let mut candidates = vec![PathBuf::from(OMNIA_DATA_M2V_MODEL_DIR)];
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        candidates.push(
            PathBuf::from(home)
                .join(".gemini")
                .join("config")
                .join("plugins")
                .join("agy-fast")
                .join("models")
                .join("potion-multilingual-128M"),
        );
    }
    candidates.into_iter().find(|dir| has_all_m2v_files(dir))
}

fn has_all_m2v_files(dir: &Path) -> bool {
    dir.join("m2v_vocab.bin").is_file()
        && dir.join("m2v_embed.bin").is_file()
        && dir.join("skill_vecs.bin").is_file()
}

/// Deterministic FNV-1a 64-bit + SplitMix64 dual hash pair matching `M2VV0001` Bloom & bucket layout.
#[must_use]
pub fn piece_hashes(data: &[u8]) -> (u64, u64) {
    let mut h1: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in data {
        h1 ^= u64::from(b);
        h1 = h1.wrapping_mul(0x0100_0000_01b3);
    }
    let mut x = h1 ^ (data.len() as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15);
    x = x.wrapping_add(0x9e37_79b9_7f4a_7c15);
    x = (x ^ (x >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    let mut h2 = x ^ (x >> 31);
    if h2 == 0 {
        h2 = 0x9e37_79b9_7f4a_7c15;
    }
    (h1, h2)
}

/// Pure-Rust Vietnamese NFD -> NFC composer covering all 134 precomposed Vietnamese vowels
/// across both modifier-first and tone-first combining orders, with an ASCII fast path.
#[must_use]
pub fn compose_vn_nfc(text: &str) -> String {
    if text.is_ascii()
        || !text.chars().any(|c| {
            matches!(
                c,
                '\u{0300}'
                    | '\u{0301}'
                    | '\u{0302}'
                    | '\u{0303}'
                    | '\u{0306}'
                    | '\u{0309}'
                    | '\u{031B}'
                    | '\u{0323}'
            )
        })
    {
        return text.to_string();
    }

    fn apply_vn_mark(base: char, mark: char) -> Option<char> {
        let tone_idx = match mark {
            '\u{0300}' => Some(0usize),
            '\u{0301}' => Some(1),
            '\u{0303}' => Some(2),
            '\u{0309}' => Some(3),
            '\u{0323}' => Some(4),
            _ => None,
        };
        if let Some(ti) = tone_idx {
            let row: Option<[char; 5]> = match base {
                'a' => Some(['à', 'á', 'ã', 'ả', 'ạ']),
                'A' => Some(['À', 'Á', 'Ã', 'Ả', 'Ạ']),
                'ă' => Some(['ằ', 'ắ', 'ẵ', 'ẳ', 'ặ']),
                'Ă' => Some(['Ằ', 'Ắ', 'Ẵ', 'Ẳ', 'Ặ']),
                'â' => Some(['ầ', 'ấ', 'ẫ', 'ẩ', 'ậ']),
                'Â' => Some(['Ầ', 'Ấ', 'Ẫ', 'Ẩ', 'Ậ']),
                'e' => Some(['è', 'é', 'ẽ', 'ẻ', 'ẹ']),
                'E' => Some(['È', 'É', 'Ẽ', 'Ẻ', 'Ẹ']),
                'ê' => Some(['ề', 'ế', 'ễ', 'ể', 'ệ']),
                'Ê' => Some(['Ề', 'Ế', 'Ễ', 'Ể', 'Ệ']),
                'i' => Some(['ì', 'í', 'ĩ', 'ỉ', 'ị']),
                'I' => Some(['Ì', 'Í', 'Ĩ', 'Ỉ', 'Ị']),
                'o' => Some(['ò', 'ó', 'õ', 'ỏ', 'ọ']),
                'O' => Some(['Ò', 'Ó', 'Õ', 'Ỏ', 'Ọ']),
                'ô' => Some(['ồ', 'ố', 'ỗ', 'ổ', 'ộ']),
                'Ô' => Some(['Ồ', 'Ố', 'Ỗ', 'Ổ', 'Ộ']),
                'ơ' => Some(['ờ', 'ớ', 'ỡ', 'ở', 'ợ']),
                'Ơ' => Some(['Ờ', 'Ớ', 'Ỡ', 'Ở', 'Ợ']),
                'u' => Some(['ù', 'ú', 'ũ', 'ủ', 'ụ']),
                'U' => Some(['Ù', 'Ú', 'Ũ', 'Ủ', 'Ụ']),
                'ư' => Some(['ừ', 'ứ', 'ữ', 'ử', 'ự']),
                'Ư' => Some(['Ừ', 'Ứ', 'Ữ', 'Ử', 'Ự']),
                'y' => Some(['ỳ', 'ý', 'ỹ', 'ỷ', 'ỵ']),
                'Y' => Some(['Ỳ', 'Ý', 'Ỹ', 'Ỷ', 'Ỵ']),
                _ => None,
            };
            return row.map(|r| r[ti]);
        }
        match (base, mark) {
            ('a', '\u{0306}') => Some('ă'),
            ('A', '\u{0306}') => Some('Ă'),
            ('a', '\u{0302}') => Some('â'),
            ('A', '\u{0302}') => Some('Â'),
            ('e', '\u{0302}') => Some('ê'),
            ('E', '\u{0302}') => Some('Ê'),
            ('o', '\u{0302}') => Some('ô'),
            ('O', '\u{0302}') => Some('Ô'),
            ('o', '\u{031B}') => Some('ơ'),
            ('O', '\u{031B}') => Some('Ơ'),
            ('u', '\u{031B}') => Some('ư'),
            ('U', '\u{031B}') => Some('Ư'),
            ('à', '\u{0306}') => Some('ằ'),
            ('á', '\u{0306}') => Some('ắ'),
            ('ã', '\u{0306}') => Some('ẵ'),
            ('ả', '\u{0306}') => Some('ẳ'),
            ('ạ', '\u{0306}') => Some('ặ'),
            ('À', '\u{0306}') => Some('Ằ'),
            ('Á', '\u{0306}') => Some('Ắ'),
            ('Ã', '\u{0306}') => Some('Ẵ'),
            ('Ả', '\u{0306}') => Some('Ẳ'),
            ('Ạ', '\u{0306}') => Some('Ặ'),
            ('à', '\u{0302}') => Some('ầ'),
            ('á', '\u{0302}') => Some('ấ'),
            ('ã', '\u{0302}') => Some('ẫ'),
            ('ả', '\u{0302}') => Some('ẩ'),
            ('ạ', '\u{0302}') => Some('ậ'),
            ('À', '\u{0302}') => Some('Ầ'),
            ('Á', '\u{0302}') => Some('Ấ'),
            ('Ã', '\u{0302}') => Some('Ẫ'),
            ('Ả', '\u{0302}') => Some('Ẩ'),
            ('Ạ', '\u{0302}') => Some('Ậ'),
            ('è', '\u{0302}') => Some('ề'),
            ('é', '\u{0302}') => Some('ế'),
            ('ẽ', '\u{0302}') => Some('ễ'),
            ('ẻ', '\u{0302}') => Some('ể'),
            ('ẹ', '\u{0302}') => Some('ệ'),
            ('È', '\u{0302}') => Some('Ề'),
            ('É', '\u{0302}') => Some('Ế'),
            ('Ẽ', '\u{0302}') => Some('Ễ'),
            ('Ẻ', '\u{0302}') => Some('Ể'),
            ('Ẹ', '\u{0302}') => Some('Ệ'),
            ('ò', '\u{0302}') => Some('ồ'),
            ('ó', '\u{0302}') => Some('ố'),
            ('õ', '\u{0302}') => Some('ỗ'),
            ('ỏ', '\u{0302}') => Some('ổ'),
            ('ọ', '\u{0302}') => Some('ộ'),
            ('Ò', '\u{0302}') => Some('Ồ'),
            ('Ó', '\u{0302}') => Some('Ố'),
            ('Õ', '\u{0302}') => Some('Ỗ'),
            ('Ỏ', '\u{0302}') => Some('Ổ'),
            ('Ọ', '\u{0302}') => Some('Ộ'),
            ('ò', '\u{031B}') => Some('ờ'),
            ('ó', '\u{031B}') => Some('ớ'),
            ('õ', '\u{031B}') => Some('ỡ'),
            ('ỏ', '\u{031B}') => Some('ở'),
            ('ọ', '\u{031B}') => Some('ợ'),
            ('Ò', '\u{031B}') => Some('Ờ'),
            ('Ó', '\u{031B}') => Some('Ớ'),
            ('Õ', '\u{031B}') => Some('Ỡ'),
            ('Ỏ', '\u{031B}') => Some('Ở'),
            ('Ọ', '\u{031B}') => Some('Ợ'),
            ('ù', '\u{031B}') => Some('ừ'),
            ('ú', '\u{031B}') => Some('ứ'),
            ('ũ', '\u{031B}') => Some('ữ'),
            ('ủ', '\u{031B}') => Some('ử'),
            ('ụ', '\u{031B}') => Some('ự'),
            ('Ù', '\u{031B}') => Some('Ừ'),
            ('Ú', '\u{031B}') => Some('Ứ'),
            ('Ũ', '\u{031B}') => Some('Ữ'),
            ('Ủ', '\u{031B}') => Some('Ử'),
            ('Ụ', '\u{031B}') => Some('Ự'),
            _ => None,
        }
    }

    let mut out = String::with_capacity(text.len());
    let mut pending: Option<char> = None;
    for ch in text.chars() {
        if let Some(prev) = pending {
            if let Some(composed) = apply_vn_mark(prev, ch) {
                pending = Some(composed);
                continue;
            }
            out.push(prev);
        }
        pending = Some(ch);
    }
    if let Some(last) = pending {
        out.push(last);
    }
    out
}

/// Computes Reciprocal Rank Fusion (`1 / (k + rank)`, 1-based rank) combining sparse and dense rankings.
#[must_use]
pub fn rrf_fuse_ranks(
    sparse_ranks: &HashMap<String, usize>,
    dense_ranks: &HashMap<String, usize>,
    k: f64,
) -> HashMap<String, f64> {
    let k_safe = if k.is_finite() && k > 0.0 { k } else { 60.0 };
    let mut fused: HashMap<String, f64> =
        HashMap::with_capacity(sparse_ranks.len() + dense_ranks.len());
    for (key, &rank) in sparse_ranks {
        let r = rank.max(1) as f64;
        *fused.entry(key.clone()).or_insert(0.0) += 1.0 / (k_safe + r);
    }
    for (key, &rank) in dense_ranks {
        let r = rank.max(1) as f64;
        *fused.entry(key.clone()).or_insert(0.0) += 1.0 / (k_safe + r);
    }
    fused
}

fn read_u32_le(b: &[u8], off: usize) -> Option<u32> {
    let slice = b.get(off..off.checked_add(4)?)?;
    Some(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn read_u16_le(b: &[u8], off: usize) -> Option<u16> {
    let slice = b.get(off..off.checked_add(2)?)?;
    Some(u16::from_le_bytes([slice[0], slice[1]]))
}

fn read_f32_le(b: &[u8], off: usize) -> Option<f32> {
    let slice = b.get(off..off.checked_add(4)?)?;
    Some(f32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn normalize_for_m2v(text: &str) -> String {
    let nfc = compose_vn_nfc(text);
    let mut out = String::with_capacity(nfc.len() + 16);
    let mut prev_space = true;
    for ch in nfc.chars() {
        let c = match ch {
            '\u{FF01}'..='\u{FF5E}' => char::from_u32((ch as u32) - 0xFEE0).unwrap_or(ch),
            '\u{3000}' | '\u{00A0}' => ' ',
            _ => ch,
        };
        if c.is_whitespace() {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else if c.is_ascii_punctuation() {
            if !prev_space {
                out.push(' ');
            }
            out.push(c);
            out.push(' ');
            prev_space = true;
        } else {
            out.push(c);
            prev_space = false;
        }
    }
    out.trim().to_string()
}

impl M2vSeekEngine {
    /// Auto-discovers and loads the default Model2Vec seek binaries if available on disk.
    #[must_use]
    pub fn load_default() -> Option<Self> {
        let dir = discover_m2v_model_dir()?;
        Self::load(&dir)
    }

    /// Loads and validates `m2v_vocab.bin` (`M2VV0001`), `m2v_embed.bin` (`M2VE0001`),
    /// and `skill_vecs.bin` (`M2VS0001`) from `model_dir`.
    ///
    /// Performs strict pre-allocation bounds checks on every count and offset against file
    /// sizes before allocating; returns `None` cleanly if any file is absent or corrupt.
    #[must_use]
    pub fn load(model_dir: &Path) -> Option<Self> {
        let vocab_path = model_dir.join("m2v_vocab.bin");
        let embed_path = model_dir.join("m2v_embed.bin");
        let skill_path = model_dir.join("skill_vecs.bin");
        if !vocab_path.is_file() || !embed_path.is_file() || !skill_path.is_file() {
            return None;
        }

        // 1. Validate m2v_vocab.bin (M2VV0001)
        let mut vf = File::open(&vocab_path).ok()?;
        let vf_len = vf.metadata().ok()?.len();
        if vf_len < 64 {
            return None;
        }
        let mut vhdr = [0u8; 64];
        vf.read_exact(&mut vhdr).ok()?;
        if &vhdr[0..8] != b"M2VV0001" {
            return None;
        }
        let num_buckets = read_u32_le(&vhdr, 12)? as usize;
        let bloom_bytes = read_u32_le(&vhdr, 16)? as usize;
        let unk_id = read_u32_le(&vhdr, 20)?;
        let max_piece_bytes = (read_u32_le(&vhdr, 24)? as usize).clamp(16, 128);
        let dim = read_u32_le(&vhdr, 28)? as usize;
        let payload_offset = u64::from(read_u32_le(&vhdr, 36)?);
        if dim != M2V_DIM
            || num_buckets == 0
            || num_buckets > MAX_BUCKETS
            || !num_buckets.is_power_of_two()
            || bloom_bytes == 0
            || bloom_bytes > MAX_BLOOM_BYTES
            || !bloom_bytes.is_power_of_two()
        {
            return None;
        }
        let off_table_bytes = ((num_buckets as u64).checked_add(1)?).checked_mul(4)?;
        let header_end = 64u64
            .checked_add(bloom_bytes as u64)?
            .checked_add(off_table_bytes)?;
        if payload_offset < header_end || payload_offset > vf_len {
            return None;
        }

        let mut bloom = vec![0u8; bloom_bytes];
        vf.read_exact(&mut bloom).ok()?;

        let off_table_len = usize::try_from(off_table_bytes).ok()?;
        let mut off_raw = vec![0u8; off_table_len];
        vf.read_exact(&mut off_raw).ok()?;
        let mut bucket_offsets = Vec::with_capacity(num_buckets + 1);
        let mut prev_off = 0u32;
        for i in 0..=num_buckets {
            let off = read_u32_le(&off_raw, i * 4)?;
            if off < prev_off {
                return None;
            }
            if u64::from(off - prev_off) > MAX_BUCKET_LEN {
                return None;
            }
            if payload_offset.checked_add(u64::from(off))? > vf_len {
                return None;
            }
            prev_off = off;
            bucket_offsets.push(off);
        }

        // 2. Validate m2v_embed.bin (M2VE0001)
        let mut ef = File::open(&embed_path).ok()?;
        let ef_len = ef.metadata().ok()?.len();
        if ef_len < 64 {
            return None;
        }
        let mut ehdr = [0u8; 64];
        ef.read_exact(&mut ehdr).ok()?;
        if &ehdr[0..8] != b"M2VE0001" {
            return None;
        }
        let embed_vocab_size = read_u32_le(&ehdr, 8)?;
        let edim = read_u32_le(&ehdr, 12)? as usize;
        let embed_row_stride = u64::from(read_u32_le(&ehdr, 16)?);
        if edim != M2V_DIM || embed_row_stride != (4 + M2V_DIM) as u64 {
            return None;
        }
        let expected_ef =
            64u64.checked_add(u64::from(embed_vocab_size).checked_mul(embed_row_stride)?)?;
        if expected_ef > ef_len {
            return None;
        }

        // 3. Validate & load skill_vecs.bin (M2VS0001)
        let sraw = std::fs::read(&skill_path).ok()?;
        if sraw.len() < 64 || &sraw[0..8] != b"M2VS0001" {
            return None;
        }
        let num_skills = read_u32_le(&sraw, 8)? as usize;
        let sdim = read_u32_le(&sraw, 12)? as usize;
        let sstride = read_u32_le(&sraw, 16)? as usize;
        let meta_offset = read_u32_le(&sraw, 20)? as usize;
        if num_skills > MAX_SKILL_ROWS
            || sdim != M2V_DIM
            || sstride != 4 + M2V_DIM
            || meta_offset > sraw.len()
        {
            return None;
        }
        let mat_end = 64usize.checked_add(num_skills.checked_mul(sstride)?)?;
        if mat_end > meta_offset {
            return None;
        }

        let mut skill_rows = Vec::with_capacity(num_skills);
        let mut key_to_idx = HashMap::with_capacity(num_skills.saturating_mul(2));
        let mut slug_to_idx = HashMap::with_capacity(num_skills.saturating_mul(2));
        let mut cur = meta_offset;

        for i in 0..num_skills {
            let row_off = 64 + i * sstride;
            let scale = read_f32_le(&sraw, row_off)?;
            if !scale.is_finite() || scale < 0.0 {
                return None;
            }
            let mut q = [0i8; M2V_DIM];
            let q_slice = sraw.get(row_off + 4..row_off + 4 + M2V_DIM)?;
            for (dst, &byte) in q.iter_mut().zip(q_slice.iter()) {
                *dst = byte as i8;
            }

            let klen = usize::from(read_u16_le(&sraw, cur)?);
            cur = cur.checked_add(2)?;
            let dedup_key = std::str::from_utf8(sraw.get(cur..cur.checked_add(klen)?)?)
                .ok()?
                .to_string();
            cur = cur.checked_add(klen)?;

            let slen = usize::from(read_u16_le(&sraw, cur)?);
            cur = cur.checked_add(2)?;
            let slug = std::str::from_utf8(sraw.get(cur..cur.checked_add(slen)?)?)
                .ok()?
                .to_string();
            cur = cur.checked_add(slen)?;

            let clen = usize::from(read_u16_le(&sraw, cur)?);
            cur = cur.checked_add(2)?;
            let category_id = std::str::from_utf8(sraw.get(cur..cur.checked_add(clen)?)?)
                .ok()?
                .to_string();
            cur = cur.checked_add(clen)?.checked_add(2)?; // tier + source_kind bytes
            if cur > sraw.len() {
                return None;
            }

            key_to_idx.insert(dedup_key.clone(), i);
            slug_to_idx.entry(slug.clone()).or_insert(i);
            skill_rows.push(SkillVecRow {
                scale,
                q,
                dedup_key,
                slug,
                category_id,
            });
        }

        Some(Self {
            vocab_file: Mutex::new(vf),
            vocab_file_len: vf_len,
            embed_file: Mutex::new(ef),
            num_buckets,
            bloom_bits: (bloom_bytes as u64) * 8,
            bloom,
            bucket_offsets,
            payload_offset,
            max_piece_bytes,
            unk_id,
            embed_vocab_size,
            embed_row_stride,
            skill_rows,
            key_to_idx,
            slug_to_idx,
        })
    }

    #[must_use]
    pub fn num_skills(&self) -> usize {
        self.skill_rows.len()
    }

    #[must_use]
    pub fn lookup_skill_index(&self, dedup_key: &str, slug: &str) -> Option<usize> {
        self.key_to_idx
            .get(dedup_key)
            .copied()
            .or_else(|| self.slug_to_idx.get(slug).copied())
    }

    #[must_use]
    pub fn skill_slug_at(&self, idx: usize) -> Option<&str> {
        self.skill_rows.get(idx).map(|r| r.slug.as_str())
    }

    #[must_use]
    pub fn skill_category_id_at(&self, idx: usize) -> Option<&str> {
        self.skill_rows.get(idx).map(|r| r.category_id.as_str())
    }

    #[inline]
    fn bloom_might_contain(&self, h1: u64, h2: u64) -> bool {
        let mask = self.bloom_bits - 1;
        for k in 0..BLOOM_K {
            let bit = (h1.wrapping_add((k as u64).wrapping_mul(h2))) & mask;
            let byte = self.bloom[(bit >> 3) as usize];
            if (byte & (1u8 << (bit & 7))) == 0 {
                return false;
            }
        }
        true
    }

    fn lookup_piece_with_file<'a>(
        &'a self,
        vf: &mut Option<std::sync::MutexGuard<'a, File>>,
        piece_bytes: &[u8],
        local_cache: &mut HashMap<Vec<u8>, Option<(u32, f32)>>,
        bucket_buf: &mut Vec<u8>,
    ) -> Option<(u32, f32)> {
        if piece_bytes.is_empty() || piece_bytes.len() > self.max_piece_bytes {
            return None;
        }
        if let Some(&cached) = local_cache.get(piece_bytes) {
            return cached;
        }
        let (h1, h2) = piece_hashes(piece_bytes);
        if !self.bloom_might_contain(h1, h2) {
            return None;
        }
        let b_idx = (h1 as usize) & (self.num_buckets - 1);
        let b_start = u64::from(self.bucket_offsets[b_idx]);
        let b_end = u64::from(self.bucket_offsets[b_idx + 1]);
        if b_end <= b_start {
            local_cache.insert(piece_bytes.to_vec(), None);
            return None;
        }
        let blen_u64 = b_end - b_start;
        if blen_u64 > MAX_BUCKET_LEN
            || self.payload_offset.saturating_add(b_end) > self.vocab_file_len
        {
            return None;
        }
        let blen = blen_u64 as usize;
        bucket_buf.resize(blen, 0);
        if vf.is_none() {
            *vf = self.vocab_file.lock().ok();
        }
        let guard = vf.as_mut()?;
        if guard
            .seek(SeekFrom::Start(self.payload_offset + b_start))
            .is_err()
            || guard.read_exact(bucket_buf).is_err()
        {
            return None;
        }

        let mut cur = 0usize;
        let mut found = None;
        while cur + 10 <= blen {
            let tid = read_u32_le(bucket_buf, cur)?;
            let lp = read_f32_le(bucket_buf, cur + 4)?;
            let plen = usize::from(read_u16_le(bucket_buf, cur + 8)?);
            cur += 10;
            if cur + plen > blen {
                break;
            }
            if plen == piece_bytes.len() && &bucket_buf[cur..cur + plen] == piece_bytes {
                found = Some((tid, lp));
                break;
            }
            cur += plen;
        }
        local_cache.insert(piece_bytes.to_vec(), found);
        found
    }

    /// Bloom-accelerated SentencePiece Unigram Viterbi tokenizer over `m2v_vocab.bin`.
    #[must_use]
    pub fn tokenize(&self, text: &str) -> Vec<u32> {
        let norm = normalize_for_m2v(text);
        if norm.is_empty() {
            return Vec::new();
        }
        let mut token_ids = Vec::with_capacity(32);
        let mut local_cache: HashMap<Vec<u8>, Option<(u32, f32)>> = HashMap::with_capacity(64);
        let mut bucket_buf: Vec<u8> = Vec::with_capacity(512);
        let mut seg = String::with_capacity(64);
        let mut char_bounds: Vec<usize> = Vec::with_capacity(48);
        let mut vf_guard: Option<std::sync::MutexGuard<'_, File>> = None;

        for word in norm.split(' ') {
            if word.is_empty() {
                continue;
            }
            if token_ids.len() >= MAX_ENCODE_TOKENS {
                break;
            }
            seg.clear();
            seg.push('\u{2581}');
            seg.push_str(word);

            if seg.len() <= self.max_piece_bytes {
                if let Some((tid, _)) = self.lookup_piece_with_file(
                    &mut vf_guard,
                    seg.as_bytes(),
                    &mut local_cache,
                    &mut bucket_buf,
                ) {
                    if tid != 0 && tid != 1 && tid != self.unk_id {
                        token_ids.push(tid);
                    }
                    continue;
                }
            }

            char_bounds.clear();
            for (bidx, _) in seg.char_indices() {
                char_bounds.push(bidx);
            }
            char_bounds.push(seg.len());
            let n = char_bounds.len() - 1;
            let seg_bytes = seg.as_bytes();

            const NEG_INF: f32 = -1e30;
            let mut best_score = vec![NEG_INF; n + 1];
            let mut best_prev = vec![usize::MAX; n + 1];
            let mut best_tid = vec![self.unk_id; n + 1];
            best_score[0] = 0.0;

            for i in 0..n {
                if best_score[i] <= NEG_INF * 0.5 {
                    continue;
                }
                let start_b = char_bounds[i];
                let mut matched_any = false;
                for j in (i + 1)..=n {
                    let end_b = char_bounds[j];
                    if end_b - start_b > self.max_piece_bytes {
                        break;
                    }
                    if let Some((tid, lp)) = self.lookup_piece_with_file(
                        &mut vf_guard,
                        &seg_bytes[start_b..end_b],
                        &mut local_cache,
                        &mut bucket_buf,
                    ) {
                        let cand = best_score[i] + lp;
                        if cand > best_score[j] {
                            best_score[j] = cand;
                            best_prev[j] = i;
                            best_tid[j] = tid;
                        }
                        matched_any = true;
                    }
                }
                if !matched_any {
                    let cand = best_score[i] - 20.0;
                    if cand > best_score[i + 1] {
                        best_score[i + 1] = cand;
                        best_prev[i + 1] = i;
                        best_tid[i + 1] = self.unk_id;
                    }
                }
            }

            let mut seg_ids: Vec<u32> = Vec::with_capacity(4);
            let mut pos = n;
            while pos > 0 {
                let prev = best_prev[pos];
                if prev == usize::MAX {
                    break;
                }
                let tid = best_tid[pos];
                if tid != 0 && tid != 1 && tid != self.unk_id {
                    seg_ids.push(tid);
                }
                pos = prev;
            }
            seg_ids.reverse();
            let rem = MAX_ENCODE_TOKENS.saturating_sub(token_ids.len());
            token_ids.extend_from_slice(&seg_ids[..seg_ids.len().min(rem)]);
        }
        token_ids
    }

    /// Encodes a Vietnamese/English query via sorted seek-read `int8` dequantization,
    /// mean pooling, and L2 normalization.
    #[must_use]
    pub fn encode_query(&self, text: &str) -> Option<[f32; M2V_DIM]> {
        let capped = if text.len() > MAX_ENCODE_QUERY_BYTES {
            let mut end = MAX_ENCODE_QUERY_BYTES;
            while end > 0 && !text.is_char_boundary(end) {
                end -= 1;
            }
            if let Some(ws) = text[..end].rfind(char::is_whitespace) {
                if ws >= 64 {
                    &text[..ws]
                } else {
                    &text[..end]
                }
            } else {
                &text[..end]
            }
        } else {
            text
        };

        let tids = self.tokenize(capped);
        if tids.is_empty() {
            return None;
        }
        let mut counts: HashMap<u32, f32> = HashMap::with_capacity(tids.len());
        for tid in tids {
            if tid < self.embed_vocab_size {
                *counts.entry(tid).or_insert(0.0) += 1.0;
            }
        }
        if counts.is_empty() {
            return None;
        }

        let mut sorted_counts: Vec<(u32, f32)> = counts.into_iter().collect();
        sorted_counts.sort_unstable_by_key(|&(tid, _)| tid);

        let mut acc = [0.0f32; M2V_DIM];
        let mut row_buf = [0u8; 4 + M2V_DIM];
        if let Ok(mut ef) = self.embed_file.lock() {
            for (tid, mult) in sorted_counts {
                let off = 64u64 + u64::from(tid) * self.embed_row_stride;
                if ef.seek(SeekFrom::Start(off)).is_err() || ef.read_exact(&mut row_buf).is_err() {
                    continue;
                }
                let Some(raw_scale) = read_f32_le(&row_buf, 0) else {
                    continue;
                };
                if !raw_scale.is_finite() {
                    continue;
                }
                let scale = raw_scale * mult;
                if scale == 0.0 {
                    continue;
                }
                let mut j = 0usize;
                while j < M2V_DIM {
                    acc[j] += f32::from(row_buf[4 + j] as i8) * scale;
                    acc[j + 1] += f32::from(row_buf[5 + j] as i8) * scale;
                    acc[j + 2] += f32::from(row_buf[6 + j] as i8) * scale;
                    acc[j + 3] += f32::from(row_buf[7 + j] as i8) * scale;
                    j += 4;
                }
            }
        }

        let norm_sq: f32 = acc.iter().map(|&x| x * x).sum();
        if !norm_sq.is_finite() || norm_sq <= 1e-12 {
            return None;
        }
        let inv = 1.0 / norm_sq.sqrt();
        for x in &mut acc {
            *x *= inv;
        }
        Some(acc)
    }

    /// Scores every skill row in `skill_vecs.bin` against a unit-normalized query vector
    /// using an unrolled `i32` quantized dot product.
    #[must_use]
    pub fn score_skill_matrix(&self, q_vec: &[f32; M2V_DIM]) -> Vec<f32> {
        let mut max_abs = 0.0f32;
        for &v in q_vec {
            let a = v.abs();
            if a > max_abs {
                max_abs = a;
            }
        }
        if !max_abs.is_finite() || max_abs <= 1e-12 {
            return vec![0.0; self.skill_rows.len()];
        }
        let q_scale = max_abs / 127.0;
        let inv_q = 127.0 / max_abs;
        let mut q_i8 = [0i8; M2V_DIM];
        for (dst, &v) in q_i8.iter_mut().zip(q_vec.iter()) {
            *dst = (v * inv_q).round().clamp(-127.0, 127.0) as i8;
        }

        let mut scores = Vec::with_capacity(self.skill_rows.len());
        for row in &self.skill_rows {
            if row.scale == 0.0 {
                scores.push(0.0);
                continue;
            }
            let rq = &row.q;
            let mut s0 = 0i32;
            let mut s1 = 0i32;
            let mut s2 = 0i32;
            let mut s3 = 0i32;
            let mut s4 = 0i32;
            let mut s5 = 0i32;
            let mut s6 = 0i32;
            let mut s7 = 0i32;
            let mut j = 0usize;
            while j < M2V_DIM {
                s0 += i32::from(q_i8[j]) * i32::from(rq[j])
                    + i32::from(q_i8[j + 8]) * i32::from(rq[j + 8]);
                s1 += i32::from(q_i8[j + 1]) * i32::from(rq[j + 1])
                    + i32::from(q_i8[j + 9]) * i32::from(rq[j + 9]);
                s2 += i32::from(q_i8[j + 2]) * i32::from(rq[j + 2])
                    + i32::from(q_i8[j + 10]) * i32::from(rq[j + 10]);
                s3 += i32::from(q_i8[j + 3]) * i32::from(rq[j + 3])
                    + i32::from(q_i8[j + 11]) * i32::from(rq[j + 11]);
                s4 += i32::from(q_i8[j + 4]) * i32::from(rq[j + 4])
                    + i32::from(q_i8[j + 12]) * i32::from(rq[j + 12]);
                s5 += i32::from(q_i8[j + 5]) * i32::from(rq[j + 5])
                    + i32::from(q_i8[j + 13]) * i32::from(rq[j + 13]);
                s6 += i32::from(q_i8[j + 6]) * i32::from(rq[j + 6])
                    + i32::from(q_i8[j + 14]) * i32::from(rq[j + 14]);
                s7 += i32::from(q_i8[j + 7]) * i32::from(rq[j + 7])
                    + i32::from(q_i8[j + 15]) * i32::from(rq[j + 15]);
                j += 16;
            }
            let dot = (s0 + s1 + s2 + s3 + s4 + s5 + s6 + s7) as f32;
            scores.push((dot * q_scale * row.scale).clamp(-1.0, 1.0));
        }
        scores
    }

    /// Encodes `query` and returns up to `top_k` skills sorted descending by dense cosine similarity.
    #[must_use]
    pub fn top_skills(&self, query: &str, top_k: usize) -> Vec<M2vSkillHit> {
        if top_k == 0 || query.trim().is_empty() {
            return Vec::new();
        }
        let Some(q_vec) = self.encode_query(query) else {
            return Vec::new();
        };
        let scores = self.score_skill_matrix(&q_vec);
        let mut hits: Vec<M2vSkillHit> = self
            .skill_rows
            .iter()
            .zip(scores)
            .map(|(row, cosine)| M2vSkillHit {
                slug: row.slug.clone(),
                dedup_key: row.dedup_key.clone(),
                category_id: row.category_id.clone(),
                cosine,
            })
            .collect();
        hits.sort_by(|a, b| {
            b.cosine
                .total_cmp(&a.cosine)
                .then_with(|| a.slug.cmp(&b.slug))
        });
        hits.truncate(top_k);
        hits
    }

    /// Encodes `query` and returns a `slug -> max_cosine` map across all indexed skills.
    #[must_use]
    pub fn score_map_by_slug(&self, query: &str) -> HashMap<String, f32> {
        let Some(q_vec) = self.encode_query(query) else {
            return HashMap::new();
        };
        let scores = self.score_skill_matrix(&q_vec);
        let mut map: HashMap<String, f32> = HashMap::with_capacity(self.skill_rows.len());
        for (row, cos) in self.skill_rows.iter().zip(scores) {
            map.entry(row.slug.clone())
                .and_modify(|prev| {
                    if cos > *prev {
                        *prev = cos;
                    }
                })
                .or_insert(cos);
        }
        map
    }
}

/// Test-only / fixture builder helper for compiling minimal valid `M2VV0001`/`M2VE0001`/`M2VS0001`
/// files on disk (used by unit tests in `m2v_router` and `skill_registry`).
#[cfg(test)]
pub(crate) fn write_synthetic_m2v_fixture(
    dir: &Path,
    vocab_pieces: &[(&str, u32, f32)],
    token_vecs: &[(u32, [f32; M2V_DIM])],
    skills: &[(&str, &str, [f32; M2V_DIM])],
) -> std::io::Result<()> {
    use std::io::Write;
    std::fs::create_dir_all(dir)?;

    let num_buckets: usize = 16;
    let bloom_bytes: usize = 64;
    let bloom_bits = (bloom_bytes as u64) * 8;
    let mut bloom = vec![0u8; bloom_bytes];
    let mut buckets: Vec<Vec<u8>> = vec![Vec::new(); num_buckets];

    for &(piece, tid, lp) in vocab_pieces {
        let pb = piece.as_bytes();
        let (h1, h2) = piece_hashes(pb);
        let mask = bloom_bits - 1;
        for k in 0..BLOOM_K {
            let bit = (h1.wrapping_add((k as u64).wrapping_mul(h2))) & mask;
            bloom[(bit >> 3) as usize] |= 1u8 << (bit & 7);
        }
        let b_idx = (h1 as usize) & (num_buckets - 1);
        let entry = &mut buckets[b_idx];
        entry.extend_from_slice(&tid.to_le_bytes());
        entry.extend_from_slice(&lp.to_le_bytes());
        entry.extend_from_slice(&(pb.len() as u16).to_le_bytes());
        entry.extend_from_slice(pb);
    }

    let mut offsets: Vec<u32> = Vec::with_capacity(num_buckets + 1);
    let mut payload = Vec::new();
    for b in &buckets {
        offsets.push(payload.len() as u32);
        payload.extend_from_slice(b);
    }
    offsets.push(payload.len() as u32);
    let payload_offset = (64 + bloom_bytes + (num_buckets + 1) * 4) as u32;

    let mut vhdr = [0u8; 64];
    vhdr[0..8].copy_from_slice(b"M2VV0001");
    vhdr[12..16].copy_from_slice(&(num_buckets as u32).to_le_bytes());
    vhdr[16..20].copy_from_slice(&(bloom_bytes as u32).to_le_bytes());
    vhdr[20..24].copy_from_slice(&0u32.to_le_bytes()); // unk_id
    vhdr[24..28].copy_from_slice(&64u32.to_le_bytes()); // max_piece_bytes
    vhdr[28..32].copy_from_slice(&(M2V_DIM as u32).to_le_bytes());
    vhdr[36..40].copy_from_slice(&payload_offset.to_le_bytes());

    let mut vf = File::create(dir.join("m2v_vocab.bin"))?;
    vf.write_all(&vhdr)?;
    vf.write_all(&bloom)?;
    for off in &offsets {
        vf.write_all(&off.to_le_bytes())?;
    }
    vf.write_all(&payload)?;

    // Write m2v_embed.bin
    let max_tid = token_vecs.iter().map(|(t, _)| *t).max().unwrap_or(1) + 1;
    let vocab_size = max_tid.max(4);
    let stride = (4 + M2V_DIM) as u32;
    let mut ehdr = [0u8; 64];
    ehdr[0..8].copy_from_slice(b"M2VE0001");
    ehdr[8..12].copy_from_slice(&vocab_size.to_le_bytes());
    ehdr[12..16].copy_from_slice(&(M2V_DIM as u32).to_le_bytes());
    ehdr[16..20].copy_from_slice(&stride.to_le_bytes());

    let mut ef = File::create(dir.join("m2v_embed.bin"))?;
    ef.write_all(&ehdr)?;
    let vec_map: HashMap<u32, [f32; M2V_DIM]> = token_vecs.iter().copied().collect();
    for tid in 0..vocab_size {
        if let Some(v) = vec_map.get(&tid) {
            let (scale, q) = quantize_row(v);
            ef.write_all(&scale.to_le_bytes())?;
            let bytes: [u8; M2V_DIM] = q.map(|x| x as u8);
            ef.write_all(&bytes)?;
        } else {
            ef.write_all(&[0u8; 4 + M2V_DIM])?;
        }
    }

    // Write skill_vecs.bin
    let meta_offset = (64 + skills.len() * (4 + M2V_DIM)) as u32;
    let mut shdr = [0u8; 64];
    shdr[0..8].copy_from_slice(b"M2VS0001");
    shdr[8..12].copy_from_slice(&(skills.len() as u32).to_le_bytes());
    shdr[12..16].copy_from_slice(&(M2V_DIM as u32).to_le_bytes());
    shdr[16..20].copy_from_slice(&stride.to_le_bytes());
    shdr[20..24].copy_from_slice(&meta_offset.to_le_bytes());

    let mut sf = File::create(dir.join("skill_vecs.bin"))?;
    sf.write_all(&shdr)?;
    for (_, _, v) in skills {
        let (scale, q) = quantize_row(v);
        sf.write_all(&scale.to_le_bytes())?;
        let bytes: [u8; M2V_DIM] = q.map(|x| x as u8);
        sf.write_all(&bytes)?;
    }
    for (slug, cat_id, _) in skills {
        let key = format!("omnia:{slug}");
        sf.write_all(&(key.len() as u16).to_le_bytes())?;
        sf.write_all(key.as_bytes())?;
        sf.write_all(&(slug.len() as u16).to_le_bytes())?;
        sf.write_all(slug.as_bytes())?;
        sf.write_all(&(cat_id.len() as u16).to_le_bytes())?;
        sf.write_all(cat_id.as_bytes())?;
        sf.write_all(&[1u8, 0u8])?;
    }
    Ok(())
}

#[cfg(test)]
fn quantize_row(v: &[f32; M2V_DIM]) -> (f32, [i8; M2V_DIM]) {
    let norm_sq: f32 = v.iter().map(|x| x * x).sum();
    if norm_sq <= 1e-12 {
        return (0.0, [0i8; M2V_DIM]);
    }
    let inv = 1.0 / norm_sq.sqrt();
    let mut unit = [0.0f32; M2V_DIM];
    let mut max_abs = 0.0f32;
    for (u, &x) in unit.iter_mut().zip(v.iter()) {
        *u = x * inv;
        max_abs = max_abs.max(u.abs());
    }
    let scale = max_abs / 127.0;
    let inv_s = if max_abs > 1e-12 { 127.0 / max_abs } else { 0.0 };
    let mut q = [0i8; M2V_DIM];
    for (dst, &u) in q.iter_mut().zip(unit.iter()) {
        *dst = (u * inv_s).round().clamp(-127.0, 127.0) as i8;
    }
    (scale, q)
}

#[cfg(test)]
mod tests {
    use super::*;
    use omnia_core::uuid_v4;

    fn basis_vec(axis: usize) -> [f32; M2V_DIM] {
        let mut v = [0.0f32; M2V_DIM];
        v[axis % M2V_DIM] = 1.0;
        v
    }

    #[test]
    fn compose_vn_nfc_handles_both_combining_orders() {
        // Modifier-first: a + circumflex + acute -> ấ
        assert_eq!(compose_vn_nfc("a\u{0302}\u{0301}"), "ấ");
        // Tone-first: a + acute + circumflex -> ấ
        assert_eq!(compose_vn_nfc("a\u{0301}\u{0302}"), "ấ");
        // Horn + dot below: o + horn + dot -> ợ
        assert_eq!(compose_vn_nfc("o\u{031B}\u{0323}"), "ợ");
        assert_eq!(compose_vn_nfc("plain ascii"), "plain ascii");
    }

    #[test]
    fn synthetic_m2v_binary_roundtrip_seek_tokenize_and_score() {
        let dir = std::env::temp_dir().join(format!("omnia-m2v-rt-{}", uuid_v4()));
        let v_research = basis_vec(1);
        let v_think = basis_vec(2);
        write_synthetic_m2v_fixture(
            &dir,
            &[
                ("\u{2581}nghiên", 2, -1.0),
                ("\u{2581}cứu", 3, -1.0),
                ("\u{2581}reasoning", 4, -1.0),
            ],
            &[(2, v_research), (3, v_research), (4, v_think)],
            &[
                ("deep-research", "01", v_research),
                ("deep-think", "02", v_think),
            ],
        )
        .unwrap();

        let eng = M2vSeekEngine::load(&dir).expect("synthetic M2V must load");
        assert_eq!(eng.num_skills(), 2);
        assert_eq!(eng.lookup_skill_index("omnia:deep-research", "deep-research"), Some(0));
        assert_eq!(eng.skill_slug_at(1), Some("deep-think"));
        assert_eq!(eng.skill_category_id_at(1), Some("02"));

        // NFD Vietnamese query composes to NFC and finds deep-research with ~1.0 cosine.
        let nfd_vn = "nghie\u{0302}n cu\u{031B}\u{0301}u";
        let hits = eng.top_skills(nfd_vn, 2);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].slug, "deep-research");
        assert!(hits[0].cosine > 0.95, "expected high cosine, got {}", hits[0].cosine);
        assert!(hits[1].cosine.abs() < 0.05);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_and_missing_m2v_files_degrade_gracefully_without_panic() {
        let missing = std::env::temp_dir().join(format!("omnia-m2v-missing-{}", uuid_v4()));
        assert!(M2vSeekEngine::load(&missing).is_none());

        let corrupt = std::env::temp_dir().join(format!("omnia-m2v-corrupt-{}", uuid_v4()));
        std::fs::create_dir_all(&corrupt).unwrap();
        // Huge fake bucket count / bloom bytes -> must fail bounds check without allocating!
        let mut bad_vocab = [0u8; 64];
        bad_vocab[0..8].copy_from_slice(b"M2VV0001");
        bad_vocab[12..16].copy_from_slice(&u32::MAX.to_le_bytes());
        bad_vocab[16..20].copy_from_slice(&u32::MAX.to_le_bytes());
        bad_vocab[28..32].copy_from_slice(&(M2V_DIM as u32).to_le_bytes());
        std::fs::write(corrupt.join("m2v_vocab.bin"), bad_vocab).unwrap();
        std::fs::write(corrupt.join("m2v_embed.bin"), [0u8; 64]).unwrap();
        std::fs::write(corrupt.join("skill_vecs.bin"), [0u8; 64]).unwrap();

        assert!(M2vSeekEngine::load(&corrupt).is_none());
        let _ = std::fs::remove_dir_all(&corrupt);
    }

    #[test]
    fn live_default_m2v_model_smoke_if_present() {
        if let Some(eng) = M2vSeekEngine::load_default() {
            assert!(eng.num_skills() > 0);
            let hits = eng.top_skills("nghiên cứu khoa học citation pdf", 5);
            assert!(!hits.is_empty());
            assert!(hits[0].cosine.is_finite());
        }
    }
}

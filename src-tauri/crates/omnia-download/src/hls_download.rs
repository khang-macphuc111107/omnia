//! HLS downloading: concurrent segment fetch, AES-128 decryption, ordered concat output,
//! live playlist polling.

use crate::error::{DownloadError, Result};
use crate::fetch::Fetcher;
use crate::hls::{
    audio_rendition_for, parse_playlist, segment_iv, select_variant, HlsKey, HlsMap, HlsPlaylist,
    HlsSegment,
};
use crate::types::Quality;
use aes::Aes128;
use bytes::Bytes;
use cbc::cipher::{block_padding::Pkcs7, BlockModeDecrypt, KeyIvInit};
use futures_util::StreamExt;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;
use url::Url;

#[derive(Clone, Debug)]
pub struct StreamOptions {
    /// Concurrent segment downloads.
    pub concurrency: usize,
    /// Live playlists: poll interval override (default: target duration / 2, 1..10 s).
    pub live_poll_interval: Option<Duration>,
    /// Cancelling this token ends a live capture gracefully (everything fetched so far is kept).
    pub live_stop: CancellationToken,
}

impl Default for StreamOptions {
    fn default() -> Self {
        Self {
            concurrency: 6,
            live_poll_interval: None,
            live_stop: CancellationToken::new(),
        }
    }
}

/// Raw per-track output files, ready for muxing / moving into place.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StreamOutput {
    pub video: PathBuf,
    pub audio: Option<PathBuf>,
    /// The main track is fragmented MP4 (has an init map) rather than MPEG-TS.
    pub fmp4: bool,
}

type KeyCache = Arc<Mutex<HashMap<String, Arc<Vec<u8>>>>>;

/// AES-128-CBC (PKCS#7) decrypt.
pub fn decrypt_aes128(data: &[u8], key: &[u8], iv: &[u8; 16]) -> Result<Vec<u8>> {
    let dec = cbc::Decryptor::<Aes128>::new_from_slices(key, iv)
        .map_err(|e| DownloadError::Parse(format!("bad AES key/IV: {e}")))?;
    dec.decrypt_padded_vec::<Pkcs7>(data)
        .map_err(|_| DownloadError::Parse("AES-128 decryption failed (bad padding)".into()))
}

async fn get_key(f: &Fetcher, cache: &KeyCache, key: &HlsKey) -> Result<Arc<Vec<u8>>> {
    let mut guard = cache.lock().await;
    if let Some(k) = guard.get(&key.url) {
        return Ok(k.clone());
    }
    let bytes = f.get(&key.url, None).await?;
    if bytes.len() != 16 {
        return Err(DownloadError::Parse(format!(
            "AES-128 key must be 16 bytes, got {}",
            bytes.len()
        )));
    }
    let k = Arc::new(bytes.to_vec());
    guard.insert(key.url.clone(), k.clone());
    Ok(k)
}

async fn fetch_segment(f: Fetcher, keys: KeyCache, seg: HlsSegment) -> Result<(HlsSegment, Bytes)> {
    let data = f.get(&seg.url, seg.byte_range).await?;
    let data = match &seg.key {
        Some(k) => {
            let key = get_key(&f, &keys, k).await?;
            Bytes::from(decrypt_aes128(&data, &key, &segment_iv(k, seg.sequence))?)
        }
        None => data,
    };
    Ok((seg, data))
}

async fn fetch_init(
    f: &Fetcher,
    keys: &KeyCache,
    map: &HlsMap,
    key: Option<&HlsKey>,
    seq: u64,
) -> Result<Bytes> {
    let data = f.get(&map.url, map.byte_range).await?;
    match key {
        Some(k) => {
            let kb = get_key(f, keys, k).await?;
            Ok(Bytes::from(decrypt_aes128(
                &data,
                &kb,
                &segment_iv(k, seq),
            )?))
        }
        None => Ok(data),
    }
}

/// Fetch the playlist repeatedly, forwarding unseen segments (de-duplicated by media sequence)
/// until `#EXT-X-ENDLIST`, user stop or cancellation.
async fn poll_playlist(
    f: Fetcher,
    url: Url,
    tx: mpsc::Sender<HlsSegment>,
    opts: StreamOptions,
) -> Result<()> {
    let mut next_seq = 0u64;
    let mut first = true;
    let mut failures = 0u32;
    loop {
        let parsed = match f.get_text(url.as_str()).await {
            Ok(text) => parse_playlist(&text, &url),
            Err(e) => Err(e),
        };
        let media = match parsed {
            Ok(HlsPlaylist::Media(m)) => {
                failures = 0;
                m
            }
            Ok(HlsPlaylist::Master(_)) => {
                return Err(DownloadError::Unsupported(
                    "expected a media playlist, got a master playlist".into(),
                ))
            }
            Err(e @ (DownloadError::Cancelled | DownloadError::DrmProtected(_))) => return Err(e),
            Err(e) => {
                failures += 1;
                if first || failures >= 3 {
                    return Err(e);
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
        };
        first = false;
        let fresh: Vec<HlsSegment> = media
            .segments
            .into_iter()
            .filter(|s| s.sequence >= next_seq)
            .collect();
        if let Some(t) = &f.tracker {
            t.add_segments_total(fresh.len() as u32);
        }
        for seg in fresh {
            next_seq = next_seq.max(seg.sequence + 1);
            if tx.send(seg).await.is_err() {
                return Ok(()); // consumer finished (error/cancel)
            }
        }
        if media.end_list {
            return Ok(());
        }
        let wait = opts.live_poll_interval.unwrap_or_else(|| {
            Duration::from_secs_f64((media.target_duration / 2.0).clamp(1.0, 10.0))
        });
        tokio::select! {
            _ = f.cancel.cancelled() => return Err(DownloadError::Cancelled),
            _ = opts.live_stop.cancelled() => return Ok(()),
            _ = tokio::time::sleep(wait) => {}
        }
    }
}

/// Download one media playlist into `<out_base>.ts` or `<out_base>.mp4` (when it has an init map).
/// Returns `(path, is_fmp4)`.
async fn download_media_playlist(
    f: &Fetcher,
    url: &Url,
    out_base: &Path,
    opts: &StreamOptions,
    audio_only: bool,
) -> Result<(PathBuf, bool)> {
    let tmp = crate::fsutil::with_suffix(out_base, ".part");
    let mut file = tokio::fs::File::create(&tmp).await?;
    let (tx, rx) = mpsc::channel::<HlsSegment>(256);
    let poller = tokio::spawn(poll_playlist(f.clone(), url.clone(), tx, opts.clone()));
    let keys: KeyCache = Arc::new(Mutex::new(HashMap::new()));

    let source =
        futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|s| (s, rx)) });
    let fetcher = f.clone();
    let keys2 = keys.clone();
    let mut fetched = Box::pin(
        source
            .map(move |seg| fetch_segment(fetcher.clone(), keys2.clone(), seg))
            .buffered(opts.concurrency.max(1)),
    );

    let mut last_map: Option<HlsMap> = None;
    let mut fmp4 = false;
    let mut write_err: Option<DownloadError> = None;
    while let Some(item) = fetched.next().await {
        let step: Result<()> = async {
            let (seg, data) = item?;
            if seg.map != last_map {
                if let Some(m) = &seg.map {
                    let init = fetch_init(f, &keys, m, seg.key.as_ref(), seg.sequence).await?;
                    file.write_all(&init).await?;
                    fmp4 = true;
                }
                last_map = seg.map.clone();
            }
            file.write_all(&data).await?;
            if let Some(t) = &f.tracker {
                t.segment_done();
            }
            Ok(())
        }
        .await;
        if let Err(e) = step {
            write_err = Some(e);
            break;
        }
    }
    drop(fetched);
    if let Some(e) = write_err {
        poller.abort();
        return Err(e);
    }
    match poller.await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(e),
        Err(e) => return Err(DownloadError::Other(format!("playlist poller failed: {e}"))),
    }
    file.flush().await?;
    drop(file);
    let ext = match (fmp4, audio_only) {
        (true, true) => "m4a",
        (true, false) => "mp4",
        (false, _) => "ts",
    };
    let out = crate::fsutil::with_suffix(out_base, &format!(".{ext}"));
    crate::fsutil::move_file(&tmp, &out)?;
    Ok((out, fmp4))
}

/// Download an HLS stream (master or media playlist URL) into `work_dir`.
///
/// For master playlists a variant is chosen with `quality`; when it references an AUDIO group
/// whose rendition has its own playlist, the audio is downloaded as a second track.
pub async fn download_hls(
    f: &Fetcher,
    playlist_url: &str,
    quality: Quality,
    work_dir: &Path,
    opts: &StreamOptions,
) -> Result<StreamOutput> {
    tokio::fs::create_dir_all(work_dir).await?;
    let base = Url::parse(playlist_url)?;
    let text = f.get_text(playlist_url).await?;
    let (video_url, audio_url) = match parse_playlist(&text, &base)? {
        HlsPlaylist::Master(m) => {
            let v = select_variant(&m, quality)
                .ok_or_else(|| DownloadError::Parse("no variants".into()))?;
            let audio = audio_rendition_for(&m, v).and_then(|r| r.url.clone());
            (
                Url::parse(&v.url)?,
                audio.map(|a| Url::parse(&a)).transpose()?,
            )
        }
        HlsPlaylist::Media(_) => (base, None),
    };
    if let Some(t) = &f.tracker {
        t.set_connections(opts.concurrency as u32);
    }
    let video_base = work_dir.join("video");
    let audio_base = work_dir.join("audio");
    let video_fut = download_media_playlist(f, &video_url, &video_base, opts, false);
    match audio_url {
        Some(au) => {
            let audio_fut = download_media_playlist(f, &au, &audio_base, opts, true);
            let ((video, fmp4), (audio, _)) = tokio::try_join!(video_fut, audio_fut)?;
            Ok(StreamOutput {
                video,
                audio: Some(audio),
                fmp4,
            })
        }
        None => {
            let (video, fmp4) = video_fut.await?;
            Ok(StreamOutput {
                video,
                audio: None,
                fmp4,
            })
        }
    }
}

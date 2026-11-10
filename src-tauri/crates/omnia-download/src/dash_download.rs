//! DASH downloading: init + media segments per track into separate files.

use crate::dash::{parse_mpd, select_tracks, DashRepresentation, DashSegment};
use crate::error::{DownloadError, Result};
use crate::fetch::Fetcher;
use crate::fsutil::move_file;
use crate::hls_download::{StreamOptions, StreamOutput};
use crate::http::{download_http, HttpOptions};
use crate::types::Quality;
use futures_util::StreamExt;
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;
use url::Url;

fn extension(rep: &DashRepresentation) -> &'static str {
    let mime = rep.mime_type.as_deref().unwrap_or("");
    let audio = mime.starts_with("audio/");
    if mime.contains("webm") {
        "webm"
    } else if audio {
        "m4a"
    } else {
        "mp4"
    }
}

async fn download_track(
    f: &Fetcher,
    http: &HttpOptions,
    rep: &DashRepresentation,
    out_base: &Path,
    concurrency: usize,
) -> Result<PathBuf> {
    let out = crate::fsutil::with_suffix(out_base, &format!(".{}", extension(rep)));
    if rep.single_file {
        let tracker = f.tracker.clone().ok_or_else(|| {
            DownloadError::Other("single-file DASH tracks need a progress tracker".into())
        })?;
        let dir = out.parent().unwrap_or(Path::new("."));
        let name = out
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("track.mp4");
        let spec = f.spec.derive(&rep.segments[0].url);
        let done = download_http(
            &f.client,
            &spec,
            dir,
            Some(name),
            http,
            &f.cancel,
            &tracker,
            None,
        )
        .await?;
        if done.path != out {
            move_file(&done.path, &out)?;
        }
        return Ok(out);
    }

    let tmp = crate::fsutil::with_suffix(out_base, ".part");
    let mut file = tokio::fs::File::create(&tmp).await?;
    let items: Vec<DashSegment> = rep
        .init
        .iter()
        .chain(rep.segments.iter())
        .cloned()
        .collect();
    if let Some(t) = &f.tracker {
        t.add_segments_total(items.len() as u32);
        t.set_connections(concurrency as u32);
    }
    let fetcher = f.clone();
    let mut stream = Box::pin(
        futures_util::stream::iter(items)
            .map(move |seg| {
                let f = fetcher.clone();
                async move { f.get(&seg.url, seg.range).await }
            })
            .buffered(concurrency.max(1)),
    );
    while let Some(chunk) = stream.next().await {
        file.write_all(&chunk?).await?;
        if let Some(t) = &f.tracker {
            t.segment_done();
        }
    }
    drop(stream);
    file.flush().await?;
    drop(file);
    move_file(&tmp, &out)?;
    Ok(out)
}

/// Download the best video + audio representations of an MPD into `work_dir`.
pub async fn download_dash(
    f: &Fetcher,
    mpd_url: &str,
    quality: Quality,
    work_dir: &Path,
    opts: &StreamOptions,
    http: &HttpOptions,
) -> Result<StreamOutput> {
    tokio::fs::create_dir_all(work_dir).await?;
    let base = Url::parse(mpd_url)?;
    let text = f.get_text(mpd_url).await?;
    let manifest = parse_mpd(&text, &base)?;
    let (video, audio) = select_tracks(&manifest, quality);
    if video.is_none() && audio.is_none() {
        return Err(DownloadError::Unsupported(
            "MPD has no downloadable audio/video representation".into(),
        ));
    }
    let mut main: Option<PathBuf> = None;
    let mut second: Option<PathBuf> = None;
    if let Some(v) = video {
        main = Some(download_track(f, http, v, &work_dir.join("video"), opts.concurrency).await?);
    }
    if let Some(a) = audio {
        let p = download_track(f, http, a, &work_dir.join("audio"), opts.concurrency).await?;
        if main.is_none() {
            main = Some(p);
        } else {
            second = Some(p);
        }
    }
    Ok(StreamOutput {
        video: main.expect("at least one track"),
        audio: second,
        fmp4: true,
    })
}

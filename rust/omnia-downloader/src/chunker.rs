//! Unified 1–128 stream byte-range planner, `.part.meta` v2 interval arithmetic,
//! and dynamic midpoint work-stealing with `remainingForThisChunk` clamping.
//!
//! Integrates directly with `omnia_workspace_ops::range_downloader` while supporting
//! resumable gap planning across arbitrary chunk-count changes.

use std::path::Path;

use omnia_workspace_ops::range_downloader::{
    pick_largest_stealable_segment, plan_range_download_with_policy, split_largest_active_segment,
    ByteRangeSegment, RangeDownloadPlan,
};

use crate::types::{ChunkRange, DownloaderError, SecurityPolicy, MAX_STREAMS, MIN_STREAMS};

/// Unified multi-stream chunk planner and dynamic midpoint work-stealer.
pub struct Chunker;

impl Chunker {
    /// Delegates validated external staging & 1–128 contiguous planning to
    /// `omnia_workspace_ops::range_downloader::plan_range_download_with_policy`.
    pub fn plan_validated_range(
        url: &str,
        total_size: u64,
        requested_streams: usize,
        min_chunk_bytes: u64,
        staging_dir: &Path,
        workspace_root: &Path,
        policy: SecurityPolicy,
    ) -> Result<RangeDownloadPlan, DownloaderError> {
        plan_range_download_with_policy(
            url,
            total_size,
            requested_streams,
            min_chunk_bytes.max(1),
            staging_dir,
            workspace_root,
            policy.to_range_url_policy(),
        )
        .map_err(Into::into)
    }

    /// Plans `1..=128` contiguous inclusive [`ChunkRange`] segments covering `[0, total_size - 1]`.
    #[must_use]
    pub fn plan_initial_ranges(
        total_size: u64,
        desired_streams: usize,
        min_chunk_bytes: u64,
    ) -> Vec<ChunkRange> {
        if total_size == 0 {
            return Vec::new();
        }
        let min_chunk = min_chunk_bytes.max(1);
        let max_by_min = (total_size / min_chunk).max(1);
        let streams = (desired_streams.clamp(MIN_STREAMS, MAX_STREAMS) as u64)
            .min(max_by_min)
            .min(total_size)
            .max(1) as usize;

        let base = total_size / (streams as u64);
        let rem = total_size % (streams as u64);
        let mut chunks = Vec::with_capacity(streams);
        let mut cursor = 0u64;
        for idx in 0..streams {
            let extra = u64::from((idx as u64) < rem);
            let len = base + extra;
            let start = cursor;
            let end = cursor + len - 1;
            chunks.push(ChunkRange::new(idx, start, end));
            cursor = end + 1;
        }
        chunks
    }

    /// Converts an `omnia_workspace_ops::range_downloader::RangeDownloadPlan` into live [`ChunkRange`]s.
    #[must_use]
    pub fn chunks_from_plan(plan: &RangeDownloadPlan) -> Vec<ChunkRange> {
        plan.segments
            .iter()
            .map(|seg| ChunkRange::new(seg.segment_id, seg.start_byte, seg.end_byte))
            .collect()
    }

    /// Computes uncompleted gap intervals `[0, total_size - 1] \ completed_ranges` and partitions
    /// ONLY the remaining bytes across `desired_streams` (`1..=128`).
    ///
    /// Safe across arbitrary chunk-count changes between pause and resume (e.g. 4 -> 32 or 128 -> 2).
    #[must_use]
    pub fn plan_from_completed_intervals(
        total_size: u64,
        completed_ranges: &[(u64, u64)],
        desired_streams: usize,
        min_chunk_bytes: u64,
    ) -> Vec<ChunkRange> {
        if total_size == 0 {
            return Vec::new();
        }
        let normalized_done = normalize_completed_intervals(completed_ranges, total_size);
        let gaps = compute_missing_intervals(total_size, &normalized_done);
        if gaps.is_empty() {
            return Vec::new();
        }

        let target_streams = desired_streams.clamp(MIN_STREAMS, MAX_STREAMS);
        let min_chunk = min_chunk_bytes.max(1);
        let total_remaining: u64 = gaps.iter().map(|(s, e)| e - s + 1).sum();
        let max_chunks = (total_remaining / min_chunk).max(1).min(total_remaining) as usize;
        let effective_target = target_streams.min(max_chunks).max(1);

        // Allocate stream slices proportionally across gaps while guaranteeing >=1 slice per gap.
        let mut chunks = Vec::new();
        let mut next_id = 0usize;

        if gaps.len() >= effective_target {
            for (s, e) in gaps {
                chunks.push(ChunkRange::new(next_id, s, e));
                next_id += 1;
            }
            return chunks;
        }

        let mut remaining_budget = effective_target;
        for (idx, &(gap_start, gap_end)) in gaps.iter().enumerate() {
            let gap_len = gap_end - gap_start + 1;
            let gaps_left = gaps.len() - idx;
            let max_for_gap = (gap_len / min_chunk).max(1).min(gap_len) as usize;
            let share = if gaps_left == 1 {
                remaining_budget
            } else {
                let proportional =
                    ((gap_len as u128 * effective_target as u128) / total_remaining as u128) as usize;
                proportional
                    .max(1)
                    .min(remaining_budget.saturating_sub(gaps_left - 1))
            };
            let slices = share.clamp(1, max_for_gap);
            remaining_budget = remaining_budget.saturating_sub(slices).max(1);

            let base = gap_len / (slices as u64);
            let rem = gap_len % (slices as u64);
            let mut cursor = gap_start;
            for i in 0..slices {
                let extra = u64::from((i as u64) < rem);
                let len = base + extra;
                let end = cursor + len - 1;
                chunks.push(ChunkRange::new(next_id, cursor, end));
                next_id += 1;
                cursor = end + 1;
            }
        }

        chunks
    }

    /// Dynamic midpoint work-stealing using `omnia_workspace_ops::range_downloader` semantics:
    /// finds the active chunk with the largest remaining uncompleted tail `>= 2 * min_split_bytes`,
    /// shortens that victim's `end` to the midpoint, and appends a newly stolen [`ChunkRange`].
    pub fn steal_midpoint(
        chunks: &mut Vec<ChunkRange>,
        min_split_bytes: u64,
    ) -> Option<ChunkRange> {
        if min_split_bytes == 0 || chunks.len() >= MAX_STREAMS * 4 {
            return None;
        }
        let segments: Vec<ByteRangeSegment> = chunks
            .iter()
            .map(|c| ByteRangeSegment {
                segment_id: c.chunk_id,
                start_byte: c.start,
                end_byte: c.end,
            })
            .collect();
        let active_progress: Vec<(usize, u64)> = chunks
            .iter()
            .filter(|c| !c.is_completed)
            .map(|c| (c.chunk_id, c.downloaded))
            .collect();

        let (victim_id, victim_done) =
            pick_largest_stealable_segment(&segments, &active_progress, min_split_bytes)?;

        let mut segs_mut = segments;
        let stolen_seg =
            split_largest_active_segment(&mut segs_mut, victim_id, victim_done, min_split_bytes)
                .ok()?;

        let updated_victim = segs_mut.iter().find(|s| s.segment_id == victim_id)?;
        if let Some(victim_chunk) = chunks.iter_mut().find(|c| c.chunk_id == victim_id) {
            victim_chunk.end = updated_victim.end_byte;
            if victim_chunk.remaining() == 0 {
                victim_chunk.is_completed = true;
            }
        }

        let stolen = ChunkRange::new(
            stolen_seg.segment_id,
            stolen_seg.start_byte,
            stolen_seg.end_byte,
        );
        chunks.push(stolen.clone());
        Some(stolen)
    }

    /// Computes `remainingForThisChunk` clamp: when an active chunk is shortened mid-stream
    /// by a dynamic midpoint steal, returns the exact safe prefix length `<= incoming_len`
    /// permitted to be written without overwriting stolen bytes.
    #[must_use]
    pub const fn clamp_write_len(chunk: &ChunkRange, incoming_len: usize) -> usize {
        let remaining_for_this_chunk = chunk.remaining();
        if (incoming_len as u64) <= remaining_for_this_chunk {
            incoming_len
        } else {
            remaining_for_this_chunk as usize
        }
    }
}

/// Normalizes, clamps to `[0, total_size - 1]`, sorts, and coalesces overlapping or adjacent
/// inclusive byte intervals `[(start, end)]`.
#[must_use]
pub fn normalize_completed_intervals(
    raw_intervals: &[(u64, u64)],
    total_size: u64,
) -> Vec<(u64, u64)> {
    if total_size == 0 || raw_intervals.is_empty() {
        return Vec::new();
    }
    let max_end = total_size - 1;
    let mut valid: Vec<(u64, u64)> = raw_intervals
        .iter()
        .filter_map(|&(s, e)| {
            if s > e || s > max_end {
                None
            } else {
                Some((s, e.min(max_end)))
            }
        })
        .collect();
    if valid.is_empty() {
        return Vec::new();
    }
    valid.sort_unstable_by_key(|&(s, e)| (s, e));

    let mut merged: Vec<(u64, u64)> = Vec::with_capacity(valid.len());
    for (s, e) in valid {
        if let Some(last) = merged.last_mut() {
            if s <= last.1.saturating_add(1) {
                if e > last.1 {
                    last.1 = e;
                }
                continue;
            }
        }
        merged.push((s, e));
    }
    merged
}

/// Inserts a newly written inclusive interval `[start, end]` into a canonical coalesced interval list.
pub fn record_completed_interval(
    completed: &mut Vec<(u64, u64)>,
    start: u64,
    end: u64,
    total_size: u64,
) {
    if total_size == 0 || start > end {
        return;
    }
    completed.push((start, end));
    *completed = normalize_completed_intervals(completed, total_size);
}

/// Computes the complement of `completed` within `[0, total_size - 1]`.
#[must_use]
pub fn compute_missing_intervals(total_size: u64, completed: &[(u64, u64)]) -> Vec<(u64, u64)> {
    if total_size == 0 {
        return Vec::new();
    }
    let norm = normalize_completed_intervals(completed, total_size);
    let mut missing = Vec::new();
    let mut cursor = 0u64;
    for (s, e) in norm {
        if s > cursor {
            missing.push((cursor, s - 1));
        }
        cursor = e.saturating_add(1);
    }
    if cursor < total_size {
        missing.push((cursor, total_size - 1));
    }
    missing
}

/// Sums total covered bytes across a normalized interval slice.
#[must_use]
pub fn total_interval_bytes(intervals: &[(u64, u64)]) -> u64 {
    intervals
        .iter()
        .filter(|&&(s, e)| s <= e)
        .fold(0u64, |acc, &(s, e)| acc.saturating_add(e - s + 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_1_to_128_streams_contiguously() {
        let c1 = Chunker::plan_initial_ranges(10_000, 1, 64);
        assert_eq!(c1.len(), 1);
        assert_eq!((c1[0].start, c1[0].end), (0, 9_999));

        let c128 = Chunker::plan_initial_ranges(262_144, 128, 1024);
        assert_eq!(c128.len(), 128);
        let mut cursor = 0;
        for c in &c128 {
            assert_eq!(c.start, cursor);
            assert!(c.len() >= 1024);
            cursor = c.end + 1;
        }
        assert_eq!(cursor, 262_144);

        // Request > 128 clamps to 128
        let c_clamped = Chunker::plan_initial_ranges(1024 * 1024, 512, 1024);
        assert_eq!(c_clamped.len(), 128);
    }

    #[test]
    fn midpoint_steal_and_remaining_clamp_prevent_overwrite() {
        let mut chunks = Chunker::plan_initial_ranges(10_000, 2, 100);
        // Chunk 0: [0..4999], Chunk 1: [5000..9999]
        chunks[0].downloaded = 1_000; // remaining 4000
        chunks[1].downloaded = 4_500; // remaining 500

        let stolen = Chunker::steal_midpoint(&mut chunks, 500).expect("steal from chunk 0");
        assert_eq!(stolen.chunk_id, 2);
        // Remaining of chunk 0 was [1000..4999] (4000 bytes) -> first half [1000..2999], stolen [3000..4999]
        assert_eq!(chunks[0].end, 2_999);
        assert_eq!((stolen.start, stolen.end), (3_000, 4_999));

        // Simulate victim had already buffered a 3_000-byte socket read before learning about steal.
        // Remaining for chunk 0 is 2_000 bytes -> clamp_write_len MUST return 2_000!
        assert_eq!(Chunker::clamp_write_len(&chunks[0], 3_000), 2_000);
        assert_eq!(Chunker::clamp_write_len(&chunks[0], 512), 512);
    }

    #[test]
    fn interval_resume_is_safe_across_chunk_count_changes() {
        // Paused after 4-stream run left two non-contiguous completed regions.
        let completed = vec![(0, 2_499), (5_000, 7_499)];
        // Resume with 16 streams!
        let resumed_chunks =
            Chunker::plan_from_completed_intervals(10_000, &completed, 16, 256);
        assert!(resumed_chunks.len() > 2);

        // Verify union of completed + resumed_chunks covers [0..9999] with zero overlap/gap.
        let mut all = completed;
        for c in &resumed_chunks {
            all.push((c.start, c.end));
        }
        let missing = compute_missing_intervals(10_000, &all);
        assert!(missing.is_empty());
        assert_eq!(
            total_interval_bytes(&normalize_completed_intervals(&all, 10_000)),
            10_000
        );
    }
}

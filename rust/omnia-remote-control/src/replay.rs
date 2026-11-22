//! Sliding 64-packet anti-replay window and monotonic outgoing sequence generator.

use thiserror::Error;

/// Size of the sliding anti-replay window in packets.
pub const REPLAY_WINDOW_SIZE: u64 = 64;

/// Errors raised by sequence generation or anti-replay validation.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ReplayError {
    /// Sequence number `0` is never valid on the wire.
    #[error("sequence number 0 is invalid; valid sequences start at 1")]
    ZeroSequence,
    /// Sequence number was already accepted inside the active window.
    #[error("replayed or duplicate sequence number: {seq}")]
    DuplicateSequence { seq: u64 },
    /// Sequence number fell below `highest_seq - (REPLAY_WINDOW_SIZE - 1)`.
    #[error(
        "sequence number {seq} fell outside {window_size}-packet replay window (highest={highest_seq})"
    )]
    OutOfWindow {
        seq: u64,
        highest_seq: u64,
        window_size: u64,
    },
    /// Outgoing monotonic sequence generator reached `u64::MAX`.
    #[error("outgoing sequence counter exhausted")]
    SequenceExhausted,
}

/// Strictly monotonic outgoing sequence number generator starting at `1`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SequenceGenerator {
    next_seq: Option<u64>,
}

impl Default for SequenceGenerator {
    fn default() -> Self {
        Self::new()
    }
}

impl SequenceGenerator {
    /// Creates a new generator starting at sequence `1`.
    #[must_use]
    pub const fn new() -> Self {
        Self { next_seq: Some(1) }
    }

    /// Creates a generator starting at `start` (rejects `0`).
    pub fn from_start(start: u64) -> Result<Self, ReplayError> {
        if start == 0 {
            return Err(ReplayError::ZeroSequence);
        }
        Ok(Self {
            next_seq: Some(start),
        })
    }

    /// Peeks at the next sequence number without advancing the generator.
    #[must_use]
    pub const fn peek_next(&self) -> Option<u64> {
        self.next_seq
    }

    /// Allocates and returns the next monotonic sequence number.
    pub fn next_seq(&mut self) -> Result<u64, ReplayError> {
        let current = self.next_seq.ok_or(ReplayError::SequenceExhausted)?;
        self.next_seq = current.checked_add(1);
        Ok(current)
    }
}

/// 64-packet sliding anti-replay window (RFC 6479 style bitmap).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ReplayWindow {
    highest_seq: u64,
    bitmap: u64,
    accepted_count: u64,
}

impl ReplayWindow {
    /// Creates an empty replay window expecting sequences `>= 1`.
    #[must_use]
    pub const fn new() -> Self {
        Self {
            highest_seq: 0,
            bitmap: 0,
            accepted_count: 0,
        }
    }

    /// Highest authenticated sequence number accepted so far (`0` when empty).
    #[must_use]
    pub const fn highest_seq(&self) -> u64 {
        self.highest_seq
    }

    /// Current 64-bit occupancy mask (`bit 0 == highest_seq`).
    #[must_use]
    pub const fn bitmap(&self) -> u64 {
        self.bitmap
    }

    /// Total number of authenticated packets accepted by this window.
    #[must_use]
    pub const fn accepted_count(&self) -> u64 {
        self.accepted_count
    }

    /// Checks whether `seq` would be accepted without mutating window state.
    pub fn would_accept(&self, seq: u64) -> Result<(), ReplayError> {
        if seq == 0 {
            return Err(ReplayError::ZeroSequence);
        }
        if self.highest_seq == 0 || seq > self.highest_seq {
            return Ok(());
        }
        let offset = self.highest_seq - seq;
        if offset >= REPLAY_WINDOW_SIZE {
            return Err(ReplayError::OutOfWindow {
                seq,
                highest_seq: self.highest_seq,
                window_size: REPLAY_WINDOW_SIZE,
            });
        }
        let mask = 1u64 << offset;
        if (self.bitmap & mask) != 0 {
            return Err(ReplayError::DuplicateSequence { seq });
        }
        Ok(())
    }

    /// Validates `seq` against the 64-packet window and records it if accepted.
    ///
    /// Callers MUST verify frame authentication (MAC & lease) before mutating
    /// the replay window so unauthenticated packets cannot advance `highest_seq`.
    pub fn check_and_accept(&mut self, seq: u64) -> Result<(), ReplayError> {
        self.would_accept(seq)?;
        if self.highest_seq == 0 {
            self.highest_seq = seq;
            self.bitmap = 1;
        } else if seq > self.highest_seq {
            let shift = seq - self.highest_seq;
            if shift >= REPLAY_WINDOW_SIZE {
                self.bitmap = 1;
            } else {
                self.bitmap = (self.bitmap << shift) | 1;
            }
            self.highest_seq = seq;
        } else {
            let offset = self.highest_seq - seq;
            self.bitmap |= 1u64 << offset;
        }
        self.accepted_count = self.accepted_count.saturating_add(1);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn monotonic_sequence_generator_and_exhaustion() {
        assert_eq!(
            SequenceGenerator::from_start(0),
            Err(ReplayError::ZeroSequence)
        );

        let mut gen = SequenceGenerator::new();
        assert_eq!(gen.peek_next(), Some(1));
        assert_eq!(gen.next_seq(), Ok(1));
        assert_eq!(gen.next_seq(), Ok(2));
        assert_eq!(gen.next_seq(), Ok(3));
        assert_eq!(gen.peek_next(), Some(4));

        let mut near_max = SequenceGenerator::from_start(u64::MAX).expect("valid start");
        assert_eq!(near_max.next_seq(), Ok(u64::MAX));
        assert_eq!(near_max.next_seq(), Err(ReplayError::SequenceExhausted));
    }

    #[test]
    fn replay_window_accepts_64_out_of_order_and_rejects_duplicates() {
        let mut window = ReplayWindow::new();
        assert_eq!(window.check_and_accept(64), Ok(()));
        assert_eq!(window.highest_seq(), 64);

        // Sequences 1..=63 are all inside the 64-packet window and arrive out of order.
        for seq in (1..64).rev() {
            assert_eq!(window.check_and_accept(seq), Ok(()));
        }
        assert_eq!(window.accepted_count(), 64);
        assert_eq!(window.bitmap(), u64::MAX);

        // Any already-seen sequence inside [1..=64] must be rejected as duplicate.
        assert_eq!(
            window.check_and_accept(1),
            Err(ReplayError::DuplicateSequence { seq: 1 })
        );
        assert_eq!(
            window.check_and_accept(64),
            Err(ReplayError::DuplicateSequence { seq: 64 })
        );
    }

    #[test]
    fn replay_window_rejects_zero_and_out_of_window_sequences() {
        let mut window = ReplayWindow::new();
        assert_eq!(window.check_and_accept(0), Err(ReplayError::ZeroSequence));

        assert_eq!(window.check_and_accept(10), Ok(()));
        assert_eq!(window.check_and_accept(74), Ok(()));

        // Window now covers [11..=74]; sequence 10 is out of window (offset = 64).
        assert_eq!(
            window.check_and_accept(10),
            Err(ReplayError::OutOfWindow {
                seq: 10,
                highest_seq: 74,
                window_size: 64,
            })
        );
        // Sequence 11 is still inside the 64-packet window (offset = 63).
        assert_eq!(window.check_and_accept(11), Ok(()));
        assert_eq!(
            window.check_and_accept(11),
            Err(ReplayError::DuplicateSequence { seq: 11 })
        );
    }
}

"""Exponential backoff and retry policy calculation."""

from __future__ import annotations

from dataclasses import dataclass
import random


@dataclass(frozen=True)
class RetryPolicy:
    max_attempts: int = 1
    base_delay: float = 0.1
    multiplier: float = 2.0
    max_delay: float = 5.0
    jitter: float = 0.0

    def __post_init__(self) -> None:
        if self.max_attempts < 1:
            raise ValueError("max_attempts must be >= 1")
        if self.base_delay < 0:
            raise ValueError("base_delay must be >= 0")
        if self.multiplier < 1.0:
            raise ValueError("multiplier must be >= 1.0")
        if self.max_delay < 0:
            raise ValueError("max_delay must be >= 0")
        if self.jitter < 0:
            raise ValueError("jitter must be >= 0")


def compute_backoff(
    policy: RetryPolicy,
    attempt: int,
    rng: random.Random | None = None,
) -> float:
    """Compute retry delay in seconds for 1-based retry `attempt`.

    Delay grows exponentially from `base_delay` by `multiplier ** (attempt - 1)`,
    capped by `max_delay`, with symmetric uniform jitter in
    `[-capped * jitter, +capped * jitter]`.
    """
    if attempt < 1:
        raise ValueError("attempt must be >= 1")

    raw_delay = policy.base_delay * (policy.multiplier ** (attempt - 1))
    capped = min(raw_delay, policy.max_delay)

    if policy.jitter == 0.0 or capped == 0.0:
        return capped

    generator = rng if rng is not None else random.Random()
    span = capped * policy.jitter
    jittered = capped + generator.uniform(-span, span)
    return jittered

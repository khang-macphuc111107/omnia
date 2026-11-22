"""Asynchronous DLQ retry scheduler and webhook replay worker for services/worker."""

from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
import random
from typing import Any, Protocol

from services.auth.config_loader import _parse_simple_yaml, deep_merge
from services.billing.subscription_repo import SqlExecutor
from shared.protocol.models import (
    WEBHOOK_HMAC_HEADER,
    WEBHOOK_TIMESTAMP_HEADER,
    compute_webhook_hmac,
)


class WorkerQueueClient(Protocol):
    def enqueue_delayed(self, queue_name: str, payload_json: str, delay_sec: float) -> None: ...
    def push_dlq(self, dlq_key: str, payload_json: str) -> None: ...


def load_worker_dlq_config(config_dir: Path, env_name: str = "prod") -> dict[str, Any]:
    """Load merged worker DLQ configuration (defaults.yaml overlaid by env_<env>.yaml)."""
    defaults = _parse_simple_yaml((config_dir / "defaults.yaml").read_text(encoding="utf-8"))
    env_path = config_dir / f"env_{env_name}.yaml"
    env_cfg = (
        _parse_simple_yaml(env_path.read_text(encoding="utf-8"))
        if env_path.exists()
        else {}
    )
    merged = deep_merge(defaults, env_cfg)
    worker_cfg = merged["worker"]
    return {
        "queue_name": str(worker_cfg["queue_name"]),
        "dlq_key": str(worker_cfg["dlq_key"]),
        "base_delay_sec": int(worker_cfg["dlq"]["base_delay_sec"]),
        "backoff_multiplier": int(worker_cfg["dlq"]["backoff_multiplier"]),
        "max_delay_sec": int(worker_cfg["dlq"]["max_delay_sec"]),
        "max_attempts": int(worker_cfg["dlq"]["max_attempts"]),
        "jitter_pct": float(worker_cfg["dlq"]["jitter_pct"]),
    }


def compute_retry_delay_sec(
    attempt: int,
    base_delay_sec: int,
    backoff_multiplier: int,
    max_delay_sec: int,
    jitter_pct: float = 0.0,
    rng: random.Random | None = None,
) -> float:
    """Compute exponential retry backoff delay in seconds with optional symmetric jitter.

    Formula (1-indexed attempt):
        raw_delay    = base_delay_sec * (backoff_multiplier ** (attempt - 1))
        capped_delay = min(raw_delay, max_delay_sec)
        jitter       = uniform(-capped_delay * jitter_pct, +capped_delay * jitter_pct)
        delay_sec    = max(0.0, capped_delay + jitter)
    """
    if attempt < 1:
        raise ValueError("attempt must be >= 1")
    raw_delay = base_delay_sec * (backoff_multiplier ** (attempt - 1))
    capped_delay = float(min(raw_delay, max_delay_sec))
    if jitter_pct <= 0.0:
        return capped_delay
    generator = rng or random
    jitter_bound = capped_delay * jitter_pct
    return max(0.0, capped_delay + generator.uniform(-jitter_bound, jitter_bound))


class DlqProcessor:
    """Handles retryable worker failures, DLQ routing, and exhausted dunning jobs."""

    def __init__(
        self,
        db: SqlExecutor,
        queue: WorkerQueueClient,
        config_dir: Path,
        env_name: str = "prod",
    ) -> None:
        self.db = db
        self.queue = queue
        self.cfg = load_worker_dlq_config(config_dir, env_name=env_name)

    def schedule_retry_or_dlq(
        self,
        job: dict[str, Any],
        error_message: str,
        rng: random.Random | None = None,
    ) -> str:
        attempt = int(job.get("attempt", 1))
        if attempt >= self.cfg["max_attempts"]:
            dead_letter = {
                **job,
                "dead_lettered_at": datetime.now(timezone.utc).isoformat(),
                "last_error": error_message,
            }
            self.queue.push_dlq(self.cfg["dlq_key"], json.dumps(dead_letter))
            if job.get("job_type") == "dunning.final_notice":
                self.handle_exhausted_dunning_job(dead_letter)
            return "dead_lettered"

        delay_sec = compute_retry_delay_sec(
            attempt=attempt,
            base_delay_sec=self.cfg["base_delay_sec"],
            backoff_multiplier=self.cfg["backoff_multiplier"],
            max_delay_sec=self.cfg["max_delay_sec"],
            jitter_pct=self.cfg["jitter_pct"],
            rng=rng,
        )
        next_job = {**job, "attempt": attempt + 1, "last_error": error_message}
        self.queue.enqueue_delayed(
            self.cfg["queue_name"],
            json.dumps(next_job),
            delay_sec=delay_sec,
        )
        return "retrying"

    def handle_exhausted_dunning_job(self, job: dict[str, Any]) -> None:
        """Mark subscription past_due directly once final dunning retries exhaust."""
        payload = job.get("payload", {})
        subscription_id = str(payload["subscription_id"])
        now_utc = datetime.now(timezone.utc)
        self.db.execute(
            """
            UPDATE subscriptions
            SET subscription_state = 'past_due', updated_at = %s
            WHERE id = %s AND subscription_state = 'active'
            """,
            (now_utc, subscription_id),
        )

    def format_dunning_alert(self, job: dict[str, Any]) -> str:
        """Render customer-facing overdue invoice alert text from job payload."""
        payload = job.get("payload", {})
        invoice_id = str(payload.get("invoice_id", "unknown"))
        cents = int(payload.get("amount_cents", 0))
        dollars = cents / 100.0
        return f"Overdue notice for invoice {invoice_id}: balance due ${dollars:.2f}"

    def build_webhook_replay_headers(
        self,
        secret: str,
        timestamp_sec: str,
        raw_body: bytes,
    ) -> dict[str, str]:
        sig = compute_webhook_hmac(secret, timestamp_sec, raw_body)
        return {
            "Content-Type": "application/json",
            WEBHOOK_HMAC_HEADER: sig,
            WEBHOOK_TIMESTAMP_HEADER: timestamp_sec,
        }

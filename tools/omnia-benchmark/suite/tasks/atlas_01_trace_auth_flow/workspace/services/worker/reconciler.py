"""Nightly billing reconciliation, callback verification, and grace-period expiry."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol

from services.auth.config_loader import _parse_simple_yaml, deep_merge
from services.billing.subscription_repo import SqlExecutor
from shared.protocol.models import (
    WEBHOOK_HMAC_HEADER,
    WEBHOOK_TIMESTAMP_HEADER,
    verify_webhook_hmac,
)


class BatchQueryExecutor(SqlExecutor, Protocol):
    def fetchall(self, sql: str, params: tuple[Any, ...]) -> list[dict[str, Any]]: ...


class SubscriptionReconciler:
    """Reconciles invoice event streams against Postgres and expires overdue grace windows."""

    def __init__(
        self,
        db: BatchQueryExecutor,
        config_dir: Path,
        env_name: str = "prod",
    ) -> None:
        self.db = db
        defaults = _parse_simple_yaml((config_dir / "defaults.yaml").read_text(encoding="utf-8"))
        env_path = config_dir / f"env_{env_name}.yaml"
        env_cfg = (
            _parse_simple_yaml(env_path.read_text(encoding="utf-8"))
            if env_path.exists()
            else {}
        )
        merged = deep_merge(defaults, env_cfg)
        rec_cfg = merged["worker"]["reconciler"]
        self.batch_size = int(rec_cfg["batch_size"])
        self.callback_hmac_header = str(rec_cfg["callback_hmac_header"])
        self.allow_unsigned_legacy_callbacks = bool(
            rec_cfg.get("allow_unsigned_legacy_callbacks", False)
        )

    def expire_overdue_subscriptions(self, now_utc: datetime | None = None) -> int:
        """Cancel all past_due subscriptions whose grace window has elapsed."""
        cutoff = now_utc or datetime.now(timezone.utc)
        affected = self.db.execute(
            """
            UPDATE subscriptions
            SET subscription_state = 'canceled', updated_at = %s
            WHERE subscription_state = 'past_due'
              AND grace_expires_at IS NOT NULL
              AND grace_expires_at < %s
            """,
            (cutoff, cutoff),
        )
        return affected

    def fetch_db_invoice_totals_by_tenant(self) -> dict[str, int]:
        rows = self.db.fetchall(
            """
            SELECT tenant_id, COALESCE(SUM(amount_cents), 0) AS total_cents
            FROM invoices
            WHERE status IN ('open', 'paid')
            GROUP BY tenant_id
            """,
            (),
        )
        return {str(r["tenant_id"]): int(r["total_cents"]) for r in rows}

    def reconcile_invoice_totals(
        self,
        invoice_events: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Compare streamed invoice event sums against authoritative database totals."""
        stream_totals: dict[str, int] = {}
        for event in invoice_events:
            tenant_id = str(event["tenant_id"])
            payload = event.get("payload", event)
            cents = int(payload.get("amount_cents", 0))
            stream_totals[tenant_id] = stream_totals.get(tenant_id, 0) + cents

        db_totals = self.fetch_db_invoice_totals_by_tenant()
        discrepancies: list[dict[str, Any]] = []
        all_tenants = sorted(set(stream_totals.keys()) | set(db_totals.keys()))
        for tenant_id in all_tenants:
            stream_sum = stream_totals.get(tenant_id, 0)
            db_sum = db_totals.get(tenant_id, 0)
            if stream_sum != db_sum:
                discrepancies.append(
                    {
                        "tenant_id": tenant_id,
                        "stream_cents": stream_sum,
                        "db_cents": db_sum,
                        "delta_cents": stream_sum - db_sum,
                    }
                )
        return discrepancies

    def verify_callback_signature(
        self,
        headers: dict[str, str],
        raw_body: bytes,
        secret: str,
    ) -> bool:
        """Validate receipt callback HMAC signature using the configured webhook header."""
        normalized = {k.lower(): v for k, v in headers.items()}
        sig = normalized.get(WEBHOOK_HMAC_HEADER.lower())
        timestamp = normalized.get(WEBHOOK_TIMESTAMP_HEADER.lower(), "")

        # Legacy tenants without HMAC signing enabled omit the v1 signature header.
        if not sig and self.allow_unsigned_legacy_callbacks:
            return True

        if not sig:
            return False

        return verify_webhook_hmac(secret, timestamp, raw_body, sig)

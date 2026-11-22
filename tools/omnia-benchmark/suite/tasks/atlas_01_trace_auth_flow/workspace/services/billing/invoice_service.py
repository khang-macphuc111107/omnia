"""Invoice issuance, payment webhook verification, and billing event publishing."""

from __future__ import annotations

from datetime import datetime, timezone
import json
from typing import Any, Protocol

from services.billing.subscription_repo import SqlExecutor, SubscriptionRepository
from shared.protocol.models import (
    InvoiceRecord,
    SubscriptionState,
    TenantTier,
    WEBHOOK_HMAC_HEADER,
    WEBHOOK_TIMESTAMP_HEADER,
    verify_webhook_hmac,
)


class QueuePublisher(Protocol):
    def publish(self, queue_name: str, message_json: str) -> None: ...


class WebhookAuthError(PermissionError):
    """Raised when an incoming payment webhook fails HMAC verification."""


def serialize_invoice_event(invoice: InvoiceRecord) -> str:
    """Serialize an InvoiceRecord into the canonical queue JSON envelope."""
    envelope = {
        "job_id": f"job_{invoice.invoice_id}",
        "job_type": "invoice.created",
        "tenant_id": invoice.tenant_id,
        "attempt": 1,
        "payload": invoice.to_wire_dict(),
    }
    return json.dumps(envelope, separators=(",", ":"), sort_keys=True)


class InvoiceService:
    """Creates invoices, ingests payment webhooks, and computes billing rollups."""

    def __init__(
        self,
        db: SqlExecutor,
        sub_repo: SubscriptionRepository,
        queue: QueuePublisher,
        webhook_secret: str,
        queue_name: str = "queue:billing_events",
    ) -> None:
        self.db = db
        self.sub_repo = sub_repo
        self.queue = queue
        self.webhook_secret = webhook_secret
        self.queue_name = queue_name

    def create_invoice(
        self,
        invoice_id: str,
        tenant_id: str,
        subscription_id: str,
        tenant_tier: TenantTier,
        amount_cents: int,
        currency: str = "USD",
    ) -> InvoiceRecord:
        issued_at = datetime.now(timezone.utc).isoformat()
        record = InvoiceRecord(
            invoice_id=invoice_id,
            tenant_id=tenant_id,
            subscription_id=subscription_id,
            tenant_tier=tenant_tier,
            amount_cents=amount_cents,
            currency=currency,
            issued_at=issued_at,
            status="open",
        )
        self.db.execute(
            """
            INSERT INTO invoices (
                invoice_id, tenant_id, subscription_id, tenant_tier,
                amount_cents, currency, status, issued_at
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                record.invoice_id,
                record.tenant_id,
                record.subscription_id,
                record.tenant_tier.value,
                record.amount_cents,
                record.currency,
                record.status,
                record.issued_at,
            ),
        )
        self.queue.publish(self.queue_name, serialize_invoice_event(record))
        return record

    def freeze_on_chargeback(self, subscription_id: str, dispute_id: str) -> None:
        """Emergency direct SQL freeze when a confirmed chargeback arrives."""
        now_utc = datetime.now(timezone.utc)
        self.db.execute(
            """
            UPDATE subscriptions
            SET subscription_state = 'suspended', updated_at = %s
            WHERE id = %s
            """,
            (now_utc, subscription_id),
        )
        self.db.execute(
            """
            INSERT INTO subscription_audit_log (
                subscription_id, previous_state, new_state, reason, actor_service
            ) VALUES (%s, %s, %s, %s, %s)
            """,
            (
                subscription_id,
                "active",
                "suspended",
                f"chargeback_confirmed:{dispute_id}",
                "billing.invoice_service",
            ),
        )

    def handle_payment_webhook(
        self,
        headers: dict[str, str],
        raw_body: bytes,
    ) -> dict[str, Any]:
        normalized_headers = {k.lower(): v for k, v in headers.items()}
        signature = normalized_headers.get(WEBHOOK_HMAC_HEADER.lower(), "")
        timestamp = normalized_headers.get(WEBHOOK_TIMESTAMP_HEADER.lower(), "")

        if not verify_webhook_hmac(self.webhook_secret, timestamp, raw_body, signature):
            raise WebhookAuthError(
                f"Invalid or missing {WEBHOOK_HMAC_HEADER} signature"
            )

        event = json.loads(raw_body.decode("utf-8"))
        event_type = event["event_type"]
        subscription_id = event["subscription_id"]

        if event_type == "payment.succeeded":
            invoice_id = event["invoice_id"]
            self.db.execute(
                "UPDATE invoices SET status = 'paid', paid_at = NOW() WHERE invoice_id = %s",
                (invoice_id,),
            )
            self.sub_repo.transition_state(
                subscription_id,
                SubscriptionState.ACTIVE,
                reason=f"invoice_paid:{invoice_id}",
            )
            return {"handled": True, "action": "marked_paid"}

        if event_type == "chargeback.confirmed":
            self.freeze_on_chargeback(subscription_id, event["dispute_id"])
            return {"handled": True, "action": "frozen_chargeback"}

        return {"handled": False, "action": "ignored"}

    def build_ledger_summary(
        self,
        invoice_payloads: list[dict[str, Any]],
    ) -> dict[str, int]:
        """Aggregate invoiced cents per tenant_tier from deserialized wire payloads."""
        totals_by_tier: dict[str, int] = {}
        for payload in invoice_payloads:
            tier_key = str(payload.get("tenant_tier", "free"))
            cents = int(payload.get("amount_cents", 0))
            totals_by_tier[tier_key] = totals_by_tier.get(tier_key, 0) + cents
        return totals_by_tier

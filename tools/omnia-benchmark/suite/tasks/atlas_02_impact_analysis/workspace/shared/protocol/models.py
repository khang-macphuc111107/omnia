"""Shared Python wire-protocol models and HMAC utilities for Nimbus Cloud."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import hashlib
import hmac
from typing import Any


WEBHOOK_HMAC_HEADER = "X-Nimbus-Signature-V1"
WEBHOOK_TIMESTAMP_HEADER = "X-Nimbus-Timestamp"
REQUEST_ID_HEADER = "X-Request-Id"


class TenantTier(str, Enum):
    FREE = "free"
    PRO = "pro"
    ENTERPRISE = "enterprise"


class SubscriptionState(str, Enum):
    TRIALING = "trialing"
    ACTIVE = "active"
    PAST_DUE = "past_due"
    SUSPENDED = "suspended"
    CANCELED = "canceled"


@dataclass(frozen=True)
class AuthTokenClaims:
    sub: str
    tenant_id: str
    tenant_tier: TenantTier
    subscription_state: SubscriptionState
    session_id: str
    iat: int
    exp: int

    def to_jwt_payload(self) -> dict[str, Any]:
        return {
            "sub": self.sub,
            "tenant_id": self.tenant_id,
            "tenant_tier": self.tenant_tier.value,
            "subscription_state": self.subscription_state.value,
            "session_id": self.session_id,
            "iat": self.iat,
            "exp": self.exp,
        }

    @classmethod
    def from_jwt_payload(cls, raw: dict[str, Any]) -> AuthTokenClaims:
        return cls(
            sub=str(raw["sub"]),
            tenant_id=str(raw["tenant_id"]),
            tenant_tier=TenantTier(raw["tenant_tier"]),
            subscription_state=SubscriptionState(raw["subscription_state"]),
            session_id=str(raw["session_id"]),
            iat=int(raw["iat"]),
            exp=int(raw["exp"]),
        )


@dataclass(frozen=True)
class InvoiceRecord:
    invoice_id: str
    tenant_id: str
    subscription_id: str
    tenant_tier: TenantTier
    amount_cents: int
    currency: str
    issued_at: str
    status: str

    def to_wire_dict(self) -> dict[str, Any]:
        return {
            "invoice_id": self.invoice_id,
            "tenant_id": self.tenant_id,
            "subscription_id": self.subscription_id,
            "tenant_tier": self.tenant_tier.value,
            "amount_cents": self.amount_cents,
            "currency": self.currency,
            "issued_at": self.issued_at,
            "status": self.status,
        }

    @classmethod
    def from_wire_dict(cls, raw: dict[str, Any]) -> InvoiceRecord:
        return cls(
            invoice_id=str(raw["invoice_id"]),
            tenant_id=str(raw["tenant_id"]),
            subscription_id=str(raw["subscription_id"]),
            tenant_tier=TenantTier(raw["tenant_tier"]),
            amount_cents=int(raw["amount_cents"]),
            currency=str(raw["currency"]),
            issued_at=str(raw["issued_at"]),
            status=str(raw["status"]),
        )


def compute_webhook_hmac(secret: str, timestamp: str, raw_body: bytes) -> str:
    """Compute canonical 'sha256=<hex>' HMAC signature for webhook requests."""
    signed_payload = timestamp.encode("utf-8") + b"." + raw_body
    digest = hmac.new(
        secret.encode("utf-8"),
        signed_payload,
        hashlib.sha256,
    ).hexdigest()
    return f"sha256={digest}"


def verify_webhook_hmac(
    secret: str,
    timestamp: str,
    raw_body: bytes,
    provided_signature: str,
) -> bool:
    """Constant-time verification of X-Nimbus-Signature-V1."""
    if not provided_signature or not provided_signature.startswith("sha256="):
        return False
    expected = compute_webhook_hmac(secret, timestamp, raw_body)
    return hmac.compare_digest(expected, provided_signature)

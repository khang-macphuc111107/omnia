"""Subscription persistence repository and plan pricing helpers for services/billing."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Protocol

from shared.protocol.models import SubscriptionState, TenantTier


class SqlExecutor(Protocol):
    def execute(self, sql: str, params: tuple[Any, ...]) -> int: ...
    def fetchone(self, sql: str, params: tuple[Any, ...]) -> dict[str, Any] | None: ...


PLAN_MONTHLY_PRICE_CENTS: dict[TenantTier, int] = {
    TenantTier.FREE: 0,
    TenantTier.PRO: 4900,
    TenantTier.ENTERPRISE: 34900,
}

ALLOWED_TRANSITIONS: dict[SubscriptionState, set[SubscriptionState]] = {
    SubscriptionState.TRIALING: {
        SubscriptionState.ACTIVE,
        SubscriptionState.CANCELED,
    },
    SubscriptionState.ACTIVE: {
        SubscriptionState.PAST_DUE,
        SubscriptionState.SUSPENDED,
        SubscriptionState.CANCELED,
    },
    SubscriptionState.PAST_DUE: {
        SubscriptionState.ACTIVE,
        SubscriptionState.SUSPENDED,
        SubscriptionState.CANCELED,
    },
    SubscriptionState.SUSPENDED: {
        SubscriptionState.ACTIVE,
        SubscriptionState.CANCELED,
    },
    SubscriptionState.CANCELED: set(),
}


@dataclass(frozen=True)
class SubscriptionRow:
    subscription_id: str
    tenant_id: str
    plan_tier: TenantTier
    subscription_state: SubscriptionState
    current_period_end: datetime
    grace_expires_at: datetime | None


class InvalidStateTransitionError(ValueError):
    """Raised when an illegal subscription lifecycle transition is attempted."""


def calculate_proration_cents(
    old_tier: TenantTier,
    new_tier: TenantTier,
    days_remaining: int,
    cycle_days: int = 30,
) -> int:
    """Compute prorated invoice delta in cents when switching tenant tiers."""
    if days_remaining <= 0 or cycle_days <= 0:
        return 0
    old_rate = PLAN_MONTHLY_PRICE_CENTS[old_tier]
    new_rate = PLAN_MONTHLY_PRICE_CENTS[new_tier]
    delta = new_rate - old_rate
    return round(delta * (days_remaining / cycle_days))


class SubscriptionRepository:
    """Canonical data-access layer for the subscriptions table."""

    def __init__(self, db: SqlExecutor) -> None:
        self.db = db

    def get_subscription(self, subscription_id: str) -> SubscriptionRow | None:
        row = self.db.fetchone(
            """
            SELECT id, tenant_id, plan_tier, subscription_state,
                   current_period_end, grace_expires_at
            FROM subscriptions
            WHERE id = %s
            """,
            (subscription_id,),
        )
        if row is None:
            return None
        return SubscriptionRow(
            subscription_id=str(row["id"]),
            tenant_id=str(row["tenant_id"]),
            plan_tier=TenantTier(row["plan_tier"]),
            subscription_state=SubscriptionState(row["subscription_state"]),
            current_period_end=row["current_period_end"],
            grace_expires_at=row.get("grace_expires_at"),
        )

    def create_subscription(
        self,
        subscription_id: str,
        tenant_id: str,
        plan_tier: TenantTier,
        initial_state: SubscriptionState,
        period_end: datetime,
    ) -> None:
        self.db.execute(
            """
            INSERT INTO subscriptions (
                id, tenant_id, plan_tier, subscription_state, current_period_end
            ) VALUES (%s, %s, %s, %s, %s)
            """,
            (
                subscription_id,
                tenant_id,
                plan_tier.value,
                initial_state.value,
                period_end,
            ),
        )
        self.db.execute(
            """
            INSERT INTO subscription_audit_log (
                subscription_id, previous_state, new_state, reason, actor_service
            ) VALUES (%s, %s, %s, %s, %s)
            """,
            (subscription_id, None, initial_state.value, "initial_creation", "billing"),
        )

    def transition_state(
        self,
        subscription_id: str,
        new_state: SubscriptionState,
        reason: str,
        actor_service: str = "billing",
    ) -> None:
        current = self.get_subscription(subscription_id)
        if current is None:
            raise KeyError(f"Subscription not found: {subscription_id}")
        if new_state not in ALLOWED_TRANSITIONS[current.subscription_state]:
            raise InvalidStateTransitionError(
                f"Cannot transition {subscription_id} from "
                f"{current.subscription_state.value} to {new_state.value}"
            )

        now_utc = datetime.now(timezone.utc)
        self.db.execute(
            """
            UPDATE subscriptions
            SET subscription_state = %s, updated_at = %s
            WHERE id = %s
            """,
            (new_state.value, now_utc, subscription_id),
        )
        self.db.execute(
            """
            INSERT INTO subscription_audit_log (
                subscription_id, previous_state, new_state, reason, actor_service
            ) VALUES (%s, %s, %s, %s, %s)
            """,
            (
                subscription_id,
                current.subscription_state.value,
                new_state.value,
                reason,
                actor_service,
            ),
        )

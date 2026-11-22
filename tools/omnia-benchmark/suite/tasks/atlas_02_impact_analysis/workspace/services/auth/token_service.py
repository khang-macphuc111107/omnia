"""JWT token issuance and Redis-backed refresh token rotation for services/auth."""

from __future__ import annotations

import base64
from dataclasses import dataclass
import hashlib
import hmac
import json
import secrets
import time
from typing import Any, Protocol

from services.auth.config_loader import AuthConfigLoader
from shared.protocol.models import AuthTokenClaims, SubscriptionState


class RedisSessionStore(Protocol):
    def set_session(self, key: str, payload: dict[str, Any], ttl_sec: int) -> None: ...
    def get_refresh_record(self, token: str) -> RefreshTokenRecord | None: ...
    def save_refresh_record(self, record: RefreshTokenRecord, ttl_sec: int) -> None: ...
    def mark_refresh_used(self, token: str, replaced_by: str) -> None: ...
    def revoke_session_family(self, family_id: str) -> None: ...


class SubscriptionStateReader(Protocol):
    def get_state_for_tenant(self, tenant_id: str) -> SubscriptionState: ...


@dataclass
class RefreshTokenRecord:
    token: str
    user_id: str
    tenant_id: str
    family_id: str
    session_id: str
    used: bool
    issued_at: int
    expires_at: int
    replaced_by: str | None = None


@dataclass(frozen=True)
class TokenPair:
    access_token: str
    refresh_token: str
    session_id: str
    session_ttl_sec: int


class RefreshTokenError(RuntimeError):
    """Raised when a refresh token is missing, expired, or replayed."""


class TokenService:
    """Issues signed access tokens and rotates refresh tokens stored in Redis."""

    def __init__(
        self,
        config_loader: AuthConfigLoader,
        redis_store: RedisSessionStore,
        subscription_reader: SubscriptionStateReader,
        jwt_signing_key: str,
    ) -> None:
        self.config_loader = config_loader
        self.redis = redis_store
        self.subscription_reader = subscription_reader
        self.jwt_signing_key = jwt_signing_key

    def _encode_jwt(self, claims: AuthTokenClaims) -> str:
        header = {"alg": "HS256", "typ": "JWT"}
        h_b64 = base64.urlsafe_b64encode(
            json.dumps(header, separators=(",", ":")).encode("utf-8")
        ).decode("ascii").rstrip("=")
        p_b64 = base64.urlsafe_b64encode(
            json.dumps(claims.to_jwt_payload(), separators=(",", ":")).encode("utf-8")
        ).decode("ascii").rstrip("=")
        sig = hmac.new(
            self.jwt_signing_key.encode("utf-8"),
            f"{h_b64}.{p_b64}".encode("ascii"),
            hashlib.sha256,
        ).digest()
        s_b64 = base64.urlsafe_b64encode(sig).decode("ascii").rstrip("=")
        return f"{h_b64}.{p_b64}.{s_b64}"

    def issue_token_pair(
        self,
        user_id: str,
        tenant_id: str,
        family_id: str | None = None,
    ) -> TokenPair:
        now = int(time.time())
        auth_cfg = self.config_loader.merged_cfg["auth"]
        access_ttl = int(auth_cfg["access_token_ttl_sec"])
        refresh_ttl = int(auth_cfg["refresh_token_ttl_sec"])
        session_ttl = self.config_loader.resolve_session_redis_ttl(tenant_id)

        tenant_tier = self.config_loader.get_tenant_tier(tenant_id)
        sub_state = self.subscription_reader.get_state_for_tenant(tenant_id)

        session_id = f"sess_{secrets.token_hex(12)}"
        new_family_id = family_id or f"fam_{secrets.token_hex(8)}"
        claims = AuthTokenClaims(
            sub=user_id,
            tenant_id=tenant_id,
            tenant_tier=tenant_tier,
            subscription_state=sub_state,
            session_id=session_id,
            iat=now,
            exp=now + access_ttl,
        )
        access_token = self._encode_jwt(claims)
        refresh_token = f"rt_{secrets.token_hex(24)}"

        session_key = f"{auth_cfg['redis_key_prefix']}{session_id}"
        self.redis.set_session(
            session_key,
            {
                "user_id": user_id,
                "tenant_id": tenant_id,
                "tenant_tier": tenant_tier.value,
                "subscription_state": sub_state.value,
                "family_id": new_family_id,
            },
            ttl_sec=session_ttl,
        )
        self.redis.save_refresh_record(
            RefreshTokenRecord(
                token=refresh_token,
                user_id=user_id,
                tenant_id=tenant_id,
                family_id=new_family_id,
                session_id=session_id,
                used=False,
                issued_at=now,
                expires_at=now + refresh_ttl,
            ),
            ttl_sec=refresh_ttl,
        )
        return TokenPair(
            access_token=access_token,
            refresh_token=refresh_token,
            session_id=session_id,
            session_ttl_sec=session_ttl,
        )

    def refresh_access_token(self, refresh_token: str, tenant_id: str) -> TokenPair:
        """Rotate a refresh token and mint a replacement session + token pair."""
        now = int(time.time())
        record = self.redis.get_refresh_record(refresh_token)
        if record is None:
            raise RefreshTokenError("Refresh token not found")
        if record.tenant_id != tenant_id:
            raise RefreshTokenError("Refresh token tenant mismatch")
        if record.expires_at <= now:
            raise RefreshTokenError("Refresh token expired")
        if record.used:
            self.redis.revoke_session_family(record.family_id)
            raise RefreshTokenError("Refresh token replay detected; session family revoked")

        # Mint replacement credentials and persist new session prior to invalidating old token.
        new_pair = self.issue_token_pair(
            user_id=record.user_id,
            tenant_id=record.tenant_id,
            family_id=record.family_id,
        )
        self.redis.mark_refresh_used(refresh_token, replaced_by=new_pair.refresh_token)
        return new_pair

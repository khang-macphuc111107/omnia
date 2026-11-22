"""Layered configuration loader for services/auth.

Resolves settings in strict 3-layer precedence:
  1. config/defaults.yaml          (defaults)
  2. config/env_<env>.yaml         (env)
  3. config/tenants.json           (tenant_override)
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

from shared.protocol.models import TenantTier


def _parse_simple_yaml(text: str) -> dict[str, Any]:
    """Minimal indentation-based YAML loader for nested mapping config files."""
    root: dict[str, Any] = {}
    stack: list[tuple[int, dict[str, Any]]] = [(-1, root)]

    for raw_line in text.splitlines():
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(raw_line) - len(raw_line.lstrip(" "))
        while len(stack) > 1 and indent <= stack[-1][0]:
            stack.pop()
        parent = stack[-1][1]
        key, _, rest = stripped.partition(":")
        key = key.strip()
        val_str = rest.strip()
        if not val_str:
            child: dict[str, Any] = {}
            parent[key] = child
            stack.append((indent, child))
        else:
            parent[key] = _coerce_scalar(val_str)
    return root


def _coerce_scalar(token: str) -> Any:
    if (token.startswith('"') and token.endswith('"')) or (
        token.startswith("'") and token.endswith("'")
    ):
        return token[1:-1]
    lower = token.lower()
    if lower == "true":
        return True
    if lower == "false":
        return False
    if lower == "null":
        return None
    try:
        return int(token)
    except ValueError:
        pass
    try:
        return float(token)
    except ValueError:
        return token


def deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    merged = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = deep_merge(merged[key], value)
        else:
            merged[key] = copy.deepcopy(value)
    return merged


class AuthConfigLoader:
    """Loads layered auth configuration and resolves per-tenant Redis session TTLs."""

    def __init__(self, config_dir: Path, env_name: str = "prod") -> None:
        self.config_dir = config_dir
        self.env_name = env_name
        self.defaults_cfg = _parse_simple_yaml(
            (config_dir / "defaults.yaml").read_text(encoding="utf-8")
        )
        env_path = config_dir / f"env_{env_name}.yaml"
        self.env_cfg = (
            _parse_simple_yaml(env_path.read_text(encoding="utf-8"))
            if env_path.exists()
            else {}
        )
        self.merged_cfg = deep_merge(self.defaults_cfg, self.env_cfg)
        tenants_raw = json.loads(
            (config_dir / "tenants.json").read_text(encoding="utf-8")
        )
        self.tenants: dict[str, dict[str, Any]] = tenants_raw.get("tenants", {})

    def get_tenant_tier(self, tenant_id: str) -> TenantTier:
        tenant_entry = self.tenants.get(tenant_id)
        if tenant_entry is None:
            raise KeyError(f"Unknown tenant_id: {tenant_id}")
        return TenantTier(tenant_entry["tenant_tier"])

    def resolve_session_redis_ttl(self, tenant_id: str) -> int:
        """Resolve effective Redis session TTL across defaults -> env -> tenant_override.

        Applies min_session_ttl_sec / max_session_ttl_sec bounds from merged env config.
        """
        auth_cfg = self.merged_cfg["auth"]

        # Layer 1 (defaults.yaml) overridden by Layer 2 (env_<env>.yaml) via deep_merge.
        ttl_sec = int(auth_cfg["session_redis_ttl_sec"])

        # Layer 3 (tenants.json): per-tenant override when enabled by environment config.
        if bool(auth_cfg.get("allow_tenant_ttl_override", False)):
            tenant_entry = self.tenants.get(tenant_id, {})
            overrides = tenant_entry.get("overrides", {})
            if "session_redis_ttl_sec" in overrides and overrides["session_redis_ttl_sec"] is not None:
                ttl_sec = int(overrides["session_redis_ttl_sec"])

        min_ttl = int(auth_cfg["min_session_ttl_sec"])
        max_ttl = int(auth_cfg["max_session_ttl_sec"])
        return max(min_ttl, min(ttl_sec, max_ttl))

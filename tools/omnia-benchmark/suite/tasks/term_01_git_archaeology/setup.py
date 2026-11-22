#!/usr/bin/env python3
"""Deterministic Git repository initializer for term_01_git_archaeology."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import tempfile
from pathlib import Path


def find_git() -> str:
    git_bin = shutil.which("git")
    if git_bin:
        return git_bin
    fallback = Path(r"C:\Program Files\Git\cmd\git.exe")
    if fallback.is_file():
        return str(fallback)
    raise RuntimeError("git executable not found in PATH or standard location")


def write_text(root: Path, rel_path: str, content: str) -> None:
    target = root / rel_path
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8", newline="\n") as fh:
        fh.write(content)


def write_bytes(root: Path, rel_path: str, data: bytes) -> None:
    target = root / rel_path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)


def run_git(
    git_bin: str,
    repo: Path,
    args: list[str],
    *,
    env_extra: dict[str, str] | None = None,
) -> str:
    env = os.environ.copy()
    if env_extra:
        env.update(env_extra)
    proc = subprocess.run(
        [git_bin, *args],
        cwd=str(repo),
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"git {' '.join(args)} failed (rc={proc.returncode}):\n"
            f"STDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}"
        )
    return proc.stdout.strip()


def make_commit(
    git_bin: str,
    repo: Path,
    base_env: dict[str, str],
    message: str,
    iso_date: str,
    author_name: str = "Alex Mercer",
    author_email: str = "alex.mercer@nexuspay.internal",
) -> str:
    env = dict(base_env)
    env.update(
        {
            "GIT_AUTHOR_NAME": author_name,
            "GIT_AUTHOR_EMAIL": author_email,
            "GIT_COMMITTER_NAME": author_name,
            "GIT_COMMITTER_EMAIL": author_email,
            "GIT_AUTHOR_DATE": iso_date,
            "GIT_COMMITTER_DATE": iso_date,
        }
    )
    run_git(git_bin, repo, ["add", "-A"], env_extra=env)
    run_git(git_bin, repo, ["commit", "-m", message], env_extra=env)
    return run_git(git_bin, repo, ["rev-parse", "HEAD"], env_extra=env)


def build_repo(workspace: Path) -> dict[str, str]:
    workspace.mkdir(parents=True, exist_ok=True)
    git_bin = find_git()

    with tempfile.TemporaryDirectory() as cfg_tmp:
        empty_cfg = Path(cfg_tmp) / "empty.gitconfig"
        empty_cfg.write_text("", encoding="utf-8")
        base_env = {
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": str(empty_cfg),
            "GIT_TERMINAL_PROMPT": "0",
        }

        run_git(git_bin, workspace, ["init", "-b", "main"], env_extra=base_env)
        run_git(git_bin, workspace, ["config", "user.name", "Dev Agent"], env_extra=base_env)
        run_git(
            git_bin,
            workspace,
            ["config", "user.email", "dev@nexuspay.internal"],
            env_extra=base_env,
        )
        run_git(git_bin, workspace, ["config", "core.autocrlf", "false"], env_extra=base_env)
        run_git(git_bin, workspace, ["config", "core.eol", "lf"], env_extra=base_env)
        run_git(git_bin, workspace, ["config", "commit.gpgsign", "false"], env_extra=base_env)

        commits: dict[str, str] = {}

        # C1: Initial repository scaffold
        write_text(
            workspace,
            "README.md",
            (
                "# NexusPay Gateway Service\n\n"
                "Lightweight Python gateway service providing framed SHA-256 request "
                "verification, HMAC token authentication, response caching, and telemetry metrics.\n\n"
                "Run the test suite with:\n\n"
                "```bash\n"
                "python test_suite.py\n"
                "```\n"
            ),
        )
        write_text(workspace, ".gitignore", "__pycache__/\n*.pyc\n.pytest_cache/\n")
        write_text(workspace, "service/__init__.py", '"""NexusPay Gateway Service package."""\n')
        write_text(workspace, "tests/__init__.py", '"""NexusPay test suite."""\n')
        commits["C1"] = make_commit(
            git_bin,
            workspace,
            base_env,
            "chore: initialize nexuspay gateway repository",
            "2026-01-10T09:00:00Z",
        )

        # C2: Working framed SHA-256 checksum implementation
        write_text(
            workspace,
            "service/checksum.py",
            '''"""Length-prefixed SHA-256 framed checksum utilities."""

from __future__ import annotations

import hashlib
import hmac
from typing import Iterable


DEFAULT_SALT = b"NXP-V1"


def compute_frame_checksum(
    chunks: Iterable[bytes | str],
    salt: bytes = DEFAULT_SALT,
) -> str:
    """Compute a deterministic length-prefixed SHA-256 hex digest over payload chunks."""
    hasher = hashlib.sha256()
    hasher.update(salt)
    hasher.update(b"\\x00")
    for chunk in chunks:
        raw = chunk.encode("utf-8") if isinstance(chunk, str) else bytes(chunk)
        hasher.update(len(raw).to_bytes(4, "big"))
        hasher.update(raw)
    return hasher.hexdigest()


def verify_frame_checksum(
    chunks: Iterable[bytes | str],
    expected_hex: str,
    salt: bytes = DEFAULT_SALT,
) -> bool:
    """Verify a framed checksum using constant-time comparison."""
    if not isinstance(expected_hex, str) or len(expected_hex) != 64:
        return False
    actual = compute_frame_checksum(chunks, salt=salt)
    return hmac.compare_digest(actual, expected_hex.lower())
''',
        )
        write_text(
            workspace,
            "tests/test_checksum.py",
            '''"""Unit tests for framed SHA-256 checksum utilities."""

from __future__ import annotations

import hashlib
import unittest

from service.checksum import DEFAULT_SALT, compute_frame_checksum, verify_frame_checksum


class TestFramedChecksum(unittest.TestCase):
    def test_known_framed_vector(self) -> None:
        expected = hashlib.sha256(
            DEFAULT_SALT
            + b"\\x00"
            + (5).to_bytes(4, "big")
            + b"hello"
            + (5).to_bytes(4, "big")
            + b"world"
        ).hexdigest()
        actual = compute_frame_checksum(["hello", "world"])
        self.assertEqual(actual, expected)
        self.assertTrue(verify_frame_checksum(["hello", "world"], expected))

    def test_chunk_boundary_collision_resistance(self) -> None:
        digest_a = compute_frame_checksum(["ab", "c"])
        digest_b = compute_frame_checksum(["a", "bc"])
        self.assertNotEqual(digest_a, digest_b)

    def test_utf8_multibyte_payloads(self) -> None:
        digest_cafe = compute_frame_checksum(["caf\\u00e9", "v1"])
        digest_caf = compute_frame_checksum(["caf", "v1"])
        self.assertNotEqual(digest_cafe, digest_caf)
        self.assertTrue(verify_frame_checksum(["caf\\u00e9", "v1"], digest_cafe))

    def test_rejects_wrong_checksum(self) -> None:
        self.assertFalse(verify_frame_checksum(["alpha"], "0" * 64))
        self.assertFalse(verify_frame_checksum(["alpha"], "short"))
''',
        )
        commits["C2"] = make_commit(
            git_bin,
            workspace,
            base_env,
            "feat(checksum): implement length-prefixed SHA-256 framed checksum",
            "2026-01-10T10:15:00Z",
        )

        # C3: Initial v1 cache and auth modules
        write_text(
            workspace,
            "service/cache.py",
            '''"""Simple in-memory response cache (v1)."""

from __future__ import annotations

from typing import Any


class ResponseCache:
    """Basic bounded dict cache without LRU ordering or TTL eviction."""

    def __init__(self, max_size: int = 128) -> None:
        if max_size <= 0:
            raise ValueError("max_size must be positive")
        self.max_size = max_size
        self._store: dict[str, Any] = {}

    def get(self, key: str) -> Any | None:
        return self._store.get(key)

    def set(self, key: str, value: Any) -> None:
        if key not in self._store and len(self._store) >= self.max_size:
            first_key = next(iter(self._store))
            del self._store[first_key]
        self._store[key] = value

    def __len__(self) -> int:
        return len(self._store)
''',
        )
        write_text(
            workspace,
            "service/auth.py",
            '''"""Legacy token authenticator (v1)."""

from __future__ import annotations

import hashlib


class TokenAuthenticator:
    def __init__(self, secret: str) -> None:
        self._secret = secret

    def issue_token(self, user_id: str, role: str, ttl_seconds: int = 300) -> str:
        exp = 9999999999
        payload = f"{user_id}:{role}:{exp}"
        sig = hashlib.sha256(f"{self._secret}:{payload}".encode("utf-8")).hexdigest()
        return f"{payload}:{sig}"

    def verify_token(self, token: str) -> dict | None:
        parts = token.split(":")
        if len(parts) != 4:
            return None
        user_id, role, exp_str, sig = parts
        payload = f"{user_id}:{role}:{exp_str}"
        expected = hashlib.sha256(f"{self._secret}:{payload}".encode("utf-8")).hexdigest()
        if sig != expected:
            return None
        return {"user_id": user_id, "role": role, "expires_at": int(exp_str)}
''',
        )
        commits["C3"] = make_commit(
            git_bin,
            workspace,
            base_env,
            "feat(cache,auth): add initial response cache and token authenticator",
            "2026-01-10T11:30:00Z",
        )

        # C4: Gateway app + test runner
        write_text(
            workspace,
            "service/app.py",
            '''"""NexusPay Gateway Service entrypoint."""

from __future__ import annotations

from service.auth import TokenAuthenticator
from service.cache import ResponseCache
from service.checksum import verify_frame_checksum


class GatewayService:
    def __init__(self, secret: str, cache_size: int = 128) -> None:
        self.auth = TokenAuthenticator(secret)
        self.cache = ResponseCache(max_size=cache_size)

    def handle_request(
        self,
        token: str,
        payload_chunks: list[str | bytes],
        frame_checksum: str,
    ) -> dict:
        claims = self.auth.verify_token(token)
        if claims is None:
            return {"ok": False, "error": "unauthorized"}
        if not verify_frame_checksum(payload_chunks, frame_checksum):
            return {"ok": False, "error": "checksum_mismatch"}
        cache_key = f"{claims['user_id']}:{frame_checksum}"
        cached = self.cache.get(cache_key)
        if cached is not None:
            return {"ok": True, "cached": True, "data": cached}
        result = {
            "user": claims["user_id"],
            "chunks": len(payload_chunks),
            "checksum": frame_checksum,
        }
        self.cache.set(cache_key, result)
        return {"ok": True, "cached": False, "data": result}
''',
        )
        write_text(
            workspace,
            "tests/test_app.py",
            '''"""Integration tests for GatewayService."""

from __future__ import annotations

import unittest

from service.app import GatewayService
from service.checksum import compute_frame_checksum


class TestGatewayService(unittest.TestCase):
    def test_valid_request_and_cache_hit(self) -> None:
        svc = GatewayService("super-secret-key", cache_size=8)
        token = svc.auth.issue_token("u-100", "user", ttl_seconds=600)
        chunks = ["order:42", "amount:1999"]
        digest = compute_frame_checksum(chunks)

        first = svc.handle_request(token, chunks, digest)
        self.assertTrue(first["ok"])
        self.assertFalse(first["cached"])

        second = svc.handle_request(token, chunks, digest)
        self.assertTrue(second["ok"])
        self.assertTrue(second["cached"])
        self.assertEqual(second["data"]["user"], "u-100")

    def test_rejects_bad_checksum(self) -> None:
        svc = GatewayService("super-secret-key")
        token = svc.auth.issue_token("u-100", "user", ttl_seconds=600)
        resp = svc.handle_request(token, ["payload"], "f" * 64)
        self.assertFalse(resp["ok"])
        self.assertEqual(resp["error"], "checksum_mismatch")
''',
        )
        write_text(
            workspace,
            "test_suite.py",
            '''#!/usr/bin/env python3
"""Run all NexusPay Gateway unit and integration tests."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path


def main() -> int:
    root = Path(__file__).resolve().parent
    loader = unittest.defaultTestLoader
    suite = loader.discover(start_dir=str(root / "tests"), pattern="test_*.py", top_level_dir=str(root))
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
''',
        )
        commits["C4"] = make_commit(
            git_bin,
            workspace,
            base_env,
            "feat(app): wire gateway service and baseline unit test suite",
            "2026-01-10T13:00:00Z",
        )

        # Branch 1: feature/cache-v2 forked from C4
        run_git(git_bin, workspace, ["checkout", "-b", "feature/cache-v2"], env_extra=base_env)

        write_text(
            workspace,
            "service/cache.py",
            '''"""LRU + TTL response cache (v2)."""

from __future__ import annotations

from collections import OrderedDict
import time
from typing import Any, Callable


class ResponseCache:
    """Bounded LRU cache with per-entry monotonic TTL expiration."""

    def __init__(
        self,
        max_size: int = 128,
        default_ttl: float | None = 60.0,
        clock: Callable[[], float] | None = None,
    ) -> None:
        if max_size <= 0:
            raise ValueError("max_size must be positive")
        if default_ttl is not None and default_ttl <= 0:
            raise ValueError("default_ttl must be positive or None")
        self.max_size = max_size
        self.default_ttl = default_ttl
        self._clock: Callable[[], float] = clock or time.monotonic
        self._store: OrderedDict[str, tuple[Any, float | None]] = OrderedDict()
        self._hits = 0
        self._misses = 0
        self._evictions = 0

    def _is_expired(self, expires_at: float | None, now: float) -> bool:
        return expires_at is not None and now >= expires_at

    def purge_expired(self) -> int:
        now = self._clock()
        expired_keys = [
            key for key, (_, exp) in self._store.items() if self._is_expired(exp, now)
        ]
        for key in expired_keys:
            del self._store[key]
        return len(expired_keys)

    def get(self, key: str) -> Any | None:
        entry = self._store.get(key)
        if entry is None:
            self._misses += 1
            return None
        value, expires_at = entry
        if self._is_expired(expires_at, self._clock()):
            del self._store[key]
            self._misses += 1
            return None
        self._store.move_to_end(key)
        self._hits += 1
        return value

    def set(self, key: str, value: Any, ttl: float | None = None) -> None:
        now = self._clock()
        effective_ttl = self.default_ttl if ttl is None else ttl
        if effective_ttl is not None and effective_ttl <= 0:
            raise ValueError("ttl must be positive or None")
        expires_at = None if effective_ttl is None else now + effective_ttl
        if key in self._store:
            self._store[key] = (value, expires_at)
            self._store.move_to_end(key)
            return
        self.purge_expired()
        while len(self._store) >= self.max_size:
            self._store.popitem(last=False)
            self._evictions += 1
        self._store[key] = (value, expires_at)

    def stats(self) -> dict[str, int]:
        return {
            "size": len(self._store),
            "hits": self._hits,
            "misses": self._misses,
            "evictions": self._evictions,
        }

    def __len__(self) -> int:
        return len(self._store)
''',
        )
        commits["F1"] = make_commit(
            git_bin,
            workspace,
            base_env,
            "feat(cache): upgrade ResponseCache to OrderedDict LRU with monotonic TTL",
            "2026-01-11T09:30:00Z",
            author_name="Priya Nair",
            author_email="priya.nair@nexuspay.internal",
        )

        write_text(
            workspace,
            "service/app.py",
            '''"""NexusPay Gateway Service entrypoint."""

from __future__ import annotations

from typing import Callable

from service.auth import TokenAuthenticator
from service.cache import ResponseCache
from service.checksum import verify_frame_checksum


class GatewayService:
    def __init__(
        self,
        secret: str,
        cache_size: int = 128,
        *,
        cache_ttl: float | None = 60.0,
        cache_clock: Callable[[], float] | None = None,
    ) -> None:
        self.auth = TokenAuthenticator(secret)
        self.cache = ResponseCache(
            max_size=cache_size,
            default_ttl=cache_ttl,
            clock=cache_clock,
        )

    def handle_request(
        self,
        token: str,
        payload_chunks: list[str | bytes],
        frame_checksum: str,
    ) -> dict:
        claims = self.auth.verify_token(token)
        if claims is None:
            return {"ok": False, "error": "unauthorized"}
        if not verify_frame_checksum(payload_chunks, frame_checksum):
            return {"ok": False, "error": "checksum_mismatch"}
        cache_key = f"{claims['user_id']}:{frame_checksum}"
        cached = self.cache.get(cache_key)
        if cached is not None:
            return {"ok": True, "cached": True, "data": cached}
        result = {
            "user": claims["user_id"],
            "chunks": len(payload_chunks),
            "checksum": frame_checksum,
        }
        self.cache.set(cache_key, result)
        return {"ok": True, "cached": False, "data": result}
''',
        )
        commits["F2"] = make_commit(
            git_bin,
            workspace,
            base_env,
            "feat(app): integrate cache-v2 TTL and clock options into GatewayService",
            "2026-01-11T10:45:00Z",
            author_name="Priya Nair",
            author_email="priya.nair@nexuspay.internal",
        )

        write_text(
            workspace,
            "tests/test_cache_v2.py",
            '''"""Unit and integration tests for ResponseCache v2 (LRU + TTL)."""

from __future__ import annotations

import unittest

from service.app import GatewayService
from service.cache import ResponseCache
from service.checksum import compute_frame_checksum


class TestCacheV2(unittest.TestCase):
    def test_lru_eviction_respects_recency(self) -> None:
        now = [100.0]
        cache = ResponseCache(max_size=2, default_ttl=60.0, clock=lambda: now[0])
        cache.set("k1", "v1")
        cache.set("k2", "v2")
        self.assertEqual(cache.get("k1"), "v1")  # k1 becomes MRU
        cache.set("k3", "v3")  # should evict k2
        self.assertIsNone(cache.get("k2"))
        self.assertEqual(cache.get("k1"), "v1")
        self.assertEqual(cache.get("k3"), "v3")
        self.assertEqual(cache.stats()["evictions"], 1)

    def test_ttl_expiration_and_purge(self) -> None:
        now = [10.0]
        cache = ResponseCache(max_size=4, default_ttl=5.0, clock=lambda: now[0])
        cache.set("short", 1, ttl=3.0)
        cache.set("long", 2, ttl=20.0)
        now[0] = 13.0
        self.assertIsNone(cache.get("short"))
        self.assertEqual(cache.get("long"), 2)
        now[0] = 35.0
        self.assertEqual(cache.purge_expired(), 1)
        self.assertEqual(len(cache), 0)

    def test_gateway_respects_cache_ttl(self) -> None:
        cache_now = [50.0]
        svc = GatewayService(
            "secret-cache-v2",
            cache_size=2,
            cache_ttl=10.0,
            cache_clock=lambda: cache_now[0],
        )
        token = svc.auth.issue_token("u-7", "user", ttl_seconds=600)
        chunks = ["item:1"]
        digest = compute_frame_checksum(chunks)

        r1 = svc.handle_request(token, chunks, digest)
        self.assertTrue(r1["ok"])
        self.assertFalse(r1["cached"])

        r2 = svc.handle_request(token, chunks, digest)
        self.assertTrue(r2["ok"])
        self.assertTrue(r2["cached"])

        cache_now[0] = 61.0
        r3 = svc.handle_request(token, chunks, digest)
        self.assertTrue(r3["ok"])
        self.assertFalse(r3["cached"])
''',
        )
        commits["F3"] = make_commit(
            git_bin,
            workspace,
            base_env,
            "test(cache): add LRU eviction and TTL expiration coverage",
            "2026-01-11T12:00:00Z",
            author_name="Priya Nair",
            author_email="priya.nair@nexuspay.internal",
        )

        # Branch 2: hotfix/auth forked from C4
        run_git(git_bin, workspace, ["checkout", "main"], env_extra=base_env)
        run_git(git_bin, workspace, ["checkout", "-b", "hotfix/auth"], env_extra=base_env)

        write_text(
            workspace,
            "service/auth.py",
            '''"""Hardened HMAC-SHA256 token authenticator with expiry verification."""

from __future__ import annotations

import hashlib
import hmac
import time
from typing import Callable


ALLOWED_ROLES = frozenset({"admin", "service", "user"})


class TokenAuthenticator:
    def __init__(self, secret: str, clock: Callable[[], float] | None = None) -> None:
        if not secret:
            raise ValueError("secret must be non-empty")
        self._secret_bytes = secret.encode("utf-8")
        self._clock: Callable[[], float] = clock or time.time

    def _sign(self, payload: str) -> str:
        return hmac.new(
            self._secret_bytes,
            payload.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()

    def issue_token(self, user_id: str, role: str, ttl_seconds: int = 300) -> str:
        if role not in ALLOWED_ROLES:
            raise ValueError(f"unsupported role: {role}")
        if ttl_seconds <= 0:
            raise ValueError("ttl_seconds must be positive")
        expires_at = int(self._clock()) + int(ttl_seconds)
        payload = f"{user_id}:{role}:{expires_at}"
        sig = self._sign(payload)
        return f"{payload}:{sig}"

    def verify_token(self, token: str) -> dict | None:
        if not isinstance(token, str):
            return None
        parts = token.split(":")
        if len(parts) != 4:
            return None
        user_id, role, exp_str, sig = parts
        if not user_id or role not in ALLOWED_ROLES:
            return None
        try:
            expires_at = int(exp_str)
        except ValueError:
            return None
        if expires_at <= int(self._clock()):
            return None
        payload = f"{user_id}:{role}:{expires_at}"
        expected = self._sign(payload)
        if not hmac.compare_digest(expected, sig):
            return None
        return {"user_id": user_id, "role": role, "expires_at": expires_at}
''',
        )
        write_text(
            workspace,
            "tests/test_auth.py",
            '''"""Security tests for hardened TokenAuthenticator."""

from __future__ import annotations

import unittest

from service.auth import TokenAuthenticator


class TestAuthSecurity(unittest.TestCase):
    def test_valid_and_expired_token(self) -> None:
        now = [1_700_000_000.0]
        auth = TokenAuthenticator("hmac-key-99", clock=lambda: now[0])
        token = auth.issue_token("alice", "admin", ttl_seconds=60)
        claims = auth.verify_token(token)
        self.assertIsNotNone(claims)
        assert claims is not None
        self.assertEqual(claims["user_id"], "alice")
        self.assertEqual(claims["role"], "admin")

        now[0] += 60.0
        self.assertIsNone(auth.verify_token(token))

    def test_rejects_tampered_signature_or_role(self) -> None:
        now = [1_700_000_000.0]
        auth = TokenAuthenticator("hmac-key-99", clock=lambda: now[0])
        token = auth.issue_token("bob", "user", ttl_seconds=120)
        parts = token.split(":")
        tampered_sig = ":".join(parts[:3] + [("0" if parts[3][0] != "0" else "1") + parts[3][1:]])
        self.assertIsNone(auth.verify_token(tampered_sig))
        tampered_role = ":".join([parts[0], "admin", parts[2], parts[3]])
        self.assertIsNone(auth.verify_token(tampered_role))
''',
        )
        commits["H1"] = make_commit(
            git_bin,
            workspace,
            base_env,
            "fix(auth): enforce HMAC-SHA256 constant-time verification and token expiry",
            "2026-01-12T08:10:00Z",
            author_name="Marcus Vance",
            author_email="marcus.vance@nexuspay.internal",
        )

        write_text(
            workspace,
            "service/app.py",
            '''"""NexusPay Gateway Service entrypoint."""

from __future__ import annotations

from typing import Callable

from service.auth import ALLOWED_ROLES, TokenAuthenticator
from service.cache import ResponseCache
from service.checksum import verify_frame_checksum


class GatewayService:
    def __init__(
        self,
        secret: str,
        cache_size: int = 128,
        *,
        auth_clock: Callable[[], float] | None = None,
    ) -> None:
        self.auth = TokenAuthenticator(secret, clock=auth_clock)
        self.cache = ResponseCache(max_size=cache_size)

    def handle_request(
        self,
        token: str,
        payload_chunks: list[str | bytes],
        frame_checksum: str,
    ) -> dict:
        claims = self.auth.verify_token(token)
        if claims is None or claims.get("role") not in ALLOWED_ROLES:
            return {"ok": False, "error": "unauthorized"}
        if not verify_frame_checksum(payload_chunks, frame_checksum):
            return {"ok": False, "error": "checksum_mismatch"}
        cache_key = f"{claims['user_id']}:{claims['role']}:{frame_checksum}"
        cached = self.cache.get(cache_key)
        if cached is not None:
            return {"ok": True, "cached": True, "data": cached}
        result = {
            "user": claims["user_id"],
            "role": claims["role"],
            "chunks": len(payload_chunks),
            "checksum": frame_checksum,
        }
        self.cache.set(cache_key, result)
        return {"ok": True, "cached": False, "data": result}
''',
        )
        commits["H2"] = make_commit(
            git_bin,
            workspace,
            base_env,
            "fix(app): enforce role validation and injectable auth clock in GatewayService",
            "2026-01-12T08:45:00Z",
            author_name="Marcus Vance",
            author_email="marcus.vance@nexuspay.internal",
        )

        # Back to main: C5 docs commit
        run_git(git_bin, workspace, ["checkout", "main"], env_extra=base_env)
        write_text(
            workspace,
            "docs/ARCHITECTURE.md",
            (
                "# NexusPay Gateway Architecture\n\n"
                "1. Request arrives with bearer token and chunked payload.\n"
                "2. `TokenAuthenticator` verifies HMAC signature and expiry.\n"
                "3. `verify_frame_checksum` validates length-prefixed SHA-256 framing.\n"
                "4. `ResponseCache` serves cached responses when valid.\n"
            ),
        )
        commits["C5"] = make_commit(
            git_bin,
            workspace,
            base_env,
            "docs: add architecture notes and request flow overview",
            "2026-01-12T10:00:00Z",
        )

        # C6: Merge hotfix/auth into main (--no-ff real merge commit)
        merge_env = dict(base_env)
        merge_env.update(
            {
                "GIT_AUTHOR_NAME": "Alex Mercer",
                "GIT_AUTHOR_EMAIL": "alex.mercer@nexuspay.internal",
                "GIT_COMMITTER_NAME": "Alex Mercer",
                "GIT_COMMITTER_EMAIL": "alex.mercer@nexuspay.internal",
                "GIT_AUTHOR_DATE": "2026-01-12T11:00:00Z",
                "GIT_COMMITTER_DATE": "2026-01-12T11:00:00Z",
            }
        )
        run_git(
            git_bin,
            workspace,
            ["merge", "--no-ff", "hotfix/auth", "-m", "Merge branch 'hotfix/auth' into main"],
            env_extra=merge_env,
        )
        commits["C6"] = run_git(git_bin, workspace, ["rev-parse", "HEAD"], env_extra=base_env)

        # C7: Config defaults
        write_text(
            workspace,
            "config/defaults.json",
            '{\n  "cache_size": 256,\n  "cache_ttl_seconds": 60,\n  "token_ttl_seconds": 300\n}\n',
        )
        commits["C7"] = make_commit(
            git_bin,
            workspace,
            base_env,
            "chore(config): add default gateway runtime settings",
            "2026-01-13T09:15:00Z",
        )

        # C8: CULPRIT COMMIT — subtle checksum regression!
        write_text(
            workspace,
            "service/checksum.py",
            '''"""Length-prefixed SHA-256 framed checksum utilities."""

from __future__ import annotations

import hashlib
import hmac
from typing import Iterable


DEFAULT_SALT = b"NXP-V1"


def compute_frame_checksum(
    chunks: Iterable[bytes | str],
    salt: bytes = DEFAULT_SALT,
) -> str:
    """Compute a SHA-256 hex digest over payload chunks."""
    hasher = hashlib.sha256()
    hasher.update(salt)
    joined = b"".join(
        chunk.encode("ascii", errors="ignore") if isinstance(chunk, str) else bytes(chunk)
        for chunk in chunks
    )
    hasher.update(joined)
    return hasher.hexdigest()


def verify_frame_checksum(
    chunks: Iterable[bytes | str],
    expected_hex: str,
    salt: bytes = DEFAULT_SALT,
) -> bool:
    """Verify a framed checksum using constant-time comparison."""
    if not isinstance(expected_hex, str) or len(expected_hex) != 64:
        return False
    actual = compute_frame_checksum(chunks, salt=salt)
    return hmac.compare_digest(actual, expected_hex.lower())
''',
        )
        commits["C8"] = make_commit(
            git_bin,
            workspace,
            base_env,
            "refactor(checksum): optimize chunk hashing loop",
            "2026-01-14T14:20:00Z",
            author_name="Devon Park",
            author_email="devon.park@nexuspay.internal",
        )

        # C9: Accidentally tracked binary build artifact
        write_bytes(workspace, "build/artifact.bin", bytes((i * 37) % 256 for i in range(256)))
        commits["C9"] = make_commit(
            git_bin,
            workspace,
            base_env,
            "chore(build): snapshot local staging artifact",
            "2026-01-15T08:05:00Z",
            author_name="Devon Park",
            author_email="devon.park@nexuspay.internal",
        )

        # C10: Good post-regression commit — telemetry metrics module (MUST NOT BE LOST!)
        write_text(
            workspace,
            "service/metrics.py",
            '''"""In-memory telemetry metrics registry."""

from __future__ import annotations

from collections import defaultdict


class MetricsRegistry:
    """Tracks monotonic counters and observed numeric values."""

    def __init__(self) -> None:
        self._counters: dict[str, int] = defaultdict(int)
        self._observations: dict[str, list[float]] = defaultdict(list)

    def increment(self, name: str, amount: int = 1) -> int:
        if amount < 0:
            raise ValueError("counter increment must be non-negative")
        self._counters[name] += amount
        return self._counters[name]

    def observe(self, name: str, value: float) -> None:
        self._observations[name].append(float(value))

    def get_counter(self, name: str) -> int:
        return self._counters.get(name, 0)

    def snapshot(self) -> dict[str, dict]:
        return {
            "counters": dict(self._counters),
            "observations": {k: list(v) for k, v in self._observations.items()},
        }
''',
        )
        write_text(
            workspace,
            "tests/test_metrics.py",
            '''"""Unit tests for MetricsRegistry."""

from __future__ import annotations

import unittest

from service.metrics import MetricsRegistry


class TestMetricsRegistry(unittest.TestCase):
    def test_counters_and_observations(self) -> None:
        reg = MetricsRegistry()
        self.assertEqual(reg.get_counter("requests_total"), 0)
        reg.increment("requests_total")
        reg.increment("requests_total", 3)
        reg.observe("latency_ms", 12.5)
        reg.observe("latency_ms", 25.0)
        snap = reg.snapshot()
        self.assertEqual(snap["counters"]["requests_total"], 4)
        self.assertEqual(snap["observations"]["latency_ms"], [12.5, 25.0])
''',
        )
        commits["C10"] = make_commit(
            git_bin,
            workspace,
            base_env,
            "feat(metrics): add MetricsRegistry telemetry collector",
            "2026-01-16T11:40:00Z",
        )

        # C11: Good post-regression commit — wire metrics into GatewayService (MUST NOT BE LOST!)
        write_text(
            workspace,
            "service/app.py",
            '''"""NexusPay Gateway Service entrypoint."""

from __future__ import annotations

from typing import Callable

from service.auth import ALLOWED_ROLES, TokenAuthenticator
from service.cache import ResponseCache
from service.checksum import verify_frame_checksum
from service.metrics import MetricsRegistry


class GatewayService:
    def __init__(
        self,
        secret: str,
        cache_size: int = 128,
        *,
        auth_clock: Callable[[], float] | None = None,
    ) -> None:
        self.auth = TokenAuthenticator(secret, clock=auth_clock)
        self.cache = ResponseCache(max_size=cache_size)
        self.metrics = MetricsRegistry()

    def handle_request(
        self,
        token: str,
        payload_chunks: list[str | bytes],
        frame_checksum: str,
    ) -> dict:
        self.metrics.increment("requests_total")
        claims = self.auth.verify_token(token)
        if claims is None or claims.get("role") not in ALLOWED_ROLES:
            self.metrics.increment("auth_failures")
            return {"ok": False, "error": "unauthorized"}
        if not verify_frame_checksum(payload_chunks, frame_checksum):
            self.metrics.increment("checksum_failures")
            return {"ok": False, "error": "checksum_mismatch"}
        cache_key = f"{claims['user_id']}:{claims['role']}:{frame_checksum}"
        cached = self.cache.get(cache_key)
        if cached is not None:
            self.metrics.increment("cache_hits")
            return {"ok": True, "cached": True, "data": cached}
        self.metrics.increment("cache_misses")
        result = {
            "user": claims["user_id"],
            "role": claims["role"],
            "chunks": len(payload_chunks),
            "checksum": frame_checksum,
        }
        self.cache.set(cache_key, result)
        return {"ok": True, "cached": False, "data": result}
''',
        )
        write_text(
            workspace,
            "tests/test_app.py",
            '''"""Integration tests for GatewayService."""

from __future__ import annotations

import unittest

from service.app import GatewayService
from service.checksum import compute_frame_checksum


class TestGatewayService(unittest.TestCase):
    def test_valid_request_cache_and_metrics(self) -> None:
        now = [1_700_000_000.0]
        svc = GatewayService("super-secret-key", cache_size=8, auth_clock=lambda: now[0])
        token = svc.auth.issue_token("u-100", "service", ttl_seconds=600)
        chunks = ["order:42", "amount:1999"]
        digest = compute_frame_checksum(chunks)

        first = svc.handle_request(token, chunks, digest)
        self.assertTrue(first["ok"])
        self.assertFalse(first["cached"])
        self.assertEqual(first["data"]["role"], "service")

        second = svc.handle_request(token, chunks, digest)
        self.assertTrue(second["ok"])
        self.assertTrue(second["cached"])

        snap = svc.metrics.snapshot()["counters"]
        self.assertEqual(snap["requests_total"], 2)
        self.assertEqual(snap["cache_misses"], 1)
        self.assertEqual(snap["cache_hits"], 1)

    def test_rejects_expired_token_and_bad_checksum(self) -> None:
        now = [1_700_000_000.0]
        svc = GatewayService("super-secret-key", auth_clock=lambda: now[0])
        token = svc.auth.issue_token("u-100", "user", ttl_seconds=10)
        bad = svc.handle_request(token, ["payload"], "f" * 64)
        self.assertFalse(bad["ok"])
        self.assertEqual(bad["error"], "checksum_mismatch")

        now[0] += 20.0
        exp = svc.handle_request(token, ["payload"], compute_frame_checksum(["payload"]))
        self.assertFalse(exp["ok"])
        self.assertEqual(exp["error"], "unauthorized")
        self.assertEqual(svc.metrics.get_counter("checksum_failures"), 1)
        self.assertEqual(svc.metrics.get_counter("auth_failures"), 1)
''',
        )
        commits["C11"] = make_commit(
            git_bin,
            workspace,
            base_env,
            "feat(app): record gateway request and error telemetry metrics",
            "2026-01-16T15:00:00Z",
        )

    return commits


def main() -> int:
    parser = argparse.ArgumentParser(description="Initialize term_01_git_archaeology workspace.")
    parser.add_argument("--workspace", required=True, help="Target workspace directory")
    args = parser.parse_args()
    build_repo(Path(args.workspace).resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

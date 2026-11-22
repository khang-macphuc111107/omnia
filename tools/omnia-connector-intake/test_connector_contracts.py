"""Unit tests for Omnia deterministic connector intake contracts."""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

MODULE_DIR = Path(__file__).resolve().parent
if str(MODULE_DIR) not in sys.path:
    sys.path.insert(0, str(MODULE_DIR))

import connector_contracts as cc  # noqa: E402

CLI_PATH = MODULE_DIR / "cli.py"


class ProxyRouteNormalizerTests(unittest.TestCase):
    def test_valid_env_ref_and_routing_defaults(self) -> None:
        raw = {
            "server": {"api_keys": ["${OMNIA_GATEWAY_KEY}"]},
            "routing": {
                "strategy": "weighted_round_robin",
                "rate_limit_cooldown": "15s",
                "server_error_cooldown": "30s",
                "busy_retry_wait": "5s",
                "max_concurrent": 8,
            },
            "provider_nodes": [
                {
                    "id": "node-primary",
                    "provider_id": "openai",
                    "model_id": "gpt-5",
                    "base_url": "https://api.openai.com/v1",
                    "api_type": "openai",
                    "privacy_tier": "ZeroDataRetention",
                    "api_key": "${OPENAI_API_KEY}",
                    "headers": {"X-Workspace-Mode": "strict"},
                    "circuit_breaker": {
                        "state": "closed",
                        "failure_threshold": 3,
                        "cooldown_ms": 30000,
                    },
                    "quota": {"kind": "Known", "remaining_units": 50000, "source": "header"},
                }
            ],
        }
        out = cc.normalize_proxy_route_config(raw)
        self.assertTrue(out["valid"], out["findings"])
        self.assertEqual(out["status"], "ACCEPTED")
        self.assertEqual(out["routing_policy"]["rate_limit_cooldown_ms"], 15_000)
        self.assertEqual(out["routing_policy"]["server_error_cooldown_ms"], 30_000)
        self.assertEqual(out["routing_policy"]["client_fault_exempt_statuses"], [400, 409, 413, 422])
        cand = out["candidates"][0]
        self.assertEqual(cand["privacy_tier"], "ZeroDataRetention")
        self.assertTrue(cand["credential_present"])
        self.assertEqual(cand["credential_source"], "env_ref")
        state = out["resource_states"]["node-primary"]
        self.assertEqual(state["circuit_state"], "Closed")
        self.assertEqual(state["quota"]["kind"], "Known")

    def test_refuses_and_redacts_literal_bearer_and_api_keys(self) -> None:
        fake_sk = "sk" + "-" + "dummysecret123456"
        fake_bearer = "Bearer " + "opaque_bearer_" + "987654321"
        fake_google = "AI" + "za" + "DummySyntheticKey1234567890"
        raw = {
            "server": {"api_keys": [fake_sk]},
            "accounts": [
                {
                    "id": "acct-1",
                    "provider": "google",
                    "model": "gemini-2.5-pro",
                    "base_url": "https://generativelanguage.googleapis.com/v1beta",
                    "api_key": fake_google,
                    "headers": {"Authorization": fake_bearer},
                }
            ],
        }
        out = cc.normalize_proxy_route_config(raw)
        self.assertFalse(out["valid"])
        self.assertEqual(out["status"], "REFUSED")
        codes = {f["code"] for f in out["findings"]}
        self.assertIn("ERR_LITERAL_SECRET_PRESENT", codes)
        dumped = json.dumps(out)
        self.assertNotIn(fake_sk, dumped)
        self.assertNotIn("opaque_bearer_", dumped)
        self.assertNotIn(fake_google, dumped)

    def test_strips_url_userinfo_and_query_secrets(self) -> None:
        raw = {
            "provider_nodes": [
                {
                    "id": "node-url-leak",
                    "provider_id": "custom",
                    "model_id": "m1",
                    "base_url": "https://" + "user1:pass1" + "@" + "relay.example.com/v1?api_key=leakvalue999&v=2",
                }
            ]
        }
        out = cc.normalize_proxy_route_config(raw)
        self.assertFalse(out["valid"])
        codes = {f["code"] for f in out["findings"]}
        self.assertIn("ERR_URL_EMBEDDED_CREDENTIALS", codes)
        self.assertIn("ERR_URL_QUERY_SECRET", codes)
        dumped = json.dumps(out)
        self.assertNotIn("pass1", dumped)
        self.assertNotIn("leakvalue999", dumped)
        self.assertNotIn("user1@", dumped)

    def test_flags_ssrf_metadata_and_non_tls_remote_allows_loopback(self) -> None:
        bad = cc.normalize_proxy_route_config(
            {
                "provider_nodes": [
                    {
                        "id": "ssrf",
                        "base_url": "http://169.254.169.254/latest/meta-data",
                        "api_key": "${KEY}",
                    },
                    {
                        "id": "plain-remote",
                        "base_url": "http://api.remote.example/v1",
                        "api_key": "${KEY}",
                    },
                ]
            }
        )
        codes = {f["code"] for f in bad["findings"]}
        self.assertIn("ERR_SSRF_METADATA_HOST", codes)
        self.assertIn("ERR_UNSAFE_NON_TLS_ENDPOINT", codes)

        loopback = cc.normalize_proxy_route_config(
            {
                "provider_nodes": [
                    {
                        "id": "local-llamacpp",
                        "privacy_tier": "LocalOnly",
                        "base_url": "http://127.0.0.1:8080/v1",
                    }
                ]
            }
        )
        self.assertTrue(loopback["valid"], loopback["findings"])

    def test_rejects_default_password_and_spoofing_flags(self) -> None:
        raw = {
            "management": {"password": "123" + "456"},
            "claude_code_cloak": True,
            "tls_impersonation": True,
            "recaptcha_bypass": True,
        }
        out = cc.normalize_proxy_route_config(raw)
        self.assertFalse(out["valid"])
        codes = {f["code"] for f in out["findings"]}
        self.assertIn("ERR_DEFAULT_MGMT_PASSWORD", codes)
        self.assertIn("ERR_REJECTED_SPOOFING_POLICY", codes)
        self.assertIn("ERR_REJECTED_ANTI_BOT_BYPASS", codes)

    def test_detects_combo_cycle_and_invalid_duration_bounds(self) -> None:
        raw = {
            "routing": {"rate_limit_cooldown": "-5s", "max_concurrent": 0},
            "combos": [
                {"combo_id": "combo-a", "models": ["combo-b"]},
                {"combo_id": "combo-b", "models": ["combo-a"]},
            ],
        }
        out = cc.normalize_proxy_route_config(raw)
        self.assertFalse(out["valid"])
        codes = {f["code"] for f in out["findings"]}
        self.assertIn("ERR_COMBO_CYCLE", codes)
        self.assertIn("ERR_INVALID_DURATION_BOUNDS", codes)
        self.assertIn("ERR_INVALID_CONCURRENCY_LIMIT", codes)


class NotebookBundleValidatorTests(unittest.TestCase):
    def test_valid_bundle_and_provenance_edges(self) -> None:
        src_text = "# Spec\nDeterministic workflow.\n"
        digest = hashlib.sha256(src_text.encode("utf-8")).hexdigest()
        bundle = {
            "namespace_path": "connectors/notebook/repo-a",
            "tier": "durable",
            "sources": [
                {
                    "source_id": "src-spec",
                    "remote_id": "remote-001",
                    "rel_path": "docs/spec.md",
                    "title": "spec.md",
                    "mime_type": "text/markdown",
                    "byte_len": len(src_text.encode("utf-8")),
                    "content": src_text,
                    "content_sha256": digest,
                    "provenance": "extracted",
                }
            ],
            "citations": [
                {
                    "citation_id": "cit-1",
                    "remote_id": "remote-001",
                    "quote": "Deterministic workflow.",
                    "provenance": "extracted",
                }
            ],
        }
        out = cc.validate_notebook_bundle(bundle)
        self.assertTrue(out["valid"], out["findings"])
        self.assertEqual(len(out["entries"]), 1)
        self.assertEqual(out["entries"][0]["content_sha256"], digest)
        self.assertEqual(len(out["edges"]), 1)
        self.assertEqual(out["edges"][0]["to_id"], "src-spec")
        self.assertEqual(out["edges"][0]["provenance"], "extracted")

    def test_rejects_invalid_memory_namespaces(self) -> None:
        for bad_ns in (
            "",
            "/leading",
            "a//b",
            "a/../b",
            "a\\b",
            "a:b",
            "1/2/3/4/5/6/7/8/9",
        ):
            self.assertFalse(cc.is_valid_memory_namespace(bad_ns), bad_ns)
            res = cc.validate_notebook_bundle({"namespace_path": bad_ns, "sources": []})
            self.assertEqual(res["findings"][0]["code"], "ERR_INVALID_NAMESPACE")

    def test_rejects_path_traversal_and_absolute_paths(self) -> None:
        win_abs = "\\".join(["C:", "secret", "notes.md"])
        for bad_path in ("../../etc/passwd", "%2e%2e/secret.md", win_abs, "\\\\server\\share\\a.md"):
            res = cc.validate_notebook_bundle(
                {
                    "namespace_path": "connectors/notebook",
                    "sources": [
                        {
                            "source_id": "s1",
                            "rel_path": bad_path,
                            "content": "hello",
                        }
                    ],
                }
            )
            self.assertFalse(res["valid"])
            self.assertIn("ERR_PATH_TRAVERSAL", {f["code"] for f in res["findings"]})

    def test_strips_private_disk_paths_and_redacts_home_strings(self) -> None:
        fake_home = "\\".join(["C:", "Users", "demo_user", "workspace", "notes.md"])
        res = cc.validate_notebook_bundle(
            {
                "namespace_path": "connectors/notebook",
                "sources": [
                    {
                        "source_id": "s1",
                        "rel_path": "docs/notes.md",
                        "localPath": fake_home,
                        "diskPath": fake_home,
                        "fullPath": fake_home,
                        "originalPath": fake_home,
                        "content": f"Located at {fake_home}",
                    }
                ],
            }
        )
        self.assertTrue(res["valid"], res["findings"])
        codes = {f["code"] for f in res["findings"]}
        self.assertIn("WARN_STRIPPED_PRIVATE_DISK_PATHS", codes)
        self.assertIn("WARN_REDACTED_USER_PROFILE_PATH", codes)
        dumped = json.dumps(res)
        self.assertNotIn("demo_user", dumped)

    def test_enforces_mime_extension_allowlist_and_rejects_executables(self) -> None:
        exe_res = cc.validate_notebook_bundle(
            {
                "namespace_path": "connectors/notebook",
                "sources": [
                    {
                        "source_id": "s-exe",
                        "rel_path": "bin/tool.exe",
                        "mime_type": "application/x-msdownload",
                        "content_sha256": "a" * 64,
                    }
                ],
            }
        )
        self.assertFalse(exe_res["valid"])
        self.assertIn("ERR_FORBIDDEN_FILE_TYPE", {f["code"] for f in exe_res["findings"]})

        mismatch = cc.validate_notebook_bundle(
            {
                "namespace_path": "connectors/notebook",
                "sources": [
                    {
                        "source_id": "s-pdf",
                        "rel_path": "docs/paper.pdf",
                        "mime_type": "text/html",
                        "content_sha256": "b" * 64,
                    }
                ],
            }
        )
        self.assertFalse(mismatch["valid"])
        self.assertIn("ERR_MIME_EXTENSION_MISMATCH", {f["code"] for f in mismatch["findings"]})

    def test_rejects_xxe_archive_depth_chunk_overflow_and_marks_encrypted_pdf(self) -> None:
        xxe_body = "<?xml version='1.0'?><!DOCTYPE root [<!ENTITY e SYSTEM 'file:///x'>]><root>&e;</root>"
        res = cc.validate_notebook_bundle(
            {
                "namespace_path": "connectors/notebook",
                "sources": [
                    {
                        "source_id": "xml-xxe",
                        "rel_path": "data/feed.xml",
                        "mime_type": "application/xml",
                        "content": xxe_body,
                        "archive_depth": 6,
                        "chunk_bytes": cc.MAX_SAFE_TXT_CHUNK_BYTES + 1,
                    },
                    {
                        "source_id": "enc-pdf",
                        "rel_path": "docs/locked.pdf",
                        "mime_type": "application/pdf",
                        "pdf_encrypted": True,
                        "content_sha256": "c" * 64,
                    },
                ],
            }
        )
        self.assertFalse(res["valid"])
        codes = {f["code"] for f in res["findings"]}
        self.assertIn("ERR_XXE_FORBIDDEN", codes)
        self.assertIn("ERR_ARCHIVE_DEPTH_EXCEEDED", codes)
        self.assertIn("ERR_CHUNK_SIZE_EXCEEDED", codes)
        enc_entry = [e for e in res["entries"] if e["id"] == "enc-pdf"][0]
        self.assertEqual(enc_entry["extraction_status"], "UNREADABLE:ENCRYPTED_PDF")

    def test_rejects_ambiguous_equal_title_citation_without_remote_id(self) -> None:
        res = cc.validate_notebook_bundle(
            {
                "namespace_path": "connectors/notebook",
                "sources": [
                    {"source_id": "id-1", "rel_path": "a/design.md", "title": "design.md", "content": "A"},
                    {"source_id": "id-2", "rel_path": "b/design.md", "title": "design.md", "content": "B"},
                ],
                "citations": [{"citation_id": "c1", "source_title": "design.md"}],
            }
        )
        self.assertFalse(res["valid"])
        self.assertIn("ERR_AMBIGUOUS_CITATION_TARGET", {f["code"] for f in res["findings"]})


class DownloadManifestValidatorTests(unittest.TestCase):
    def test_valid_segmented_manifest_and_payload_blob(self) -> None:
        digest = "0123456789abcdef" * 4
        manifest = {
            "filename": "lecture-archive.tar.gz",
            "source_url": "https://cdn.example.com/dl/file?utm_source=ads&X-Amz-Expires=300&X-Amz-Signature=sigval123",
            "mime_type": "application/gzip",
            "total_bytes": 3000,
            "etag": '"etag-strong-v1"',
            "sha256": f"sha256:{digest}",
            "status": "completed",
            "drm_supported": False,
            "auth_boundary": "MANUAL_VISIBLE_BROWSER_ONLY",
            "ws_origin": "chrome-extension://abcdefghijklmnop",
            "segments": [
                {"index": 0, "start": 0, "end": 999, "downloaded_bytes": 1000, "completed": True},
                {"index": 1, "start": 1000, "end": 1999, "downloaded_bytes": 1000, "completed": True},
                {"index": 2, "start": 2000, "end": 2999, "downloaded_bytes": 1000, "completed": True},
            ],
        }
        res = cc.validate_download_manifest(manifest)
        self.assertTrue(res["valid"], res["findings"])
        self.assertEqual(res["validator_strength"], "strong_etag")
        self.assertTrue(res["resume_safe"])
        self.assertTrue(res["range_summary"]["is_range_complete"])
        self.assertTrue(res["range_summary"]["is_download_complete"])
        self.assertEqual(res["payload_blob"]["sha256"], digest)
        self.assertEqual(res["payload_blob"]["extraction_status"], "VERIFIED_COMPLETE")
        self.assertEqual(res["stripped_tracking_params"], ["utm_source"])
        self.assertIn("X-Amz-Signature", res["preserved_signed_params"])
        self.assertNotIn("sigval123", res["source_url_sanitized"])

    def test_detects_gaps_and_overlaps_without_double_counting(self) -> None:
        manifest = {
            "filename": "dataset.bin",
            "source_url": "https://files.example.com/dataset.bin",
            "total_bytes": 500,
            "require_complete": True,
            "sha256": "a" * 64,
            "segments": [
                {"index": 0, "start": 0, "end": 99, "downloaded_bytes": 100, "completed": True},
                {"index": 1, "start": 200, "end": 299, "downloaded_bytes": 100, "completed": True},
                {"index": 2, "start": 250, "end": 499, "downloaded_bytes": 250, "completed": True},
            ],
        }
        res = cc.validate_download_manifest(manifest)
        self.assertFalse(res["valid"])
        codes = {f["code"] for f in res["findings"]}
        self.assertIn("ERR_RANGE_OVERLAP", codes)
        self.assertIn("ERR_RANGE_GAPS_DETECTED", codes)
        rs = res["range_summary"]
        self.assertEqual(rs["gaps"], [{"start": 100, "end": 199}])
        self.assertEqual(rs["overlaps"], [{"start": 250, "end": 299}])
        self.assertEqual(rs["covered_bytes"], 400)
        self.assertFalse(rs["is_range_complete"])

    def test_sanitizes_win32_reserved_and_bidi_filenames(self) -> None:
        raw_name = "../../\u202eCON.pdf.. "
        sanitized, notes = cc.sanitize_download_filename(raw_name)
        self.assertEqual(sanitized, "_CON.pdf")
        self.assertIn("STRIPPED_BIDI_CONTROLS", notes)
        self.assertIn("DROPPED_PATH_COMPONENTS", notes)
        self.assertIn("TRIMMED_TRAILING_DOTS_SPACES", notes)
        self.assertIn("ESCAPED_WIN32_RESERVED_NAME", notes)

    def test_rejects_drm_captcha_bypass_and_untrusted_ws_origin(self) -> None:
        manifest = {
            "filename": "video.mp4",
            "source_url": "https://cdn.example.com/video.mp4",
            "total_bytes": 100,
            "drm_supported": True,
            "view_only_bypass": True,
            "ws_origin": "https://attacker.example.com",
            "segments": [{"start": 0, "end": 99, "completed": True}],
        }
        res = cc.validate_download_manifest(manifest)
        self.assertFalse(res["valid"])
        codes = {f["code"] for f in res["findings"]}
        self.assertIn("ERR_FORBIDDEN_DRM_SUPPORT", codes)
        self.assertIn("ERR_FORBIDDEN_DRM_OR_CAPTCHA_BYPASS", codes)
        self.assertIn("ERR_DISALLOWED_WS_ORIGIN", codes)

    def test_rejects_prototype_pollution_and_detects_weak_if_range(self) -> None:
        # Use json.loads to construct a dict carrying "__proto__" key deterministically
        payload = json.loads(
            '{"filename":"archive.zip","source_url":"https://cdn.example.com/a.zip",'
            '"total_bytes":200,"etag":"W/\\"weak1\\"","__proto__":{"polluted":true},'
            '"segments":[{"start":0,"end":99},{"start":100,"end":199}]}'
        )
        res = cc.validate_download_manifest(payload)
        self.assertFalse(res["valid"])
        self.assertIn("ERR_UNSAFE_PROTOTYPE_KEY", {f["code"] for f in res["findings"]})
        self.assertEqual(res["validator_strength"], "weak_etag")
        self.assertFalse(res["resume_safe"])

    def test_rejects_malformed_crc32c_and_md5_even_when_long(self) -> None:
        bad = cc.validate_download_manifest(
            {
                "filename": "archive.bin",
                "source_url": "https://cdn.example.com/archive.bin",
                "total_bytes": 100,
                "crc32c": "zzzzzzzz",
                "md5": "not-a-valid-md5-hash",
                "segments": [{"start": 0, "end": 99, "completed": True}],
            }
        )
        self.assertFalse(bad["valid"])
        codes = {f["code"] for f in bad["findings"]}
        self.assertIn("ERR_INVALID_CRC32C", codes)
        self.assertIn("ERR_INVALID_MD5", codes)

        good = cc.validate_download_manifest(
            {
                "filename": "archive.bin",
                "source_url": "https://cdn.example.com/archive.bin",
                "total_bytes": 100,
                "etag": '"etag-v1"',
                "crc32c": "deadbeef",
                "md5": "0123456789abcdef0123456789abcdef",
                "sha256": "a" * 64,
                "segments": [{"start": 0, "end": 99, "completed": True}],
            }
        )
        self.assertTrue(good["valid"], good["findings"])

    def test_rejects_malformed_integer_fields_across_all_parsers(self) -> None:
        proxy_res = cc.normalize_proxy_route_config(
            {
                "routing": {
                    "max_concurrent": True,
                    "max_failover_rounds": "not-an-int",
                    "probe_unproven_every": ["list"],
                    "sticky_limit": None,
                },
                "proxy_pools": [{"id": "p1", "max_slots": "ten"}],
                "provider_nodes": [
                    {
                        "id": "node-bad-ints",
                        "base_url": "https://api.example.com/v1",
                        "context_limit_tokens": {"bad": 1},
                        "circuit_failure_threshold": None,
                        "capabilities": {"max_attachments": False},
                        "ewma_latency_ms": "nan",
                    }
                ],
            }
        )
        self.assertFalse(proxy_res["valid"])
        p_paths = {(f["code"], f["path"]) for f in proxy_res["findings"]}
        self.assertIn(("ERR_INVALID_INTEGER", "routing.max_concurrent"), p_paths)
        self.assertIn(("ERR_INVALID_INTEGER", "routing.max_failover_rounds"), p_paths)
        self.assertIn(("ERR_INVALID_INTEGER", "proxy_pools[0].max_slots"), p_paths)
        self.assertIn(("ERR_INVALID_INTEGER", "provider_nodes[0].context_limit_tokens"), p_paths)
        self.assertIn(("ERR_INVALID_INTEGER", "provider_nodes[0].circuit_failure_threshold"), p_paths)
        self.assertIn(("ERR_INVALID_INTEGER", "provider_nodes[0].capabilities.max_attachments"), p_paths)
        self.assertIn(("ERR_INVALID_NUMBER", "provider_nodes[0].ewma_latency_ms"), p_paths)

        nb_res = cc.validate_notebook_bundle(
            {
                "namespace_path": "connectors/notebook",
                "sources": [
                    {
                        "source_id": "s-bad-ints",
                        "rel_path": "docs/feed.xml",
                        "mime_type": "application/xml",
                        "content_sha256": "a" * 64,
                        "byte_len": "hundred",
                        "archive_depth": True,
                        "xml_member_bytes": {"nested": 5},
                        "chunk_bytes": None,
                        "updated_at_ms": [123],
                    }
                ],
            }
        )
        self.assertFalse(nb_res["valid"])
        nb_paths = {(f["code"], f["path"]) for f in nb_res["findings"]}
        self.assertIn(("ERR_INVALID_INTEGER", "sources[0].byte_len"), nb_paths)
        self.assertIn(("ERR_INVALID_INTEGER", "sources[0].archive_depth"), nb_paths)
        self.assertIn(("ERR_INVALID_INTEGER", "sources[0].xml_member_bytes"), nb_paths)
        self.assertIn(("ERR_INVALID_INTEGER", "sources[0].chunk_bytes"), nb_paths)
        self.assertIn(("ERR_INVALID_INTEGER", "sources[0].updated_at_ms"), nb_paths)

        dl_res = cc.validate_download_manifest(
            {
                "filename": "data.bin",
                "source_url": "https://cdn.example.com/data.bin",
                "total_bytes": 100,
                "segments": [
                    {"index": "bad", "start": 0, "end": 49, "completed": True},
                    {"index": False, "start": 50, "end": 99, "completed": True},
                ],
            }
        )
        self.assertFalse(dl_res["valid"])
        dl_paths = {(f["code"], f["path"]) for f in dl_res["findings"]}
        self.assertIn(("ERR_INVALID_INTEGER", "segments[0].index"), dl_paths)
        self.assertIn(("ERR_INVALID_INTEGER", "segments[1].index"), dl_paths)


class CliIntegrationTests(unittest.TestCase):
    def test_cli_strict_mode_and_bundle_dispatch(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            good_path = tmp / "good_proxy.json"
            good_path.write_text(
                json.dumps(
                    {
                        "kind": "proxy_route",
                        "provider_nodes": [
                            {
                                "id": "ok-1",
                                "provider_id": "openai",
                                "model_id": "gpt-5",
                                "base_url": "https://api.openai.com/v1",
                                "api_key": "${OPENAI_API_KEY}",
                            }
                        ],
                    }
                ),
                encoding="utf-8",
                newline="\n",
            )
            bad_bundle_path = tmp / "bad_bundle.json"
            bad_token = "gh" + "p_" + "SyntheticSecretToken999999"
            bad_bundle_path.write_text(
                json.dumps(
                    {
                        "proxy_routes": [
                            {
                                "provider_nodes": [
                                    {
                                        "id": "bad-1",
                                        "base_url": "https://api.example.com/v1",
                                        "api_key": bad_token,
                                    }
                                ]
                            }
                        ]
                    }
                ),
                encoding="utf-8",
                newline="\n",
            )

            proc_ok = subprocess.run(
                [sys.executable, "-B", str(CLI_PATH), "inspect-bundle", "--input", str(good_path), "--strict"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                check=False,
            )
            self.assertEqual(proc_ok.returncode, 0, proc_ok.stderr)
            parsed_ok = json.loads(proc_ok.stdout)
            self.assertTrue(parsed_ok["valid"])

            proc_bad = subprocess.run(
                [sys.executable, "-B", str(CLI_PATH), "inspect-bundle", "--input", str(bad_bundle_path), "--strict"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                check=False,
            )
            self.assertEqual(proc_bad.returncode, 2)
            self.assertNotIn(bad_token, proc_bad.stdout)
            parsed_bad = json.loads(proc_bad.stdout)
            self.assertFalse(parsed_bad["valid"])


if __name__ == "__main__":
    unittest.main()

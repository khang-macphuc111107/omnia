"""Unit tests for `omnia-gemini-extractor` (stdlib `unittest`)."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

import cli  # noqa: E402
from extractor import (  # noqa: E402
    SCHEMA_VERSION,
    GeminiBlockedError,
    GeminiDecodeError,
    decode_batchexecute_frames,
    export_transcript_markdown,
    extract_share_transcript,
    fetch_share_http,
    redact_text,
    validate_share_url,
    verify_completeness,
)


def _make_batchexecute_chunk(envelopes: list[list[object]]) -> str:
    body = json.dumps(envelopes, ensure_ascii=False, separators=(",", ":"))
    return f"{len(body)}\n{body}\n"


def _sample_turn(
    conv_id: str,
    turn_id: str,
    prompt: str,
    resp_id: str,
    resp_md: str,
    *,
    uploads: list[object] | None = None,
    pasted: list[object] | None = None,
    queries: list[str] | None = None,
    model_id: str = "model_pro_25",
    thinking_steps: list[object] | None = None,
    grounding_citations: list[object] | None = None,
) -> list[object]:
    # Build t[2] where t[2][8] is explicitly scalar boolean `False` (must be ignored).
    prompt_node: list[object] = [None] * 16
    prompt_node[0] = [prompt, None, None, None, uploads]
    prompt_node[8] = False
    prompt_node[15] = pasted

    draft: list[object] = [None] * 38
    draft[0] = resp_id
    draft[1] = [resp_md]
    draft[2] = [None, grounding_citations]
    draft[37] = [None, thinking_steps]

    resp_node: list[object] = [None] * 15
    resp_node[0] = [draft]
    resp_node[1] = queries
    resp_node[14] = model_id

    return [[conv_id, turn_id], None, prompt_node, resp_node]


class GeminiShareExtractorTests(unittest.TestCase):
    def test_validate_share_url_accepts_public_and_refuses_auth_or_captcha(self) -> None:
        ok1 = validate_share_url("https://share.gemini.google/1f2021de30e9?utm_source=copy")
        self.assertTrue(ok1.valid)
        self.assertEqual(ok1.share_id, "1f2021de30e9")
        self.assertEqual(ok1.normalized_url, "https://share.gemini.google/1f2021de30e9")

        ok2 = validate_share_url("https://gemini.google.com/share/abcd1234ef56/")
        self.assertTrue(ok2.valid)
        self.assertEqual(ok2.share_id, "abcd1234ef56")
        self.assertEqual(ok2.normalized_url, "https://gemini.google.com/share/abcd1234ef56")

        for auth_url in (
            "https://gemini.google.com/app/abc123def456",
            "https://gemini.google.com/u/0/app/abc123def456",
            "https://accounts.google.com/ServiceLogin?continue=https://gemini.google.com/app",
        ):
            res = validate_share_url(auth_url)
            self.assertFalse(res.valid)
            self.assertEqual(res.reason, "auth_required", msg=auth_url)

        for sorry_url in (
            "https://www.google.com/sorry/index?continue=https://share.gemini.google/1f2021de30e9",
            "https://google.com/sorry/index",
        ):
            res = validate_share_url(sorry_url)
            self.assertFalse(res.valid)
            self.assertEqual(res.reason, "captcha_blocked", msg=sorry_url)

        bad_scheme = validate_share_url("http://share.gemini.google/1f2021de30e9")
        self.assertFalse(bad_scheme.valid)
        self.assertEqual(bad_scheme.reason, "insecure_scheme")

        bad_creds = validate_share_url("https://user:dummy_password@share.gemini.google/1f2021de30e9")
        self.assertFalse(bad_creds.valid)
        self.assertEqual(bad_creds.reason, "embedded_credentials")

    def test_decode_batchexecute_and_extract_thinking_sources_grounding_and_turn_2_8_false(self) -> None:
        turn1 = _sample_turn(
            "c_001",
            "r_001",
            "Compare Rust and Python extraction",
            "rc_001",
            "Here is the grounded comparison.",
            uploads=[["https://example.org/files/spec.pdf", "spec.pdf", "application/pdf", 2048]],
            pasted=[["fn main() {}", "snippet.rs", "text/rust"]],
            queries=["gemini batchexecute ujx1Bf", "wiz frame format"],
            model_id="model_pro_25",
            thinking_steps=[
                [
                    "search",
                    "google_search",
                    "Searching WIZ RPCs",
                    "Inspecting ujx1Bf schema and draft[37][1] thoughts.",
                    [
                        ["https://example.com/favicon.ico", "https://example.com/wiz", "WIZ RPC Notes"],
                        ["https://example.org/favicon.ico", "https://example.org/docs", "Grounding Guide"],
                    ],
                ],
                [
                    "synthesize",
                    None,
                    "Drafting answer",
                    "Verified pagination cursor and attachment handling.",
                    [],
                ],
            ],
            grounding_citations=[
                [
                    [0, 32, "Here is the grounded comparison."],
                    [
                        [
                            "https://example.com/wiz?utm_source=share",
                            "WIZ RPC Notes",
                            "Length-prefixed wrb.fr envelopes",
                            "Example Press",
                        ]
                    ],
                ]
            ],
        )

        # Include emoji to ensure UTF-16 vs UTF-8 length counting never breaks parsing.
        ujx_root = [
            [
                None,
                [turn1],
                ["c_001", "Gemini Share Test \U0001f680"],
                "1f2021de30e9",
                [1731542400, 0],
            ]
        ]
        ot_payload = [["model_pro_25", "Gemini 2.5 Pro"]]

        raw = ")]}'\n\n" + _make_batchexecute_chunk([
            ["wrb.fr", "otAQ7b", json.dumps(ot_payload), None, None, None, "generic"],
            ["wrb.fr", "ujx1Bf", json.dumps(ujx_root, ensure_ascii=False), None, None, None, "generic"],
            ["di", 99],
        ])

        decoded = decode_batchexecute_frames(raw)
        self.assertEqual(decoded["model_map"], {"model_pro_25": "Gemini 2.5 Pro"})
        self.assertEqual(len(decoded["ujx1bf_pages"]), 1)

        transcript = extract_share_transcript(
            raw,
            source_url="https://share.gemini.google/1f2021de30e9",
            redact=True,
        )
        self.assertEqual(transcript["schema_version"], SCHEMA_VERSION)
        self.assertEqual(transcript["share_id"], "1f2021de30e9")
        self.assertEqual(transcript["published_timestamp"], "2024-11-14T00:00:00Z")
        self.assertTrue(transcript["cursor_exhausted"])
        self.assertEqual(len(transcript["turns"]), 1)

        t = transcript["turns"][0]
        self.assertEqual(t["conversation_id"], "c_001")
        self.assertEqual(t["turn_id"], "r_001")
        self.assertEqual(t["model_name"], "Gemini 2.5 Pro")
        # `t[2][8] = false` ignored; only uploaded file + pasted block present.
        self.assertEqual(len(t["attachments"]), 2)
        self.assertEqual(t["attachments"][0]["kind"], "uploaded_file")
        self.assertEqual(t["attachments"][1]["kind"], "pasted_block")
        self.assertEqual(len(t["thinking_steps"]), 2)
        self.assertEqual(len(t["thinking_steps"][0]["sources"]), 2)
        self.assertEqual(
            t["grounding_citations"][0]["items"][0]["url"],
            "https://example.com/wiz",
        )
        self.assertEqual(t["grounding_citations"][0]["items"][0]["publisher"], "Example Press")

        check = verify_completeness(transcript)
        self.assertTrue(check["passed"], msg=check)
        self.assertEqual(check["turns_total"], 1)
        self.assertEqual(check["turns_with_thinking"], 1)
        self.assertEqual(check["thinking_steps_total"], 2)
        self.assertEqual(check["turns_with_sources"], 1)
        self.assertEqual(check["unique_sources_total"], 2)
        self.assertEqual(check["search_queries_total"], 2)
        self.assertEqual(check["attachments_total"], 2)

    def test_pagination_cursor_loop_and_completeness_check(self) -> None:
        turn1 = _sample_turn("c_page", "r_1", "First prompt", "rc_1", "First answer")
        turn2 = _sample_turn("c_page", "r_2", "Second prompt", "rc_2", "Second answer")

        root_page_1 = [["cursor_tok_page2", [turn1], ["c_page", "Paginated Share"], "share_pg1", [1731542400, 0]]]
        root_page_2 = [[None, [turn1, turn2], ["c_page", "Paginated Share"], "share_pg1", [1731542400, 0]]]

        raw_p1 = ")]}'\n" + _make_batchexecute_chunk([
            ["wrb.fr", "ujx1Bf", json.dumps(root_page_1), None, None, None, "generic"],
        ])
        raw_p2 = ")]}'\n" + _make_batchexecute_chunk([
            ["wrb.fr", "ujx1Bf", json.dumps(root_page_2), None, None, None, "generic"],
        ])

        # Unexhausted single page must fail completeness verification.
        partial = extract_share_transcript(raw_p1, source_url="https://share.gemini.google/share_pg1")
        self.assertFalse(partial["cursor_exhausted"])
        partial_report = verify_completeness(partial)
        self.assertFalse(partial_report["passed"])
        self.assertIn("cursor_not_exhausted", partial_report["issues"])

        # Combined multi-page capture deduplicates r_1 and exhausts cursor.
        full = extract_share_transcript(
            [raw_p1, raw_p2],
            source_url="https://share.gemini.google/share_pg1",
        )
        self.assertTrue(full["cursor_exhausted"])
        self.assertEqual(len(full["turns"]), 2)
        self.assertEqual([t["turn_index"] for t in full["turns"]], [0, 1])
        self.assertEqual([t["turn_id"] for t in full["turns"]], ["r_1", "r_2"])
        self.assertTrue(verify_completeness(full)["passed"])

        # Verify `fetch_share_http` loops cursor cleanly using injected transport.
        seen_urls: list[str] = []

        def fake_transport(url: str, data: bytes | None, _headers: dict[str, str], _timeout: float):
            seen_urls.append(url)
            if data is None:
                return 200, "https://share.gemini.google/share_pg1", '<html>"FdrFJe":"123","cfb2h":"bl_test"</html>'
            body_text = data.decode("utf-8")
            if "cursor_tok_page2" in body_text:
                return 200, url, raw_p2
            return 200, url, raw_p1

        fetched = fetch_share_http("https://share.gemini.google/share_pg1", transport=fake_transport)
        self.assertEqual(len(fetched["turns"]), 2)
        self.assertTrue(fetched["cursor_exhausted"])
        self.assertEqual(len(seen_urls), 3)

        # Verify redirect to CAPTCHA sorry page is refused without bypassing.
        def captcha_transport(_url: str, _data: bytes | None, _headers: dict[str, str], _timeout: float):
            return 200, "https://www.google.com/sorry/index?continue=https://share.gemini.google/share_pg1", "<html></html>"

        with self.assertRaises(GeminiBlockedError) as ctx:
            fetch_share_http("https://share.gemini.google/share_pg1", transport=captcha_transport)
        self.assertEqual(ctx.exception.reason, "captcha_blocked")

    def test_redaction_strips_secrets_cookies_signed_urls_pii_and_user_paths(self) -> None:
        fake_sk = "sk-" + "dummy_secret_value_123456"
        fake_pem = "-----BEGIN RSA PRIVATE " + "KEY-----\nMIIE_DUMMY_DATA\n-----END RSA PRIVATE " + "KEY-----"
        fake_cookie = "__Secure-1PSID=dummy_cookie_secret_987654; SIDCC=dummy_sidcc_112233"
        signed_url = "https://cdn.example.test/doc.pdf?X-Amz-Signature=dummy_amz_sig&X-Goog-Signature=dummy_goog_sig&utm_source=x"

        turn = _sample_turn(
            "c_sec",
            "r_sec",
            f"Check {fake_sk} from C:\\Users\\DummyWinUser\\notes.txt and /home/dummyposix/file",
            "rc_sec",
            f"Contact alice@example.test\nBearer dummy_bearer_tok_55555\n{fake_cookie}\n{fake_pem}\n{signed_url}",
            uploads=[["https://cdn.example.test/up.png?X-Goog-Signature=dummy_upload_sig", "img.png", "image/png"]],
        )
        root = [[None, [turn], ["c_sec", "Owner alice@example.test"], "sec_share_1", [1731542400, 0]]]
        raw = ")]}'\n" + _make_batchexecute_chunk([
            ["wrb.fr", "ujx1Bf", json.dumps(root), None, None, None, "generic"],
        ])

        transcript = extract_share_transcript(raw, source_url="https://share.gemini.google/sec_share_1", redact=True)
        dumped = json.dumps(transcript)
        for leaked in (
            "dummy_secret_value_123456",
            "MIIE_DUMMY_DATA",
            "dummy_cookie_secret_987654",
            "dummy_sidcc_112233",
            "dummy_amz_sig",
            "dummy_goog_sig",
            "dummy_upload_sig",
            "dummy_bearer_tok_55555",
            "alice@example.test",
            "DummyWinUser",
            "dummyposix",
        ):
            self.assertNotIn(leaked, dumped)
        self.assertGreater(len(transcript["redacted_fields"]), 0)

        cleaned_inline, hits = redact_text("Cookie: SID=dummy_cookie_sid_9999; HSID=dummy_hsid_9999")
        self.assertNotIn("dummy_cookie_sid_9999", cleaned_inline)
        self.assertGreater(len(hits), 0)

    def test_prototype_key_rejected_and_cli_subcommands_roundtrip(self) -> None:
        evil_raw = ')]}\'\n[["wrb.fr","ujx1Bf","{\\"__proto__\\":{\\"polluted\\":true}}",null,null,null,"generic"]]'
        with self.assertRaises(GeminiDecodeError):
            decode_batchexecute_frames(evil_raw)

        turn = _sample_turn("c_cli", "r_cli", "Prompt CLI", "rc_cli", "Response CLI")
        raw = ")]}'\n" + _make_batchexecute_chunk([
            ["wrb.fr", "ujx1Bf", json.dumps([[None, [turn], ["c_cli", "CLI Test"], "cli_share", [1731542400, 0]]]), None, None, None, "generic"],
        ])

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            raw_path = tmp / "raw.txt"
            json_path = tmp / "transcript.json"
            md_path = tmp / "transcript.md"
            raw_path.write_text(raw, encoding="utf-8", newline="\n")

            rc_parse = cli.main(["parse-raw", "--in", str(raw_path), "--source-url", "https://share.gemini.google/cli_share", "--out", str(json_path), "--strict"])
            self.assertEqual(rc_parse, 0)
            rc_verify = cli.main(["verify", "--in", str(json_path)])
            self.assertEqual(rc_verify, 0)
            rc_md = cli.main(["export-markdown", "--in", str(json_path), "--out", str(md_path)])
            self.assertEqual(rc_md, 0)

            md_bytes = md_path.read_bytes()
            self.assertNotIn(b"\r\n", md_bytes)
            self.assertFalse(md_bytes.startswith(b"\xef\xbb\xbf"))
            self.assertIn("# CLI Test", md_bytes.decode("utf-8"))

            # Verify cdp_capture.mjs refuses auth_required and captcha_blocked URLs cleanly without launching browser.
            cdp_script = _THIS_DIR / "cdp_capture.mjs"
            for gate_url, expected_reason in (
                ("https://gemini.google.com/app/private123", "auth_required"),
                ("https://www.google.com/sorry/index?continue=https://share.gemini.google/cli_share", "captcha_blocked"),
            ):
                proc = subprocess.run(
                    ["node", str(cdp_script), "--url", gate_url],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(proc.returncode, 2)
                cdp_res = json.loads(proc.stdout)
                self.assertEqual(cdp_res["reason"], expected_reason)

            # Verify cdp_capture.mjs refuses writing inside repository unless --allow-in-repo is set.
            in_repo_target = _THIS_DIR / "forbidden_capture.txt"
            proc_repo = subprocess.run(
                ["node", str(cdp_script), "--url", "https://share.gemini.google/cli_share", "--out", str(in_repo_target)],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(proc_repo.returncode, 1)
            self.assertEqual(json.loads(proc_repo.stdout)["reason"], "in_repo_output_forbidden")
            self.assertFalse(in_repo_target.exists())

            # Verify cli.py also refuses writing inside repository unless --allow-in-repo is set.
            with self.assertRaises(ValueError):
                cli._write_text_utf8_lf(str(in_repo_target), "test", allow_in_repo=False)
            self.assertFalse(in_repo_target.exists())

    def test_html_gates_and_empty_turn_and_summary_mismatch_detected(self) -> None:
        with self.assertRaises(GeminiBlockedError) as ctx_auth:
            decode_batchexecute_frames("<html><title>Sign in - Google Accounts</title><body>accounts.google.com/ServiceLogin</body></html>")
        self.assertEqual(ctx_auth.exception.reason, "auth_required")

        with self.assertRaises(GeminiBlockedError) as ctx_cap:
            decode_batchexecute_frames("<!doctype html><html><body>Our systems have detected unusual traffic from your computer network g-recaptcha</body></html>")
        self.assertEqual(ctx_cap.exception.reason, "captcha_blocked")

        empty_turn = _sample_turn("c_e", "r_e", "", "rc_e", "")
        raw_empty = ")]}'\n" + _make_batchexecute_chunk([
            ["wrb.fr", "ujx1Bf", json.dumps([[None, [empty_turn], ["c_e", "Empty Turn"], "e_share", [1731542400, 0]]]), None, None, None, "generic"],
        ])
        tr = extract_share_transcript(raw_empty)
        rep = verify_completeness(tr)
        self.assertFalse(rep["passed"])
        self.assertIn("empty_turns_detected:1", rep["issues"])

        tr["summary"]["turns_total"] = 99
        rep_mismatch = verify_completeness(tr)
        self.assertFalse(rep_mismatch["passed"])
        self.assertTrue(any(i.startswith("summary_mismatch:turns_total:") for i in rep_mismatch["issues"]))


if __name__ == "__main__":
    unittest.main()

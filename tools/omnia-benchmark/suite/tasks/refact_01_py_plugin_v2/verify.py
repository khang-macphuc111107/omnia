#!/usr/bin/env python3
"""Deterministic verifier for refact_01_py_plugin_v2."""

from __future__ import annotations

import argparse
import ast
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

TASK_ID = "refact_01_py_plugin_v2"


def _run_py(workspace: Path, code: str, timeout: int = 30) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(workspace)
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    return subprocess.run(
        [sys.executable, "-c", code],
        cwd=str(workspace),
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=timeout,
    )


def _run_cmd(workspace: Path, args: list[str], timeout: int = 30) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(workspace)
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    return subprocess.run(
        args,
        cwd=str(workspace),
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=timeout,
    )


def check_legacy_unittest_suite(workspace: Path) -> tuple[bool, str]:
    proc = _run_cmd(workspace, [sys.executable, "-m", "unittest", "tests/test_legacy_v1.py", "-v"])
    if proc.returncode == 0:
        return True, "tests/test_legacy_v1.py passed"
    detail = (proc.stderr or proc.stdout).strip()[-500:]
    return False, f"unittest failed (rc={proc.returncode}): {detail}"


def check_builtin_transform_semantics(workspace: Path) -> tuple[bool, str]:
    code = r"""
import hashlib, json
from docpipe import Pipeline
from docpipe.plugins import NormalizePlugin, RedactPlugin, ChunkPlugin, EnrichPlugin

doc = {
    "id": "hidden-p2p-1",
    "text": "  Alpha   beta\r\n\r\n\r\nContact sec@domain.org  SSN 987-65-4321  ",
    "metadata": {"title": "Audit Log #42!"},
    "tenant": "acme",
}
out = Pipeline([
    NormalizePlugin(),
    RedactPlugin(),
    ChunkPlugin(chunk_size=3, overlap=1),
    EnrichPlugin(words_per_minute=120),
]).run(doc)

expected_text = "Alpha beta\n\nContact [REDACTED_EMAIL] SSN [REDACTED_SSN]"
assert out["id"] == "hidden-p2p-1", f"bad id: {out.get('id')}"
assert out["text"] == expected_text, f"bad text: {out.get('text')!r}"
assert out["tenant"] == "acme", f"extra key lost: {out}"
m = out["metadata"]
assert m["title_slug"] == "audit-log-42", f"bad slug: {m.get('title_slug')}"
assert m["normalized"] is True
assert m["redactions"] == {"email": 1, "ssn": 1, "card": 0}, f"bad redactions: {m.get('redactions')}"
assert m["redaction_count"] == 2
assert out["chunks"] == [
    "Alpha beta Contact",
    "Contact [REDACTED_EMAIL] SSN",
    "SSN [REDACTED_SSN]",
], f"bad chunks: {out.get('chunks')}"
assert m["chunk_count"] == 3
assert m["word_count"] == 6
assert m["char_count"] == len(expected_text)
assert m["content_sha256"] == hashlib.sha256(expected_text.encode("utf-8")).hexdigest()
assert m["reading_time_sec"] == 3.0
print("OK")
"""
    proc = _run_py(workspace, code)
    if proc.returncode == 0 and "OK" in proc.stdout:
        return True, "All built-in plugin transform semantics verified"
    detail = (proc.stderr or proc.stdout).strip()[-500:]
    return False, f"Transform semantics check failed: {detail}"


def check_cli_v1_execution(workspace: Path) -> tuple[bool, str]:
    with tempfile.TemporaryDirectory() as tmp:
        in_file = Path(tmp) / "doc.json"
        out_file = Path(tmp) / "out.json"
        in_file.write_text(
            json.dumps(
                {
                    "id": "cli-v1-check",
                    "text": "  Ping   ops@site.io\r\ncard 1111-2222-3333-4444  ",
                    "metadata": {"title": "Ops Alert"},
                }
            ),
            encoding="utf-8",
        )
        proc = _run_cmd(
            workspace,
            [sys.executable, "-m", "docpipe.cli", "--input", str(in_file), "--output", str(out_file)],
        )
        if proc.returncode != 0:
            return False, f"CLI v1 failed (rc={proc.returncode}): {(proc.stderr or proc.stdout).strip()[-400:]}"
        try:
            data = json.loads(out_file.read_text(encoding="utf-8"))
        except Exception as exc:
            return False, f"CLI v1 output invalid JSON: {exc}"
        if data.get("id") != "cli-v1-check":
            return False, f"Unexpected id: {data.get('id')}"
        if data.get("text") != "Ping [REDACTED_EMAIL]\ncard [REDACTED_CARD]":
            return False, f"Unexpected text: {data.get('text')!r}"
        meta = data.get("metadata", {})
        if meta.get("title_slug") != "ops-alert" or meta.get("redaction_count") != 2:
            return False, f"Unexpected metadata: {meta}"
        return True, "CLI v1 mode produced exact expected document JSON"


def check_ast_builtin_async_process_v2(workspace: Path) -> tuple[bool, str]:
    targets = [
        ("docpipe/plugins/normalize.py", "NormalizePlugin"),
        ("docpipe/plugins/redact.py", "RedactPlugin"),
        ("docpipe/plugins/chunk.py", "ChunkPlugin"),
        ("docpipe/plugins/enrich.py", "EnrichPlugin"),
    ]
    missing: list[str] = []
    for rel_path, cls_name in targets:
        fpath = workspace / rel_path
        if not fpath.is_file():
            missing.append(f"{rel_path} missing")
            continue
        try:
            tree = ast.parse(fpath.read_text(encoding="utf-8"), filename=str(fpath))
        except SyntaxError as exc:
            return False, f"SyntaxError in {rel_path}: {exc}"
        found_cls = False
        found_async_v2 = False
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef) and node.name == cls_name:
                found_cls = True
                for item in node.body:
                    if isinstance(item, ast.AsyncFunctionDef) and item.name == "process_v2":
                        found_async_v2 = True
        if not found_cls:
            missing.append(f"class {cls_name} not found in {rel_path}")
        elif not found_async_v2:
            missing.append(f"{cls_name} lacks native async def process_v2 in {rel_path}")
    if missing:
        return False, "; ".join(missing)
    return True, "All 4 built-in plugins define native async def process_v2"


def check_v2_types_and_document_roundtrip(workspace: Path) -> tuple[bool, str]:
    code = r"""
from dataclasses import is_dataclass
import docpipe
from docpipe import (
    CancellationToken,
    Document,
    ExecutionContext,
    Pipeline,
    PipelineCancelledError,
    PluginBase,
    ProcessResult,
    StageResult,
    default_plugins,
)

assert issubclass(PipelineCancelledError, Exception)
for cls in (ExecutionContext, Document, StageResult, ProcessResult):
    assert is_dataclass(cls), f"{cls.__name__} must be a dataclass"

tok = CancellationToken()
assert tok.is_cancelled is False
tok.raise_if_cancelled()
tok.cancel("user_abort")
assert tok.is_cancelled is True
raised = False
try:
    tok.raise_if_cancelled()
except PipelineCancelledError:
    raised = True
assert raised, "raise_if_cancelled() did not raise PipelineCancelledError"

ctx = ExecutionContext()
assert isinstance(ctx.run_id, str) and len(ctx.run_id) > 0
assert isinstance(ctx.config, dict)
assert isinstance(ctx.cancellation_token, CancellationToken)
assert isinstance(ctx.stage_timings_ms, dict)
assert isinstance(ctx.warnings, list)

raw = {
    "id": "rt-1",
    "text": "hello world",
    "metadata": {"nested": {"k": 1}},
    "chunks": ["hello", "world"],
    "custom_top": "preserved",
}
d = Document.from_dict(raw)
assert d.doc_id == "rt-1"
assert d.text == "hello world"
assert d.metadata == {"nested": {"k": 1}}
assert d.chunks == ["hello", "world"]
d.metadata["nested"]["k"] = 99
assert raw["metadata"]["nested"]["k"] == 1, "from_dict must deep-copy metadata"

back = d.to_dict()
assert back["id"] == "rt-1"
assert back["text"] == "hello world"
assert back["chunks"] == ["hello", "world"]
assert back["custom_top"] == "preserved", f"extra top-level key lost: {back}"

sr = StageResult(plugin_name="normalize", duration_ms=1.25, status="ok")
pr = ProcessResult(document=d, stage_results=[sr], total_duration_ms=1.5, cancelled=False, warnings=[])
pr_dict = pr.to_dict()
assert pr_dict["document"]["id"] == "rt-1"
assert pr_dict["stage_results"][0]["plugin_name"] == "normalize"
assert pr_dict["cancelled"] is False
print("OK")
"""
    proc = _run_py(workspace, code)
    if proc.returncode == 0 and "OK" in proc.stdout:
        return True, "All v2 core types, CancellationToken, and Document round-trip verified"
    detail = (proc.stderr or proc.stdout).strip()[-500:]
    return False, f"v2 core types check failed: {detail}"


def check_builtin_run_v2_zero_deprecation_warnings(workspace: Path) -> tuple[bool, str]:
    code = r"""
import asyncio, warnings
from docpipe import Document, ExecutionContext, Pipeline, default_plugins
from docpipe.plugins import NormalizePlugin

async def main():
    ctx = ExecutionContext(
        run_id="run-v2-clean",
        config={
            "normalize": {"lowercase_slug": False},
            "redact": {"replacement_email": "[MASKED]"},
            "chunk": {"chunk_size": 3, "overlap": 1},
            "enrich": {"words_per_minute": 60},
        },
    )
    doc = Document(
        doc_id="v2-doc",
        text="  One   Two Three Four  me@example.com  ",
        metadata={"title": "Keep Case Title"},
    )
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        result = await Pipeline(default_plugins()).run_v2(doc, ctx)

    dep_warnings = [w for w in caught if issubclass(w.category, DeprecationWarning)]
    assert len(dep_warnings) == 0, f"Unexpected DeprecationWarnings: {[str(w.message) for w in dep_warnings]}"
    assert len(ctx.warnings) == 0, f"Unexpected ctx.warnings: {ctx.warnings}"
    assert len(result.warnings) == 0, f"Unexpected result.warnings: {result.warnings}"
    assert result.cancelled is False
    assert [s.plugin_name for s in result.stage_results] == ["normalize", "redact", "chunk", "enrich"]
    assert all(s.status == "ok" and s.duration_ms >= 0.0 for s in result.stage_results)
    assert set(ctx.stage_timings_ms.keys()) == {"normalize", "redact", "chunk", "enrich"}
    assert result.total_duration_ms >= 0.0

    # Verify ctx.config overrides took effect
    out_doc = result.document
    assert out_doc.text == "One Two Three Four [MASKED]", f"bad text: {out_doc.text!r}"
    assert out_doc.metadata["title_slug"] == "Keep-Case-Title", f"bad slug: {out_doc.metadata.get('title_slug')}"
    assert out_doc.chunks == ["One Two Three", "Three Four [MASKED]"], f"bad chunks: {out_doc.chunks}"
    assert out_doc.metadata["reading_time_sec"] == 5.0, f"bad reading time: {out_doc.metadata.get('reading_time_sec')}"

asyncio.run(main())

# Also verify sync call to built-in plugin.process() emits zero deprecation warnings
with warnings.catch_warnings(record=True) as caught2:
    warnings.simplefilter("always")
    out2 = NormalizePlugin().process({"id": "x", "text": "  hi  ", "metadata": {}})
dep2 = [w for w in caught2 if issubclass(w.category, DeprecationWarning)]
assert len(dep2) == 0, f"Built-in sync process emitted DeprecationWarning: {dep2}"
assert out2["text"] == "hi"
print("OK")
"""
    proc = _run_py(workspace, code)
    if proc.returncode == 0 and "OK" in proc.stdout:
        return True, "Built-in plugins run cleanly in v2 with ctx.config overrides and zero DeprecationWarnings"
    detail = (proc.stderr or proc.stdout).strip()[-500:]
    return False, f"Built-in v2 clean execution failed: {detail}"


def check_legacy_v1_plugin_deprecation_shim(workspace: Path) -> tuple[bool, str]:
    code = r"""
import asyncio, warnings
from typing import Any
from docpipe import Document, ExecutionContext, Pipeline, PluginBase
from docpipe.plugins import EnrichPlugin, NormalizePlugin

class ExternalLegacyV1Plugin(PluginBase):
    name = "ext_legacy_v1"

    def process(self, doc: dict[str, Any]) -> dict[str, Any]:
        doc["text"] = doc["text"] + " [v1-suffix]"
        doc.setdefault("metadata", {})["legacy_ran"] = True
        doc["extra_v1_field"] = 42
        return doc

async def run_test():
    ctx = ExecutionContext(run_id="shim-test")
    pipe = Pipeline([NormalizePlugin(), ExternalLegacyV1Plugin(), EnrichPlugin()])
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        res = await pipe.run_v2({"id": "shim-1", "text": "  hello   world  "}, ctx)

    dep_warnings = [w for w in caught if issubclass(w.category, DeprecationWarning)]
    assert len(dep_warnings) == 1, f"Expected exactly 1 DeprecationWarning, got {len(dep_warnings)}: {[str(w.message) for w in dep_warnings]}"
    msg = str(dep_warnings[0].message)
    assert "ExternalLegacyV1Plugin" in msg or "ext_legacy_v1" in msg, f"Warning should name plugin: {msg}"
    assert len(ctx.warnings) >= 1 and len(res.warnings) >= 1, "Deprecation warning must be recorded in ctx.warnings and result.warnings"
    assert res.document.text == "hello world [v1-suffix]"
    assert res.document.metadata["legacy_ran"] is True
    assert res.document.metadata["word_count"] == 3
    assert res.document.to_dict()["extra_v1_field"] == 42

asyncio.run(run_test())

# Also test legacy Pipeline.run() triggers DeprecationWarning for v1 plugin
with warnings.catch_warnings(record=True) as caught_sync:
    warnings.simplefilter("always")
    out_sync = Pipeline([NormalizePlugin(), ExternalLegacyV1Plugin()]).run({"id": "s2", "text": "  abc  "})
dep_sync = [w for w in caught_sync if issubclass(w.category, DeprecationWarning)]
assert len(dep_sync) == 1, f"Expected 1 DeprecationWarning in Pipeline.run(), got {len(dep_sync)}"
assert out_sync["text"] == "abc [v1-suffix]"
assert out_sync["extra_v1_field"] == 42
print("OK")
"""
    proc = _run_py(workspace, code)
    if proc.returncode == 0 and "OK" in proc.stdout:
        return True, "Legacy v1 subclass shim emits DeprecationWarning, records ctx.warnings, and preserves output"
    detail = (proc.stderr or proc.stdout).strip()[-500:]
    return False, f"Legacy v1 shim check failed: {detail}"


def check_async_v2_custom_plugin_and_timings(workspace: Path) -> tuple[bool, str]:
    code = r"""
import asyncio, warnings
from docpipe import Document, ExecutionContext, Pipeline, PluginBase
from docpipe.plugins import EnrichPlugin, NormalizePlugin

class AsyncDelayV2Plugin(PluginBase):
    name = "async_delay"

    async def process_v2(self, ctx: ExecutionContext, doc: Document) -> Document:
        ctx.cancellation_token.raise_if_cancelled()
        await asyncio.sleep(0.03)
        doc.text = doc.text + " async-ok"
        doc.metadata["async_run_id"] = ctx.run_id
        return doc

async def main():
    ctx = ExecutionContext(run_id="async-run-99")
    pipe = Pipeline([NormalizePlugin(), AsyncDelayV2Plugin(), EnrichPlugin()])
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        res = await pipe.run_v2(Document(doc_id="a1", text="  start  "), ctx)

    dep = [w for w in caught if issubclass(w.category, DeprecationWarning)]
    assert len(dep) == 0, f"Unexpected deprecation warnings: {dep}"
    assert res.document.text == "start async-ok"
    assert res.document.metadata["async_run_id"] == "async-run-99"
    assert res.document.metadata["word_count"] == 2
    assert ctx.stage_timings_ms["async_delay"] >= 15.0, f"Timing too small: {ctx.stage_timings_ms}"
    stage_map = {s.plugin_name: s for s in res.stage_results}
    assert stage_map["async_delay"].status == "ok"
    assert stage_map["async_delay"].duration_ms >= 15.0
    assert res.total_duration_ms >= 15.0

asyncio.run(main())
print("OK")
"""
    proc = _run_py(workspace, code)
    if proc.returncode == 0 and "OK" in proc.stdout:
        return True, "Custom async v2 plugin executes without defining process() and records accurate timings"
    detail = (proc.stderr or proc.stdout).strip()[-500:]
    return False, f"Async v2 custom plugin check failed: {detail}"


def check_pre_cancelled_token_handling(workspace: Path) -> tuple[bool, str]:
    code = r"""
import asyncio
from docpipe import (
    CancellationToken,
    Document,
    ExecutionContext,
    Pipeline,
    PipelineCancelledError,
    PluginBase,
)

executed = []

class SpyPlugin(PluginBase):
    def __init__(self, name: str):
        self.name = name

    async def process_v2(self, ctx: ExecutionContext, doc: Document) -> Document:
        executed.append(self.name)
        return doc

async def main():
    tok1 = CancellationToken()
    tok1.cancel("already_done")
    ctx1 = ExecutionContext(cancellation_token=tok1)
    pipe = Pipeline([SpyPlugin("s1"), SpyPlugin("s2")])

    raised = False
    try:
        await pipe.run_v2(Document(doc_id="c1", text="hi"), ctx1, raise_on_cancel=True)
    except PipelineCancelledError:
        raised = True
    assert raised, "Pre-cancelled run_v2(raise_on_cancel=True) must raise PipelineCancelledError"
    assert executed == [], f"No plugin should run when pre-cancelled, ran: {executed}"

    tok2 = CancellationToken()
    tok2.cancel("stop_early")
    ctx2 = ExecutionContext(cancellation_token=tok2)
    res = await pipe.run_v2(Document(doc_id="c2", text="hi"), ctx2, raise_on_cancel=False)
    assert res.cancelled is True, "ProcessResult.cancelled must be True"
    assert executed == [], f"No plugin should run when pre-cancelled, ran: {executed}"
    assert all(s.status in ("skipped", "cancelled") for s in res.stage_results)

asyncio.run(main())
print("OK")
"""
    proc = _run_py(workspace, code)
    if proc.returncode == 0 and "OK" in proc.stdout:
        return True, "Pre-cancelled token raises PipelineCancelledError by default and returns cancelled ProcessResult when raise_on_cancel=False"
    detail = (proc.stderr or proc.stdout).strip()[-500:]
    return False, f"Pre-cancelled token check failed: {detail}"


def check_mid_pipeline_cancellation_stops_downstream(workspace: Path) -> tuple[bool, str]:
    code = r"""
import asyncio
from docpipe import (
    CancellationToken,
    Document,
    ExecutionContext,
    Pipeline,
    PipelineCancelledError,
    PluginBase,
)

class RecordPlugin(PluginBase):
    def __init__(self, name: str, log: list[str]):
        self.name = name
        self._log = log

    async def process_v2(self, ctx: ExecutionContext, doc: Document) -> Document:
        ctx.cancellation_token.raise_if_cancelled()
        self._log.append(self.name)
        return doc

class CancelInsidePlugin(PluginBase):
    name = "canceller"

    def __init__(self, log: list[str], raise_inside: bool):
        self._log = log
        self._raise_inside = raise_inside

    async def process_v2(self, ctx: ExecutionContext, doc: Document) -> Document:
        self._log.append(self.name)
        ctx.cancellation_token.cancel("mid_stop")
        if self._raise_inside:
            ctx.cancellation_token.raise_if_cancelled()
        return doc

async def main():
    # Case 1: raise_on_cancel=False, plugin cancels & raises inside
    log1: list[str] = []
    pipe1 = Pipeline([
        RecordPlugin("stage1", log1),
        CancelInsidePlugin(log1, raise_inside=True),
        RecordPlugin("never_runs", log1),
    ])
    res1 = await pipe1.run_v2(Document(doc_id="m1", text="t"), ExecutionContext(), raise_on_cancel=False)
    assert res1.cancelled is True
    assert log1 == ["stage1", "canceller"], f"Unexpected execution order: {log1}"
    assert "never_runs" not in log1

    # Case 2: raise_on_cancel=False, plugin cancels token without raising
    log2: list[str] = []
    pipe2 = Pipeline([
        RecordPlugin("stage1", log2),
        CancelInsidePlugin(log2, raise_inside=False),
        RecordPlugin("never_runs", log2),
    ])
    res2 = await pipe2.run_v2(Document(doc_id="m2", text="t"), ExecutionContext(), raise_on_cancel=False)
    assert res2.cancelled is True
    assert log2 == ["stage1", "canceller"], f"Unexpected execution order: {log2}"
    assert "never_runs" not in log2

    # Case 3: raise_on_cancel=True raises PipelineCancelledError and stops downstream
    log3: list[str] = []
    pipe3 = Pipeline([
        RecordPlugin("stage1", log3),
        CancelInsidePlugin(log3, raise_inside=False),
        RecordPlugin("never_runs", log3),
    ])
    raised = False
    try:
        await pipe3.run_v2(Document(doc_id="m3", text="t"), ExecutionContext(), raise_on_cancel=True)
    except PipelineCancelledError:
        raised = True
    assert raised, "Mid-pipeline cancel with raise_on_cancel=True must raise PipelineCancelledError"
    assert log3 == ["stage1", "canceller"], f"Unexpected execution order: {log3}"

asyncio.run(main())
print("OK")
"""
    proc = _run_py(workspace, code)
    if proc.returncode == 0 and "OK" in proc.stdout:
        return True, "Mid-pipeline cancellation halts downstream plugins cleanly in both raise_on_cancel modes"
    detail = (proc.stderr or proc.stdout).strip()[-500:]
    return False, f"Mid-pipeline cancellation check failed: {detail}"


def check_cli_v2_flag_output(workspace: Path) -> tuple[bool, str]:
    with tempfile.TemporaryDirectory() as tmp:
        in_file = Path(tmp) / "doc_v2.json"
        out_file = Path(tmp) / "out_v2.json"
        in_file.write_text(
            json.dumps(
                {
                    "id": "cli-v2-doc",
                    "text": "  Alert   contact admin@corp.org  SSN 123-45-6789  ",
                    "metadata": {"title": "V2 CLI Test"},
                }
            ),
            encoding="utf-8",
        )
        proc = _run_cmd(
            workspace,
            [sys.executable, "-m", "docpipe.cli", "--input", str(in_file), "--output", str(out_file), "--v2"],
        )
        if proc.returncode != 0:
            return False, f"CLI --v2 failed (rc={proc.returncode}): {(proc.stderr or proc.stdout).strip()[-400:]}"
        try:
            data = json.loads(out_file.read_text(encoding="utf-8"))
        except Exception as exc:
            return False, f"CLI --v2 output invalid JSON: {exc}"
        for key in ("document", "stage_results", "total_duration_ms", "cancelled", "warnings"):
            if key not in data:
                return False, f"CLI --v2 JSON missing key '{key}': {list(data.keys())}"
        stages = data["stage_results"]
        if not isinstance(stages, list) or len(stages) != 4:
            return False, f"Expected 4 stage_results, got: {stages}"
        names = [s.get("plugin_name") for s in stages]
        if names != ["normalize", "redact", "chunk", "enrich"]:
            return False, f"Unexpected stage names: {names}"
        if not all(s.get("status") == "ok" and isinstance(s.get("duration_ms"), (int, float)) and s["duration_ms"] >= 0 for s in stages):
            return False, f"Invalid stage_results entries: {stages}"
        if data["document"].get("text") != "Alert contact [REDACTED_EMAIL] SSN [REDACTED_SSN]":
            return False, f"Unexpected document text: {data['document'].get('text')!r}"
        if data["cancelled"] is not False or data["warnings"] != []:
            return False, f"Unexpected cancelled/warnings: {data['cancelled']}, {data['warnings']}"
        return True, "CLI --v2 outputs complete ProcessResult JSON with 4 stage timings"


def main() -> int:
    parser = argparse.ArgumentParser(description=f"Verifier for {TASK_ID}")
    parser.add_argument("--workspace", required=True, help="Path to workspace directory")
    args = parser.parse_args()

    workspace = Path(args.workspace).resolve()
    checks_spec: list[tuple[str, str, Any]] = [
        ("legacy_unittest_suite", "pass_to_pass", check_legacy_unittest_suite),
        ("builtin_transform_semantics", "pass_to_pass", check_builtin_transform_semantics),
        ("cli_v1_execution", "pass_to_pass", check_cli_v1_execution),
        ("ast_builtin_async_process_v2", "fail_to_pass", check_ast_builtin_async_process_v2),
        ("v2_types_and_document_roundtrip", "fail_to_pass", check_v2_types_and_document_roundtrip),
        ("builtin_run_v2_zero_deprecation_warnings", "fail_to_pass", check_builtin_run_v2_zero_deprecation_warnings),
        ("legacy_v1_plugin_deprecation_shim", "fail_to_pass", check_legacy_v1_plugin_deprecation_shim),
        ("async_v2_custom_plugin_and_timings", "fail_to_pass", check_async_v2_custom_plugin_and_timings),
        ("pre_cancelled_token_handling", "fail_to_pass", check_pre_cancelled_token_handling),
        ("mid_pipeline_cancellation_stops_downstream", "fail_to_pass", check_mid_pipeline_cancellation_stops_downstream),
        ("cli_v2_flag_output", "fail_to_pass", check_cli_v2_flag_output),
    ]

    results: list[dict[str, Any]] = []
    top_error: str | None = None

    try:
        if not workspace.is_dir():
            raise FileNotFoundError(f"Workspace directory does not exist: {workspace}")

        for name, group, fn in checks_spec:
            try:
                ok, detail = fn(workspace)
            except Exception as exc:
                ok, detail = False, f"Verifier exception: {type(exc).__name__}: {exc}"
            results.append(
                {
                    "name": name,
                    "passed": bool(ok),
                    "group": group,
                    "detail": detail,
                }
            )
    except Exception as exc:
        top_error = f"{type(exc).__name__}: {exc}"

    f2p = [c for c in results if c["group"] == "fail_to_pass"]
    p2p = [c for c in results if c["group"] == "pass_to_pass"]
    total = len(results)
    passed_count = sum(1 for c in results if c["passed"])
    all_passed = top_error is None and total > 0 and passed_count == total
    score = 1.0 if all_passed else (round(passed_count / total, 4) if total > 0 else 0.0)

    payload = {
        "task_id": TASK_ID,
        "passed": all_passed,
        "score": score,
        "fail_to_pass": {
            "passed": sum(1 for c in f2p if c["passed"]),
            "total": len(f2p),
        },
        "pass_to_pass": {
            "passed": sum(1 for c in p2p if c["passed"]),
            "total": len(p2p),
        },
        "checks": results,
        "error": top_error,
    }
    print(json.dumps(payload, indent=2))
    return 0 if all_passed else 1


if __name__ == "__main__":
    raise SystemExit(main())

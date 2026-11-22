"""Wire-Level Telemetry Interceptor, Multi-Protocol Bridge & Fault Injector for htmustc.

Sits on an ephemeral loopback port (`127.0.0.1:<port>`) in front of `https://htmustc.id.vn`
(100% exclusive htmustc upstream; NEVER contacts OpenAI/Anthropic/Google directly).

Capabilities:
  1. Direct passthrough + wire telemetry for `/v1/models`, `/v1/chat/completions`,
     `/v1/responses`, `/backend-api/codex/responses`, `/v1/messages`, `/v1/messages/count_tokens`.
  2. Native Gemini `/v1beta/models/<model>:(generateContent|streamGenerateContent|countTokens)`
     translator bridging AGY CLI strictly onto `https://htmustc.id.vn/v1/chat/completions`
     (because hosted `htmustc.id.vn` returns Next.js 404 on `/v1beta`).
  3. Identical per-request wire metrics (`telemetry_wire.jsonl`) across all 5 harnesses:
     perf_counter_ns TTFB / TTFT / stream_end, burst-flush detector, canonical token
     normalization (`prompt_total = uncached + cache_read + cache_write`), Turn-1 system
     prompt overhead, tool calls, malformed tool JSON, truncated SSE EOF, and retries.
  4. Deterministic fault injection for Axis 11 resilience tasks (`429_502`, `sse_eof`).
  5. Optional local zero-latency mock mode (`mock_mode=True`) for zero-quota startup &
     20-tool dispatch throughput micro-benchmarks.
"""
from __future__ import annotations

import http.client
import http.server
import json
import os
import re
import socketserver
import ssl
import sys
import threading
import time
import urllib.parse
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


DEFAULT_UPSTREAM_BASE = "https://htmustc.id.vn"


def _normalize_usage(obj: dict) -> Dict[str, Any]:
    """Extract canonical token counters across OpenAI Chat, Responses, Anthropic & Gemini shapes."""
    u = obj
    for key in ("usage", "response", "message", "usageMetadata", "metadata"):
        sub = obj.get(key)
        if isinstance(sub, dict):
            if key in ("usage", "usageMetadata"):
                u = sub
                break
            if isinstance(sub.get("usage"), dict):
                u = sub["usage"]
                break
    if not isinstance(u, dict):
        return {}

    out: Dict[str, Any] = {}
    # Input
    for k in ("prompt_tokens", "input_tokens", "promptTokenCount"):
        if k in u and u[k] is not None:
            out["raw_input"] = int(u[k])
            break
    # Output
    for k in ("completion_tokens", "output_tokens", "candidatesTokenCount"):
        if k in u and u[k] is not None:
            out["output"] = int(u[k])
            break
    # Cache read
    ptd = u.get("prompt_tokens_details") or u.get("input_tokens_details") or {}
    if not isinstance(ptd, dict):
        ptd = {}
    for val in (
        ptd.get("cached_tokens"),
        u.get("cache_read_input_tokens"),
        u.get("cached_tokens"),
        u.get("cachedContentTokenCount"),
    ):
        if val is not None:
            out["cache_read"] = int(val)
            break
    # Cache write
    for val in (
        ptd.get("cache_creation_tokens"),
        u.get("cache_creation_input_tokens"),
        u.get("cache_write_input_tokens"),
    ):
        if val is not None:
            out["cache_write"] = int(val)
            break
    # Reasoning
    ctd = u.get("completion_tokens_details") or u.get("output_tokens_details") or {}
    if not isinstance(ctd, dict):
        ctd = {}
    for val in (
        ctd.get("reasoning_tokens"),
        u.get("reasoning_tokens"),
        u.get("thoughtsTokenCount"),
    ):
        if val is not None:
            out["reasoning"] = int(val)
            break
    # Anthropic semantics: input_tokens excludes cache halves when prompt_tokens is absent
    out["anthropic_excludes_cache"] = (
        "prompt_tokens" not in u
        and "input_tokens" in u
        and ("cache_read_input_tokens" in u or "cache_creation_input_tokens" in u)
    )
    return out


def _merge_usage(acc: Dict[str, Any], nxt: Dict[str, Any]) -> None:
    if not nxt:
        return
    for k in ("raw_input", "output", "cache_read", "cache_write", "reasoning"):
        if k in nxt:
            acc[k] = nxt[k]
    if nxt.get("anthropic_excludes_cache"):
        acc["anthropic_excludes_cache"] = True


def _finalize_usage(acc: Dict[str, Any]) -> Dict[str, int]:
    raw_in = int(acc.get("raw_input", 0))
    cache_r = int(acc.get("cache_read", 0))
    cache_w = int(acc.get("cache_write", 0))
    out_tok = int(acc.get("output", 0))
    reason = int(acc.get("reasoning", 0))
    if acc.get("anthropic_excludes_cache"):
        prompt_total = raw_in + cache_r + cache_w
        uncached = raw_in
    else:
        prompt_total = raw_in
        uncached = max(0, raw_in - cache_r - cache_w)
    return {
        "prompt_total": prompt_total,
        "uncached_input": uncached,
        "cache_read": cache_r,
        "cache_write": cache_w,
        "output_tokens": out_tok,
        "reasoning_tokens": reason,
    }


def _clean_json_schema_for_openai(schema: Any) -> Any:
    """Convert Gemini Schema (UPPERCASE types like OBJECT/STRING) to standard JSON Schema."""
    if not isinstance(schema, dict):
        return schema
    out: Dict[str, Any] = {}
    for k, v in schema.items():
        if k == "type" and isinstance(v, str):
            out["type"] = v.lower()
        elif k == "properties" and isinstance(v, dict):
            out["properties"] = {pk: _clean_json_schema_for_openai(pv) for pk, pv in v.items()}
        elif k == "items":
            out["items"] = _clean_json_schema_for_openai(v)
        elif k in ("anyOf", "oneOf", "allOf") and isinstance(v, list):
            out[k] = [_clean_json_schema_for_openai(x) for x in v]
        elif k in ("nullable", "propertyOrdering", "format"):
            if k == "format" and isinstance(v, str):
                out[k] = v
        else:
            out[k] = v
    return out


def gemini_req_to_openai_chat(model: str, gem_body: dict, stream: bool) -> dict:
    """Translate Gemini v1beta GenerateContentRequest -> OpenAI /v1/chat/completions."""
    messages: List[Dict[str, Any]] = []
    sys_inst = gem_body.get("systemInstruction") or gem_body.get("system_instruction")
    if isinstance(sys_inst, dict):
        parts = sys_inst.get("parts") or []
        sys_text = "\n".join(p.get("text", "") for p in parts if isinstance(p, dict) and p.get("text"))
        if sys_text:
            messages.append({"role": "system", "content": sys_text})

    call_id_queue: Dict[str, List[str]] = {}
    call_counter = 0

    for item in gem_body.get("contents") or []:
        if not isinstance(item, dict):
            continue
        role = item.get("role", "user")
        parts = item.get("parts") or []
        has_func_resp = any(isinstance(p, dict) and "functionResponse" in p for p in parts)
        if has_func_resp:
            # AGY CLI sends functionResponse inside role="model" or role="user" — always emit role="tool"
            extra_texts: List[str] = []
            for p in parts:
                if not isinstance(p, dict):
                    continue
                if "functionResponse" in p and isinstance(p["functionResponse"], dict):
                    fr = p["functionResponse"]
                    name = str(fr.get("name", ""))
                    resp = fr.get("response")
                    cid = str(fr.get("id") or "")
                    if not cid and call_id_queue.get(name):
                        cid = call_id_queue[name].pop(0)
                    if not cid:
                        call_counter += 1
                        cid = f"call_gem_{call_counter}"
                    if isinstance(resp, dict) and set(resp.keys()) == {"output"} and isinstance(resp["output"], str):
                        content_str = resp["output"]
                    elif isinstance(resp, str):
                        content_str = resp
                    else:
                        content_str = json.dumps(resp, ensure_ascii=False)
                    messages.append({
                        "role": "tool",
                        "tool_call_id": cid,
                        "name": name,
                        "content": content_str,
                    })
                elif "text" in p and not p.get("thought"):
                    extra_texts.append(str(p["text"]))
            if extra_texts:
                messages.append({"role": "user", "content": "\n".join(extra_texts)})
        elif role == "model":
            text_chunks: List[str] = []
            tool_calls: List[Dict[str, Any]] = []
            for p in parts:
                if not isinstance(p, dict):
                    continue
                if "text" in p and not p.get("thought"):
                    text_chunks.append(str(p["text"]))
                elif "functionCall" in p and isinstance(p["functionCall"], dict):
                    fc = p["functionCall"]
                    name = str(fc.get("name", ""))
                    args = fc.get("args") or {}
                    call_counter += 1
                    cid = str(fc.get("id") or f"call_gem_{call_counter}")
                    call_id_queue.setdefault(name, []).append(cid)
                    tool_calls.append({
                        "id": cid,
                        "type": "function",
                        "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)},
                    })
            msg: Dict[str, Any] = {"role": "assistant", "content": "".join(text_chunks) or None}
            if tool_calls:
                msg["tool_calls"] = tool_calls
            if msg["content"] is not None or tool_calls:
                messages.append(msg)
        else:
            user_texts: List[str] = []
            for p in parts:
                if isinstance(p, dict) and "text" in p:
                    user_texts.append(str(p["text"]))
            if user_texts:
                messages.append({"role": "user", "content": "\n".join(user_texts)})

    oai: Dict[str, Any] = {"model": model, "messages": messages, "stream": stream}
    if stream:
        oai["stream_options"] = {"include_usage": True}

    gen_cfg = gem_body.get("generationConfig") or gem_body.get("generation_config") or {}
    if isinstance(gen_cfg, dict):
        if gen_cfg.get("maxOutputTokens"):
            oai["max_tokens"] = int(gen_cfg["maxOutputTokens"])
        if gen_cfg.get("temperature") is not None and not model.startswith("gpt-"):
            oai["temperature"] = float(gen_cfg["temperature"])
        if gen_cfg.get("stopSequences"):
            oai["stop"] = gen_cfg["stopSequences"]

    tools_out: List[Dict[str, Any]] = []
    for t in gem_body.get("tools") or []:
        if not isinstance(t, dict):
            continue
        for fd in t.get("functionDeclarations") or t.get("function_declarations") or []:
            if not isinstance(fd, dict) or not fd.get("name"):
                continue
            params = _clean_json_schema_for_openai(
                fd.get("parameters") or fd.get("parametersJsonSchema") or {"type": "object", "properties": {}}
            )
            tools_out.append({
                "type": "function",
                "function": {
                    "name": fd["name"],
                    "description": fd.get("description", ""),
                    "parameters": params,
                },
            })
    if tools_out:
        oai["tools"] = tools_out
    return oai


def _map_finish_reason_to_gemini(fr: Optional[str]) -> str:
    if not fr:
        return "STOP"
    m = {
        "stop": "STOP",
        "tool_calls": "STOP",
        "function_call": "STOP",
        "length": "MAX_TOKENS",
        "content_filter": "SAFETY",
    }
    return m.get(fr.lower(), "STOP")


def openai_nonstream_to_gemini_resp(oai: dict) -> dict:
    parts: List[Dict[str, Any]] = []
    finish = "STOP"
    choices = oai.get("choices") or []
    if choices and isinstance(choices[0], dict):
        c0 = choices[0]
        finish = _map_finish_reason_to_gemini(c0.get("finish_reason"))
        msg = c0.get("message") or {}
        if msg.get("reasoning_content"):
            parts.append({"text": str(msg["reasoning_content"]), "thought": True})
        if msg.get("content"):
            parts.append({"text": str(msg["content"])})
        for tc in msg.get("tool_calls") or []:
            fn = tc.get("function") or {}
            raw_args = fn.get("arguments") or "{}"
            try:
                parsed_args = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
            except json.JSONDecodeError:
                parsed_args = {"_raw": raw_args}
            parts.append({
                "functionCall": {
                    "id": tc.get("id") or f"call_{uuid.uuid4().hex[:8]}",
                    "name": fn.get("name", ""),
                    "args": parsed_args,
                },
            })
    usage = _finalize_usage(_normalize_usage(oai))
    return {
        "candidates": [{
            "content": {"role": "model", "parts": parts or [{"text": ""}]},
            "finishReason": finish,
            "index": 0,
        }],
        "usageMetadata": {
            "promptTokenCount": usage["prompt_total"],
            "cachedContentTokenCount": usage["cache_read"],
            "candidatesTokenCount": usage["output_tokens"],
            "thoughtsTokenCount": usage["reasoning_tokens"],
            "totalTokenCount": usage["prompt_total"] + usage["output_tokens"],
        },
        "modelVersion": oai.get("model", ""),
    }


@dataclass
class ProxyState:
    run_id: str
    harness: str
    task_id: str
    model_override: Optional[str] = None
    upstream_base: str = DEFAULT_UPSTREAM_BASE
    upstream_api_key: str = ""
    log_path: Optional[Path] = None
    fault_mode: Optional[str] = None  # None | "429_502" | "sse_eof"
    mock_mode: bool = False
    mock_tool_steps: int = 0
    lock: threading.Lock = field(default_factory=threading.Lock)
    seq: int = 0
    faults_fired: Dict[str, int] = field(default_factory=dict)
    records: List[Dict[str, Any]] = field(default_factory=list)
    mock_turn: int = 0

    def next_seq(self) -> int:
        with self.lock:
            self.seq += 1
            return self.seq

    def record(self, rec: Dict[str, Any]) -> None:
        with self.lock:
            self.records.append(rec)
            if self.log_path:
                self.log_path.parent.mkdir(parents=True, exist_ok=True)
                with open(self.log_path, "a", encoding="utf-8") as f:
                    f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    def get_summary(self) -> Dict[str, Any]:
        with self.lock:
            recs = list(self.records)
        llm_recs = [r for r in recs if r.get("is_inference")]
        total_req = len(llm_recs)
        err_req = sum(1 for r in llm_recs if int(r.get("http_status", 0)) >= 400 or r.get("truncated_sse_eof"))
        fault_inj = sum(1 for r in llm_recs if r.get("is_fault_injected"))
        total_llm_wait_ms = sum(float(r.get("wire_llm_wait_ms", 0.0)) for r in llm_recs)
        first_ttft = next((r["wire_ttft_ms"] for r in llm_recs if r.get("wire_ttft_ms") is not None), None)
        ttfts = [r["wire_ttft_ms"] for r in llm_recs if r.get("wire_ttft_ms") is not None]
        prompt_total = sum(int(r.get("prompt_total", 0)) for r in llm_recs)
        uncached = sum(int(r.get("uncached_input", 0)) for r in llm_recs)
        cache_r = sum(int(r.get("cache_read", 0)) for r in llm_recs)
        cache_w = sum(int(r.get("cache_write", 0)) for r in llm_recs)
        out_tok = sum(int(r.get("output_tokens", 0)) for r in llm_recs)
        reason_tok = sum(int(r.get("reasoning_tokens", 0)) for r in llm_recs)
        turn1_prompt = llm_recs[0]["prompt_total"] if llm_recs else 0
        # KV cache hit rate across turns >= 2
        ge2_prompt = sum(int(r.get("prompt_total", 0)) for r in llm_recs[1:])
        ge2_cache_r = sum(int(r.get("cache_read", 0)) for r in llm_recs[1:])
        kv_hit_ge2 = (ge2_cache_r / ge2_prompt) if ge2_prompt > 0 else 0.0
        kv_hit_all = (cache_r / prompt_total) if prompt_total > 0 else 0.0
        burst_count = sum(1 for r in llm_recs if r.get("burst_flush_detected"))
        trunc_count = sum(1 for r in llm_recs if r.get("truncated_sse_eof"))
        malformed_tools = sum(int(r.get("malformed_tool_json", 0)) for r in llm_recs)
        tool_calls_wire = sum(int(r.get("tool_calls_emitted", 0)) for r in llm_recs)
        non_burst_gen_ms = sum(
            float(r.get("gen_window_ms", 0.0)) for r in llm_recs if not r.get("burst_flush_detected") and r.get("output_tokens", 0) > 0
        )
        non_burst_out = sum(
            int(r.get("output_tokens", 0)) for r in llm_recs if not r.get("burst_flush_detected") and r.get("output_tokens", 0) > 0
        )
        wire_gen_tps = (non_burst_out / (non_burst_gen_ms / 1000.0)) if non_burst_gen_ms > 10 else 0.0
        eff_cost = 1.0 * uncached + 0.1 * cache_r + 1.25 * cache_w + 5.0 * out_tok
        return {
            "wire_requests": total_req,
            "wire_total_http_calls": len(recs),
            "wire_errors": err_req,
            "wire_faults_injected": fault_inj,
            "wire_first_ttft_ms": round(first_ttft, 2) if first_ttft is not None else None,
            "wire_median_ttft_ms": round(sorted(ttfts)[len(ttfts) // 2], 2) if ttfts else None,
            "wire_total_llm_wait_ms": round(total_llm_wait_ms, 2),
            "wire_gen_tokens_per_sec": round(wire_gen_tps, 2),
            "wire_prompt_total": prompt_total,
            "wire_uncached_input": uncached,
            "wire_cache_read": cache_r,
            "wire_cache_write": cache_w,
            "wire_output_tokens": out_tok,
            "wire_reasoning_tokens": reason_tok,
            "wire_total_tokens": prompt_total + out_tok,
            "wire_turn1_prompt_tokens": turn1_prompt,
            "wire_kv_cache_hit_rate": round(kv_hit_all, 4),
            "wire_kv_cache_hit_rate_ge2": round(kv_hit_ge2, 4),
            "wire_burst_flush_count": burst_count,
            "wire_truncated_eof_count": trunc_count,
            "wire_tool_calls_emitted": tool_calls_wire,
            "wire_malformed_tool_json": malformed_tools,
            "wire_effective_cost_units": round(eff_cost, 1),
            "wire_first_req_perf_ns": llm_recs[0]["t_req_start_ns"] if llm_recs else None,
        }


class _ThreadedServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address) -> None:
        _, exc, _ = sys.exc_info()
        if isinstance(exc, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, OSError)):
            return
        super().handle_error(request, client_address)


def _make_handler(state: ProxyState):
    parsed_up = urllib.parse.urlparse(state.upstream_base)
    up_scheme = parsed_up.scheme or "https"
    up_host = parsed_up.hostname or "htmustc.id.vn"
    up_port = parsed_up.port or (443 if up_scheme == "https" else 80)
    ssl_ctx = ssl.create_default_context()

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            return  # quiet

        def _open_upstream(self) -> http.client.HTTPConnection:
            if up_scheme == "https":
                return http.client.HTTPSConnection(up_host, up_port, timeout=180, context=ssl_ctx)
            return http.client.HTTPConnection(up_host, up_port, timeout=180)

        def _read_body(self) -> bytes:
            if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
                chunks = []
                while True:
                    line = self.rfile.readline()
                    if not line:
                        break
                    sz = int(line.strip().split(b";")[0], 16)
                    if sz == 0:
                        self.rfile.readline()
                        break
                    chunks.append(self.rfile.read(sz))
                    self.rfile.readline()
                return b"".join(chunks)
            cl = int(self.headers.get("Content-Length") or "0")
            return self.rfile.read(cl) if cl > 0 else b""

        def do_GET(self) -> None:
            self._handle("GET")

        def do_POST(self) -> None:
            self._handle("POST")

        def _send_json(self, code: int, obj: Any, extra_headers: Optional[Dict[str, str]] = None) -> None:
            raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            if extra_headers:
                for k, v in extra_headers.items():
                    self.send_header(k, v)
            self.end_headers()
            self.wfile.write(raw)
            self.wfile.flush()

        def _handle_mock(self, path: str, body_bytes: bytes, seq: int, t0_ns: int) -> None:
            """Zero-latency mock endpoint for cold-start & tool-dispatch microbenches."""
            is_gemini = "/v1beta/" in path
            is_anthropic = "/messages" in path
            is_responses = "/responses" in path
            with state.lock:
                state.mock_turn += 1
                turn = state.mock_turn
            state.record({
                "seq": seq, "run_id": state.run_id, "harness": state.harness, "task_id": state.task_id,
                "wire_protocol": "mock", "endpoint": path, "is_inference": True, "http_status": 200,
                "t_req_start_ns": t0_ns, "wire_ttft_ms": 0.5, "wire_llm_wait_ms": 1.0,
                "prompt_total": 100, "uncached_input": 100, "cache_read": 0, "cache_write": 0,
                "output_tokens": 5, "reasoning_tokens": 0,
            })
            if path.endswith("/models"):
                self._send_json(200, {"object": "list", "data": [{"id": "mock-model", "object": "model"}]})
                return
            if is_gemini:
                resp = {
                    "candidates": [{"content": {"role": "model", "parts": [{"text": "OK"}]}, "finishReason": "STOP", "index": 0}],
                    "usageMetadata": {"promptTokenCount": 100, "candidatesTokenCount": 5, "totalTokenCount": 105},
                }
                if "streamGenerateContent" in path:
                    payload = f"data: {json.dumps(resp)}\n\n".encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                else:
                    self._send_json(200, resp)
                return
            if is_anthropic:
                events = [
                    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_mock","type":"message","role":"assistant","content":[],"model":"mock-model","stop_reason":null,"usage":{"input_tokens":100,"output_tokens":0}}}\n\n',
                    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
                    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\n',
                    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
                    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}\n\n',
                    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
                ]
                payload = "".join(events).encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            if is_responses:
                ev1 = {"type": "response.created", "response": {"id": "resp_mock", "status": "in_progress"}}
                ev2 = {"type": "response.output_text.delta", "delta": "OK"}
                ev3 = {
                    "type": "response.completed",
                    "response": {
                        "id": "resp_mock", "status": "completed",
                        "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "OK"}]}],
                        "usage": {"input_tokens": 100, "output_tokens": 5, "total_tokens": 105},
                    },
                }
                payload = (
                    f"event: response.created\ndata: {json.dumps(ev1)}\n\n"
                    f"event: response.output_text.delta\ndata: {json.dumps(ev2)}\n\n"
                    f"event: response.completed\ndata: {json.dumps(ev3)}\n\n"
                ).encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            # OpenAI Chat
            chunk1 = {"id": "chatcmpl-mock", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {"role": "assistant", "content": "OK"}, "finish_reason": None}]}
            chunk2 = {"id": "chatcmpl-mock", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 100, "completion_tokens": 5, "total_tokens": 105}}
            payload = f"data: {json.dumps(chunk1)}\n\ndata: {json.dumps(chunk2)}\n\ndata: [DONE]\n\n".encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def _maybe_inject_fault(self, seq: int, path: str, wire_proto: str, t0_ns: int) -> Optional[str]:
            """Return None if no fault, '429'/'502' if already answered, or 'truncate_sse' for stream cut."""
            if not state.fault_mode:
                return None
            with state.lock:
                inf_num = sum(1 for r in state.records if r.get("is_inference") and not r.get("is_fault_injected")) + 1
                if state.fault_mode == "429_502":
                    if inf_num == 2 and state.faults_fired.get("t2_429", 0) == 0:
                        state.faults_fired["t2_429"] = 1
                        code, msg = 429, "Synthetic benchmark 429 rate limit — retry after 2s"
                    elif inf_num == 4 and state.faults_fired.get("t4_502", 0) == 0:
                        state.faults_fired["t4_502"] = 1
                        code, msg = 502, "Synthetic benchmark 502 upstream gateway error"
                    else:
                        return None
                elif state.fault_mode == "sse_eof":
                    if inf_num == 3 and state.faults_fired.get("t3_eof", 0) == 0:
                        state.faults_fired["t3_eof"] = 1
                        return "truncate_sse"
                    return None
                else:
                    return None
            err_body = (
                {"type": "error", "error": {"type": "rate_limit_error" if code == 429 else "api_error", "message": msg}}
                if wire_proto == "anthropic_messages"
                else {"error": {"message": msg, "type": "rate_limit_error" if code == 429 else "server_error", "code": code}}
            )
            extra = {"Retry-After": "2"} if code == 429 else {}
            self._send_json(code, err_body, extra)
            state.record({
                "seq": seq, "run_id": state.run_id, "harness": state.harness, "task_id": state.task_id,
                "wire_protocol": wire_proto, "endpoint": path, "is_inference": True, "is_fault_injected": True,
                "http_status": code, "t_req_start_ns": t0_ns, "wire_llm_wait_ms": 1.0,
                "prompt_total": 0, "uncached_input": 0, "cache_read": 0, "cache_write": 0, "output_tokens": 0,
            })
            return str(code)

        def _handle(self, method: str) -> None:
            t0_ns = time.perf_counter_ns()
            seq = state.next_seq()
            body_bytes = self._read_body() if method in ("POST", "PUT", "PATCH") else b""
            path = self.path

            if state.mock_mode:
                self._handle_mock(path, body_bytes, seq, t0_ns)
                return

            # Fast local count_tokens fallback
            if path.endswith("/count_tokens") or ":countTokens" in path:
                est = max(1, len(body_bytes) // 4)
                if ":countTokens" in path:
                    self._send_json(200, {"totalTokens": est})
                else:
                    self._send_json(200, {"input_tokens": est})
                state.record({
                    "seq": seq, "run_id": state.run_id, "harness": state.harness, "task_id": state.task_id,
                    "wire_protocol": "count_tokens", "endpoint": path, "is_inference": False,
                    "http_status": 200, "t_req_start_ns": t0_ns, "req_bytes": len(body_bytes),
                })
                return

            # Gemini v1beta bridge -> htmustc /v1/chat/completions
            if "/v1beta/models/" in path or "/models/" in path and (":generateContent" in path or ":streamGenerateContent" in path):
                self._handle_gemini_bridge(path, body_bytes, seq, t0_ns)
                return

            # Classify protocol
            parsed_path = urllib.parse.urlparse(path).path
            if parsed_path.endswith("/responses"):
                wire_proto = "openai_responses"
                up_path = "/v1/responses"
                is_inf = True
            elif parsed_path.endswith("/messages"):
                wire_proto = "anthropic_messages"
                up_path = "/v1/messages"
                is_inf = True
            elif parsed_path.endswith("/chat/completions"):
                wire_proto = "openai_chat"
                up_path = "/v1/chat/completions"
                is_inf = True
            else:
                wire_proto = "other"
                up_path = path
                is_inf = False

            truncate_sse = False
            if is_inf:
                fault = self._maybe_inject_fault(seq, path, wire_proto, t0_ns)
                if fault in ("429", "502"):
                    return
                if fault == "truncate_sse":
                    truncate_sse = True

            # Parse request JSON for telemetry & optional model alias rewrite
            req_model = ""
            tools_count = 0
            want_stream = False
            out_body = body_bytes
            if body_bytes and body_bytes.lstrip().startswith(b"{"):
                try:
                    j = json.loads(body_bytes.decode("utf-8"))
                    req_model = str(j.get("model") or "")
                    want_stream = bool(j.get("stream", False))
                    if isinstance(j.get("tools"), list):
                        tools_count = len(j["tools"])
                    if state.model_override and is_inf and req_model != state.model_override:
                        j["model"] = state.model_override
                        req_model = state.model_override
                        out_body = json.dumps(j, ensure_ascii=False).encode("utf-8")
                    # Ensure OpenAI Chat streaming always returns usage
                    if wire_proto == "openai_chat" and want_stream and "stream_options" not in j:
                        j["stream_options"] = {"include_usage": True}
                        out_body = json.dumps(j, ensure_ascii=False).encode("utf-8")
                except Exception:
                    pass

            # Build upstream headers (inject real htmustc key, strip hop-by-hop)
            up_headers: Dict[str, str] = {
                "Host": up_host,
                "Accept-Encoding": "identity",
            }
            for k, v in self.headers.items():
                kl = k.lower()
                if kl in ("host", "content-length", "connection", "accept-encoding", "authorization", "x-api-key", "x-goog-api-key"):
                    continue
                up_headers[k] = v
            if state.upstream_api_key:
                up_headers["Authorization"] = f"Bearer {state.upstream_api_key}"
                if wire_proto == "anthropic_messages":
                    up_headers["x-api-key"] = state.upstream_api_key
            if out_body:
                up_headers["Content-Length"] = str(len(out_body))

            conn = self._open_upstream()
            t_fb_ns: Optional[int] = None
            t_first_delta_ns: Optional[int] = None
            resp_bytes = 0
            usage_acc: Dict[str, Any] = {}
            tool_calls_seen = 0
            malformed_tool_json = 0
            saw_terminal = False
            status = 502
            err_msg = ""

            try:
                conn.request(method, up_path, body=out_body if method != "GET" else None, headers=up_headers)
                resp = conn.getresponse()
                status = resp.status
                ctype = resp.getheader("Content-Type", "application/json")
                is_sse = "text/event-stream" in ctype.lower()

                self.send_response(status)
                for hk, hv in resp.getheaders():
                    hl = hk.lower()
                    if hl in ("transfer-encoding", "content-length", "connection"):
                        continue
                    self.send_header(hk, hv)
                if not is_sse:
                    full = resp.read()
                    t_fb_ns = time.perf_counter_ns()
                    t_first_delta_ns = t_fb_ns
                    resp_bytes = len(full)
                    self.send_header("Content-Length", str(len(full)))
                    self.end_headers()
                    self.wfile.write(full)
                    self.wfile.flush()
                    if status == 200 and full.lstrip().startswith(b"{"):
                        try:
                            parsed = json.loads(full.decode("utf-8", "replace"))
                            _merge_usage(usage_acc, _normalize_usage(parsed))
                            saw_terminal = True
                        except Exception:
                            pass
                else:
                    self.send_header("Cache-Control", "no-cache")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    buf = b""
                    frames_sent = 0
                    while True:
                        chunk = resp.read(4096)
                        if not chunk:
                            break
                        now_ns = time.perf_counter_ns()
                        if t_fb_ns is None:
                            t_fb_ns = now_ns
                        resp_bytes += len(chunk)
                        # Inspect SSE frames
                        buf += chunk
                        while b"\n" in buf:
                            line, buf = buf.split(b"\n", 1)
                            s = line.strip()
                            if not s.startswith(b"data:"):
                                continue
                            payload = s[5:].strip()
                            if payload == b"[DONE]":
                                saw_terminal = True
                                continue
                            if payload.startswith(b"{"):
                                try:
                                    ev = json.loads(payload.decode("utf-8", "replace"))
                                    _merge_usage(usage_acc, _normalize_usage(ev))
                                    if t_first_delta_ns is None and _sse_has_content_or_tool(ev):
                                        t_first_delta_ns = now_ns
                                    tc_n, bad_n, term = _inspect_sse_event(ev)
                                    tool_calls_seen += tc_n
                                    malformed_tool_json += bad_n
                                    if term:
                                        saw_terminal = True
                                except Exception:
                                    pass
                        self.wfile.write(chunk)
                        self.wfile.flush()
                        frames_sent += 1
                        if truncate_sse and frames_sent >= 2:
                            # Abruptly drop stream to test harness SSE recovery
                            self.close_connection = True
                            saw_terminal = False
                            break
                    self.close_connection = True
            except Exception as exc:
                err_msg = f"{type(exc).__name__}: {exc}"
                if t_fb_ns is None:
                    try:
                        self._send_json(502, {"error": {"message": err_msg, "type": "proxy_error"}})
                    except Exception:
                        pass
            finally:
                try:
                    conn.close()
                except Exception:
                    pass

            t_end_ns = time.perf_counter_ns()
            u_fin = _finalize_usage(usage_acc)
            wait_ms = (t_end_ns - t0_ns) / 1e6
            ttfb_ms = ((t_fb_ns - t0_ns) / 1e6) if t_fb_ns else None
            ttft_ms = ((t_first_delta_ns - t0_ns) / 1e6) if t_first_delta_ns else ttfb_ms
            gen_ms = ((t_end_ns - t_first_delta_ns) / 1e6) if t_first_delta_ns else 0.0
            burst = (u_fin["output_tokens"] >= 30 and gen_ms < 80.0)
            trunc = bool(is_inf and want_stream and status == 200 and not saw_terminal)

            state.record({
                "seq": seq,
                "run_id": state.run_id,
                "harness": state.harness,
                "task_id": state.task_id,
                "model": req_model,
                "wire_protocol": wire_proto,
                "endpoint": parsed_path,
                "stream": want_stream,
                "is_inference": is_inf,
                "is_fault_injected": truncate_sse,
                "http_status": status,
                "t_req_start_ns": t0_ns,
                "t_first_sse_byte_ns": t_fb_ns,
                "t_first_content_delta_ns": t_first_delta_ns,
                "t_stream_end_ns": t_end_ns,
                "wire_ttfb_ms": round(ttfb_ms, 2) if ttfb_ms is not None else None,
                "wire_ttft_ms": round(ttft_ms, 2) if ttft_ms is not None else None,
                "wire_llm_wait_ms": round(wait_ms, 2),
                "gen_window_ms": round(gen_ms, 2),
                "burst_flush_detected": burst,
                "req_bytes": len(out_body),
                "resp_bytes": resp_bytes,
                "tools_count": tools_count,
                **u_fin,
                "kv_cache_hit_rate": round(u_fin["cache_read"] / u_fin["prompt_total"], 4) if u_fin["prompt_total"] > 0 else 0.0,
                "tool_calls_emitted": tool_calls_seen,
                "malformed_tool_json": malformed_tool_json,
                "truncated_sse_eof": trunc,
                "empty_completion": bool(is_inf and status == 200 and u_fin["output_tokens"] == 0 and tool_calls_seen == 0),
                "error": err_msg or None,
            })

        def _handle_gemini_bridge(self, path: str, body_bytes: bytes, seq: int, t0_ns: int) -> None:
            """Translate AGY CLI Gemini /v1beta requests -> htmustc /v1/chat/completions."""
            parsed = urllib.parse.urlparse(path)
            m = re.search(r"/models/(.+?):(streamGenerateContent|generateContent)$", parsed.path)
            if not m:
                self._send_json(404, {"error": {"code": 404, "message": f"Unsupported Gemini path: {parsed.path}"}})
                return
            req_model = state.model_override or m.group(1)
            is_stream = m.group(2) == "streamGenerateContent"

            fault = self._maybe_inject_fault(seq, parsed.path, "gemini_v1beta", t0_ns)
            if fault in ("429", "502"):
                return
            truncate_sse = (fault == "truncate_sse")

            try:
                gem_req = json.loads(body_bytes.decode("utf-8"))
            except Exception as exc:
                self._send_json(400, {"error": {"code": 400, "message": f"Invalid JSON: {exc}"}})
                return

            oai_req = gemini_req_to_openai_chat(req_model, gem_req, stream=is_stream)
            tools_count = len(oai_req.get("tools") or [])
            oai_bytes = json.dumps(oai_req, ensure_ascii=False).encode("utf-8")

            up_headers = {
                "Host": up_host,
                "Content-Type": "application/json",
                "Accept-Encoding": "identity",
                "Content-Length": str(len(oai_bytes)),
            }
            if state.upstream_api_key:
                up_headers["Authorization"] = f"Bearer {state.upstream_api_key}"

            conn = self._open_upstream()
            t_fb_ns: Optional[int] = None
            t_first_delta_ns: Optional[int] = None
            resp_bytes = 0
            usage_acc: Dict[str, Any] = {}
            tool_calls_seen = 0
            malformed_tool_json = 0
            saw_terminal = False
            status = 502
            err_msg = ""

            try:
                conn.request("POST", "/v1/chat/completions", body=oai_bytes, headers=up_headers)
                resp = conn.getresponse()
                status = resp.status
                if status != 200:
                    err_raw = resp.read()
                    t_fb_ns = time.perf_counter_ns()
                    resp_bytes = len(err_raw)
                    self._send_json(status, {"error": {"code": status, "message": err_raw.decode("utf-8", "replace")[:800]}})
                elif not is_stream:
                    raw = resp.read()
                    t_fb_ns = time.perf_counter_ns()
                    t_first_delta_ns = t_fb_ns
                    resp_bytes = len(raw)
                    oai_resp = json.loads(raw.decode("utf-8", "replace"))
                    _merge_usage(usage_acc, _normalize_usage(oai_resp))
                    gem_resp = openai_nonstream_to_gemini_resp(oai_resp)
                    saw_terminal = True
                    self._send_json(200, gem_resp)
                else:
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Cache-Control", "no-cache")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    buf = b""
                    # Accumulate streaming tool calls until finish so Gemini gets complete functionCall parts
                    pending_tools: Dict[int, Dict[str, str]] = {}
                    last_finish: Optional[str] = None
                    frames_sent = 0
                    while True:
                        chunk = resp.read(4096)
                        if not chunk:
                            break
                        now_ns = time.perf_counter_ns()
                        if t_fb_ns is None:
                            t_fb_ns = now_ns
                        resp_bytes += len(chunk)
                        buf += chunk
                        while b"\n" in buf:
                            line, buf = buf.split(b"\n", 1)
                            s = line.strip()
                            if not s.startswith(b"data:"):
                                continue
                            payload = s[5:].strip()
                            if payload == b"[DONE]":
                                saw_terminal = True
                                continue
                            if not payload.startswith(b"{"):
                                continue
                            try:
                                ev = json.loads(payload.decode("utf-8", "replace"))
                            except Exception:
                                continue
                            _merge_usage(usage_acc, _normalize_usage(ev))
                            choices = ev.get("choices") or []
                            if not choices:
                                continue
                            c0 = choices[0]
                            delta = c0.get("delta") or {}
                            fr = c0.get("finish_reason")
                            if fr:
                                last_finish = fr
                                saw_terminal = True
                            parts: List[Dict[str, Any]] = []
                            if delta.get("reasoning_content"):
                                if t_first_delta_ns is None:
                                    t_first_delta_ns = now_ns
                                parts.append({"text": str(delta["reasoning_content"]), "thought": True})
                            if delta.get("content"):
                                if t_first_delta_ns is None:
                                    t_first_delta_ns = now_ns
                                parts.append({"text": str(delta["content"])})
                            for tc in delta.get("tool_calls") or []:
                                if t_first_delta_ns is None:
                                    t_first_delta_ns = now_ns
                                idx = int(tc.get("index", 0))
                                slot = pending_tools.setdefault(idx, {"id": "", "name": "", "args": ""})
                                if tc.get("id"):
                                    slot["id"] = str(tc["id"])
                                fn = tc.get("function") or {}
                                if fn.get("name"):
                                    slot["name"] += str(fn["name"])
                                if fn.get("arguments"):
                                    slot["args"] += str(fn["arguments"])
                            if parts:
                                frame = {"candidates": [{"content": {"role": "model", "parts": parts}, "index": 0}], "modelVersion": req_model}
                                self.wfile.write(f"data: {json.dumps(frame, ensure_ascii=False)}\n\n".encode("utf-8"))
                                self.wfile.flush()
                                frames_sent += 1
                                if truncate_sse and frames_sent >= 2:
                                    self.close_connection = True
                                    saw_terminal = False
                                    break
                        if truncate_sse and frames_sent >= 2:
                            break
                    if not (truncate_sse and frames_sent >= 2):
                        final_parts: List[Dict[str, Any]] = []
                        for idx in sorted(pending_tools):
                            slot = pending_tools[idx]
                            tool_calls_seen += 1
                            try:
                                parsed_args = json.loads(slot["args"]) if slot["args"].strip() else {}
                            except json.JSONDecodeError:
                                malformed_tool_json += 1
                                parsed_args = {"_raw": slot["args"]}
                            final_parts.append({
                                "functionCall": {
                                    "id": slot["id"] or f"call_gem_{idx}_{uuid.uuid4().hex[:6]}",
                                    "name": slot["name"],
                                    "args": parsed_args,
                                },
                            })
                        u_fin = _finalize_usage(usage_acc)
                        term_frame: Dict[str, Any] = {
                            "candidates": [{
                                "content": {"role": "model", "parts": final_parts or [{"text": ""}]},
                                "finishReason": _map_finish_reason_to_gemini(last_finish),
                                "index": 0,
                            }],
                            "usageMetadata": {
                                "promptTokenCount": u_fin["prompt_total"],
                                "cachedContentTokenCount": u_fin["cache_read"],
                                "candidatesTokenCount": u_fin["output_tokens"],
                                "thoughtsTokenCount": u_fin["reasoning_tokens"],
                                "totalTokenCount": u_fin["prompt_total"] + u_fin["output_tokens"],
                            },
                            "modelVersion": req_model,
                        }
                        self.wfile.write(f"data: {json.dumps(term_frame, ensure_ascii=False)}\n\n".encode("utf-8"))
                        self.wfile.flush()
                    self.close_connection = True
            except Exception as exc:
                err_msg = f"{type(exc).__name__}: {exc}"
                if t_fb_ns is None:
                    try:
                        self._send_json(502, {"error": {"code": 502, "message": err_msg}})
                    except Exception:
                        pass
            finally:
                try:
                    conn.close()
                except Exception:
                    pass

            t_end_ns = time.perf_counter_ns()
            u_fin = _finalize_usage(usage_acc)
            wait_ms = (t_end_ns - t0_ns) / 1e6
            ttfb_ms = ((t_fb_ns - t0_ns) / 1e6) if t_fb_ns else None
            ttft_ms = ((t_first_delta_ns - t0_ns) / 1e6) if t_first_delta_ns else ttfb_ms
            gen_ms = ((t_end_ns - t_first_delta_ns) / 1e6) if t_first_delta_ns else 0.0
            state.record({
                "seq": seq,
                "run_id": state.run_id,
                "harness": state.harness,
                "task_id": state.task_id,
                "model": req_model,
                "wire_protocol": "gemini_v1beta_to_oai",
                "endpoint": parsed.path,
                "stream": is_stream,
                "is_inference": True,
                "is_fault_injected": truncate_sse,
                "http_status": status,
                "t_req_start_ns": t0_ns,
                "t_first_sse_byte_ns": t_fb_ns,
                "t_first_content_delta_ns": t_first_delta_ns,
                "t_stream_end_ns": t_end_ns,
                "wire_ttfb_ms": round(ttfb_ms, 2) if ttfb_ms is not None else None,
                "wire_ttft_ms": round(ttft_ms, 2) if ttft_ms is not None else None,
                "wire_llm_wait_ms": round(wait_ms, 2),
                "gen_window_ms": round(gen_ms, 2),
                "burst_flush_detected": (u_fin["output_tokens"] >= 30 and gen_ms < 80.0),
                "req_bytes": len(oai_bytes),
                "resp_bytes": resp_bytes,
                "tools_count": tools_count,
                **u_fin,
                "kv_cache_hit_rate": round(u_fin["cache_read"] / u_fin["prompt_total"], 4) if u_fin["prompt_total"] > 0 else 0.0,
                "tool_calls_emitted": tool_calls_seen,
                "malformed_tool_json": malformed_tool_json,
                "truncated_sse_eof": bool(is_stream and status == 200 and not saw_terminal),
                "empty_completion": bool(status == 200 and u_fin["output_tokens"] == 0 and tool_calls_seen == 0),
                "error": err_msg or None,
            })

    return Handler


def _sse_has_content_or_tool(ev: dict) -> bool:
    etype = ev.get("type", "")
    if etype in ("content_block_delta", "response.output_text.delta", "response.function_call_arguments.delta", "response.reasoning_summary_text.delta"):
        return True
    choices = ev.get("choices")
    if isinstance(choices, list) and choices:
        d = choices[0].get("delta") or {}
        if d.get("content") or d.get("reasoning_content") or d.get("tool_calls"):
            return True
    return False


def _inspect_sse_event(ev: dict) -> Tuple[int, int, bool]:
    """Return (tool_calls_completed, malformed_json_count, is_terminal)."""
    tc = 0
    bad = 0
    term = False
    etype = ev.get("type", "")
    if etype in ("message_stop", "response.completed", "response.done"):
        term = True
    if etype == "content_block_start" and (ev.get("content_block") or {}).get("type") == "tool_use":
        tc += 1
    if etype == "response.output_item.done":
        item = ev.get("item") or {}
        if item.get("type") in ("function_call", "custom_tool_call"):
            tc += 1
            args = item.get("arguments")
            if isinstance(args, str) and args.strip():
                try:
                    json.loads(args)
                except json.JSONDecodeError:
                    bad += 1
    choices = ev.get("choices")
    if isinstance(choices, list) and choices:
        c0 = choices[0]
        if c0.get("finish_reason"):
            term = True
        d = c0.get("delta") or {}
        for t in d.get("tool_calls") or []:
            if t.get("id"):
                tc += 1
    return tc, bad, term


class BenchTelemetryProxy:
    """Context-managed ephemeral loopback telemetry proxy bound to 127.0.0.1:0."""

    def __init__(
        self,
        run_id: str,
        harness: str,
        task_id: str,
        *,
        model_override: Optional[str] = None,
        upstream_base: Optional[str] = None,
        upstream_api_key: Optional[str] = None,
        log_path: Optional[Path] = None,
        fault_mode: Optional[str] = None,
        mock_mode: bool = False,
    ) -> None:
        self.state = ProxyState(
            run_id=run_id,
            harness=harness,
            task_id=task_id,
            model_override=model_override,
            upstream_base=(upstream_base or os.environ.get("HTMUSTC_BASE_URL") or DEFAULT_UPSTREAM_BASE).rstrip("/"),
            upstream_api_key=upstream_api_key if upstream_api_key is not None else os.environ.get("HTMUSTC_API_KEY", ""),
            log_path=log_path,
            fault_mode=fault_mode,
            mock_mode=mock_mode,
        )
        self._server: Optional[_ThreadedServer] = None
        self._thread: Optional[threading.Thread] = None
        self.port: int = 0

    def start(self) -> int:
        handler_cls = _make_handler(self.state)
        self._server = _ThreadedServer(("127.0.0.1", 0), handler_cls)
        self.port = int(self._server.server_address[1])
        self._thread = threading.Thread(target=self._server.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True)
        self._thread.start()
        return self.port

    def stop(self) -> Dict[str, Any]:
        if self._server:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        if self._thread:
            self._thread.join(timeout=2.0)
            self._thread = None
        return self.state.get_summary()

    def __enter__(self) -> "BenchTelemetryProxy":
        self.start()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.stop()

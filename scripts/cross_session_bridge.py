#!/usr/bin/env python3
"""Cross-Session Named Pipe IPC Bridge for Omnia.

Connects Omnia Desktop (Tauri/React) and Antigravity orchestrators with external
Claude Desktop and Claude CLI sessions running on the host via Windows Named Pipes.

Capabilities:
1. Dynamic session discovery: scans `~/.claude/sessions/*.json` and companion `*.key` files.
2. Named Pipe connection: connects to `\\\\.\\pipe\\LOCAL\\cc-msg-*`.
3. Protocol authentication handshake: sends `{"type":"auth","token":"<peerToken>"}\\n`.
4. Envelope serialization: formats `<cross-session-message>` XML inside JSON payloads.
5. JSONL tailing: streams real-time responses from `~/.claude/projects/D--Omnia/<sessionId>.jsonl`.
6. CLI interface: `--list`, `--target desktop|cli|<pid>`, `--message "..."`, `--stream`, `--probe`.
"""

from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import glob
import json
import os
import re
import sys
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple


# ==============================================================================
# Protocol Constants & Defaults
# ==============================================================================

PIPE_PREFIX = r"\\.\pipe\LOCAL\cc-msg-"
PIPE_URI_PREFIX = r"uds:\\.\pipe\LOCAL\cc-msg-"
PIPE_NAME_PATTERN = re.compile(
    r"^(?:uds:)?\\\\\.\\pipe\\LOCAL\\cc-msg-[0-9a-f]{32}$", re.IGNORECASE
)

DEFAULT_SESSIONS_DIR = os.path.expanduser(r"~\.claude\sessions")
DEFAULT_PROJECTS_DIR = os.path.expanduser(r"~\.claude\projects\D--Omnia")
CLAUDE_PROJECTS_BASE = os.path.expanduser(r"~\.claude\projects")

DEFAULT_BRIDGE_PIPE = r"\\.\pipe\LOCAL\cc-msg-omnia-bridge"
DEFAULT_BRIDGE_UDS = r"uds:\\.\pipe\LOCAL\cc-msg-omnia-bridge"
DEFAULT_BRIDGE_NAME = "Omnia Bridge"
DEFAULT_BRIDGE_MODE = "bypass"


# ==============================================================================
# Data Structures
# ==============================================================================

@dataclass
class SessionInfo:
    pid: int
    session_id: str
    name: str
    entrypoint: str
    kind: str
    pipe_path: str
    token: Optional[str] = None
    status: str = "unknown"
    cwd: str = ""
    started_at: Optional[int] = None
    updated_at: Optional[int] = None
    json_path: str = ""
    key_path: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "pid": self.pid,
            "session_id": self.session_id,
            "name": self.name,
            "entrypoint": self.entrypoint,
            "kind": self.kind,
            "pipe_path": self.pipe_path,
            "token": "***" if self.token else None,
            "status": self.status,
            "cwd": self.cwd,
            "started_at": self.started_at,
            "updated_at": self.updated_at,
        }


@dataclass
class CrossSessionMessage:
    from_endpoint: str
    content: str
    from_session: Optional[str] = None
    from_name: Optional[str] = "Omnia Bridge"
    from_mode: Optional[str] = "bypass"
    hop_chain: Optional[str] = None

    def serialize(self) -> str:
        attrs = [f'from="{self._escape_attr(self.from_endpoint)}"']
        if self.from_session:
            attrs.append(f'from-session="{self._escape_attr(self.from_session)}"')
        if self.from_name:
            attrs.append(f'from-name="{self._escape_attr(self.from_name)}"')
        if self.from_mode:
            attrs.append(f'from-mode="{self._escape_attr(self.from_mode)}"')
        if self.hop_chain:
            attrs.append(f'hop-chain="{self._escape_attr(self.hop_chain)}"')

        attr_str = " ".join(attrs)
        return f"<cross-session-message {attr_str}>\n{self.content}\n</cross-session-message>\n"

    @classmethod
    def deserialize(cls, text: str) -> CrossSessionMessage:
        pattern = re.compile(
            r'<cross-session-message\b([^>]*)>(?:\r?\n)?([\s\S]*)</cross-session-message>',
            re.DOTALL,
        )
        match = pattern.search(text)
        if not match:
            raise ValueError(f"Malformed cross-session message: tag not found in {text[:80]!r}")

        attr_raw = match.group(1)
        content = match.group(2)
        if content.endswith("\r\n"):
            content = content[:-2]
        elif content.endswith("\n"):
            content = content[:-1]

        def extract_attr(name: str) -> Optional[str]:
            m = re.search(rf'\b{name}="([^"]*)"', attr_raw)
            return cls._unescape_attr(m.group(1)) if m else None

        from_ep = extract_attr("from")
        if not from_ep:
            raise ValueError("Missing mandatory 'from' attribute in <cross-session-message>")

        return cls(
            from_endpoint=from_ep,
            content=content,
            from_session=extract_attr("from-session"),
            from_name=extract_attr("from-name"),
            from_mode=extract_attr("from-mode"),
            hop_chain=extract_attr("hop-chain"),
        )

    @staticmethod
    def _escape_attr(val: str) -> str:
        return (
            str(val)
            .replace("&", "&amp;")
            .replace('"', "&quot;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
        )

    @staticmethod
    def _unescape_attr(val: str) -> str:
        return (
            str(val)
            .replace("&quot;", '"')
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&amp;", "&")
        )


@dataclass
class DeliveryAcknowledgment:
    success: bool
    message: str
    msg_id: str
    display: Optional[str] = None
    queued: bool = False

    def to_json(self) -> str:
        data: Dict[str, Any] = {
            "success": self.success,
            "message": self.message,
            "msg_id": self.msg_id,
        }
        if self.display:
            data["display"] = self.display
        if self.queued:
            data["queued"] = True
        return json.dumps(data)

    @classmethod
    def from_json(cls, raw: str) -> DeliveryAcknowledgment:
        obj = json.loads(raw)
        return cls(
            success=bool(obj.get("success")),
            message=str(obj.get("message", "")),
            msg_id=str(obj.get("msg_id", "")),
            display=obj.get("display"),
            queued=bool(obj.get("queued", False)),
        )


@dataclass
class SendMessageToolPayload:
    to: str
    summary: str
    message: str
    type: str = "message"
    recipient: Optional[str] = None
    recipient_kind: Optional[str] = None
    content: Optional[str] = None

    def to_json(self) -> str:
        data: Dict[str, Any] = {
            "to": self.to,
            "summary": self.summary,
            "message": self.message,
            "type": self.type,
        }
        if self.recipient is not None:
            data["recipient"] = self.recipient
        if self.recipient_kind is not None:
            data["recipient_kind"] = self.recipient_kind
        if self.content is not None:
            data["content"] = self.content
        return json.dumps(data)

    @classmethod
    def from_json(cls, raw: str) -> SendMessageToolPayload:
        obj = json.loads(raw)
        for req in ("to", "summary", "message"):
            if req not in obj:
                raise ValueError(f"Missing required field {req!r} in SendMessage payload")
        return cls(
            to=obj["to"],
            summary=obj["summary"],
            message=obj["message"],
            type=obj.get("type", "message"),
            recipient=obj.get("recipient"),
            recipient_kind=obj.get("recipient_kind"),
            content=obj.get("content"),
        )


class PipeConnectionError(Exception):
    """Raised when named pipe connection fails."""


class PipeTimeoutError(Exception):
    """Raised when a pipe read/write times out."""


class PipeResetError(Exception):
    """Raised when connection is reset or broken by peer."""


class PipeAuthError(Exception):
    """Raised when authentication is rejected by peer."""


# ==============================================================================
# Dynamic Session Discovery
# ==============================================================================

def discover_sessions(sessions_dir: Optional[str] = None) -> List[SessionInfo]:
    """Scan the Claude sessions directory for active session descriptors and key tokens."""
    target_dir = sessions_dir or DEFAULT_SESSIONS_DIR
    if not os.path.isdir(target_dir):
        return []

    sessions: List[SessionInfo] = []
    json_pattern = os.path.join(target_dir, "*.json")

    for json_file in glob.glob(json_pattern):
        # Extract filename (e.g. 1956.json)
        base = os.path.basename(json_file)
        pid_str = base.removesuffix(".json")
        if not pid_str.isdigit():
            continue

        try:
            with open(json_file, "r", encoding="utf-8") as f:
                data = json.load(f)

            pid = int(data.get("pid", pid_str))
            session_id = str(data.get("sessionId", ""))
            name = str(data.get("name", ""))
            entrypoint = str(data.get("entrypoint", ""))
            kind = str(data.get("kind", ""))
            pipe_path = str(data.get("messagingSocketPath", ""))
            status = str(data.get("status", "unknown"))
            cwd = str(data.get("cwd", ""))
            started_at = data.get("startedAt")
            updated_at = data.get("updatedAt")

            # Look for companion key file: <pid>.*.key or <pid>.key
            token: Optional[str] = None
            key_path: Optional[str] = None
            key_candidates = glob.glob(os.path.join(target_dir, f"{pid}.*.key"))
            if not key_candidates:
                direct_key = os.path.join(target_dir, f"{pid}.key")
                if os.path.exists(direct_key):
                    key_candidates = [direct_key]

            if key_candidates:
                key_path = key_candidates[0]
                try:
                    with open(key_path, "r", encoding="utf-8") as kf:
                        raw = kf.read().strip()
                        try:
                            kdata = json.loads(raw)
                            if isinstance(kdata, dict):
                                token = kdata.get("peerToken") or kdata.get("token") or raw
                            else:
                                token = raw
                        except Exception:
                            token = raw
                except Exception:
                    token = None

            sessions.append(
                SessionInfo(
                    pid=pid,
                    session_id=session_id,
                    name=name,
                    entrypoint=entrypoint,
                    kind=kind,
                    pipe_path=pipe_path,
                    token=token,
                    status=status,
                    cwd=cwd,
                    started_at=started_at,
                    updated_at=updated_at,
                    json_path=json_file,
                    key_path=key_path,
                )
            )
        except Exception:
            continue

    # Sort sessions by PID
    sessions.sort(key=lambda s: s.pid)
    return sessions


def find_session(
    target: str,
    sessions: Optional[List[SessionInfo]] = None,
    sessions_dir: Optional[str] = None,
) -> Optional[SessionInfo]:
    """Resolve a target identifier to a specific active SessionInfo.

    Target can be:
    - 'desktop' / 'claude-desktop': Claude Desktop session
    - 'cli' / 'claude-cli': Claude CLI session
    - numeric PID (e.g. '1956', '3260')
    - session UUID prefix (e.g. 'e4bb6ce7', '8a74eb55')
    - socket / pipe path
    - partial session name
    """
    session_list = sessions if sessions is not None else discover_sessions(sessions_dir)
    target_clean = target.strip()
    target_lower = target_clean.lower()

    # 1. Alias: desktop
    if target_lower in ("desktop", "claude-desktop", "claude_desktop"):
        # Prioritize entrypoint == 'claude-desktop'
        for s in session_list:
            if s.entrypoint == "claude-desktop":
                return s
        # Fallback to name containing desktop or harness
        for s in session_list:
            if "desktop" in s.name.lower() or "harness" in s.name.lower():
                return s
        # Fallback to known desktop session prefix
        for s in session_list:
            if s.session_id.startswith("e4bb6ce7"):
                return s

    # 2. Alias: cli
    if target_lower in ("cli", "claude-cli", "claude_cli"):
        # Prioritize CLI sessions in D:\Omnia or named with coordinator
        for s in session_list:
            if s.entrypoint == "cli" and "omnia" in s.cwd.lower():
                return s
        for s in session_list:
            if s.entrypoint == "cli" and "điều phối" in s.name.lower():
                return s
        for s in session_list:
            if s.entrypoint == "cli":
                return s
        for s in session_list:
            if s.session_id.startswith("8a74eb55"):
                return s

    # 3. Numeric PID match
    if target_clean.isdigit():
        target_pid = int(target_clean)
        for s in session_list:
            if s.pid == target_pid:
                return s

    # 4. Session ID prefix or exact match
    for s in session_list:
        if s.session_id.lower().startswith(target_lower):
            return s

    # 5. Named pipe match
    for s in session_list:
        if s.pipe_path.lower() == target_lower or s.pipe_path.lower().endswith(target_lower):
            return s

    # 6. Name substring match
    for s in session_list:
        if target_lower in s.name.lower():
            return s

    return None


# ==============================================================================
# Windows Named Pipe Native Transport (via ctypes kernel32)
# ==============================================================================

class WindowsNamedPipe:
    """Native Windows Named Pipe client using kernel32 via ctypes."""

    GENERIC_READ = 0x80000000
    GENERIC_WRITE = 0x40000000
    OPEN_EXISTING = 3
    FILE_ATTRIBUTE_NORMAL = 0x80
    INVALID_HANDLE_VALUE = -1

    def __init__(self, pipe_path: str):
        self.pipe_path = pipe_path
        self._handle = None
        self._kernel32 = ctypes.windll.kernel32 if sys.platform == "win32" else None

        if self._kernel32:
            self._kernel32.CreateFileW.argtypes = [
                wintypes.LPCWSTR,
                wintypes.DWORD,
                wintypes.DWORD,
                wintypes.LPVOID,
                wintypes.DWORD,
                wintypes.DWORD,
                wintypes.HANDLE,
            ]
            self._kernel32.CreateFileW.restype = wintypes.HANDLE

            self._kernel32.WriteFile.argtypes = [
                wintypes.HANDLE,
                wintypes.LPCVOID,
                wintypes.DWORD,
                ctypes.POINTER(wintypes.DWORD),
                wintypes.LPVOID,
            ]
            self._kernel32.WriteFile.restype = wintypes.BOOL

            self._kernel32.ReadFile.argtypes = [
                wintypes.HANDLE,
                wintypes.LPVOID,
                wintypes.DWORD,
                ctypes.POINTER(wintypes.DWORD),
                wintypes.LPVOID,
            ]
            self._kernel32.ReadFile.restype = wintypes.BOOL

            self._kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
            self._kernel32.CloseHandle.restype = wintypes.BOOL

            self._kernel32.WaitNamedPipeW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD]
            self._kernel32.WaitNamedPipeW.restype = wintypes.BOOL

            self._kernel32.PeekNamedPipe.argtypes = [
                wintypes.HANDLE,
                wintypes.LPVOID,
                wintypes.DWORD,
                ctypes.POINTER(wintypes.DWORD),
                ctypes.POINTER(wintypes.DWORD),
                ctypes.POINTER(wintypes.DWORD),
            ]
            self._kernel32.PeekNamedPipe.restype = wintypes.BOOL

    def exists(self) -> bool:
        if sys.platform != "win32" or not self._kernel32:
            return False
        ret = self._kernel32.WaitNamedPipeW(wintypes.LPCWSTR(self.pipe_path), 0)
        err = self._kernel32.GetLastError()
        return bool(ret) or err in (121, 231)  # 121=TIMEOUT, 231=ERROR_PIPE_BUSY

    def probe(self, timeout_ms: int = 500) -> bool:
        if sys.platform != "win32" or not self._kernel32:
            return False
        ret = self._kernel32.WaitNamedPipeW(wintypes.LPCWSTR(self.pipe_path), timeout_ms)
        err = self._kernel32.GetLastError()
        return bool(ret) or err in (121, 231)

    def connect(self, timeout_ms: int = 2000) -> None:
        if sys.platform != "win32" or not self._kernel32:
            raise OSError("Windows Named Pipes require win32 platform")

        # Wait for pipe instance to be available
        self._kernel32.WaitNamedPipeW(wintypes.LPCWSTR(self.pipe_path), timeout_ms)

        handle = self._kernel32.CreateFileW(
            self.pipe_path,
            self.GENERIC_READ | self.GENERIC_WRITE,
            0,
            None,
            self.OPEN_EXISTING,
            0,
            None,
        )

        if handle == self.INVALID_HANDLE_VALUE or handle == 0:
            err = self._kernel32.GetLastError()
            raise ConnectionError(
                f"Failed to connect to named pipe '{self.pipe_path}' (Win32 error: {err})"
            )

        self._handle = handle

    def write_line(self, line: str) -> int:
        if not self._handle:
            raise ConnectionError("Pipe is not connected")

        encoded = line.encode("utf-8")
        if not encoded.endswith(b"\n"):
            encoded += b"\n"

        bytes_written = wintypes.DWORD(0)
        ok = self._kernel32.WriteFile(
            self._handle,
            encoded,
            len(encoded),
            ctypes.byref(bytes_written),
            None,
        )

        if not ok:
            err = self._kernel32.GetLastError()
            raise IOError(f"WriteFile failed on named pipe (Win32 error: {err})")

        return bytes_written.value

    def read_available(self, timeout_ms: int = 1000) -> bytes:
        """Read any currently pending response data from the pipe up to timeout."""
        if not self._handle:
            raise ConnectionError("Pipe is not connected")

        start = time.time()
        timeout_sec = timeout_ms / 1000.0
        avail = wintypes.DWORD(0)

        while time.time() - start < timeout_sec:
            ok = self._kernel32.PeekNamedPipe(
                self._handle, None, 0, None, ctypes.byref(avail), None
            )
            if ok and avail.value > 0:
                buf = ctypes.create_string_buffer(avail.value)
                bytes_read = wintypes.DWORD(0)
                read_ok = self._kernel32.ReadFile(
                    self._handle,
                    buf,
                    avail.value,
                    ctypes.byref(bytes_read),
                    None,
                )
                if read_ok:
                    return buf.raw[:bytes_read.value]
            time.sleep(0.05)

        return b""

    def close(self) -> None:
        if self._handle and self._kernel32:
            self._kernel32.CloseHandle(self._handle)
            self._handle = None

    def __enter__(self) -> WindowsNamedPipe:
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        self.close()


# ==============================================================================
# Envelope Serialization & Dispatch
# ==============================================================================

def serialize_envelope(
    task_content: str,
    from_pipe: str = DEFAULT_BRIDGE_UDS,
    from_name: str = DEFAULT_BRIDGE_NAME,
    from_mode: str = DEFAULT_BRIDGE_MODE,
    msg_id: Optional[str] = None,
    priority: str = "next",
) -> Dict[str, Any]:
    """Serialize user task instruction into Claude Code cross-session wire envelope."""
    msg_id = msg_id or uuid.uuid4().hex
    xml_msg = CrossSessionMessage(
        from_endpoint=from_pipe,
        content=task_content,
        from_name=from_name,
        from_mode=from_mode,
    )
    formatted_content = xml_msg.serialize().rstrip("\n")

    return {
        "msg_id": msg_id,
        "type": "user",
        "message": {
            "role": "user",
            "content": formatted_content,
        },
        "priority": priority,
        "from": from_pipe,
    }


def send_message_to_session(
    session: SessionInfo,
    task_content: str,
    from_pipe: str = DEFAULT_BRIDGE_UDS,
    from_name: str = DEFAULT_BRIDGE_NAME,
    from_mode: str = DEFAULT_BRIDGE_MODE,
    timeout_ms: int = 5000,
    dispatcher: Optional[CrossSessionDispatcher] = None,
) -> Dict[str, Any]:
    """Connect to session named pipe, perform auth handshake, and dispatch message envelope."""
    if not session.pipe_path:
        raise ValueError(f"Session {session.pid} ({session.name}) has no messagingSocketPath")

    envelope = serialize_envelope(
        task_content=task_content,
        from_pipe=from_pipe,
        from_name=from_name,
        from_mode=from_mode,
    )

    pipe = WindowsNamedPipe(session.pipe_path)
    try:
        pipe.connect(timeout_ms=timeout_ms)

        # Step 1: Authentication Handshake (if token present)
        if session.token:
            auth_handshake = json.dumps({"type": "auth", "token": session.token})
            pipe.write_line(auth_handshake)

        # Step 2: Message Payload Line
        payload_line = json.dumps(envelope)
        pipe.write_line(payload_line)

        # Step 3: Read optional acknowledgment if returned by peer
        response_bytes = pipe.read_available(timeout_ms=500)
        ack_text = response_bytes.decode("utf-8", errors="replace").strip()
        is_success = True
        if ack_text:
            try:
                resp_json = json.loads(ack_text)
                if isinstance(resp_json, dict) and (
                    resp_json.get("type") == "error"
                    or "error" in resp_json
                    or resp_json.get("success") is False
                ):
                    is_success = False
            except Exception:
                if "unauthorized" in ack_text.lower() or "error" in ack_text.lower():
                    is_success = False

        return {
            "success": is_success,
            "msg_id": envelope["msg_id"],
            "target_pid": session.pid,
            "target_session_id": session.session_id,
            "pipe": session.pipe_path,
            "response": ack_text if ack_text else "dispatched (in session inbox)",
        }
    except Exception as err:
        if dispatcher and dispatcher.fallback_enabled:
            dispatcher.enqueue_failure(
                target=str(session.pid),
                endpoint=session.pipe_path,
                task_instruction=task_content,
                summary=f"Message to {session.name}",
                error=str(err),
            )
            return {
                "success": False,
                "queued": True,
                "msg_id": envelope["msg_id"],
                "target_pid": session.pid,
                "target_session_id": session.session_id,
                "pipe": session.pipe_path,
                "error": str(err),
                "response": f"Enqueued in fallback buffer: {err}",
            }
        raise
    finally:
        pipe.close()


class CrossSessionDispatcher:
    """Dispatches task instructions to session endpoints with fallback queue buffering."""

    def __init__(
        self,
        connect_timeout_ms: int = 1500,
        fallback_enabled: bool = True,
        registry: Optional[Dict[str, str]] = None,
        sessions_dir: Optional[str] = None,
    ):
        self.connect_timeout_ms = connect_timeout_ms
        self.fallback_enabled = fallback_enabled
        self.registry: Dict[str, str] = dict(registry) if registry else {}
        self.sessions_dir = sessions_dir
        self.fallback_queue: List[Dict[str, Any]] = []

    def register_endpoint(self, alias: str, pipe_path: str) -> None:
        """Register or override an alias/endpoint mapping."""
        self.registry[alias] = pipe_path

    def resolve_endpoint(self, target: str) -> str:
        """Resolve session alias, UUID, or direct pipe path to a named pipe."""
        if target in self.registry:
            return self.registry[target]

        session = find_session(target, sessions_dir=self.sessions_dir)
        if session and session.pipe_path:
            return session.pipe_path

        clean = target.removeprefix("uds:")
        if PIPE_NAME_PATTERN.match(clean) or PIPE_NAME_PATTERN.match(target):
            return clean

        raise ValueError(f"Unknown endpoint or invalid named pipe address: {target}")

    def enqueue_failure(
        self,
        target: str,
        endpoint: str,
        task_instruction: str,
        summary: str,
        error: str,
    ) -> DeliveryAcknowledgment:
        payload = SendMessageToolPayload(
            to=f"uds:{endpoint}",
            summary=summary,
            message=task_instruction,
            content=task_instruction,
        )
        item = {
            "target": target,
            "endpoint": endpoint,
            "payload": payload,
            "task_instruction": task_instruction,
            "summary": summary,
            "error": error,
            "enqueued_at": time.time(),
        }
        self.fallback_queue.append(item)
        return DeliveryAcknowledgment(
            success=False,
            message=f"Primary pipe delivery failed ({error}); queued in fallback buffer",
            msg_id=f"fallback-{int(time.time() * 1000)}",
            queued=True,
        )

    def dispatch(
        self,
        target: str,
        task_instruction: str,
        summary: str = "",
        transport_fn: Optional[Callable[[str, str], DeliveryAcknowledgment]] = None,
    ) -> DeliveryAcknowledgment:
        endpoint = self.resolve_endpoint(target)
        payload = SendMessageToolPayload(
            to=f"uds:{endpoint}",
            summary=summary,
            message=task_instruction,
            content=task_instruction,
        )

        if transport_fn:
            try:
                return transport_fn(endpoint, payload.to_json())
            except (PipeConnectionError, PipeTimeoutError, PipeResetError, PipeAuthError, ConnectionError, IOError, Exception) as err:
                if self.fallback_enabled:
                    return self.enqueue_failure(target, endpoint, task_instruction, summary, str(err))
                raise

        # Default real transport
        try:
            session = find_session(endpoint, sessions_dir=self.sessions_dir)
            target_session = session or SessionInfo(
                pid=0,
                session_id="custom",
                name="custom",
                entrypoint="pipe",
                kind="pipe",
                pipe_path=endpoint,
            )
            res = send_message_to_session(
                session=target_session,
                task_content=task_instruction,
                timeout_ms=self.connect_timeout_ms,
                dispatcher=self,
            )
            if not res.get("success", False):
                if self.fallback_enabled:
                    return self.enqueue_failure(target, endpoint, task_instruction, summary, res.get("error", "Dispatch failed"))
                raise PipeConnectionError(res.get("error", "Dispatch failed"))

            return DeliveryAcknowledgment(
                success=res.get("success", True),
                message=res.get("response", "in session inbox"),
                msg_id=res.get("msg_id", f"msg-{int(time.time() * 1000)}"),
            )
        except Exception as err:
            if self.fallback_enabled:
                return self.enqueue_failure(target, endpoint, task_instruction, summary, str(err))
            raise PipeConnectionError(str(err)) from err

    def drain_fallback_queue(
        self,
        transport_fn: Optional[Callable[[str, str], DeliveryAcknowledgment]] = None,
    ) -> List[Dict[str, Any]]:
        """Drain and retry pending messages in fallback queue."""
        results = []
        while self.fallback_queue:
            item = self.fallback_queue.pop(0)
            ep = item["endpoint"]
            pl = item["payload"]
            try:
                if transport_fn:
                    res = transport_fn(ep, pl.to_json())
                else:
                    res = self.dispatch(ep, pl.message, pl.summary)
                results.append({"item": item, "result": res})
            except Exception:
                self.fallback_queue.insert(0, item)
                break
        return results

    def drain(
        self,
        transport_fn: Optional[Callable[[str, str], DeliveryAcknowledgment]] = None,
    ) -> List[Dict[str, Any]]:
        """Alias for drain_fallback_queue."""
        return self.drain_fallback_queue(transport_fn=transport_fn)


# ==============================================================================
# JSONL Transcript Tailing
# ==============================================================================

def find_transcript_file(
    session_id: str,
    projects_dir: Optional[str] = None,
) -> Optional[str]:
    """Locate the .jsonl transcript file for a given session ID."""
    primary_dir = projects_dir or DEFAULT_PROJECTS_DIR
    direct_path = os.path.join(primary_dir, f"{session_id}.jsonl")
    if os.path.isfile(direct_path):
        return direct_path

    # Search all subdirectories under ~/.claude/projects/
    if os.path.isdir(CLAUDE_PROJECTS_BASE):
        pattern = os.path.join(CLAUDE_PROJECTS_BASE, "*", f"{session_id}.jsonl")
        matches = glob.glob(pattern)
        if matches:
            return matches[0]

    return None


def tail_transcript(
    transcript_path: str,
    timeout_sec: float = 60.0,
    on_record: Optional[Callable[[Dict[str, Any]], None]] = None,
    poll_interval: float = 0.5,
) -> None:
    """Tail transcript JSONL file in real time for updates, responses, and tool calls."""
    if not os.path.isfile(transcript_path):
        raise FileNotFoundError(f"Transcript file not found: {transcript_path}")

    print(f"[*] Tailing transcript: {transcript_path} (timeout: {timeout_sec}s)")
    start_time = time.time()

    with open(transcript_path, "r", encoding="utf-8", errors="replace") as f:
        # Seek to end of file to stream only new lines
        f.seek(0, os.SEEK_END)

        while time.time() - start_time < timeout_sec:
            line = f.readline()
            if not line:
                time.sleep(poll_interval)
                continue

            line = line.strip()
            if not line:
                continue

            try:
                record = json.loads(line)
                if on_record:
                    on_record(record)
                else:
                    _default_print_record(record)
            except Exception:
                pass


def _default_print_record(record: Dict[str, Any]) -> None:
    rec_type = record.get("type", "unknown")
    if rec_type == "message":
        msg = record.get("message", {})
        role = msg.get("role", "unknown")
        content = msg.get("content", "")
        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") == "text":
                    print(f"[{role.upper()}]: {part.get('text', '')}")
                elif isinstance(part, dict) and part.get("type") == "tool_use":
                    print(f"[TOOL USE]: {part.get('name')}(...)")
        elif isinstance(content, str):
            print(f"[{role.upper()}]: {content}")
    elif rec_type == "queue-operation":
        op = record.get("operation")
        content = str(record.get("content", ""))[:120]
        print(f"[QUEUE {op}]: {content}...")
    elif rec_type == "tool_result":
        print(f"[TOOL RESULT]: {str(record.get('content', ''))[:100]}...")


# ==============================================================================
# CLI Formatting & Commands
# ==============================================================================

def cmd_list(sessions_dir: Optional[str] = None, json_output: bool = False) -> int:
    """List all active Claude sessions, PIDs, pipe paths, and probe statuses."""
    sessions = discover_sessions(sessions_dir)
    if json_output:
        res = []
        for s in sessions:
            pipe_alive = WindowsNamedPipe(s.pipe_path).probe() if s.pipe_path else False
            item = s.to_dict()
            item["pipe_alive"] = pipe_alive
            res.append(item)
        print(json.dumps(res, indent=2))
        return 0

    if not sessions:
        print("[!] No active Claude sessions found in ~/.claude/sessions/")
        return 0

    print("=" * 105)
    print("Omnia Cross-Session Bridge — Active Claude Sessions")
    print("=" * 105)
    header = f"{'PID':<7} {'Type':<15} {'Status':<8} {'Alive':<7} {'Name':<28} {'Messaging Pipe'}"
    print(header)
    print("-" * 105)

    for s in sessions:
        pipe_alive = False
        if s.pipe_path:
            pipe_alive = WindowsNamedPipe(s.pipe_path).probe()
        alive_str = "YES" if pipe_alive else "NO"
        entry_desc = f"{s.entrypoint} ({s.kind})" if s.kind else s.entrypoint
        name_short = (s.name[:25] + "...") if len(s.name) > 28 else s.name
        pipe_short = os.path.basename(s.pipe_path) if s.pipe_path else "none"

        print(
            f"{s.pid:<7} {entry_desc:<15} {s.status:<8} {alive_str:<7} {name_short:<28} {s.pipe_path}"
        )

    print("-" * 105)
    print(f"Total sessions: {len(sessions)}")
    return 0


def cmd_probe(target: Optional[str], sessions_dir: Optional[str] = None) -> int:
    """Probe connectivity to one or all session named pipes."""
    sessions = discover_sessions(sessions_dir)
    targets = [find_session(target, sessions)] if target else sessions

    if target and not targets[0]:
        print(f"[✗] Target '{target}' not found in active sessions.")
        return 1

    all_ok = True
    print("[*] Probing Claude Named Pipe endpoints...")
    for s in targets:
        if not s or not s.pipe_path:
            continue
        pipe = WindowsNamedPipe(s.pipe_path)
        exists = pipe.exists()
        responsive = pipe.probe(timeout_ms=1000)
        status_icon = "✓" if responsive else "✗"
        if not responsive:
            all_ok = False
        print(
            f"  {status_icon} PID {s.pid} [{s.name}]: pipe={s.pipe_path} "
            f"(exists={exists}, responsive={responsive})"
        )

    return 0 if all_ok else 1


def run_self_tests() -> int:
    """Run comprehensive self-verification of the bridge's components."""
    print("=" * 70)
    print("Running Cross-Session Bridge Self-Tests (Python)")
    print("=" * 70)
    passed = 0
    total = 0

    def check(name: str, fn: Callable[[], bool]) -> None:
        nonlocal passed, total
        total += 1
        try:
            res = fn()
            if res:
                passed += 1
                print(f"  ✓ {name}")
            else:
                print(f"  ✗ {name}: assertion returned False")
        except Exception as e:
            print(f"  ✗ {name}: Exception: {e}")

    # Test 1: XML serialization & escaping
    def t1():
        msg = CrossSessionMessage(
            from_endpoint=r'uds:\\.\pipe\LOCAL\cc-msg-test"&<>\'',
            content='Special <content> & "quotes"\nTiếng Việt: Mũi tên > và v',
            from_name='Agent "Omnia" & <Special>',
        )
        wire = msg.serialize()
        assert '&quot;' in wire and '&amp;' in wire and '&lt;' in wire and '&gt;' in wire
        back = CrossSessionMessage.deserialize(wire)
        assert back.from_endpoint == msg.from_endpoint
        assert back.from_name == msg.from_name
        assert back.content == msg.content

        # Nested closing tag round-trip
        nested_msg = CrossSessionMessage(
            from_endpoint=r"\\.\pipe\LOCAL\cc-msg-test-nested",
            content="Line 1\nExample: </cross-session-message>\nLine 2 (Critical instruction)",
        )
        nested_wire = nested_msg.serialize()
        nested_back = CrossSessionMessage.deserialize(nested_wire)
        assert nested_back.content == nested_msg.content, "Nested closing tag truncated"
        return True

    check("CrossSessionMessage serialization & XML attribute escaping", t1)

    # Test 2: Envelope formatting
    def t2():
        env = serialize_envelope("Execute gate verification")
        assert env["type"] == "user"
        assert env["priority"] == "next"
        assert "from" in env
        assert env["message"]["role"] == "user"
        assert "<cross-session-message" in env["message"]["content"]
        assert "Execute gate verification" in env["message"]["content"]
        return True

    check("serialize_envelope adheres to wire protocol specification", t2)

    # Test 3: Session discovery (hermetic fixture + live scan if present)
    def t3():
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            sample_session = {
                "pid": 4321,
                "sessionId": "mock-sess-4321",
                "name": "Desktop Harness",
                "entrypoint": "claude-desktop",
                "kind": "desktop",
                "messagingSocketPath": r"\\.\pipe\LOCAL\cc-msg-43214321432143214321432143214321",
                "status": "idle",
            }
            with open(os.path.join(tmpdir, "4321.json"), "w", encoding="utf-8") as f:
                json.dump(sample_session, f)
            with open(os.path.join(tmpdir, "4321.mockkey.key"), "w", encoding="utf-8") as f:
                f.write("token-xyz-123")

            discovered = discover_sessions(tmpdir)
            assert len(discovered) == 1, "Expected 1 discovered session in fixture"
            assert discovered[0].pid == 4321
            assert discovered[0].token == "token-xyz-123"

        # Validate live sessions structure without asserting static PIDs
        for s in discover_sessions():
            assert s.pid > 0 and isinstance(s.name, str)
        return True

    check("discover_sessions finds active Claude sessions and tokens", t3)

    # Test 4: Target resolution (fixture + dynamic)
    def t4():
        mock_sessions = [
            SessionInfo(
                pid=111,
                session_id="desktop-111",
                name="Claude Desktop",
                entrypoint="claude-desktop",
                kind="desktop",
                pipe_path=r"\\.\pipe\LOCAL\cc-msg-111",
            ),
            SessionInfo(
                pid=222,
                session_id="cli-222",
                name="Claude CLI",
                entrypoint="cli",
                kind="cli",
                pipe_path=r"\\.\pipe\LOCAL\cc-msg-222",
                cwd="D:\\Omnia",
            ),
        ]
        desktop = find_session("desktop", sessions=mock_sessions)
        assert desktop is not None and desktop.pid == 111, "Failed to resolve desktop alias"
        cli = find_session("cli", sessions=mock_sessions)
        assert cli is not None and cli.pid == 222, "Failed to resolve cli alias"
        by_pid = find_session("111", sessions=mock_sessions)
        assert by_pid is not None and by_pid.session_id == desktop.session_id
        return True

    check("find_session resolves aliases ('desktop', 'cli', PID)", t4)

    # Test 5: Pipe probe (bogus pipe + mock pipe server fixture)
    def t5():
        if sys.platform != "win32":
            return True
        bogus_pipe = WindowsNamedPipe(r"\\.\pipe\LOCAL\cc-msg-00000000000000000000000000000000")
        assert not bogus_pipe.exists() and not bogus_pipe.probe(50)

        # Create temporary named pipe instance to verify probing without live process dependency
        kernel32 = ctypes.windll.kernel32
        pipe_name = rf"\\.\pipe\LOCAL\cc-msg-test-{uuid.uuid4().hex}"
        h_pipe = kernel32.CreateNamedPipeW(
            pipe_name,
            0x00000003,  # PIPE_ACCESS_DUPLEX
            0x00000004 | 0x00000002 | 0x00000000,
            1,
            1024,
            1024,
            0,
            None,
        )
        assert h_pipe != -1 and h_pipe != 0
        try:
            test_pipe = WindowsNamedPipe(pipe_name)
            assert test_pipe.exists()
            assert test_pipe.probe(500)
        finally:
            kernel32.CloseHandle(h_pipe)
        return True

    check("WindowsNamedPipe probes active vs bogus named pipes", t5)

    print("=" * 70)
    print(f"Self-Test Results: {passed} / {total} tests passed ({(passed/total)*100:.0f}%)")
    print("=" * 70)
    return 0 if passed == total else 1


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Omnia Cross-Session Named Pipe IPC Bridge",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="List all active Claude sessions, PIDs, pipe paths, and status",
    )
    parser.add_argument(
        "--target",
        type=str,
        default=None,
        help="Target session: 'desktop', 'cli', PID (e.g. 3260), or session ID prefix",
    )
    parser.add_argument(
        "--message",
        type=str,
        default=None,
        help="Task instruction or message content to dispatch to target session",
    )
    parser.add_argument(
        "--probe",
        action="store_true",
        help="Probe named pipe connectivity for target or all sessions",
    )
    parser.add_argument(
        "--stream",
        action="store_true",
        help="Tail target session's JSONL transcript file for real-time updates",
    )
    parser.add_argument(
        "--from-name",
        type=str,
        default=DEFAULT_BRIDGE_NAME,
        help=f"Sender display name in XML tag (default: '{DEFAULT_BRIDGE_NAME}')",
    )
    parser.add_argument(
        "--from-pipe",
        type=str,
        default=DEFAULT_BRIDGE_UDS,
        help=f"Sender UDS pipe endpoint (default: '{DEFAULT_BRIDGE_UDS}')",
    )
    parser.add_argument(
        "--from-mode",
        type=str,
        default=DEFAULT_BRIDGE_MODE,
        help=f"Sender mode attribute (default: '{DEFAULT_BRIDGE_MODE}')",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=10.0,
        help="Operation timeout in seconds (default: 10.0)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output results in JSON format",
    )
    parser.add_argument(
        "--test",
        action="store_true",
        help="Run internal component self-tests",
    )

    args = parser.parse_args(argv)

    if args.test:
        return run_self_tests()

    if args.list:
        return cmd_list(json_output=args.json)

    if args.probe and not args.message:
        return cmd_probe(args.target)

    # Message dispatch or stream requires target
    if args.message or args.stream or (args.probe and args.target):
        target_name = args.target or "desktop"
        session = find_session(target_name)
        if not session:
            print(f"[✗] Error: Target session '{target_name}' could not be resolved.")
            print("[*] Run with --list to see all available sessions.")
            return 1

        if args.probe:
            return cmd_probe(args.target)

        if args.message:
            print(
                f"[*] Dispatching message to PID {session.pid} ({session.name}) "
                f"via {session.pipe_path}..."
            )
            try:
                res = send_message_to_session(
                    session=session,
                    task_content=args.message,
                    from_pipe=args.from_pipe,
                    from_name=args.from_name,
                    from_mode=args.from_mode,
                    timeout_ms=int(args.timeout * 1000),
                )
                if args.json:
                    print(json.dumps(res, indent=2))
                else:
                    print(f"[✓] Message delivered successfully! Message ID: {res['msg_id']}")
                    print(f"    Target response: {res['response']}")
            except Exception as e:
                print(f"[✗] Message dispatch failed: {e}")
                return 1

        if args.stream:
            transcript = find_transcript_file(session.session_id)
            if not transcript:
                print(f"[✗] Transcript JSONL not found for session {session.session_id}")
                return 1
            try:
                tail_transcript(transcript, timeout_sec=args.timeout)
            except KeyboardInterrupt:
                print("\n[*] Stopped tailing transcript.")
            return 0

        return 0

    # Default action if no arguments: show list
    return cmd_list(json_output=args.json)


if __name__ == "__main__":
    sys.exit(main())

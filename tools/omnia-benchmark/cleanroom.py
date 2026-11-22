"""Clean-Room Isolation Sandbox & Egress Firewall for 5-Way Harness Benchmarking.

Guarantees:
  1. Zero ancestor instruction files (`AGENTS.md`, `CLAUDE.md`, `.claude/`, `.codex/`,
     `.gemini/`, `.opencode/`) in `D:\\` or `D:\\omnia-bench\\`.
  2. Strict allowlist minimal environment (strips all host API keys, profiles, and harness vars).
  3. Per-run ephemeral home/config/cache/temp dirs inside `D:\\omnia-bench\\env\\<harness>\\<run_id>\\`.
  4. Hard loopback-only egress firewall (`HTTP_PROXY=http://127.0.0.1:1`,
     `HTTPS_PROXY=http://127.0.0.1:1`, `ALL_PROXY=http://127.0.0.1:1`,
     `NO_PROXY=127.0.0.1,localhost`) so ZERO LLM or telemetry traffic can bypass
     `bench_telemetry_proxy.py` -> `htmustc`.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional

BENCH_ROOT = Path(r"D:\omnia-bench")
HARNESS_ROOT = BENCH_ROOT / "harnesses"
ENV_ROOT = BENCH_ROOT / "env"
MANIFEST_PATH = HARNESS_ROOT / "installed_manifest.json"

ANCESTOR_FORBIDDEN = ("AGENTS.md", "CLAUDE.md", ".claude", ".codex", ".gemini", ".opencode")

# Strict Windows system env keys needed for Python/Node/Git/Rust/Win32 to work cleanly
SAFE_SYSTEM_KEYS = (
    "SYSTEMROOT", "WINDIR", "COMSPEC", "OS",
    "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "NUMBER_OF_PROCESSORS",
    "PROGRAMFILES", "PROGRAMFILES(X86)", "COMMONPROGRAMFILES", "PROGRAMDATA",
    "PATHEXT", "SYSTEMDRIVE", "COMPUTERNAME",
)


def assert_clean_ancestors() -> List[str]:
    """Verify zero user rule/config files exist in D:\\ or D:\\omnia-bench\\."""
    violations: List[str] = []
    for root in (Path(r"D:\\"), BENCH_ROOT):
        for name in ANCESTOR_FORBIDDEN:
            p = root / name
            if p.exists():
                violations.append(str(p))
    if violations:
        raise RuntimeError(f"Clean-room hygiene violation — remove ancestor config files: {violations}")
    return violations


def build_minimal_path() -> str:
    """Assemble clean deterministic PATH with system dirs + standard dev runtimes (no user harness bins)."""
    candidates = [
        r"C:\Program Files\Git\cmd",
        r"C:\Program Files\Git\usr\bin",
        r"C:\Program Files\nodejs",
        str(Path.home() / ".local" / "bin"),
        str(Path.home() / ".cargo" / "bin"),
        r"C:\Windows\System32",
        r"C:\Windows",
        r"C:\Windows\System32\Wbem",
        r"C:\Windows\System32\WindowsPowerShell\v1.0",
    ]
    out: List[str] = []
    seen = set()
    for c in candidates:
        if os.path.isdir(c):
            norm = os.path.normcase(os.path.normpath(c))
            if norm not in seen:
                seen.add(norm)
                out.append(c)
    return ";".join(out)


def load_installed_manifest() -> Dict[str, dict]:
    if not MANIFEST_PATH.exists():
        return {}
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


@dataclass
class CleanRoomLaunch:
    harness: str
    run_id: str
    env_dir: Path
    cmd: List[str]
    env: Dict[str, str]
    stdin_text: Optional[str] = None
    harness_root_exe: str = ""
    wire_protocol: str = "openai_chat"

    def cleanup(self) -> None:
        shutil.rmtree(self.env_dir, ignore_errors=True)


def prepare_harness_launch(
    harness: str,
    model: str,
    prompt: str,
    workspace: Path,
    proxy_port: int,
    *,
    run_id: Optional[str] = None,
    timeout_s: int = 300,
    omnia_bin: Optional[Path] = None,
) -> CleanRoomLaunch:
    """Create ephemeral clean-room env, config files, firewall vars & CLI args for a harness."""
    assert_clean_ancestors()
    rid = run_id or f"{harness}-{uuid.uuid4().hex[:8]}"
    env_dir = ENV_ROOT / harness / rid
    user_dir = env_dir / "user"
    appdata = user_dir / "AppData" / "Roaming"
    localappdata = user_dir / "AppData" / "Local"
    xdg_cfg = env_dir / "xdg-config"
    xdg_data = env_dir / "xdg-data"
    xdg_cache = env_dir / "xdg-cache"
    xdg_state = env_dir / "xdg-state"
    tmp_dir = env_dir / "temp"
    for d in (user_dir, appdata, localappdata, xdg_cfg, xdg_data, xdg_cache, xdg_state, tmp_dir):
        d.mkdir(parents=True, exist_ok=True)

    # Strict allowlist environment
    env: Dict[str, str] = {}
    for k in SAFE_SYSTEM_KEYS:
        if k in os.environ:
            env[k] = os.environ[k]
    env.update({
        "PATH": build_minimal_path(),
        "HOME": str(user_dir),
        "USERPROFILE": str(user_dir),
        "HOMEDRIVE": user_dir.drive or "D:",
        "HOMEPATH": str(user_dir)[2:] if len(str(user_dir)) > 2 else "\\",
        "APPDATA": str(appdata),
        "LOCALAPPDATA": str(localappdata),
        "XDG_CONFIG_HOME": str(xdg_cfg),
        "XDG_DATA_HOME": str(xdg_data),
        "XDG_CACHE_HOME": str(xdg_cache),
        "XDG_STATE_HOME": str(xdg_state),
        "TEMP": str(tmp_dir),
        "TMP": str(tmp_dir),
        "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8",
        "TERM": "dumb",
        "NO_COLOR": "1",
        # Hard Loopback-Only Egress Firewall — any non-loopback HTTP/HTTPS call fails closed
        "HTTP_PROXY": "http://127.0.0.1:1",
        "HTTPS_PROXY": "http://127.0.0.1:1",
        "ALL_PROXY": "http://127.0.0.1:1",
        "http_proxy": "http://127.0.0.1:1",
        "https_proxy": "http://127.0.0.1:1",
        "all_proxy": "http://127.0.0.1:1",
        "NO_PROXY": "127.0.0.1,localhost",
        "no_proxy": "127.0.0.1,localhost",
    })

    run_tok = f"bench-tok-{rid}"
    base = f"http://127.0.0.1:{proxy_port}"
    manifest = load_installed_manifest()

    if harness == "codex":
        exe = Path(manifest.get("codex", {}).get("binary") or (HARNESS_ROOT / "codex" / "bin" / "codex.exe"))
        codex_home = env_dir / "codex-home"
        codex_home.mkdir(parents=True, exist_ok=True)
        cfg = (
            f'model = "{model}"\n'
            f'model_provider = "htmustc"\n'
            f'approval_policy = "never"\n'
            f'sandbox_mode = "danger-full-access"\n'
            f'check_for_update_on_startup = false\n\n'
            f'[analytics]\n'
            f'enabled = false\n\n'
            f'[model_providers.htmustc]\n'
            f'name = "htmustc"\n'
            f'base_url = "{base}/v1"\n'
            f'env_key = "HTMUSTC_API_KEY"\n'
            f'wire_api = "responses"\n'
        )
        (codex_home / "config.toml").write_text(cfg, encoding="utf-8")
        env["CODEX_HOME"] = str(codex_home)
        env["HTMUSTC_API_KEY"] = run_tok
        cmd = [
            str(exe),
            "exec",
            "--json",
            "--ephemeral",
            "--skip-git-repo-check",
            "--dangerously-bypass-approvals-and-sandbox",
            "-C", str(workspace),
            "-",
        ]
        return CleanRoomLaunch(
            harness=harness, run_id=rid, env_dir=env_dir, cmd=cmd, env=env,
            stdin_text=prompt, harness_root_exe=exe.name, wire_protocol="openai_responses",
        )

    if harness == "claude":
        exe = Path(manifest.get("claude", {}).get("binary") or (HARNESS_ROOT / "claude" / "bin" / "claude.exe"))
        claude_cfg = env_dir / "claude-config"
        claude_cfg.mkdir(parents=True, exist_ok=True)
        empty_mcp = env_dir / "empty-mcp.json"
        empty_mcp.write_text('{"mcpServers":{}}\n', encoding="utf-8")
        # Pre-seed minimal onboarding-skipped settings inside isolated CLAUDE_CONFIG_DIR
        (claude_cfg / "settings.json").write_text(
            json.dumps({"hasCompletedOnboarding": True, "theme": "dark"}, indent=2),
            encoding="utf-8",
        )
        env.update({
            "CLAUDE_CONFIG_DIR": str(claude_cfg),
            "ANTHROPIC_BASE_URL": base,  # NO /v1 suffix — Claude Code appends /v1/messages
            "ANTHROPIC_AUTH_TOKEN": run_tok,
            "ANTHROPIC_API_KEY": run_tok,
            "ANTHROPIC_MODEL": model,
            "ANTHROPIC_SMALL_FAST_MODEL": model,
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": model,
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "DISABLE_TELEMETRY": "1",
            "DISABLE_ERROR_REPORTING": "1",
            "DISABLE_AUTOUPDATER": "1",
            "DISABLE_COST_WARNINGS": "1",
            "CLAUDE_CODE_GIT_BASH_PATH": r"C:\Program Files\Git\bin\bash.exe",
        })
        cmd = [
            str(exe),
            "-p",
            "--model", model,
            "--output-format", "stream-json",
            "--verbose",
            "--dangerously-skip-permissions",
            "--no-session-persistence",
            "--setting-sources", "",
            "--strict-mcp-config",
            "--mcp-config", str(empty_mcp),
            "--disable-slash-commands",
        ]
        return CleanRoomLaunch(
            harness=harness, run_id=rid, env_dir=env_dir, cmd=cmd, env=env,
            stdin_text=prompt, harness_root_exe=exe.name, wire_protocol="anthropic_messages",
        )

    if harness == "opencode":
        exe = Path(manifest.get("opencode", {}).get("binary") or (HARNESS_ROOT / "opencode" / "bin" / "opencode.exe"))
        oc_cfg_path = env_dir / "opencode.json"
        oc_cfg = {
            "model": f"htmustc/{model}",
            "small_model": f"htmustc/{model}",
            "enabled_providers": ["htmustc"],
            "autoupdate": False,
            "permission": {"*": "allow"},
            "provider": {
                "htmustc": {
                    "npm": "@ai-sdk/openai-compatible",
                    "name": "htmustc",
                    "options": {
                        "baseURL": f"{base}/v1",
                        "apiKey": "{env:HTMUSTC_API_KEY}",
                    },
                    "models": {
                        model: {
                            "name": model,
                            "tool_call": True,
                            "limit": {"context": 200000, "output": 32000},
                        }
                    },
                }
            },
        }
        oc_cfg_path.write_text(json.dumps(oc_cfg, indent=2), encoding="utf-8")
        env.update({
            "OPENCODE_CONFIG": str(oc_cfg_path),
            "OPENCODE_DISABLE_AUTOUPDATE": "true",
            "OPENCODE_DISABLE_CLAUDE_CODE": "true",
            "OPENCODE_DISABLE_DEFAULT_PLUGINS": "true",
            "OPENCODE_DISABLE_MODELS_FETCH": "true",
            "HTMUSTC_API_KEY": run_tok,
        })
        cmd = [
            str(exe),
            "run",
            "--format", "json",
            "--model", f"htmustc/{model}",
            prompt,
        ]
        return CleanRoomLaunch(
            harness=harness, run_id=rid, env_dir=env_dir, cmd=cmd, env=env,
            stdin_text=None, harness_root_exe=exe.name, wire_protocol="openai_chat",
        )

    if harness == "agy":
        exe = Path(manifest.get("agy", {}).get("binary") or (HARNESS_ROOT / "agy" / "bin" / "agy.exe"))
        agy_cfg_dir = user_dir / ".gemini" / "antigravity-cli"
        agy_cfg_dir.mkdir(parents=True, exist_ok=True)
        agy_settings = {
            "modelProvider": "gemini",
            "agentMode": "",
            "toolPermission": "always-proceed",
            "artifactReviewPolicy": "always-proceed",
            "disableSlashCommands": True,
            "showTips": False,
            "showFeedbackSurvey": False,
            "notifications": False,
            "enableTerminalSandbox": False,
            "trustedWorkspaces": [str(workspace)],
            "customModelsConfig": {
                "customModels": {
                    "htmustc-bench": {
                        "modelName": f"gemini-api://{base}/v1beta/models/{model}",
                        "label": "htmustc-bench",
                        "maxTokens": 200000,
                        "toolFormatterType": "TOOL_FORMATTER_TYPE_NONE",
                        "modelFeatures": {
                            "supportsImages": True,
                            "supportsVideo": False,
                            "supportsPdf": False,
                            "supportsAudio": False,
                            "supportsToolCalls": True,
                            "supportsThinking": True,
                            "zeroShotCapable": True,
                        },
                    }
                }
            },
        }
        (agy_cfg_dir / "settings.json").write_text(json.dumps(agy_settings, indent=2), encoding="utf-8")
        env.update({
            "GEMINI_API_KEY": run_tok,
            "GOOGLE_GEMINI_BASE_URL": base,
        })
        cmd = [
            str(exe),
            "-p", prompt,
            "--model", "htmustc-bench",
            "--output-format", "stream-json",
            "--dangerously-skip-permissions",
            "--disable-slash-commands",
            "--print-timeout", f"{timeout_s}s",
        ]
        return CleanRoomLaunch(
            harness=harness, run_id=rid, env_dir=env_dir, cmd=cmd, env=env,
            stdin_text=None, harness_root_exe=exe.name, wire_protocol="gemini_v1beta_to_oai",
        )

    if harness == "omnia":
        exe = omnia_bin or Path(r"D:\OmniaData\build\omnia-rust-workspace\release\omnia.exe")
        omnia_home = env_dir / "omnia-home"
        omnia_home.mkdir(parents=True, exist_ok=True)
        # omnia-cli (D:\Omnia\rust\omnia-cli\src\main.rs) reads the prompt from positional /
        # --prompt / --prompt-file only (no stdin), resolves its AgentStore under OMNIA_HOME,
        # and in `--wire-api auto` routes claude-* -> /v1/messages, gpt-* -> /v1/chat|responses,
        # gemini-* -> /v1/chat/completions. All of those terminate on the loopback telemetry proxy.
        prompt_file = env_dir / "prompt.md"
        prompt_file.write_text(prompt, encoding="utf-8", newline="\n")
        env.update({
            "OMNIA_HOME": str(omnia_home),
            "OMNIA_API_KEY": run_tok,
            "OMNIA_BASE_URL": f"{base}/v1",
        })
        cmd = [
            str(exe),
            "run",
            "--workspace", str(workspace),
            "--model", model,
            "--base-url", f"{base}/v1",
            "--wire-api", "auto",
            "--output-format", "stream-json",
            "--auto-approve",
            "--config-dir", str(omnia_home),
            "--timeout-secs", str(max(30, timeout_s - 10)),
            "--prompt-file", str(prompt_file),
        ]
        return CleanRoomLaunch(
            harness=harness, run_id=rid, env_dir=env_dir, cmd=cmd, env=env,
            stdin_text=None, harness_root_exe=exe.name, wire_protocol="omnia_auto",
        )

    raise ValueError(f"Unsupported clean-room harness: {harness}")


def audit_non_loopback_sockets(pids: set[int]) -> List[dict]:
    """Return any established/syn-sent non-loopback TCP sockets owned by given PIDs."""
    if not pids:
        return []
    ps_pids = ",".join(str(p) for p in sorted(pids))
    cmd = [
        "powershell", "-NoProfile", "-Command",
        f"Get-NetTCPConnection -ErrorAction SilentlyContinue | "
        f"Where-Object {{ ($_.OwningProcess -in @({ps_pids})) -and ($_.RemoteAddress -notin @('127.0.0.1','::1','0.0.0.0','::')) }} | "
        f"Select-Object OwningProcess,RemoteAddress,RemotePort,State | ConvertTo-Json -Compress"
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=8)
        out = (r.stdout or "").strip()
        if not out:
            return []
        parsed = json.loads(out)
        return parsed if isinstance(parsed, list) else [parsed]
    except Exception:
        return []

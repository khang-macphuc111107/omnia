"""Honest multi-platform target contract validator and live toolchain probe (INT-09).

Reads ``platform/targets.json`` (schema ``omnia.platform.targets.v1``), inspects
source inputs, out-of-source external artifacts, and installed toolchains for:
- ``windows-native`` (Full Native Rust workspace: ``cargo``/``rustc``/``vswhere``/``msvc_link``)
- ``web-studio`` (``ui/`` ES2022 + Node syntax check + Edge headless CDP + Rust ``omnia-studio.exe``)
- ``android-apk`` (Android SDK/NDK/sdkmanager/adb/gradle/java/cargo-ndk + wrapper files)

Always invoke with ``python -B`` so zero ``__pycache__`` directories are created.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

EXPECTED_CONTRACT_SCHEMA = "omnia.platform.targets.v1"

SECRET_REDACTION_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("bearer_token", re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._\-=/+]{8,}")),
    ("openai_key", re.compile(r"\bsk-(?:proj-|live-|test-|svcacct-)?[A-Za-z0-9_\-]{12,}")),
    ("github_token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{16,}")),
    ("google_api_key", re.compile(r"\bAIza[0-9A-Za-z\-_]{20,}")),
    ("aws_key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
)


class ContractError(ValueError):
    """Raised when targets.json fails schema or structural validation."""


def _default_run_command(args: Sequence[str], timeout_sec: int = 15) -> tuple[int, str, str]:
    try:
        completed = subprocess.run(
            list(args),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_sec,
            check=False,
        )
        return completed.returncode, completed.stdout, completed.stderr
    except FileNotFoundError as exc:
        return 127, "", str(exc)
    except subprocess.TimeoutExpired:
        return 124, "", f"command timed out after {timeout_sec}s"
    except OSError as exc:
        return 126, "", str(exc)


@dataclass
class ProbeEnv:
    """Injectable host filesystem, environment, and command probe interface."""

    environ: Mapping[str, str] = field(default_factory=lambda: os.environ)
    which: Callable[[str], str | None] = shutil.which
    exists: Callable[[Path], bool] = lambda p: p.exists()
    is_file: Callable[[Path], bool] = lambda p: p.is_file()
    is_dir: Callable[[Path], bool] = lambda p: p.is_dir()
    iterdir: Callable[[Path], list[Path]] = lambda p: sorted(p.iterdir(), key=lambda x: x.name.lower())
    glob_paths: Callable[[Path, str], list[Path]] = lambda root, pattern: sorted(
        (Path(m) for m in glob.glob(str(root / pattern))),
        key=lambda p: p.as_posix().lower(),
    )
    read_text: Callable[[Path], str] = lambda p: p.read_text(encoding="utf-8")
    run_command: Callable[[Sequence[str], int], tuple[int, str, str]] = _default_run_command
    now_utc: Callable[[], str] = lambda: datetime.now(timezone.utc).isoformat()
    platform_name: str = sys.platform


def redact_text(value: str) -> str:
    """Redacts known credential token shapes from diagnostic strings."""
    out = value
    for label, pattern in SECRET_REDACTION_PATTERNS:
        out = pattern.sub(f"[REDACTED:{label}]", out)
    return out


def first_nonempty_line(text: str) -> str:
    for line in text.splitlines():
        stripped = line.strip()
        if stripped:
            return redact_text(stripped[:240])
    return ""


def load_contract(contract_path: Path, env: ProbeEnv) -> dict[str, Any]:
    """Loads and validates the platform/targets.json contract."""
    if not env.is_file(contract_path):
        raise ContractError(f"Contract file not found: {contract_path}")
    try:
        data = json.loads(env.read_text(contract_path))
    except json.JSONDecodeError as exc:
        raise ContractError(f"Invalid JSON in contract {contract_path}: {exc}") from exc

    if not isinstance(data, dict):
        raise ContractError("Contract root must be a JSON object")
    if data.get("schema") != EXPECTED_CONTRACT_SCHEMA:
        raise ContractError(
            f"Unexpected contract schema {data.get('schema')!r}; expected {EXPECTED_CONTRACT_SCHEMA!r}"
        )
    targets = data.get("targets")
    if not isinstance(targets, list) or not targets:
        raise ContractError("Contract 'targets' must be a non-empty list")

    seen_ids: set[str] = set()
    for target in targets:
        if not isinstance(target, dict) or not isinstance(target.get("id"), str) or not target["id"].strip():
            raise ContractError("Each target entry must be an object with a non-empty string 'id'")
        tid = target["id"].strip()
        if tid in seen_ids:
            raise ContractError(f"Duplicate target id in contract: {tid!r}")
        seen_ids.add(tid)
        lifecycle = target.get("lifecycle")
        if not isinstance(lifecycle, dict):
            raise ContractError(f"Target {tid!r} missing 'lifecycle' contract object")
        for key in ("build", "install", "launch", "version", "capability", "recovery"):
            if not isinstance(lifecycle.get(key), str) or not lifecycle[key].strip():
                raise ContractError(f"Target {tid!r} lifecycle missing non-empty string {key!r}")
    return data


def _find_on_path_or_candidates(
    names: Sequence[str],
    candidates: Sequence[Path],
    env: ProbeEnv,
) -> tuple[str | None, str]:
    for name in names:
        hit = env.which(name)
        if hit and env.is_file(Path(hit)):
            return hit, "PATH"
    for candidate in candidates:
        if env.is_file(candidate):
            return str(candidate), "standard_path"
    return None, "missing"


def _probe_vs_installation(env: ProbeEnv) -> dict[str, Any]:
    pf86 = env.environ.get("ProgramFiles(x86)", "")
    vswhere_candidates: list[Path] = []
    if pf86:
        vswhere_candidates.append(Path(pf86) / "Microsoft Visual Studio" / "Installer" / "vswhere.exe")
    vswhere_path, vswhere_source = _find_on_path_or_candidates(("vswhere", "vswhere.exe"), vswhere_candidates, env)
    install_path: str | None = None
    if vswhere_path:
        rc, out, _ = env.run_command(
            [
                vswhere_path,
                "-latest",
                "-products",
                "*",
                "-requires",
                "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
                "-property",
                "installationPath",
            ],
            10,
        )
        if rc == 0:
            line = first_nonempty_line(out)
            if line and env.is_dir(Path(line)):
                install_path = line

    if install_path is None and pf86:
        for year in ("18", "2022"):
            for edition in ("BuildTools", "Community", "Professional", "Enterprise"):
                candidate = Path(pf86) / "Microsoft Visual Studio" / year / edition
                if env.is_dir(candidate):
                    install_path = str(candidate)
                    break
            if install_path:
                break

    return {
        "vswhere_path": vswhere_path,
        "vswhere_source": vswhere_source,
        "vs_install_path": install_path,
    }


def _safe_iterdir(path: Path, env: ProbeEnv) -> list[Path]:
    if not env.is_dir(path):
        return []
    try:
        return env.iterdir(path)
    except OSError:
        return []


def probe_toolchains(
    env: ProbeEnv,
    repo_root: Path,
    wrapper_roots: Sequence[str],
    run_version_probes: bool = True,
) -> dict[str, Any]:
    """Probes Windows Rust/MSVC, Web/Edge, and Android toolchains without mutating state."""
    vs_info = _probe_vs_installation(env)
    vs_install = Path(vs_info["vs_install_path"]) if vs_info["vs_install_path"] else None

    pf = env.environ.get("ProgramFiles", "")
    pf86 = env.environ.get("ProgramFiles(x86)", "")
    user_profile = env.environ.get("USERPROFILE", "")
    local_app_data = env.environ.get("LOCALAPPDATA", "")
    cargo_bin = Path(user_profile) / ".cargo" / "bin" if user_profile else None

    vcvars_candidates: list[Path] = []
    cmake_candidates: list[Path] = []
    ninja_candidates: list[Path] = []
    cl_candidates: list[Path] = []
    link_candidates: list[Path] = []
    if vs_install is not None:
        vcvars_candidates.append(vs_install / "VC" / "Auxiliary" / "Build" / "vcvars64.bat")
        cmake_candidates.append(
            vs_install / "Common7" / "IDE" / "CommonExtensions" / "Microsoft" / "CMake" / "CMake" / "bin" / "cmake.exe"
        )
        ninja_candidates.append(
            vs_install / "Common7" / "IDE" / "CommonExtensions" / "Microsoft" / "CMake" / "Ninja" / "ninja.exe"
        )
        msvc_root = vs_install / "VC" / "Tools" / "MSVC"
        for ver_dir in reversed(_safe_iterdir(msvc_root, env)):
            cl_candidates.append(ver_dir / "bin" / "Hostx64" / "x64" / "cl.exe")
            link_candidates.append(ver_dir / "bin" / "Hostx64" / "x64" / "link.exe")
    if pf:
        cmake_candidates.append(Path(pf) / "CMake" / "bin" / "cmake.exe")

    cargo_candidates = [cargo_bin / "cargo.exe"] if cargo_bin else []
    rustc_candidates = [cargo_bin / "rustc.exe"] if cargo_bin else []
    rustup_candidates = [cargo_bin / "rustup.exe"] if cargo_bin else []
    cargo_ndk_candidates = [cargo_bin / "cargo-ndk.exe", cargo_bin / "cargo-ndk"] if cargo_bin else []

    node_candidates: list[Path] = []
    if pf:
        node_candidates.append(Path(pf) / "nodejs" / "node.exe")
    if local_app_data:
        node_candidates.append(Path(local_app_data) / "nodejs-nightly" / "current" / "node.exe")

    edge_candidates: list[Path] = []
    if pf86:
        edge_candidates.append(Path(pf86) / "Microsoft" / "Edge" / "Application" / "msedge.exe")
    if pf:
        edge_candidates.append(Path(pf) / "Microsoft" / "Edge" / "Application" / "msedge.exe")
    if local_app_data:
        edge_candidates.append(Path(local_app_data) / "Microsoft" / "Edge" / "Application" / "msedge.exe")

    vcvars_path, vcvars_src = _find_on_path_or_candidates(("vcvars64.bat",), vcvars_candidates, env)
    cl_path, cl_src = _find_on_path_or_candidates(("cl", "cl.exe"), cl_candidates, env)
    msvc_link_path: str | None = None
    msvc_link_src = "missing"
    for candidate in link_candidates:
        if env.is_file(candidate):
            msvc_link_path = str(candidate)
            msvc_link_src = "vs_msvc_tools"
            break
    if msvc_link_path is None:
        for name in ("link.exe", "link"):
            hit = env.which(name)
            if hit and env.is_file(Path(hit)):
                norm_hit = hit.replace("/", "\\").lower()
                if "\\vc\\tools\\msvc\\" in norm_hit or "\\microsoft visual studio\\" in norm_hit:
                    msvc_link_path = hit
                    msvc_link_src = "PATH"
                    break
    cmake_path, cmake_src = _find_on_path_or_candidates(("cmake", "cmake.exe"), cmake_candidates, env)
    ninja_path, ninja_src = _find_on_path_or_candidates(("ninja", "ninja.exe"), ninja_candidates, env)
    cargo_path, cargo_src = _find_on_path_or_candidates(("cargo", "cargo.exe"), cargo_candidates, env)
    rustc_path, rustc_src = _find_on_path_or_candidates(("rustc", "rustc.exe"), rustc_candidates, env)
    rustup_path, rustup_src = _find_on_path_or_candidates(("rustup", "rustup.exe"), rustup_candidates, env)
    node_path, node_src = _find_on_path_or_candidates(("node", "node.exe"), node_candidates, env)
    msedge_path, msedge_src = _find_on_path_or_candidates(("msedge", "msedge.exe"), edge_candidates, env)

    # Android SDK / NDK / Gradle / Java / cargo-ndk
    android_home_raw = env.environ.get("ANDROID_HOME") or env.environ.get("ANDROID_SDK_ROOT") or ""
    android_home_path = Path(android_home_raw) if android_home_raw.strip() else None
    android_home_exists = bool(android_home_path and env.is_dir(android_home_path))

    sdkmanager_candidates: list[Path] = []
    adb_candidates: list[Path] = []
    ndk_candidates: list[Path] = []
    if android_home_exists and android_home_path is not None:
        sdkmanager_candidates.extend(
            [
                android_home_path / "cmdline-tools" / "latest" / "bin" / "sdkmanager.bat",
                android_home_path / "cmdline-tools" / "latest" / "bin" / "sdkmanager",
                android_home_path / "tools" / "bin" / "sdkmanager.bat",
                android_home_path / "tools" / "bin" / "sdkmanager",
            ]
        )
        for ct_dir in reversed(_safe_iterdir(android_home_path / "cmdline-tools", env)):
            sdkmanager_candidates.append(ct_dir / "bin" / "sdkmanager.bat")
            sdkmanager_candidates.append(ct_dir / "bin" / "sdkmanager")
        adb_candidates.extend(
            [
                android_home_path / "platform-tools" / "adb.exe",
                android_home_path / "platform-tools" / "adb",
            ]
        )
        ndk_parent = android_home_path / "ndk"
        for ndk_ver in reversed(_safe_iterdir(ndk_parent, env)):
            ndk_candidates.append(ndk_ver)
        ndk_candidates.append(android_home_path / "ndk-bundle")

    sdkmanager_path, sdkmanager_src = _find_on_path_or_candidates(
        ("sdkmanager", "sdkmanager.bat"), sdkmanager_candidates, env
    )
    adb_path, adb_src = _find_on_path_or_candidates(("adb", "adb.exe"), adb_candidates, env)

    ndk_env_raw = (
        env.environ.get("ANDROID_NDK_HOME")
        or env.environ.get("ANDROID_NDK_ROOT")
        or env.environ.get("NDK_HOME")
        or ""
    )
    ndk_path: str | None = None
    ndk_src = "missing"
    if ndk_env_raw.strip() and env.is_dir(Path(ndk_env_raw)):
        ndk_path = ndk_env_raw
        ndk_src = "env"
    else:
        for candidate_dir in ndk_candidates:
            if env.is_dir(candidate_dir):
                ndk_path = str(candidate_dir)
                ndk_src = "android_sdk_ndk_dir"
                break

    gradle_candidates: list[Path] = []
    for root_rel in wrapper_roots:
        gradle_candidates.append(repo_root / root_rel / "gradlew.bat")
        gradle_candidates.append(repo_root / root_rel / "gradlew")
    gradle_path, gradle_src = _find_on_path_or_candidates(("gradle", "gradle.bat"), gradle_candidates, env)

    java_home_raw = env.environ.get("JAVA_HOME", "")
    java_candidates: list[Path] = []
    if java_home_raw.strip():
        java_candidates.append(Path(java_home_raw) / "bin" / "java.exe")
        java_candidates.append(Path(java_home_raw) / "bin" / "java")
    java_path, java_src = _find_on_path_or_candidates(("java", "java.exe"), java_candidates, env)
    cargo_ndk_path, cargo_ndk_src = _find_on_path_or_candidates(
        ("cargo-ndk", "cargo-ndk.exe"), cargo_ndk_candidates, env
    )

    def _version_of(exe_path: str | None, args: Sequence[str]) -> str | None:
        if not exe_path or not run_version_probes:
            return None
        rc, out, err = env.run_command([exe_path, *args], 10)
        if rc == 0:
            return first_nonempty_line(out) or first_nonempty_line(err)
        return None

    rust_targets: list[str] = []
    if rustup_path:
        rc, out, _ = env.run_command([rustup_path, "target", "list", "--installed"], 10)
        if rc == 0:
            rust_targets = [line.strip() for line in out.splitlines() if line.strip()]

    return {
        "tools": {
            "vswhere": {
                "present": bool(vs_info["vswhere_path"] and vs_info["vs_install_path"]),
                "path": vs_info["vswhere_path"],
                "source": vs_info["vswhere_source"],
                "vs_install_path": vs_info["vs_install_path"],
            },
            "vcvars64": {"present": bool(vcvars_path), "path": vcvars_path, "source": vcvars_src},
            "cl": {"present": bool(cl_path), "path": cl_path, "source": cl_src},
            "msvc_link": {"present": bool(msvc_link_path), "path": msvc_link_path, "source": msvc_link_src},
            "cmake": {
                "present": bool(cmake_path),
                "path": cmake_path,
                "source": cmake_src,
                "version": _version_of(cmake_path, ("--version",)),
            },
            "ninja": {
                "present": bool(ninja_path),
                "path": ninja_path,
                "source": ninja_src,
                "version": _version_of(ninja_path, ("--version",)),
            },
            "cargo": {
                "present": bool(cargo_path),
                "path": cargo_path,
                "source": cargo_src,
                "version": _version_of(cargo_path, ("--version",)),
            },
            "rustc": {
                "present": bool(rustc_path),
                "path": rustc_path,
                "source": rustc_src,
                "version": _version_of(rustc_path, ("--version",)),
            },
            "rustup": {
                "present": bool(rustup_path),
                "path": rustup_path,
                "source": rustup_src,
            },
            "node": {
                "present": bool(node_path),
                "path": node_path,
                "source": node_src,
                "version": _version_of(node_path, ("--version",)),
            },
            "msedge": {
                "present": bool(msedge_path),
                "path": msedge_path,
                "source": msedge_src,
                "version": _version_of(msedge_path, ("--headless", "--disable-gpu", "--version")),
            },
            "android_home": {
                "present": android_home_exists,
                "path": str(android_home_path) if android_home_exists and android_home_path else None,
                "source": "env" if android_home_exists else ("env_missing_dir" if android_home_raw.strip() else "missing"),
            },
            "sdkmanager": {"present": bool(sdkmanager_path), "path": sdkmanager_path, "source": sdkmanager_src},
            "adb": {"present": bool(adb_path), "path": adb_path, "source": adb_src},
            "android_ndk": {"present": bool(ndk_path), "path": ndk_path, "source": ndk_src},
            "gradle": {"present": bool(gradle_path), "path": gradle_path, "source": gradle_src},
            "java": {
                "present": bool(java_path),
                "path": java_path,
                "source": java_src,
                "version": _version_of(java_path, ("-version",)),
            },
            "cargo_ndk": {"present": bool(cargo_ndk_path), "path": cargo_ndk_path, "source": cargo_ndk_src},
        },
        "installed_rust_targets": rust_targets,
    }


def _find_external_artifacts(
    specs: Sequence[Mapping[str, Any]],
    build_root: Path | None,
    env: ProbeEnv,
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for spec in specs:
        name = str(spec.get("name", ""))
        role = str(spec.get("role", ""))
        search_roots = [str(x) for x in spec.get("search_roots", [])]
        found_paths: list[str] = []
        if build_root is not None and env.is_dir(build_root):
            for rel in search_roots:
                candidate = build_root / rel / name
                if env.is_file(candidate):
                    found_paths.append(str(candidate))
        results.append(
            {
                "name": name,
                "role": role,
                "present": len(found_paths) > 0,
                "found_paths": found_paths,
            }
        )
    return results


def _probe_source_inputs(inputs: Sequence[str], repo_root: Path, env: ProbeEnv) -> tuple[str, list[str]]:
    missing = [rel for rel in inputs if not env.exists(repo_root / rel)]
    return ("present" if not missing else "source_missing"), missing


def _probe_syntax_checks(
    globs: Sequence[str],
    node_path: str | None,
    repo_root: Path,
    env: ProbeEnv,
    run_syntax_checks: bool,
) -> dict[str, Any]:
    files: list[Path] = []
    for pattern in globs:
        files.extend(env.glob_paths(repo_root, pattern))
    seen: set[str] = set()
    unique_files: list[Path] = []
    for f in files:
        key = f.as_posix()
        if key not in seen and env.is_file(f):
            seen.add(key)
            unique_files.append(f)

    if not unique_files:
        return {"status": "source_missing", "checked_count": 0, "passed_count": 0, "results": []}
    if not run_syntax_checks:
        return {
            "status": "skipped",
            "checked_count": len(unique_files),
            "passed_count": 0,
            "results": [p.relative_to(repo_root).as_posix() for p in unique_files],
        }
    if not node_path:
        return {
            "status": "toolchain_missing",
            "checked_count": 0,
            "passed_count": 0,
            "results": [],
        }

    results: list[dict[str, Any]] = []
    passed = 0
    for file_path in unique_files:
        rc, _, err = env.run_command([node_path, "--check", str(file_path)], 10)
        ok = rc == 0
        if ok:
            passed += 1
        results.append(
            {
                "file": file_path.relative_to(repo_root).as_posix(),
                "returncode": rc,
                "passed": ok,
                "error": first_nonempty_line(err) if not ok else None,
            }
        )
    status = "passed" if passed == len(unique_files) else "syntax_error"
    return {
        "status": status,
        "checked_count": len(unique_files),
        "passed_count": passed,
        "results": results,
    }


def _probe_android_wrapper(target_spec: Mapping[str, Any], repo_root: Path, env: ProbeEnv) -> dict[str, Any]:
    roots = [str(x) for x in target_spec.get("wrapper_roots", [])]
    groups = target_spec.get("required_wrapper_groups", [])
    root_reports: list[dict[str, Any]] = []
    complete_root: str | None = None

    for root_rel in roots:
        root_dir = repo_root / root_rel
        root_exists = env.is_dir(root_dir)
        present_groups: list[str] = []
        missing_groups: list[str] = []
        matched_files: list[str] = []
        for group in groups:
            gname = str(group.get("name", ""))
            candidates = [str(c) for c in group.get("any_of", [])]
            found: str | None = None
            if root_exists:
                for rel_file in candidates:
                    if env.is_file(root_dir / rel_file):
                        found = f"{root_rel}/{rel_file}"
                        break
            if found:
                present_groups.append(gname)
                matched_files.append(found)
            else:
                missing_groups.append(gname)
        if root_exists and not missing_groups and complete_root is None:
            complete_root = root_rel
        root_reports.append(
            {
                "root": root_rel,
                "dir_exists": root_exists,
                "present_groups": present_groups,
                "missing_groups": missing_groups,
                "matched_files": matched_files,
            }
        )

    return {
        "status": "present" if complete_root is not None else "unimplemented",
        "complete_root": complete_root,
        "checked_roots": root_reports,
    }


def _probe_hygiene(contract: Mapping[str, Any], repo_root: Path, env: ProbeEnv) -> dict[str, Any]:
    policy = contract.get("out_of_source_policy", {})
    forbidden = [str(x) for x in policy.get("forbidden_in_tree_paths", [])]
    in_tree_hits: list[str] = []
    for rel in forbidden:
        if env.exists(repo_root / rel):
            in_tree_hits.append(rel)

    platform_dir = repo_root / "platform"
    platform_pycache: list[str] = []
    for entry in _safe_iterdir(platform_dir, env):
        if entry.name == "__pycache__" or entry.suffix in {".pyc", ".pyo"}:
            platform_pycache.append(entry.relative_to(repo_root).as_posix())

    in_tree_apks: list[str] = []
    for root_name in ("platform", "android", "."):
        base = repo_root if root_name == "." else repo_root / root_name
        for item in _safe_iterdir(base, env):
            if env.is_file(item):
                if item.suffix.lower() in {".apk", ".aab"}:
                    in_tree_apks.append(item.relative_to(repo_root).as_posix())

    return {
        "out_of_source_clean": not in_tree_hits and not platform_pycache and not in_tree_apks,
        "forbidden_root_hits": in_tree_hits,
        "platform_pycache_hits": platform_pycache,
        "in_tree_apk_hits": in_tree_apks,
    }


def evaluate_targets(
    contract_path: Path,
    repo_root: Path,
    build_root: Path | None,
    env: ProbeEnv | None = None,
    run_version_probes: bool = True,
    run_syntax_checks: bool = True,
) -> dict[str, Any]:
    """Evaluates every target in targets.json against live/injected host probes."""
    probe_env = env or ProbeEnv()
    contract = load_contract(contract_path, probe_env)
    android_spec = next((t for t in contract["targets"] if t["id"] == "android-apk"), {})
    wrapper_roots = [str(x) for x in android_spec.get("wrapper_roots", ["platform/android", "android"])]

    toolchain_probe = probe_toolchains(
        probe_env,
        repo_root=repo_root,
        wrapper_roots=wrapper_roots,
        run_version_probes=run_version_probes,
    )
    tools = toolchain_probe["tools"]
    installed_rust_targets = set(toolchain_probe["installed_rust_targets"])
    hygiene = _probe_hygiene(contract, repo_root, probe_env)

    target_reports: list[dict[str, Any]] = []
    for spec in contract["targets"]:
        tid = spec["id"]
        req_tools = [str(x) for x in spec.get("required_toolchains", [])]
        req_rust_targets = [str(x) for x in spec.get("required_rust_targets", [])]
        present_tools = [t for t in req_tools if tools.get(t, {}).get("present", False)]
        missing_tools = [t for t in req_tools if not tools.get(t, {}).get("present", False)]
        missing_rust_targets = [rt for rt in req_rust_targets if rt not in installed_rust_targets]
        toolchain_status = (
            "available" if (not missing_tools and not missing_rust_targets) else "toolchain_missing"
        )

        artifacts = _find_external_artifacts(spec.get("expected_artifacts", []), build_root, probe_env)
        present_artifact_count = sum(1 for a in artifacts if a["present"])
        if present_artifact_count == len(artifacts) and artifacts:
            artifact_status = "present_external"
        elif present_artifact_count > 0:
            artifact_status = "partial_external"
        else:
            artifact_status = "none"

        reasons: list[str] = []
        extra: dict[str, Any] = {}

        if tid == "android-apk":
            wrapper = _probe_android_wrapper(spec, repo_root, probe_env)
            extra["wrapper"] = wrapper
            wrapper_status = wrapper["status"]
            if toolchain_status != "available":
                reasons.append("toolchain_missing")
            if wrapper_status != "present":
                reasons.append("unimplemented")
            if toolchain_status != "available":
                overall_status = "toolchain_missing"
            elif wrapper_status != "present":
                overall_status = "unimplemented"
            else:
                overall_status = "ready"
            extra["apk_buildable"] = overall_status == "ready"
            extra["fake_apk_claimed"] = False
            source_status = wrapper_status
            missing_sources: list[str] = []
        else:
            source_status, missing_sources = _probe_source_inputs(
                spec.get("required_source_inputs", []), repo_root, probe_env
            )
            if source_status != "present":
                reasons.append("source_missing")
            if toolchain_status != "available":
                reasons.append("toolchain_missing")
            if tid == "web-studio":
                syntax = _probe_syntax_checks(
                    spec.get("syntax_check_globs", []),
                    tools.get("node", {}).get("path"),
                    repo_root,
                    probe_env,
                    run_syntax_checks=run_syntax_checks,
                )
                extra["syntax_checks"] = syntax
                if syntax["status"] not in ("passed", "skipped"):
                    reasons.append(syntax["status"])
            if not reasons:
                overall_status = "ready"
            elif "source_missing" in reasons:
                overall_status = "source_missing"
            elif "syntax_error" in reasons:
                overall_status = "syntax_error"
            else:
                overall_status = "toolchain_missing"

        target_reports.append(
            {
                "id": tid,
                "display_name": spec.get("display_name"),
                "supported_hosts": spec.get("supported_hosts", []),
                "overall_status": overall_status,
                "source_status": source_status,
                "missing_sources": missing_sources,
                "toolchain_status": toolchain_status,
                "present_tools": present_tools,
                "missing_tools": missing_tools,
                "required_rust_targets": req_rust_targets,
                "missing_rust_targets": missing_rust_targets,
                "artifact_status": artifact_status,
                "artifacts": artifacts,
                "blocked_reasons": reasons,
                "lifecycle": spec.get("lifecycle", {}),
                **extra,
            }
        )

    return {
        "schema": "omnia.platform.targets.receipt.v1",
        "contract_schema": contract["schema"],
        "contract_id": contract["contract_id"],
        "probed_at_utc": probe_env.now_utc(),
        "host_platform": probe_env.platform_name,
        "repo_root": str(repo_root),
        "build_root": str(build_root) if build_root is not None else None,
        "hygiene": hygiene,
        "toolchains": tools,
        "installed_rust_targets": sorted(installed_rust_targets),
        "targets": target_reports,
        "summary": {t["id"]: t["overall_status"] for t in target_reports},
    }


def write_utf8_lf_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rendered = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
    path.write_bytes(rendered.encode("utf-8"))


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    default_repo = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(
        description="Validate Omnia INT-09 multi-platform target contracts and probe local toolchains."
    )
    parser.add_argument("--repo-root", type=Path, default=default_repo, help="Omnia repository root")
    parser.add_argument(
        "--build-root",
        type=Path,
        default=None,
        help="External out-of-source build root (default: <repo-root>/../OmniaData/build)",
    )
    parser.add_argument(
        "--contract",
        type=Path,
        default=None,
        help="Path to targets.json contract (default: <repo-root>/platform/targets.json)",
    )
    parser.add_argument("--json-out", type=Path, default=None, help="Optional output path for JSON receipt")
    parser.add_argument("--skip-version-probes", action="store_true", help="Skip tool --version subprocess calls")
    parser.add_argument("--skip-syntax-checks", action="store_true", help="Skip node --check UI JS syntax checks")
    parser.add_argument(
        "--fail-on-unready",
        action="store_true",
        help="Exit non-zero if any declared platform target is not in 'ready' state",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    repo_root = args.repo_root.resolve()
    contract_path = (args.contract or (repo_root / "platform" / "targets.json")).resolve()
    env_build_root = os.environ.get("OMNIA_BUILD_ROOT", "").strip()
    if args.build_root is not None:
        build_root: Path | None = args.build_root.resolve()
    elif env_build_root:
        build_root = Path(env_build_root).resolve()
    else:
        build_root = (repo_root.parent / "OmniaData" / "build").resolve()

    try:
        receipt = evaluate_targets(
            contract_path=contract_path,
            repo_root=repo_root,
            build_root=build_root,
            run_version_probes=not args.skip_version_probes,
            run_syntax_checks=not args.skip_syntax_checks,
        )
    except ContractError as exc:
        err_payload = {"schema": "omnia.platform.targets.error.v1", "error": str(exc)}
        if args.json_out is not None:
            write_utf8_lf_json(args.json_out, err_payload)
        print(json.dumps(err_payload, indent=2), file=sys.stderr)
        return 2

    if args.json_out is not None:
        write_utf8_lf_json(args.json_out, receipt)
    print(json.dumps(receipt, indent=2, ensure_ascii=False))

    if args.fail_on_unready and any(t["overall_status"] != "ready" for t in receipt["targets"]):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

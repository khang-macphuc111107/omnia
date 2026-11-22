"""Unit tests for Omnia INT-09 platform target contract and toolchain probes."""

from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

PLATFORM_DIR = Path(__file__).resolve().parent
REPO_ROOT = PLATFORM_DIR.parent
if str(PLATFORM_DIR) not in sys.path:
    sys.path.insert(0, str(PLATFORM_DIR))

import validate_targets as vt  # noqa: E402


def _make_mock_env(
    *,
    existing_dirs: set[Path] | None = None,
    existing_files: set[Path] | None = None,
    which_map: dict[str, str] | None = None,
    environ: dict[str, str] | None = None,
    cmd_map: dict[tuple[str, ...], tuple[int, str, str]] | None = None,
    js_files: list[Path] | None = None,
) -> vt.ProbeEnv:
    dirs = {p.resolve() for p in (existing_dirs or set())}
    files = {p.resolve() for p in (existing_files or set())}
    files.add((PLATFORM_DIR / "targets.json").resolve())
    wmap = dict(which_map or {})
    env_map = dict(environ or {})
    cmap = dict(cmd_map or {})
    globbed_js = list(js_files or [])

    def _norm(p: Path) -> Path:
        return p.resolve()

    def _is_dir(p: Path) -> bool:
        return _norm(p) in dirs

    def _is_file(p: Path) -> bool:
        return _norm(p) in files

    def _exists(p: Path) -> bool:
        n = _norm(p)
        return n in dirs or n in files

    def _iterdir(p: Path) -> list[Path]:
        n = _norm(p)
        children: dict[str, Path] = {}
        for item in dirs | files:
            if item.parent == n:
                children[item.name] = item
        return [children[k] for k in sorted(children.keys(), key=str.lower)]

    def _glob(root: Path, pattern: str) -> list[Path]:
        if pattern == "ui/app/*.js":
            return globbed_js
        return []

    def _which(name: str) -> str | None:
        return wmap.get(name)

    def _read_text(p: Path) -> str:
        return p.read_text(encoding="utf-8")

    def _run(args: list[str] | tuple[str, ...], timeout_sec: int = 15) -> tuple[int, str, str]:
        key = tuple(args)
        if key in cmap:
            return cmap[key]
        if len(args) >= 2 and args[1] == "--check" and args[0].endswith("node.exe"):
            return cmap.get(("node", "--check", Path(args[2]).name), (0, "", ""))
        if args and args[0] == "vswhere" or (args and str(args[0]).endswith("vswhere.exe")):
            return cmap.get(("vswhere",), (1, "", ""))
        return (1, "", f"unmocked command: {args}")

    return vt.ProbeEnv(
        environ=env_map,
        which=_which,
        exists=_exists,
        is_file=_is_file,
        is_dir=_is_dir,
        iterdir=_iterdir,
        glob_paths=_glob,
        read_text=_read_text,
        run_command=_run,
        now_utc=lambda: "2026-11-14T12:00:00+00:00",
        platform_name="win32",
    )


def _baseline_windows_web_mock_data(repo: Path, build_root: Path) -> tuple[set[Path], set[Path], dict[str, str], dict[str, str], dict[tuple[str, ...], tuple[int, str, str]], list[Path]]:
    dirs: set[Path] = {repo, repo / "platform", repo / "ui", repo / "ui" / "app", build_root}
    files: set[Path] = set()
    contract = json.loads((PLATFORM_DIR / "targets.json").read_text(encoding="utf-8"))
    for t in contract["targets"]:
        for rel in t.get("required_source_inputs", []):
            p = repo / rel
            files.add(p)
            dirs.add(p.parent)

    js_files = [
        repo / "ui" / "app" / "api.js",
        repo / "ui" / "app" / "main.js",
    ]
    for jf in js_files:
        files.add(jf)

    vs_root = Path(r"C:\MockVS\18\BuildTools")
    msvc_bin = vs_root / "VC" / "Tools" / "MSVC" / "14.51.36231" / "bin" / "Hostx64" / "x64"
    vswhere = Path(r"C:\MockVSInstaller\vswhere.exe")
    vcvars = vs_root / "VC" / "Auxiliary" / "Build" / "vcvars64.bat"
    cl_exe = msvc_bin / "cl.exe"
    link_exe = msvc_bin / "link.exe"
    cmake_exe = vs_root / "CMake" / "cmake.exe"
    ninja_exe = vs_root / "Ninja" / "ninja.exe"
    cargo_exe = Path(r"C:\MockCargo\bin\cargo.exe")
    rustc_exe = Path(r"C:\MockCargo\bin\rustc.exe")
    rustup_exe = Path(r"C:\MockCargo\bin\rustup.exe")
    node_exe = Path(r"C:\MockNode\node.exe")
    edge_exe = Path(r"C:\MockEdge\msedge.exe")

    for p in (
        vswhere,
        vcvars,
        cl_exe,
        link_exe,
        cmake_exe,
        ninja_exe,
        cargo_exe,
        rustc_exe,
        rustup_exe,
        node_exe,
        edge_exe,
    ):
        files.add(p)
        dirs.add(p.parent)
    dirs.add(vs_root)
    cur_dir = msvc_bin
    while cur_dir != vs_root.parent:
        dirs.add(cur_dir)
        cur_dir = cur_dir.parent

    # External built artifacts (Full Native Rust workspace)
    for rel in (
        "omnia-rust-workspace/release/omnia-native.exe",
        "omnia-rust-workspace/release/omnia-studio.exe",
        "omnia-rust-workspace/release/omnia-runtime.exe",
    ):
        ap = build_root / rel
        files.add(ap)
        dirs.add(ap.parent)

    which_map = {
        "vswhere": str(vswhere),
        "vcvars64.bat": str(vcvars),
        "cl": str(cl_exe),
        "cmake": str(cmake_exe),
        "ninja": str(ninja_exe),
        "cargo": str(cargo_exe),
        "rustc": str(rustc_exe),
        "rustup": str(rustup_exe),
        "node": str(node_exe),
        "msedge": str(edge_exe),
    }
    cmd_map: dict[tuple[str, ...], tuple[int, str, str]] = {
        ("vswhere",): (0, str(vs_root), ""),
        (str(cmake_exe), "--version"): (0, "cmake version 4.3.1", ""),
        (str(ninja_exe), "--version"): (0, "1.13.2", ""),
        (str(cargo_exe), "--version"): (0, "cargo 1.99.1", ""),
        (str(rustc_exe), "--version"): (0, "rustc 1.99.1", ""),
        (str(node_exe), "--version"): (0, "v28.0.0", ""),
        (str(edge_exe), "--headless", "--disable-gpu", "--version"): (0, "Microsoft Edge 158.0.4370.21 beta", ""),
        (str(rustup_exe), "target", "list", "--installed"): (0, "x86_64-pc-windows-msvc\n", ""),
    }
    environ: dict[str, str] = {}
    return dirs, files, which_map, environ, cmd_map, js_files


class ValidateTargetsTests(unittest.TestCase):
    def test_contract_file_loads_and_matches_schema(self) -> None:
        env = vt.ProbeEnv()
        contract = vt.load_contract(PLATFORM_DIR / "targets.json", env)
        self.assertEqual(contract["schema"], "omnia.platform.targets.v1")
        self.assertEqual(contract["contract_id"], "INT-09")
        ids = [t["id"] for t in contract["targets"]]
        self.assertEqual(ids, ["windows-native", "web-studio", "android-apk"])
        for t in contract["targets"]:
            self.assertEqual(
                set(t["lifecycle"].keys()),
                {"build", "install", "launch", "version", "capability", "recovery"},
            )

    def test_invalid_contract_schema_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            bad_path = Path(tmp) / "targets.json"
            bad_path.write_text(json.dumps({"schema": "wrong.v0", "targets": []}), encoding="utf-8")
            with self.assertRaises(vt.ContractError):
                vt.load_contract(bad_path, vt.ProbeEnv())

    def test_real_live_probe_schema_and_android_honesty(self) -> None:
        build_root = (REPO_ROOT.parent / "OmniaData" / "build").resolve()
        receipt = vt.evaluate_targets(
            contract_path=PLATFORM_DIR / "targets.json",
            repo_root=REPO_ROOT,
            build_root=build_root,
            run_version_probes=True,
            run_syntax_checks=True,
        )
        self.assertEqual(receipt["schema"], "omnia.platform.targets.receipt.v1")
        self.assertEqual(receipt["contract_id"], "INT-09")
        self.assertTrue(receipt["hygiene"]["out_of_source_clean"])
        by_id = {t["id"]: t for t in receipt["targets"]}

        win = by_id["windows-native"]
        self.assertEqual(win["overall_status"], "ready")
        self.assertEqual(win["toolchain_status"], "available")
        self.assertEqual(win["source_status"], "present")
        self.assertIn("msvc_link", win["present_tools"])
        self.assertIn(win["artifact_status"], {"none", "partial_external", "present_external"})
        for art in win["artifacts"]:
            self.assertEqual(art["present"], bool(art["found_paths"]))

        web = by_id["web-studio"]
        self.assertEqual(web["overall_status"], "ready")
        self.assertEqual(web["syntax_checks"]["status"], "passed")
        self.assertGreaterEqual(web["syntax_checks"]["passed_count"], 8)

        android = by_id["android-apk"]
        self.assertEqual(android["overall_status"], "toolchain_missing")
        self.assertEqual(android["toolchain_status"], "toolchain_missing")
        self.assertEqual(android["wrapper"]["status"], "unimplemented")
        self.assertFalse(android["apk_buildable"])
        self.assertFalse(android["fake_apk_claimed"])
        self.assertIn("toolchain_missing", android["blocked_reasons"])
        self.assertIn("unimplemented", android["blocked_reasons"])

    def test_mock_android_toolchain_present_wrapper_missing_reports_unimplemented(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "Omnia"
            build_root = Path(tmp) / "OmniaData" / "build"
            dirs, files, wmap, environ, cmap, js_files = _baseline_windows_web_mock_data(root, build_root)
            sdk = Path(r"C:\MockAndroidSdk")
            ndk = sdk / "ndk" / "27.0.12077973"
            sdkmgr = sdk / "cmdline-tools" / "latest" / "bin" / "sdkmanager.bat"
            adb = sdk / "platform-tools" / "adb.exe"
            gradle = Path(r"C:\MockGradle\bin\gradle.bat")
            java = Path(r"C:\MockJava\bin\java.exe")
            cargo_ndk = Path(r"C:\MockCargo\bin\cargo-ndk.exe")
            for d in (sdk, ndk):
                dirs.add(d)
            for f in (sdkmgr, adb, gradle, java, cargo_ndk):
                files.add(f)
                dirs.add(f.parent)
            environ["ANDROID_HOME"] = str(sdk)
            environ["ANDROID_NDK_HOME"] = str(ndk)
            environ["JAVA_HOME"] = r"C:\MockJava"
            wmap.update({"gradle": str(gradle), "cargo-ndk": str(cargo_ndk)})
            rustup_exe = wmap["rustup"]
            cmap[(rustup_exe, "target", "list", "--installed")] = (
                0,
                "x86_64-pc-windows-msvc\naarch64-linux-android\narmv7-linux-androideabi\n",
                "",
            )
            cmap[(str(java), "-version")] = (0, "", 'openjdk version "17.0.12"')

            env = _make_mock_env(
                existing_dirs=dirs,
                existing_files=files,
                which_map=wmap,
                environ=environ,
                cmd_map=cmap,
                js_files=js_files,
            )
            receipt = vt.evaluate_targets(
                contract_path=PLATFORM_DIR / "targets.json",
                repo_root=root,
                build_root=build_root,
                env=env,
            )
            android = {t["id"]: t for t in receipt["targets"]}["android-apk"]
            self.assertEqual(android["toolchain_status"], "available")
            self.assertEqual(android["wrapper"]["status"], "unimplemented")
            self.assertEqual(android["overall_status"], "unimplemented")
            self.assertEqual(android["blocked_reasons"], ["unimplemented"])
            self.assertFalse(android["apk_buildable"])
            self.assertFalse(android["fake_apk_claimed"])

    def test_mock_android_wrapper_present_toolchain_missing_reports_toolchain_missing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "Omnia"
            build_root = Path(tmp) / "OmniaData" / "build"
            dirs, files, wmap, environ, cmap, js_files = _baseline_windows_web_mock_data(root, build_root)
            wrapper_root = root / "platform" / "android"
            wrapper_files = [
                wrapper_root / "settings.gradle.kts",
                wrapper_root / "build.gradle.kts",
                wrapper_root / "app" / "build.gradle.kts",
                wrapper_root / "app" / "src" / "main" / "AndroidManifest.xml",
                wrapper_root / "gradle" / "wrapper" / "gradle-wrapper.properties",
            ]
            for wf in wrapper_files:
                files.add(wf)
                p = wf.parent
                while p != root.parent:
                    dirs.add(p)
                    p = p.parent

            env = _make_mock_env(
                existing_dirs=dirs,
                existing_files=files,
                which_map=wmap,
                environ=environ,
                cmd_map=cmap,
                js_files=js_files,
            )
            receipt = vt.evaluate_targets(
                contract_path=PLATFORM_DIR / "targets.json",
                repo_root=root,
                build_root=build_root,
                env=env,
            )
            android = {t["id"]: t for t in receipt["targets"]}["android-apk"]
            self.assertEqual(android["wrapper"]["status"], "present")
            self.assertEqual(android["wrapper"]["complete_root"], "platform/android")
            self.assertEqual(android["toolchain_status"], "toolchain_missing")
            self.assertEqual(android["overall_status"], "toolchain_missing")
            self.assertFalse(android["apk_buildable"])

    def test_mock_android_both_toolchain_and_wrapper_present_reports_ready(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "Omnia"
            build_root = Path(tmp) / "OmniaData" / "build"
            dirs, files, wmap, environ, cmap, js_files = _baseline_windows_web_mock_data(root, build_root)

            sdk = Path(r"C:\MockAndroidSdk")
            ndk = sdk / "ndk" / "27.0.12077973"
            sdkmgr = sdk / "cmdline-tools" / "latest" / "bin" / "sdkmanager.bat"
            adb = sdk / "platform-tools" / "adb.exe"
            gradle = Path(r"C:\MockGradle\bin\gradle.bat")
            java = Path(r"C:\MockJava\bin\java.exe")
            cargo_ndk = Path(r"C:\MockCargo\bin\cargo-ndk.exe")
            for d in (sdk, ndk):
                dirs.add(d)
            for f in (sdkmgr, adb, gradle, java, cargo_ndk):
                files.add(f)
                dirs.add(f.parent)
            environ["ANDROID_HOME"] = str(sdk)
            environ["ANDROID_NDK_HOME"] = str(ndk)
            environ["JAVA_HOME"] = r"C:\MockJava"
            wmap.update({"gradle": str(gradle), "cargo-ndk": str(cargo_ndk)})
            rustup_exe = wmap["rustup"]
            cmap[(rustup_exe, "target", "list", "--installed")] = (
                0,
                "x86_64-pc-windows-msvc\naarch64-linux-android\narmv7-linux-androideabi\n",
                "",
            )
            cmap[(str(java), "-version")] = (0, "", 'openjdk version "17.0.12"')

            wrapper_root = root / "platform" / "android"
            for wf in (
                wrapper_root / "settings.gradle.kts",
                wrapper_root / "build.gradle.kts",
                wrapper_root / "app" / "build.gradle.kts",
                wrapper_root / "app" / "src" / "main" / "AndroidManifest.xml",
                wrapper_root / "gradle" / "wrapper" / "gradle-wrapper.properties",
            ):
                files.add(wf)
                p = wf.parent
                while p != root.parent:
                    dirs.add(p)
                    p = p.parent

            env = _make_mock_env(
                existing_dirs=dirs,
                existing_files=files,
                which_map=wmap,
                environ=environ,
                cmd_map=cmap,
                js_files=js_files,
            )
            receipt = vt.evaluate_targets(
                contract_path=PLATFORM_DIR / "targets.json",
                repo_root=root,
                build_root=build_root,
                env=env,
            )
            android = {t["id"]: t for t in receipt["targets"]}["android-apk"]
            self.assertEqual(android["toolchain_status"], "available")
            self.assertEqual(android["wrapper"]["status"], "present")
            self.assertEqual(android["overall_status"], "ready")
            self.assertEqual(android["blocked_reasons"], [])
            self.assertTrue(android["apk_buildable"])
            self.assertEqual(android["artifact_status"], "none")

    def test_mock_partial_android_sdk_missing_ndk_and_armv7_target(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "Omnia"
            build_root = Path(tmp) / "OmniaData" / "build"
            dirs, files, wmap, environ, cmap, js_files = _baseline_windows_web_mock_data(root, build_root)
            sdk = Path(r"C:\MockAndroidSdk")
            sdkmgr = sdk / "cmdline-tools" / "latest" / "bin" / "sdkmanager.bat"
            adb = sdk / "platform-tools" / "adb.exe"
            gradle = Path(r"C:\MockGradle\bin\gradle.bat")
            java = Path(r"C:\MockJava\bin\java.exe")
            cargo_ndk = Path(r"C:\MockCargo\bin\cargo-ndk.exe")
            dirs.add(sdk)
            for f in (sdkmgr, adb, gradle, java, cargo_ndk):
                files.add(f)
                dirs.add(f.parent)
            environ["ANDROID_HOME"] = str(sdk)
            environ["JAVA_HOME"] = r"C:\MockJava"
            wmap.update({"gradle": str(gradle), "cargo-ndk": str(cargo_ndk)})
            rustup_exe = wmap["rustup"]
            cmap[(rustup_exe, "target", "list", "--installed")] = (
                0,
                "x86_64-pc-windows-msvc\naarch64-linux-android\n",
                "",
            )

            env = _make_mock_env(
                existing_dirs=dirs,
                existing_files=files,
                which_map=wmap,
                environ=environ,
                cmd_map=cmap,
                js_files=js_files,
            )
            receipt = vt.evaluate_targets(
                contract_path=PLATFORM_DIR / "targets.json",
                repo_root=root,
                build_root=build_root,
                env=env,
            )
            android = {t["id"]: t for t in receipt["targets"]}["android-apk"]
            self.assertEqual(android["toolchain_status"], "toolchain_missing")
            self.assertEqual(android["missing_tools"], ["android_ndk"])
            self.assertEqual(android["missing_rust_targets"], ["armv7-linux-androideabi"])

    def test_mock_windows_and_web_full_rust_artifacts_ready(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "Omnia"
            build_root = Path(tmp) / "OmniaData" / "build"
            dirs, files, wmap, environ, cmap, js_files = _baseline_windows_web_mock_data(root, build_root)
            env = _make_mock_env(
                existing_dirs=dirs,
                existing_files=files,
                which_map=wmap,
                environ=environ,
                cmd_map=cmap,
                js_files=js_files,
            )
            receipt = vt.evaluate_targets(
                contract_path=PLATFORM_DIR / "targets.json",
                repo_root=root,
                build_root=build_root,
                env=env,
            )
            by_id = {t["id"]: t for t in receipt["targets"]}
            win = by_id["windows-native"]
            self.assertEqual(win["overall_status"], "ready")
            self.assertEqual(win["toolchain_status"], "available")
            self.assertEqual(win["source_status"], "present")
            self.assertEqual(win["artifact_status"], "present_external")
            self.assertEqual(
                {a["name"] for a in win["artifacts"] if a["present"]},
                {"omnia-native.exe", "omnia-studio.exe", "omnia-runtime.exe"},
            )
            web = by_id["web-studio"]
            self.assertEqual(web["overall_status"], "ready")
            self.assertEqual(web["artifact_status"], "present_external")

    def test_mock_git_usr_bin_link_does_not_satisfy_msvc_link(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "Omnia"
            build_root = Path(tmp) / "OmniaData" / "build"
            dirs, files, wmap, environ, cmap, js_files = _baseline_windows_web_mock_data(root, build_root)
            msvc_link = (
                Path(r"C:\MockVS\18\BuildTools\VC\Tools\MSVC\14.51.36231\bin\Hostx64\x64\link.exe").resolve()
            )
            files.discard(msvc_link)
            git_link = Path(r"C:\Program Files\Git\usr\bin\link.exe")
            files.add(git_link)
            dirs.add(git_link.parent)
            wmap["link"] = str(git_link)
            wmap["link.exe"] = str(git_link)
            env = _make_mock_env(
                existing_dirs=dirs,
                existing_files=files,
                which_map=wmap,
                environ=environ,
                cmd_map=cmap,
                js_files=js_files,
            )
            receipt = vt.evaluate_targets(
                contract_path=PLATFORM_DIR / "targets.json",
                repo_root=root,
                build_root=build_root,
                env=env,
            )
            win = {t["id"]: t for t in receipt["targets"]}["windows-native"]
            self.assertEqual(win["overall_status"], "toolchain_missing")
            self.assertEqual(win["missing_tools"], ["msvc_link"])

    def test_mock_windows_native_missing_toolchain_downgrades(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "Omnia"
            build_root = Path(tmp) / "OmniaData" / "build"
            env = _make_mock_env(existing_dirs={root}, existing_files=set(), which_map={}, environ={})
            receipt = vt.evaluate_targets(
                contract_path=PLATFORM_DIR / "targets.json",
                repo_root=root,
                build_root=build_root,
                env=env,
            )
            win = {t["id"]: t for t in receipt["targets"]}["windows-native"]
            self.assertEqual(win["overall_status"], "source_missing")
            self.assertEqual(win["toolchain_status"], "toolchain_missing")
            self.assertEqual(win["artifact_status"], "none")

    def test_mock_web_studio_syntax_error_reported(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "Omnia"
            build_root = Path(tmp) / "OmniaData" / "build"
            dirs, files, wmap, environ, cmap, js_files = _baseline_windows_web_mock_data(root, build_root)
            cmap[("node", "--check", "main.js")] = (1, "", "SyntaxError: Unexpected token")
            env = _make_mock_env(
                existing_dirs=dirs,
                existing_files=files,
                which_map=wmap,
                environ=environ,
                cmd_map=cmap,
                js_files=js_files,
            )
            receipt = vt.evaluate_targets(
                contract_path=PLATFORM_DIR / "targets.json",
                repo_root=root,
                build_root=build_root,
                env=env,
            )
            web = {t["id"]: t for t in receipt["targets"]}["web-studio"]
            self.assertEqual(web["overall_status"], "syntax_error")
            self.assertEqual(web["syntax_checks"]["status"], "syntax_error")
            self.assertEqual(web["syntax_checks"]["passed_count"], 1)

    def test_strict_utf8_lf_and_zero_pycache_in_platform_dir(self) -> None:
        expected_files = [
            PLATFORM_DIR / "README.md",
            PLATFORM_DIR / "targets.json",
            PLATFORM_DIR / "validate_targets.py",
            PLATFORM_DIR / "test_validate_targets.py",
        ]
        for path in expected_files:
            self.assertTrue(path.is_file(), f"missing platform file: {path}")
            raw = path.read_bytes()
            self.assertFalse(raw.startswith(b"\xef\xbb\xbf"), f"UTF-8 BOM found in {path}")
            self.assertNotIn(b"\r\n", raw, f"CRLF found in {path}")
            self.assertTrue(raw.endswith(b"\n"), f"Missing trailing LF in {path}")
            raw.decode("utf-8")

        pycache_hits = [p for p in PLATFORM_DIR.rglob("*") if p.name == "__pycache__" or p.suffix in {".pyc", ".pyo"}]
        self.assertEqual(pycache_hits, [], f"Found forbidden Python bytecode artifacts: {pycache_hits}")

    def test_secret_redaction_and_json_out_write(self) -> None:
        synthetic_bearer = "supersecret_" + "token_123456"
        synthetic_gkey = "AIza" + "SyDummyKeyValue" + "1234567890"
        sample = f"Authorization: Bearer {synthetic_bearer} key={synthetic_gkey}"
        redacted = vt.redact_text(sample)
        self.assertNotIn(synthetic_bearer, redacted)
        self.assertNotIn(synthetic_gkey, redacted)
        self.assertIn("[REDACTED:bearer_token]", redacted)
        self.assertIn("[REDACTED:google_api_key]", redacted)

        with tempfile.TemporaryDirectory() as tmp:
            out_file = Path(tmp) / "receipt.json"
            with contextlib.redirect_stdout(io.StringIO()):
                rc = vt.main(["--skip-version-probes", "--skip-syntax-checks", "--json-out", str(out_file)])
            self.assertEqual(rc, 0)
            raw = out_file.read_bytes()
            self.assertNotIn(b"\r\n", raw)
            parsed = json.loads(raw.decode("utf-8"))
            self.assertEqual(parsed["schema"], "omnia.platform.targets.receipt.v1")

    def test_cli_fail_on_unready_returns_nonzero_when_android_unready(self) -> None:
        with contextlib.redirect_stdout(io.StringIO()):
            rc = vt.main(["--skip-version-probes", "--skip-syntax-checks", "--fail-on-unready"])
        self.assertEqual(rc, 1)


if __name__ == "__main__":
    unittest.main()

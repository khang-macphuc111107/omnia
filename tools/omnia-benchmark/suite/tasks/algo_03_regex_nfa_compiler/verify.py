"""Hidden verification suite for algo_03_regex_nfa_compiler."""

from __future__ import annotations

import argparse
import ast
import builtins
import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import time
import traceback
from pathlib import Path
from typing import Any

TASK_ID = "algo_03_regex_nfa_compiler"
REDOS_SINGLE_LIMIT_S = 0.1
REDOS_TOTAL_LIMIT_S = 0.5

BANNED_MODULES = frozenset({
    "re",
    "_sre",
    "sre_compile",
    "sre_parse",
    "sre_constants",
    "regex",
    "fnmatch",
    "glob",
    "subprocess",
    "multiprocessing",
    "ctypes",
    "pty",
    "importlib",
})

BANNED_BUILTINS = frozenset({"__import__", "eval", "exec", "compile"})
BANNED_OS_ATTRS = frozenset({
    "system",
    "popen",
    "execl",
    "execle",
    "execlp",
    "execlpe",
    "execv",
    "execve",
    "execvp",
    "execvpe",
    "spawnl",
    "spawnle",
    "spawnlp",
    "spawnlpe",
    "spawnv",
    "spawnve",
    "spawnvp",
    "spawnvpe",
})


def _check_ast_anti_cheat(workspace: Path) -> tuple[bool, str]:
    py_files = sorted(
        p for p in workspace.rglob("*.py")
        if p.name != "test_sample.py" and "__pycache__" not in p.parts
    )
    if not (workspace / "solution.py").is_file():
        return False, f"solution.py not found in {workspace}"

    for py_file in py_files:
        try:
            src = py_file.read_text(encoding="utf-8")
            tree = ast.parse(src, filename=str(py_file))
        except SyntaxError as exc:
            return False, f"SyntaxError in {py_file.name}: {exc}"

        rel = py_file.relative_to(workspace)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    root = alias.name.split(".")[0]
                    if root in BANNED_MODULES:
                        return False, f"Banned import '{alias.name}' in {rel}:{node.lineno}"
            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    root = node.module.split(".")[0]
                    if root in BANNED_MODULES:
                        return False, f"Banned from-import '{node.module}' in {rel}:{node.lineno}"
            elif isinstance(node, ast.Call):
                func = node.func
                if isinstance(func, ast.Name) and func.id in BANNED_BUILTINS:
                    return False, f"Banned call '{func.id}()' in {rel}:{node.lineno}"
                if isinstance(func, ast.Attribute) and func.attr in BANNED_OS_ATTRS:
                    if isinstance(func.value, ast.Name) and func.value.id in ("os", "posix", "nt"):
                        return False, f"Banned call '{func.value.id}.{func.attr}()' in {rel}:{node.lineno}"
            elif isinstance(node, ast.Attribute):
                if node.attr == "modules" and isinstance(node.value, ast.Name) and node.value.id == "sys":
                    return False, f"Banned access 'sys.modules' in {rel}:{node.lineno}"
                if node.attr in ("_sre", "sre_compile", "sre_parse"):
                    return False, f"Banned attribute '.{node.attr}' in {rel}:{node.lineno}"

    return True, f"AST clean across {len(py_files)} workspace file(s)"


def _install_runtime_guard(workspace: Path) -> list[str]:
    """Install caller-aware __import__ hook and poison re/subprocess/os exec APIs."""
    # Pre-import harmless stdlib modules so user solutions can freely use dataclasses/typing/etc.
    import collections  # noqa: F401
    import dataclasses  # noqa: F401
    import enum  # noqa: F401
    import functools  # noqa: F401
    import itertools  # noqa: F401
    import re
    import typing  # noqa: F401

    violations: list[str] = []
    ws_resolved = str(workspace.resolve()).lower()

    def _blocked_call(label: str) -> Any:
        def _raiser(*_args: Any, **_kwargs: Any) -> Any:
            msg = f"Banned runtime call: {label}"
            violations.append(msg)
            raise RuntimeError(msg)
        return _raiser

    for attr in ("compile", "_compile", "match", "search", "fullmatch", "findall", "finditer", "sub", "subn", "split"):
        if hasattr(re, attr):
            setattr(re, attr, _blocked_call(f"re.{attr}"))

    for attr in ("Popen", "run", "call", "check_call", "check_output"):
        if hasattr(subprocess, attr):
            setattr(subprocess, attr, _blocked_call(f"subprocess.{attr}"))

    for attr in ("system", "popen"):
        if hasattr(os, attr):
            setattr(os, attr, _blocked_call(f"os.{attr}"))

    orig_import = builtins.__import__

    def _guarded_import(
        name: str,
        globals: Any = None,
        locals: Any = None,
        fromlist: Any = (),
        level: int = 0,
    ) -> Any:
        root = name.split(".")[0]
        if root in BANNED_MODULES:
            try:
                caller_file = sys._getframe(1).f_code.co_filename
                caller_norm = str(Path(caller_file).resolve()).lower()
            except Exception:
                caller_norm = ""
            if caller_norm.startswith(ws_resolved):
                msg = f"Banned runtime import '{name}' from workspace"
                violations.append(msg)
                raise ImportError(msg)
        return orig_import(name, globals, locals, fromlist, level)

    builtins.__import__ = _guarded_import  # type: ignore[assignment]
    return violations


def _load_solution_guarded(workspace: Path) -> tuple[Any, list[str]]:
    violations = _install_runtime_guard(workspace)
    sol_path = workspace / "solution.py"
    sys.path.insert(0, str(workspace))
    spec = importlib.util.spec_from_file_location("solution", str(sol_path))
    if spec is None or spec.loader is None:
        raise ImportError(f"Unable to load spec from {sol_path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["solution"] = mod
    with contextlib.redirect_stdout(io.StringIO()):
        spec.loader.exec_module(mod)

    # Check no banned module objects were smuggled into module globals
    for attr_name, val in vars(mod).items():
        if hasattr(val, "__name__") and getattr(val, "__name__", "").split(".")[0] in BANNED_MODULES:
            if type(val).__name__ == "module":
                violations.append(f"Smuggled banned module '{val.__name__}' in global '{attr_name}'")
        if type(val).__module__ in ("re", "_sre", "regex"):
            violations.append(f"Smuggled banned regex object '{type(val)}' in global '{attr_name}'")

    for req in ("RegexSyntaxError", "MatchResult", "CompiledPattern", "compile_pattern"):
        if not hasattr(mod, req):
            raise AttributeError(f"Required symbol '{req}' not found in solution.py")
    return mod, violations


def _assert_match(
    m: Any,
    expected_span: tuple[int, int] | None,
    expected_group0: str | None = None,
    expected_groups: tuple[str | None, ...] | None = None,
    label: str = "",
) -> None:
    if expected_span is None:
        if m is not None:
            raise AssertionError(f"{label}: expected None, got span={getattr(m, 'span', m)!r}")
        return
    if m is None:
        raise AssertionError(f"{label}: expected match span={expected_span}, got None")
    if m.span != expected_span:
        raise AssertionError(f"{label}: expected span={expected_span}, got {m.span!r}")
    if expected_group0 is not None and m.group(0) != expected_group0:
        raise AssertionError(f"{label}: expected group(0)={expected_group0!r}, got {m.group(0)!r}")
    if expected_groups is not None:
        if m.groups() != expected_groups:
            raise AssertionError(f"{label}: expected groups()={expected_groups!r}, got {m.groups()!r}")
        for idx, exp_g in enumerate(expected_groups, start=1):
            if m.group(idx) != exp_g:
                raise AssertionError(f"{label}: expected group({idx})={exp_g!r}, got {m.group(idx)!r}")


def _run_functional_worker(workspace: Path) -> dict[str, Any]:
    try:
        mod, violations = _load_solution_guarded(workspace)
    except Exception as exc:
        return {
            "runtime_clean": False,
            "runtime_detail": f"Load failed: {type(exc).__name__}: {exc}",
            "checks": [],
            "error": f"Import error: {type(exc).__name__}: {exc}",
        }

    if violations:
        return {
            "runtime_clean": False,
            "runtime_detail": "; ".join(violations),
            "checks": [],
            "error": f"Anti-cheat violation: {violations[0]}",
        }

    compile_pattern = mod.compile_pattern
    RegexSyntaxError = mod.RegexSyntaxError
    checks: list[dict[str, Any]] = []

    def run_case(name: str, fn: Any) -> None:
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                fn()
            checks.append({"name": name, "passed": True, "group": "fail_to_pass", "detail": "ok"})
        except Exception as exc:
            checks.append({
                "name": name,
                "passed": False,
                "group": "fail_to_pass",
                "detail": f"{type(exc).__name__}: {exc}",
            })

    def f01() -> None:
        p = compile_pattern("hello")
        _assert_match(p.fullmatch("hello"), (0, 5), "hello", (), "fullmatch")
        _assert_match(p.fullmatch("hello!"), None, label="fullmatch extra")
        _assert_match(p.match("hello world"), (0, 5), "hello", (), "match")
        _assert_match(p.match("say hello"), None, label="match miss")
        _assert_match(p.search("say hello world"), (4, 9), "hello", (), "search")
        _assert_match(p.search("goodbye"), None, label="search miss")

    def f02() -> None:
        p = compile_pattern("")
        _assert_match(p.fullmatch(""), (0, 0), "", (), "empty fullmatch")
        _assert_match(p.fullmatch("a"), None, label="empty fullmatch non-empty")
        _assert_match(p.match("abc"), (0, 0), "", (), "empty match")
        _assert_match(p.search("abc"), (0, 0), "", (), "empty search")
        assert p.findall("ab") == ["", "", ""], f"got {p.findall('ab')}"
        assert p.findall("") == [""], f"got {p.findall('')}"

    def f03() -> None:
        p = compile_pattern("a.b")
        _assert_match(p.fullmatch("axb"), (0, 3), "axb")
        _assert_match(p.fullmatch("a b"), (0, 3), "a b")
        _assert_match(p.fullmatch("a\nb"), None, label="dot must not match newline")
        _assert_match(p.fullmatch("ab"), None, label="dot requires 1 char")

    def f04() -> None:
        pd = compile_pattern(r"\d+")
        _assert_match(pd.search("abc123def"), (3, 6), "123")
        pw = compile_pattern(r"\w+")
        _assert_match(pw.search("  foo_Bar99!"), (2, 11), "foo_Bar99")
        ps = compile_pattern(r"\s+")
        _assert_match(ps.fullmatch(" \t\r\n\f\v"), (0, 6), " \t\r\n\f\v")
        _assert_match(ps.search("abc"), None)

    def f05() -> None:
        pat = r"\.\*\+\?\(\)\[\]\{\}\|\^\$\\"
        lit = r".*+?()[]{}|^$" + "\\"
        p = compile_pattern(pat)
        _assert_match(p.fullmatch(lit), (0, len(lit)), lit)
        _assert_match(p.fullmatch("a" * len(lit)), None)

    def f06() -> None:
        p = compile_pattern(r"a\nb\tc\rd")
        _assert_match(p.fullmatch("a\nb\tc\rd"), (0, 7), "a\nb\tc\rd")
        _assert_match(p.fullmatch("a b c d"), None)

    def f07() -> None:
        p = compile_pattern(r"[a-z0-9_]+")
        _assert_match(p.fullmatch("var_42"), (0, 6), "var_42")
        _assert_match(p.fullmatch("Var_42"), None)
        p2 = compile_pattern(r"[-a][a-]")
        _assert_match(p2.fullmatch("--"), (0, 2), "--")
        _assert_match(p2.fullmatch("-a"), (0, 2), "-a")
        _assert_match(p2.fullmatch("aa"), (0, 2), "aa")
        _assert_match(p2.fullmatch("ab"), None)

    def f08() -> None:
        p = compile_pattern(r"[^abc]+")
        _assert_match(p.fullmatch("xyz\n123"), (0, 7), "xyz\n123")
        _assert_match(p.search("abca"), None)
        _assert_match(p.search("abXcd"), (2, 3), "X")

    def f09() -> None:
        p = compile_pattern(r"[\d\]\\\-]+")
        _assert_match(p.fullmatch(r"09]-\5"), (0, 6), r"09]-\5")
        _assert_match(p.fullmatch("09a"), None)
        p2 = compile_pattern(r"[\s\w]+")
        _assert_match(p2.fullmatch("a_1 \t"), (0, 5), "a_1 \t")

    def f10() -> None:
        p = compile_pattern(r"[a^b]+")
        _assert_match(p.fullmatch("a^b^a"), (0, 5), "a^b^a")
        _assert_match(p.fullmatch("c"), None)

    def f11() -> None:
        p1 = compile_pattern(r"^abc$")
        _assert_match(p1.search("abc"), (0, 3), "abc")
        _assert_match(p1.search("xabc"), None)
        _assert_match(p1.search("abcx"), None)
        p2 = compile_pattern(r"^$")
        _assert_match(p2.search(""), (0, 0), "")
        _assert_match(p2.search("a"), None)
        p3 = compile_pattern(r"^abc")
        _assert_match(p3.search("abcdef"), (0, 3), "abc")
        _assert_match(p3.search("xabc"), None)
        p4 = compile_pattern(r"abc$")
        _assert_match(p4.search("xyzabc"), (3, 6), "abc")
        _assert_match(p4.search("abcxyz"), None)

    def f12() -> None:
        p = compile_pattern(r"^foo|bar$")
        _assert_match(p.search("foox"), (0, 3), "foo")
        _assert_match(p.search("xbar"), (1, 4), "bar")
        _assert_match(p.search("xfooy"), None)
        _assert_match(p.search("xbary"), None)

    def f13() -> None:
        # Leftmost-first alternation priority!
        p1 = compile_pattern(r"(a|ab)")
        _assert_match(p1.match("ab"), (0, 1), "a", ("a",))
        p2 = compile_pattern(r"(ab|a)")
        _assert_match(p2.match("ab"), (0, 2), "ab", ("ab",))

    def f14() -> None:
        # Left branch fails downstream, must fall through to right branch!
        p = compile_pattern(r"(ab|a)b")
        _assert_match(p.fullmatch("ab"), (0, 2), "ab", ("a",))
        _assert_match(p.match("ab"), (0, 2), "ab", ("a",))
        _assert_match(p.fullmatch("abb"), (0, 3), "abb", ("ab",))

    def f15() -> None:
        p1 = compile_pattern(r"a|")
        _assert_match(p1.match("a"), (0, 1), "a")
        _assert_match(p1.match("b"), (0, 0), "")
        p2 = compile_pattern(r"|a")
        _assert_match(p2.match("a"), (0, 0), "")
        _assert_match(p2.fullmatch("a"), (0, 1), "a")

    def f16() -> None:
        p = compile_pattern(r"(a)(b)?(c)")
        _assert_match(p.fullmatch("ac"), (0, 2), "ac", ("a", None, "c"))
        _assert_match(p.fullmatch("abc"), (0, 3), "abc", ("a", "b", "c"))
        _assert_match(p.fullmatch("abbc"), None)

    def f17() -> None:
        p = compile_pattern(r"((a)(b(c)))")
        _assert_match(p.fullmatch("abc"), (0, 3), "abc", ("abc", "a", "bc", "c"))

    def f18() -> None:
        p = compile_pattern(r"a()b")
        _assert_match(p.fullmatch("ab"), (0, 2), "ab", ("",))

    def f19() -> None:
        p1 = compile_pattern(r"([a-z])+")
        _assert_match(p1.fullmatch("xyz"), (0, 3), "xyz", ("z",))
        p2 = compile_pattern(r"(a|ab)+")
        _assert_match(p2.match("aab"), (0, 2), "aa", ("a",))
        _assert_match(p2.fullmatch("aab"), (0, 3), "aab", ("ab",))
        p3 = compile_pattern(r"(ab|a)+")
        _assert_match(p3.match("aab"), (0, 3), "aab", ("ab",))

    def f20() -> None:
        p = compile_pattern(r"(a)(b)")
        m = p.fullmatch("ab")
        assert m is not None
        for bad in (-1, 3, 100):
            try:
                m.group(bad)
            except IndexError:
                pass
            else:
                raise AssertionError(f"Expected IndexError for group({bad})")

    def f21() -> None:
        p1 = compile_pattern(r"a*b")
        _assert_match(p1.fullmatch("b"), (0, 1), "b")
        _assert_match(p1.fullmatch("aaab"), (0, 4), "aaab")
        p2 = compile_pattern(r"a+b")
        _assert_match(p2.fullmatch("b"), None)
        _assert_match(p2.fullmatch("ab"), (0, 2), "ab")
        p3 = compile_pattern(r"ab?c")
        _assert_match(p3.fullmatch("ac"), (0, 2), "ac")
        _assert_match(p3.fullmatch("abc"), (0, 3), "abc")
        _assert_match(p3.fullmatch("abbc"), None)

    def f22() -> None:
        p1 = compile_pattern(r"a{3}")
        _assert_match(p1.fullmatch("aa"), None)
        _assert_match(p1.fullmatch("aaa"), (0, 3), "aaa")
        _assert_match(p1.fullmatch("aaaa"), None)
        p2 = compile_pattern(r"(a){0}(b)")
        _assert_match(p2.fullmatch("b"), (0, 1), "b", (None, "b"))
        _assert_match(p2.fullmatch("ab"), None)

    def f23() -> None:
        p = compile_pattern(r"a{2,}")
        _assert_match(p.fullmatch("a"), None)
        _assert_match(p.fullmatch("aa"), (0, 2), "aa")
        _assert_match(p.fullmatch("aaaaa"), (0, 5), "aaaaa")
        _assert_match(p.match("aaaab"), (0, 4), "aaaa")

    def f24() -> None:
        p = compile_pattern(r"a{2,4}")
        _assert_match(p.fullmatch("a"), None)
        _assert_match(p.fullmatch("aa"), (0, 2), "aa")
        _assert_match(p.fullmatch("aaa"), (0, 3), "aaa")
        _assert_match(p.fullmatch("aaaa"), (0, 4), "aaaa")
        _assert_match(p.fullmatch("aaaaa"), None)
        _assert_match(p.match("aaaaa"), (0, 4), "aaaa")

    def f25() -> None:
        p = compile_pattern(r"([0-9]){0,3}")
        _assert_match(p.fullmatch(""), (0, 0), "", (None,))
        _assert_match(p.fullmatch("78"), (0, 2), "78", ("8",))
        _assert_match(p.match("12345"), (0, 3), "123", ("3",))

    def f26() -> None:
        # Zero-width loops must not infinite-loop
        p1 = compile_pattern(r"(a*)*")
        _assert_match(p1.fullmatch(""), (0, 0), "")
        _assert_match(p1.fullmatch("aaa"), (0, 3), "aaa")
        p2 = compile_pattern(r"(a?)+")
        _assert_match(p2.fullmatch(""), (0, 0), "")
        _assert_match(p2.fullmatch("aa"), (0, 2), "aa")
        p3 = compile_pattern(r"()*b")
        _assert_match(p3.fullmatch("b"), (0, 1), "b")

    def f27() -> None:
        # Earliest start position wins in search() even over longer/left branch later
        p = compile_pattern(r"b+|a")
        _assert_match(p.search("xabbb"), (1, 2), "a")

    def f28() -> None:
        # search() must scan past newlines even though '.' does not match '\n'
        p = compile_pattern(r"b.")
        _assert_match(p.search("a\nbx"), (2, 4), "bx")
        _assert_match(p.search("a\nb\n"), None)

    def f29() -> None:
        p = compile_pattern(r"aa")
        assert p.findall("aaaaa") == ["aa", "aa"]
        assert p.findall("b") == []
        p2 = compile_pattern(r"[a-z]+\d+")
        assert p2.findall("x1 y22 -- z333") == ["x1", "y22", "z333"]

    def f30() -> None:
        assert compile_pattern(r"a*").findall("ab") == ["a", "", ""]
        assert compile_pattern(r"a*").findall("") == [""]
        assert compile_pattern(r"b*").findall("a") == ["", ""]
        assert compile_pattern(r"a?").findall("a") == ["a", ""]
        assert compile_pattern(r"a?").findall("ba") == ["", "a", ""]

    def f31() -> None:
        assert compile_pattern(r"^a").findall("aa") == ["a"]
        assert compile_pattern(r"a$").findall("aa") == ["a"]
        assert compile_pattern(r"^a$").findall("a") == ["a"]
        assert compile_pattern(r"^a$").findall("aa") == []

    def f32() -> None:
        p = compile_pattern(r"^([a-zA-Z0-9._-]+)@([a-zA-Z0-9-]+)\.([a-z]{2,4})$")
        _assert_match(
            p.fullmatch("alice.bob_9@my-host.org"),
            (0, 23),
            "alice.bob_9@my-host.org",
            ("alice.bob_9", "my-host", "org"),
        )
        _assert_match(p.fullmatch("bad@host.toolong"), None)
        _assert_match(p.fullmatch("no-at-sign.com"), None)

    def f33() -> None:
        p = compile_pattern(r"^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$")
        _assert_match(p.fullmatch("192.168.0.1"), (0, 11), "192.168.0.1", ("192", "168", "0", "1"))
        _assert_match(p.fullmatch("192.168.0.1000"), None)

    def f34() -> None:
        for bad in ("(abc", "abc)", "((a)", ")(", "a(b(c)"):
            try:
                compile_pattern(bad)
            except RegexSyntaxError:
                pass
            else:
                raise AssertionError(f"Expected RegexSyntaxError for {bad!r}")

    def f35() -> None:
        for bad in ("[abc", "[]", "[^]", "[z-a]", "[9-0]", "a[b-a]c"):
            try:
                compile_pattern(bad)
            except RegexSyntaxError:
                pass
            else:
                raise AssertionError(f"Expected RegexSyntaxError for {bad!r}")

    def f36() -> None:
        for bad in (
            "*a", "+a", "?a", "{2}a", "(|*a)", "(*a)",
            "a**", "a+*", "a++", "a{2}{3}",
            "a{5,2}", "a{}", "a{,3}", "a{abc}", "a{2",
            "^*", "$+",
        ):
            try:
                compile_pattern(bad)
            except RegexSyntaxError:
                pass
            else:
                raise AssertionError(f"Expected RegexSyntaxError for {bad!r}")

    def f37() -> None:
        for bad in ("\\", "abc\\"):
            try:
                compile_pattern(bad)
            except RegexSyntaxError:
                pass
            else:
                raise AssertionError(f"Expected RegexSyntaxError for {bad!r}")

    def f38() -> None:
        p = compile_pattern(r"(\w+)=(\d+)")
        _assert_match(p.search("a=1"), (0, 3), "a=1", ("a", "1"))
        _assert_match(p.search("nope"), None)
        _assert_match(p.search("foo=999 bar=2"), (0, 7), "foo=999", ("foo", "999"))
        assert p.findall("x=10, y=20, z=30") == ["x=10", "y=20", "z=30"]
        _assert_match(p.fullmatch("k=0"), (0, 3), "k=0", ("k", "0"))

    def f39() -> None:
        # Diverse differential ground-truth table (verified against exact PikeVM/Perl semantics)
        cases = [
            (r"(a|b)*abb", "fullmatch", "ababb", (0, 5), ("b",)),
            (r"(a|b)*abb", "fullmatch", "ababa", None, None),
            (r"((a|b)c)+", "fullmatch", "acbcac", (0, 6), ("ac", "a")),
            (r"(foo|foobar)baz", "fullmatch", "foobarbaz", (0, 9), ("foobar",)),
            (r"(foo|foobar)baz", "fullmatch", "foobaz", (0, 6), ("foo",)),
            (r"(x)?(y)?z", "fullmatch", "z", (0, 1), (None, None)),
            (r"(x)?(y)?z", "fullmatch", "yz", (0, 2), (None, "y")),
            (r"(x)?(y)?z", "fullmatch", "xz", (0, 2), ("x", None)),
            (r"^((a|b){2,3})c$", "fullmatch", "abac", (0, 4), ("aba", "a")),
            (r"a(b|c)*d", "search", "xxabcbcdyy", (2, 8), ("c",)),
            (r"(\d{2})-(\d{2})-(\d{4})", "search", "date: 22-11-2026!", (6, 16), ("22", "11", "2026")),
            (r"([^,]+),([^,]+)", "fullmatch", "left,right", (0, 10), ("left", "right")),
            (r"(a+)(a+)", "fullmatch", "aaaa", (0, 4), ("aaa", "a")),
            (r"(a*)(a+)", "fullmatch", "aaaa", (0, 4), ("aaa", "a")),
            (r"(a+)(a*)", "fullmatch", "aaaa", (0, 4), ("aaaa", "")),
            (r"((ab)|(a))(b)", "fullmatch", "ab", (0, 2), ("a", None, "a", "b")),
            (r"(a|b|c){3}", "fullmatch", "cab", (0, 3), ("b",)),
            (r"^\s*(\w+)\s*:\s*([^\s]+)\s*$", "fullmatch", "  key : val42  ", (0, 15), ("key", "val42")),
            (r"(a|bc){1,3}d", "fullmatch", "abcbcd", (0, 6), ("bc",)),
            (r"((a)?b)+", "fullmatch", "abb", (0, 3), ("b", "a")),
        ]
        for pat, method, text, exp_span, exp_groups in cases:
            p = compile_pattern(pat)
            m = getattr(p, method)(text)
            exp_g0 = None if exp_span is None else text[exp_span[0] : exp_span[1]]
            _assert_match(m, exp_span, exp_g0, exp_groups, f"{pat!r}.{method}({text!r})")

    tests = [
        ("func_01_literal_methods", f01),
        ("func_02_empty_pattern", f02),
        ("func_03_dot_not_newline", f03),
        ("func_04_shorthand_d_w_s", f04),
        ("func_05_escaped_metacharacters", f05),
        ("func_06_escape_n_t_r", f06),
        ("func_07_char_class_ranges_hyphens", f07),
        ("func_08_char_class_negated", f08),
        ("func_09_char_class_escapes", f09),
        ("func_10_char_class_caret_not_first", f10),
        ("func_11_anchors_start_end", f11),
        ("func_12_anchors_in_alternation", f12),
        ("func_13_alternation_leftmost_first", f13),
        ("func_14_alternation_fallthrough", f14),
        ("func_15_alternation_empty_branches", f15),
        ("func_16_captures_optional_none", f16),
        ("func_17_captures_nested", f17),
        ("func_18_captures_empty_group", f18),
        ("func_19_captures_repeated_and_alt_loop", f19),
        ("func_20_captures_group_index_error", f20),
        ("func_21_quantifier_star_plus_question", f21),
        ("func_22_quantifier_exact_m_and_zero", f22),
        ("func_23_quantifier_min_unbounded", f23),
        ("func_24_quantifier_range_m_n", f24),
        ("func_25_quantifier_zero_to_n", f25),
        ("func_26_zero_width_loops_terminate", f26),
        ("func_27_search_earliest_start", f27),
        ("func_28_search_past_newlines", f28),
        ("func_29_findall_non_overlapping", f29),
        ("func_30_findall_empty_matches", f30),
        ("func_31_findall_with_anchors", f31),
        ("func_32_complex_email_pattern", f32),
        ("func_33_complex_ipv4_pattern", f33),
        ("func_34_syntax_error_parens", f34),
        ("func_35_syntax_error_char_classes", f35),
        ("func_36_syntax_error_quantifiers", f36),
        ("func_37_syntax_error_trailing_backslash", f37),
        ("func_38_reusable_compiled_pattern", f38),
        ("func_39_differential_ground_truth_20", f39),
    ]
    for name, fn in tests:
        run_case(name, fn)

    return {
        "runtime_clean": len(violations) == 0,
        "runtime_detail": "ok" if not violations else "; ".join(violations),
        "checks": checks,
        "error": None if not violations else f"Anti-cheat violation: {violations[0]}",
    }


def _run_redos_worker(workspace: Path) -> dict[str, Any]:
    try:
        mod, violations = _load_solution_guarded(workspace)
    except Exception as exc:
        return {
            "runtime_clean": False,
            "runtime_detail": f"Load failed: {type(exc).__name__}: {exc}",
            "checks": [],
            "error": f"Import error: {type(exc).__name__}: {exc}",
        }
    if violations:
        return {
            "runtime_clean": False,
            "runtime_detail": "; ".join(violations),
            "checks": [],
            "error": f"Anti-cheat violation: {violations[0]}",
        }

    compile_pattern = mod.compile_pattern
    cases = [
        ("redos_01_nested_plus_mismatch", r"(a+)+b", "a" * 80 + "c", None, None),
        ("redos_02_alt_optional_mismatch", r"(a|a?)+b", "a" * 60 + "c", None, None),
        ("redos_03_triple_nested_plus_mismatch", r"((a+)+)+b", "a" * 60 + "c", None, None),
        ("redos_04_alt_aa_mismatch", r"(a|aa)+b", "a" * 80 + "c", None, None),
        ("redos_05_nested_plus_positive_match", r"(a+)+b", "a" * 80 + "b", (0, 81), ("a" * 80,)),
    ]

    checks: list[dict[str, Any]] = []
    total_elapsed = 0.0
    all_correct = True

    for name, pat, text, exp_span, exp_groups in cases:
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                t0 = time.perf_counter()
                cp = compile_pattern(pat)
                m_full = cp.fullmatch(text)
                m_search = cp.search(text)
                elapsed = time.perf_counter() - t0
            total_elapsed += elapsed
            exp_g0 = None if exp_span is None else text
            _assert_match(m_full, exp_span, exp_g0, exp_groups, f"{name} fullmatch")
            _assert_match(m_search, exp_span, exp_g0, exp_groups, f"{name} search")
            if elapsed >= REDOS_SINGLE_LIMIT_S:
                all_correct = False
                checks.append({
                    "name": name,
                    "passed": False,
                    "group": "fail_to_pass",
                    "detail": f"Matched correctly but too slow: {elapsed:.4f}s >= {REDOS_SINGLE_LIMIT_S:.2f}s",
                })
            else:
                checks.append({
                    "name": name,
                    "passed": True,
                    "group": "fail_to_pass",
                    "detail": f"ok ({elapsed * 1000:.2f}ms < {REDOS_SINGLE_LIMIT_S * 1000:.0f}ms)",
                })
        except Exception as exc:
            all_correct = False
            checks.append({
                "name": name,
                "passed": False,
                "group": "fail_to_pass",
                "detail": f"{type(exc).__name__}: {exc}",
            })

    total_ok = all_correct and (total_elapsed < REDOS_TOTAL_LIMIT_S)
    checks.append({
        "name": "redos_06_total_suite_budget",
        "passed": total_ok,
        "group": "fail_to_pass",
        "detail": (
            f"ok (total={total_elapsed * 1000:.2f}ms < {REDOS_TOTAL_LIMIT_S * 1000:.0f}ms)"
            if total_ok
            else f"failed (all_correct={all_correct}, total={total_elapsed:.4f}s, limit={REDOS_TOTAL_LIMIT_S:.2f}s)"
        ),
    })

    return {
        "runtime_clean": len(violations) == 0,
        "runtime_detail": "ok" if not violations else "; ".join(violations),
        "checks": checks,
        "error": None if not violations else f"Anti-cheat violation: {violations[0]}",
    }


def _invoke_worker(mode: str, workspace: Path, timeout_s: float) -> dict[str, Any]:
    cmd = [sys.executable, str(Path(__file__).resolve()), "--workspace", str(workspace), "--_worker", mode]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout_s,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )
    except subprocess.TimeoutExpired:
        names = (
            [
                "redos_01_nested_plus_mismatch",
                "redos_02_alt_optional_mismatch",
                "redos_03_triple_nested_plus_mismatch",
                "redos_04_alt_aa_mismatch",
                "redos_05_nested_plus_positive_match",
                "redos_06_total_suite_budget",
            ]
            if mode == "redos"
            else [f"{mode}_timeout"]
        )
        return {
            "runtime_clean": True,
            "runtime_detail": "ok",
            "checks": [
                {
                    "name": n,
                    "passed": False,
                    "group": "fail_to_pass",
                    "detail": f"Timed out after {timeout_s:.1f}s (catastrophic backtracking / infinite loop)",
                }
                for n in names
            ],
            "error": f"Worker '{mode}' timed out after {timeout_s:.1f}s",
        }
    if proc.returncode != 0:
        err_msg = (proc.stderr or proc.stdout or f"exit code {proc.returncode}").strip()
        return {
            "runtime_clean": False,
            "runtime_detail": err_msg[-300:],
            "checks": [],
            "error": f"Worker '{mode}' failed: {err_msg[-500:]}",
        }
    try:
        return json.loads(proc.stdout)
    except Exception as exc:
        return {
            "runtime_clean": False,
            "runtime_detail": str(exc),
            "checks": [],
            "error": f"Invalid worker output for '{mode}': {exc}",
        }


def main() -> int:
    parser = argparse.ArgumentParser(description=f"Verify {TASK_ID}")
    parser.add_argument("--workspace", required=True, help="Path to workspace directory")
    parser.add_argument("--_worker", choices=["functional", "redos"], default=None, help=argparse.SUPPRESS)
    args = parser.parse_args()

    workspace = Path(args.workspace).resolve()

    if args._worker == "functional":
        print(json.dumps(_run_functional_worker(workspace)))
        return 0
    if args._worker == "redos":
        print(json.dumps(_run_redos_worker(workspace)))
        return 0

    checks: list[dict[str, Any]] = []
    errors: list[str] = []

    ast_ok, ast_detail = _check_ast_anti_cheat(workspace)
    checks.append({
        "name": "anti_cheat_ast",
        "passed": ast_ok,
        "group": "pass_to_pass",
        "detail": ast_detail,
    })

    if not ast_ok:
        output = {
            "task_id": TASK_ID,
            "passed": False,
            "score": 0.0,
            "fail_to_pass": {"passed": 0, "total": 0},
            "pass_to_pass": {"passed": 0, "total": 1},
            "checks": checks,
            "error": f"Anti-cheat AST check failed: {ast_detail}",
        }
        print(json.dumps(output))
        return 1

    func_res = _invoke_worker("functional", workspace, timeout_s=15.0)
    redos_res = _invoke_worker("redos", workspace, timeout_s=3.5)

    runtime_ok = bool(func_res.get("runtime_clean", False)) and bool(redos_res.get("runtime_clean", False))
    runtime_detail = "ok"
    if not runtime_ok:
        parts = []
        if not func_res.get("runtime_clean", False):
            parts.append(str(func_res.get("runtime_detail", "functional guard failed")))
        if not redos_res.get("runtime_clean", False):
            parts.append(str(redos_res.get("runtime_detail", "redos guard failed")))
        runtime_detail = "; ".join(parts)

    checks.append({
        "name": "anti_cheat_runtime",
        "passed": runtime_ok,
        "group": "pass_to_pass",
        "detail": runtime_detail,
    })

    checks.extend(func_res.get("checks", []))
    checks.extend(redos_res.get("checks", []))
    if func_res.get("error"):
        errors.append(func_res["error"])
    if redos_res.get("error"):
        errors.append(redos_res["error"])

    f2p = [c for c in checks if c["group"] == "fail_to_pass"]
    p2p = [c for c in checks if c["group"] == "pass_to_pass"]
    f2p_passed = sum(1 for c in f2p if c["passed"])
    p2p_passed = sum(1 for c in p2p if c["passed"])
    error_str = "; ".join(errors) if errors else None
    p2p_all_ok = (len(p2p) > 0) and (p2p_passed == len(p2p))

    if not p2p_all_ok:
        score = 0.0
        passed = False
    else:
        score = round(f2p_passed / len(f2p), 4) if f2p else 0.0
        passed = (error_str is None) and (len(f2p) > 0) and (f2p_passed == len(f2p))

    output = {
        "task_id": TASK_ID,
        "passed": passed,
        "score": score,
        "fail_to_pass": {"passed": f2p_passed, "total": len(f2p)},
        "pass_to_pass": {"passed": p2p_passed, "total": len(p2p)},
        "checks": checks,
        "error": error_str,
    }
    print(json.dumps(output))
    return 0 if passed else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        fallback = {
            "task_id": TASK_ID,
            "passed": False,
            "score": 0.0,
            "fail_to_pass": {"passed": 0, "total": 0},
            "pass_to_pass": {"passed": 0, "total": 0},
            "checks": [],
            "error": f"Verifier crash: {type(exc).__name__}: {exc}\n{traceback.format_exc()[-400:]}",
        }
        print(json.dumps(fallback))
        sys.exit(1)

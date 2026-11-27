"""Windows-native process-tree RSS, Job Object peak memory & CPU monitor (pure stdlib ctypes).

Upgraded v4 instrumentation:
  - Wraps spawned processes in a Win32 Job Object (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`)
    for guaranteed zero-orphan cleanup, kernel-exact `PeakJobMemoryUsed` (zero polling
    blind spots), and kernel-exact cumulative User+Kernel CPU time across all live AND
    short-lived exited descendants (`JobObjectBasicAccountingInformation`).
  - Polls the live descendant tree every 50 ms via Toolhelp32 + `GetProcessMemoryInfo`
    to separate `harness_rss_mb` (harness + its own runtime/language-server/daemon) from
    `test_child_rss_mb` (agent-spawned compilers/test runners like python/node/cargo/git).
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes
import os
import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Dict, List, Optional, Set, Tuple

# Win32 constants
TH32CS_SNAPPROCESS = 0x00000002
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
PROCESS_SET_QUOTA = 0x0100
PROCESS_TERMINATE = 0x0001
PROCESS_VM_READ = 0x0010
INVALID_HANDLE_VALUE = wintypes.HANDLE(-1).value

JobObjectBasicAccountingInformation = 1
JobObjectExtendedLimitInformation = 9
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000

# Child executables spawned by agent tool calls (separated from harness-own RSS)
TEST_CHILD_EXES = frozenset({
    "python.exe", "python3.exe", "py.exe",
    "pytest.exe", "unittest.exe",
    "cargo.exe", "rustc.exe", "rustdoc.exe", "clippy-driver.exe", "link.exe", "lld-link.exe",
    "git.exe", "sh.exe", "bash.exe", "cmd.exe", "powershell.exe", "pwsh.exe",
    "findstr.exe", "grep.exe", "sed.exe", "awk.exe", "diff.exe", "tar.exe",
    "npm.exe", "tsc.exe", "vitest.exe", "sqlite3.exe", "gcc.exe", "cl.exe",
})


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.c_size_t),
        ("th32ModuleID", wintypes.DWORD),
        ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD),
        ("pcPriClassBase", wintypes.LONG),
        ("dwFlags", wintypes.DWORD),
        ("szExeFile", wintypes.WCHAR * 260),
    ]


class PROCESS_MEMORY_COUNTERS_EX(ctypes.Structure):
    _fields_ = [
        ("cb", wintypes.DWORD),
        ("PageFaultCount", wintypes.DWORD),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
        ("PrivateUsage", ctypes.c_size_t),
    ]


class FILETIME(ctypes.Structure):
    _fields_ = [
        ("dwLowDateTime", wintypes.DWORD),
        ("dwHighDateTime", wintypes.DWORD),
    ]


class JOBOBJECT_BASIC_ACCOUNTING_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("TotalUserTime", ctypes.c_int64),
        ("TotalKernelTime", ctypes.c_int64),
        ("ThisPeriodTotalUserTime", ctypes.c_int64),
        ("ThisPeriodTotalKernelTime", ctypes.c_int64),
        ("TotalPageFaultCount", wintypes.DWORD),
        ("TotalProcesses", wintypes.DWORD),
        ("ActiveProcesses", wintypes.DWORD),
        ("TotalTerminatedProcesses", wintypes.DWORD),
    ]


class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64),
        ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_uint64),
        ("WriteOperationCount", ctypes.c_uint64),
        ("OtherOperationCount", ctypes.c_uint64),
        ("ReadTransferCount", ctypes.c_uint64),
        ("WriteTransferCount", ctypes.c_uint64),
        ("OtherTransferCount", ctypes.c_uint64),
    ]


class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ("IoInfo", IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


_kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
_psapi = ctypes.WinDLL("psapi", use_last_error=True)

_kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
_kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
_kernel32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
_kernel32.Process32FirstW.restype = wintypes.BOOL
_kernel32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
_kernel32.Process32NextW.restype = wintypes.BOOL
_kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
_kernel32.OpenProcess.restype = wintypes.HANDLE
_kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
_kernel32.CloseHandle.restype = wintypes.BOOL
_kernel32.GetProcessTimes.argtypes = [
    wintypes.HANDLE,
    ctypes.POINTER(FILETIME),
    ctypes.POINTER(FILETIME),
    ctypes.POINTER(FILETIME),
    ctypes.POINTER(FILETIME),
]
_kernel32.GetProcessTimes.restype = wintypes.BOOL

_kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
_kernel32.CreateJobObjectW.restype = wintypes.HANDLE
_kernel32.SetInformationJobObject.argtypes = [
    wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD
]
_kernel32.SetInformationJobObject.restype = wintypes.BOOL
_kernel32.QueryInformationJobObject.argtypes = [
    wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)
]
_kernel32.QueryInformationJobObject.restype = wintypes.BOOL
_kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
_kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
_kernel32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
_kernel32.TerminateJobObject.restype = wintypes.BOOL

_psapi.GetProcessMemoryInfo.argtypes = [
    wintypes.HANDLE,
    ctypes.POINTER(PROCESS_MEMORY_COUNTERS_EX),
    wintypes.DWORD,
]
_psapi.GetProcessMemoryInfo.restype = wintypes.BOOL


def _filetime_to_seconds(ft: FILETIME) -> float:
    ticks = (ft.dwHighDateTime << 32) | ft.dwLowDateTime
    return ticks * 1e-7


class Win32JobObject:
    """Win32 Job Object wrapper providing kernel-exact peak memory, CPU accounting & zero-orphan kill."""

    def __init__(self) -> None:
        self.handle = _kernel32.CreateJobObjectW(None, None)
        self.attached = False
        if self.handle:
            info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            _kernel32.SetInformationJobObject(
                self.handle,
                JobObjectExtendedLimitInformation,
                ctypes.byref(info),
                ctypes.sizeof(info),
            )

    def assign_pid(self, pid: int) -> bool:
        if not self.handle:
            return False
        ph = _kernel32.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, False, pid)
        if not ph:
            return False
        try:
            ok = bool(_kernel32.AssignProcessToJobObject(self.handle, ph))
            if ok:
                self.attached = True
            return ok
        finally:
            _kernel32.CloseHandle(ph)

    def query_stats(self) -> Dict[str, float]:
        out: Dict[str, float] = {}
        if not self.handle or not self.attached:
            return out
        ext = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        ret = wintypes.DWORD(0)
        if _kernel32.QueryInformationJobObject(
            self.handle, JobObjectExtendedLimitInformation, ctypes.byref(ext), ctypes.sizeof(ext), ctypes.byref(ret)
        ):
            out["peak_job_memory_mb"] = ext.PeakJobMemoryUsed / (1024 * 1024)
            out["peak_process_memory_mb"] = ext.PeakProcessMemoryUsed / (1024 * 1024)
        acct = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION()
        if _kernel32.QueryInformationJobObject(
            self.handle, JobObjectBasicAccountingInformation, ctypes.byref(acct), ctypes.sizeof(acct), ctypes.byref(ret)
        ):
            out["job_cpu_user_s"] = acct.TotalUserTime * 1e-7
            out["job_cpu_kernel_s"] = acct.TotalKernelTime * 1e-7
            out["job_cpu_total_s"] = (acct.TotalUserTime + acct.TotalKernelTime) * 1e-7
            out["job_total_processes"] = int(acct.TotalProcesses)
            out["job_active_processes"] = int(acct.ActiveProcesses)
        return out

    def terminate_and_close(self) -> int:
        active_before_kill = 0
        if self.handle:
            if self.attached:
                st = self.query_stats()
                active_before_kill = int(st.get("job_active_processes", 0))
                _kernel32.TerminateJobObject(self.handle, 1)
            _kernel32.CloseHandle(self.handle)
            self.handle = None
        return active_before_kill


def _snapshot_processes() -> Tuple[Dict[int, List[int]], Dict[int, str]]:
    """Return (parent_pid -> [child_pids], pid -> exe_lower) for all live processes."""
    snap = _kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snap == INVALID_HANDLE_VALUE:
        return {}, {}
    children: Dict[int, List[int]] = {}
    names: Dict[int, str] = {}
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        ok = _kernel32.Process32FirstW(snap, ctypes.byref(entry))
        while ok:
            pid = int(entry.th32ProcessID)
            ppid = int(entry.th32ParentProcessID)
            if pid != 0:
                children.setdefault(ppid, []).append(pid)
                names[pid] = str(entry.szExeFile).lower()
            ok = _kernel32.Process32NextW(snap, ctypes.byref(entry))
    finally:
        _kernel32.CloseHandle(snap)
    return children, names


def _process_creation_ticks(pid: int) -> Optional[int]:
    handle = _kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return None
    try:
        ct, et, kt, ut = FILETIME(), FILETIME(), FILETIME(), FILETIME()
        if _kernel32.GetProcessTimes(
            handle, ctypes.byref(ct), ctypes.byref(et), ctypes.byref(kt), ctypes.byref(ut)
        ):
            return (int(ct.dwHighDateTime) << 32) | int(ct.dwLowDateTime)
        return None
    finally:
        _kernel32.CloseHandle(handle)


def get_process_tree_pids(root_pid: int) -> Tuple[Set[int], Dict[int, str]]:
    children, names = _snapshot_processes()
    root_ct = _process_creation_ticks(root_pid)
    ct_cache: Dict[int, Optional[int]] = {root_pid: root_ct}
    found: Set[int] = set()
    stack = [root_pid]
    while stack:
        pid = stack.pop()
        if pid in found:
            continue
        found.add(pid)
        if pid not in ct_cache:
            ct_cache[pid] = _process_creation_ticks(pid)
        min_ct = ct_cache[pid] if ct_cache[pid] is not None else root_ct
        for child in children.get(pid, ()):
            if child in found:
                continue
            if min_ct is not None:
                if child not in ct_cache:
                    ct_cache[child] = _process_creation_ticks(child)
                child_ct = ct_cache[child]
                # Guard against Windows Toolhelp32 th32ParentProcessID reuse by exited ancestors.
                if child_ct is not None and child_ct < min_ct:
                    continue
            stack.append(child)
    return found, names


def query_pid_stats(pid: int) -> Optional[Tuple[int, int, float]]:
    handle = _kernel32.OpenProcess(
        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, False, pid
    )
    if not handle:
        handle = _kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return None
    try:
        pmc = PROCESS_MEMORY_COUNTERS_EX()
        pmc.cb = ctypes.sizeof(PROCESS_MEMORY_COUNTERS_EX)
        rss = 0
        priv = 0
        if _psapi.GetProcessMemoryInfo(handle, ctypes.byref(pmc), pmc.cb):
            rss = int(pmc.WorkingSetSize)
            priv = int(pmc.PrivateUsage)

        ct, et, kt, ut = FILETIME(), FILETIME(), FILETIME(), FILETIME()
        cpu_s = 0.0
        if _kernel32.GetProcessTimes(
            handle, ctypes.byref(ct), ctypes.byref(et), ctypes.byref(kt), ctypes.byref(ut)
        ):
            cpu_s = _filetime_to_seconds(kt) + _filetime_to_seconds(ut)
        return (rss, priv, cpu_s)
    finally:
        _kernel32.CloseHandle(handle)


def terminate_process_tree(pid: int) -> None:
    try:
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(pid)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=10,
            check=False,
        )
    except Exception:
        pass


@dataclass
class ResourceSummary:
    sample_count: int = 0
    peak_rss_mb: float = 0.0
    mean_rss_mb: float = 0.0
    peak_harness_rss_mb: float = 0.0
    peak_test_child_rss_mb: float = 0.0
    peak_private_mb: float = 0.0
    mean_private_mb: float = 0.0
    peak_job_memory_mb: float = 0.0
    total_cpu_time_s: float = 0.0
    job_cpu_user_s: float = 0.0
    job_cpu_kernel_s: float = 0.0
    mean_cpu_pct: float = 0.0
    max_process_count: int = 0
    total_processes_spawned: int = 0
    job_attached: bool = False
    orphan_processes_killed: int = 0
    poll_interval_s: float = 0.05

    def to_dict(self) -> dict:
        return {
            "sample_count": self.sample_count,
            "peak_rss_mb": round(self.peak_rss_mb, 2),
            "mean_rss_mb": round(self.mean_rss_mb, 2),
            "peak_harness_rss_mb": round(self.peak_harness_rss_mb, 2),
            "peak_test_child_rss_mb": round(self.peak_test_child_rss_mb, 2),
            "peak_private_mb": round(self.peak_private_mb, 2),
            "mean_private_mb": round(self.mean_private_mb, 2),
            "peak_job_memory_mb": round(self.peak_job_memory_mb, 2),
            "total_cpu_time_s": round(self.total_cpu_time_s, 3),
            "job_cpu_user_s": round(self.job_cpu_user_s, 3),
            "job_cpu_kernel_s": round(self.job_cpu_kernel_s, 3),
            "mean_cpu_pct": round(self.mean_cpu_pct, 2),
            "max_process_count": self.max_process_count,
            "total_processes_spawned": self.total_processes_spawned,
            "job_attached": self.job_attached,
            "orphan_processes_killed": self.orphan_processes_killed,
            "poll_interval_s": self.poll_interval_s,
        }


class ProcessTreeMonitor:
    """Win32 Job Object + 50 ms Toolhelp32 sampler for exact harness vs child RSS & CPU."""

    def __init__(
        self,
        root_pid: int,
        poll_interval_s: float = 0.05,
        harness_root_exe: Optional[str] = None,
    ) -> None:
        self.root_pid = root_pid
        self.poll_interval_s = poll_interval_s
        self.harness_root_exe = (harness_root_exe or "").lower()
        self.job = Win32JobObject()
        self.job.assign_pid(root_pid)
        self._stop_event = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._rss_samples_mb: List[float] = []
        self._harness_rss_samples_mb: List[float] = []
        self._child_rss_samples_mb: List[float] = []
        self._priv_samples_mb: List[float] = []
        self._max_procs = 0
        self._max_cpu_per_pid: Dict[int, float] = {}
        self._start_wall = 0.0
        self._end_wall = 0.0

    def start(self) -> None:
        self._start_wall = time.perf_counter()
        self._thread.start()

    def _is_test_child(self, pid: int, exe_name: str) -> bool:
        if pid == self.root_pid:
            return False
        if self.harness_root_exe and exe_name == self.harness_root_exe:
            return False
        return exe_name in TEST_CHILD_EXES

    def _sample_once(self) -> None:
        pids, names = get_process_tree_pids(self.root_pid)
        total_rss = 0
        harness_rss = 0
        child_rss = 0
        total_priv = 0
        alive = 0
        for pid in pids:
            st = query_pid_stats(pid)
            if st is None:
                continue
            rss, priv, cpu_s = st
            alive += 1
            total_rss += rss
            total_priv += priv
            exe_name = names.get(pid, "")
            if self._is_test_child(pid, exe_name):
                child_rss += rss
            else:
                harness_rss += rss
            prev = self._max_cpu_per_pid.get(pid, 0.0)
            if cpu_s > prev:
                self._max_cpu_per_pid[pid] = cpu_s
        if alive > 0:
            self._rss_samples_mb.append(total_rss / (1024 * 1024))
            self._harness_rss_samples_mb.append(harness_rss / (1024 * 1024))
            self._child_rss_samples_mb.append(child_rss / (1024 * 1024))
            self._priv_samples_mb.append(total_priv / (1024 * 1024))
            if alive > self._max_procs:
                self._max_procs = alive

    def _run(self) -> None:
        while not self._stop_event.is_set():
            try:
                self._sample_once()
            except Exception:
                pass
            self._stop_event.wait(self.poll_interval_s)

    def stop(self) -> ResourceSummary:
        self._stop_event.set()
        self._thread.join(timeout=2.0)
        self._end_wall = time.perf_counter()
        wall = max(self._end_wall - self._start_wall, 1e-6)
        job_stats = self.job.query_stats()
        orphans = self.job.terminate_and_close()

        n = len(self._rss_samples_mb)
        polled_cpu = sum(self._max_cpu_per_pid.values())
        total_cpu = max(polled_cpu, float(job_stats.get("job_cpu_total_s", 0.0)))
        mean_cpu_pct = (total_cpu / wall) * 100.0
        peak_rss = max(self._rss_samples_mb) if n else 0.0
        peak_priv = max(self._priv_samples_mb) if n else 0.0
        peak_job = float(job_stats.get("peak_job_memory_mb", 0.0)) or peak_priv

        return ResourceSummary(
            sample_count=n,
            peak_rss_mb=peak_rss,
            mean_rss_mb=(sum(self._rss_samples_mb) / n) if n else 0.0,
            peak_harness_rss_mb=max(self._harness_rss_samples_mb) if n else 0.0,
            peak_test_child_rss_mb=max(self._child_rss_samples_mb) if n else 0.0,
            peak_private_mb=peak_priv,
            mean_private_mb=(sum(self._priv_samples_mb) / n) if n else 0.0,
            peak_job_memory_mb=peak_job,
            total_cpu_time_s=total_cpu,
            job_cpu_user_s=float(job_stats.get("job_cpu_user_s", 0.0)),
            job_cpu_kernel_s=float(job_stats.get("job_cpu_kernel_s", 0.0)),
            mean_cpu_pct=mean_cpu_pct,
            max_process_count=self._max_procs,
            total_processes_spawned=int(job_stats.get("job_total_processes", self._max_procs)),
            job_attached=self.job.attached,
            orphan_processes_killed=orphans,
            poll_interval_s=self.poll_interval_s,
        )

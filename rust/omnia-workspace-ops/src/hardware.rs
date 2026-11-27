//! Zero-subprocess Windows hardware profile detection and local auxiliary VRAM guard.
//!
//! Uses `GlobalMemoryStatusEx` for RAM (`>= 14.5 GiB` threshold so Optimus laptops with
//! ~15.8 GiB usable physical RAM classify as `Standard16Gb`) and reads the 64-bit
//! `HardwareInformation.qwMemorySize` registry value directly via `advapi32.dll`
//! (`< 0.1 ms`, zero subprocesses, immune to the 32-bit `MemorySize` 4 GiB cap).

use serde::{Deserialize, Serialize};

/// Reserved Windows DWM and Studio/desktop UI VRAM headroom in MiB.
pub const DEFAULT_DWM_UI_HEADROOM_MB: u64 = 1024;
/// Hard ceiling for local auxiliary GGUF models on 4 GiB discrete GPU laptops (e.g., AN515-55).
pub const DEFAULT_MAX_AUX_MODEL_VRAM_MB: u64 = 3072;

const GIB: u64 = 1024 * 1024 * 1024;
const MIB: u64 = 1024 * 1024;
/// 14.5 GiB threshold for Optimus laptops whose iGPU reserves part of 16 GiB RAM.
const STANDARD_16GB_MIN_BYTES: u64 = (14 * GIB) + (512 * MIB);
/// 28 GiB threshold for 32 GiB workstations with reserved hardware holes.
const WORKSTATION_32GB_MIN_BYTES: u64 = 28 * GIB;

/// Adaptive hardware resource tier governing concurrency, caches, and repo-map sizing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HardwareTier {
    /// <= 14.5 GiB usable RAM (8 GiB laptops / constrained containers).
    Compact8Gb,
    /// 14.5 GiB .. 28 GiB usable RAM (16 GiB laptops such as Nitro 5 AN515-55).
    Standard16Gb,
    /// >= 28 GiB usable RAM (32 GiB+ workstations).
    Workstation32Gb,
}

impl HardwareTier {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Compact8Gb => "compact_8gb",
            Self::Standard16Gb => "standard_16gb",
            Self::Workstation32Gb => "workstation_32gb",
        }
    }

    /// Maximum concurrent read-only tool executions in a single turn.
    #[must_use]
    pub const fn max_concurrent_tools(self) -> usize {
        match self {
            Self::Compact8Gb => 4,
            Self::Standard16Gb => 6,
            Self::Workstation32Gb => 12,
        }
    }

    /// Maximum concurrent subagent / swarm workers launched by a local orchestrator.
    #[must_use]
    pub const fn max_parallel_subagents(self) -> usize {
        match self {
            Self::Compact8Gb => 2,
            Self::Standard16Gb => 3,
            Self::Workstation32Gb => 6,
        }
    }

    /// Recommended SQLite page cache size in KiB (`PRAGMA cache_size = -N`).
    #[must_use]
    pub const fn sqlite_cache_kib(self) -> i32 {
        match self {
            Self::Compact8Gb => 4_096,
            Self::Standard16Gb => 8_192,
            Self::Workstation32Gb => 32_768,
        }
    }

    /// Maximum indexed source files retained in the hot repo-map memory window.
    #[must_use]
    pub const fn max_repo_map_files(self) -> usize {
        match self {
            Self::Compact8Gb => 1_000,
            Self::Standard16Gb => 2_500,
            Self::Workstation32Gb => 10_000,
        }
    }

    /// Whether compact memory/prompt caps should be preferred.
    #[must_use]
    pub const fn compact_mode(self) -> bool {
        matches!(self, Self::Compact8Gb)
    }
}

/// Measured host hardware profile for adaptive runtime and local-model admission decisions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HardwareProfile {
    pub total_ram_bytes: u64,
    pub available_ram_bytes: u64,
    pub total_vram_bytes: u64,
    pub total_vram_mb: u64,
    pub logical_cpus: usize,
    pub tier: HardwareTier,
    pub dwm_ui_headroom_mb: u64,
    pub max_aux_model_vram_mb: u64,
    pub usable_aux_vram_mb: u64,
}

impl HardwareProfile {
    /// Builds a deterministic profile from measured RAM/VRAM/CPU values.
    #[must_use]
    pub fn from_metrics(
        total_ram_bytes: u64,
        available_ram_bytes: u64,
        total_vram_bytes: u64,
        logical_cpus: usize,
    ) -> Self {
        let tier = classify_hardware_tier(total_ram_bytes);
        let total_vram_mb = total_vram_bytes / MIB;
        let dwm_ui_headroom_mb = DEFAULT_DWM_UI_HEADROOM_MB;
        let usable_after_dwm = total_vram_mb.saturating_sub(dwm_ui_headroom_mb);
        let usable_aux_vram_mb = usable_after_dwm.min(DEFAULT_MAX_AUX_MODEL_VRAM_MB);
        Self {
            total_ram_bytes,
            available_ram_bytes,
            total_vram_bytes,
            total_vram_mb,
            logical_cpus: logical_cpus.max(1),
            tier,
            dwm_ui_headroom_mb,
            max_aux_model_vram_mb: DEFAULT_MAX_AUX_MODEL_VRAM_MB,
            usable_aux_vram_mb,
        }
    }
}

/// Result of checking whether a local auxiliary GGUF model fits safely in discrete VRAM.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalAuxVramCheck {
    pub allowed: bool,
    pub model_id: String,
    pub estimated_vram_mb: Option<u64>,
    pub total_vram_mb: u64,
    pub dwm_ui_headroom_mb: u64,
    pub usable_aux_vram_mb: u64,
    pub reason: String,
}

/// Classifies host physical RAM into a [`HardwareTier`].
#[must_use]
pub const fn classify_hardware_tier(total_ram_bytes: u64) -> HardwareTier {
    if total_ram_bytes >= WORKSTATION_32GB_MIN_BYTES {
        HardwareTier::Workstation32Gb
    } else if total_ram_bytes >= STANDARD_16GB_MIN_BYTES {
        HardwareTier::Standard16Gb
    } else {
        HardwareTier::Compact8Gb
    }
}

/// Detects the current machine's RAM, discrete GPU VRAM, and CPU core count without spawning
/// any subprocesses.
#[must_use]
pub fn detect_hardware_profile() -> HardwareProfile {
    let logical_cpus = std::thread::available_parallelism()
        .map(std::num::NonZeroUsize::get)
        .unwrap_or(4);
    let (total_ram_bytes, available_ram_bytes) = detect_ram_bytes();
    let total_vram_bytes = detect_vram_bytes();
    HardwareProfile::from_metrics(
        total_ram_bytes,
        available_ram_bytes,
        total_vram_bytes,
        logical_cpus,
    )
}

/// Evaluates whether a local auxiliary model fits safely within `profile`'s discrete VRAM budget
/// after reserving [`DEFAULT_DWM_UI_HEADROOM_MB`] (1024 MiB) for Windows DWM + desktop UI and
/// clamping auxiliary models to [`DEFAULT_MAX_AUX_MODEL_VRAM_MB`] (3072 MiB).
#[must_use]
pub fn validate_local_aux_model_vram(
    profile: &HardwareProfile,
    model_id: &str,
    estimated_vram_mb: Option<u64>,
) -> LocalAuxVramCheck {
    let resolved_mb = estimated_vram_mb.or_else(|| infer_conservative_model_vram_mb(model_id));
    let Some(req_mb) = resolved_mb else {
        return LocalAuxVramCheck {
            allowed: false,
            model_id: model_id.to_string(),
            estimated_vram_mb: None,
            total_vram_mb: profile.total_vram_mb,
            dwm_ui_headroom_mb: profile.dwm_ui_headroom_mb,
            usable_aux_vram_mb: profile.usable_aux_vram_mb,
            reason: format!(
                "Cannot infer VRAM footprint for '{model_id}'; explicit estimated_vram_mb required."
            ),
        };
    };

    if profile.total_vram_mb <= profile.dwm_ui_headroom_mb {
        return LocalAuxVramCheck {
            allowed: false,
            model_id: model_id.to_string(),
            estimated_vram_mb: Some(req_mb),
            total_vram_mb: profile.total_vram_mb,
            dwm_ui_headroom_mb: profile.dwm_ui_headroom_mb,
            usable_aux_vram_mb: 0,
            reason: format!(
                "Total GPU VRAM ({} MiB) does not exceed DWM/UI reserve ({} MiB).",
                profile.total_vram_mb, profile.dwm_ui_headroom_mb
            ),
        };
    }

    if req_mb > profile.usable_aux_vram_mb {
        return LocalAuxVramCheck {
            allowed: false,
            model_id: model_id.to_string(),
            estimated_vram_mb: Some(req_mb),
            total_vram_mb: profile.total_vram_mb,
            dwm_ui_headroom_mb: profile.dwm_ui_headroom_mb,
            usable_aux_vram_mb: profile.usable_aux_vram_mb,
            reason: format!(
                "Model '{model_id}' requires ~{req_mb} MiB VRAM, exceeding safe auxiliary budget {} MiB ({} MiB total - {} MiB DWM headroom, capped at {} MiB).",
                profile.usable_aux_vram_mb,
                profile.total_vram_mb,
                profile.dwm_ui_headroom_mb,
                profile.max_aux_model_vram_mb
            ),
        };
    }

    LocalAuxVramCheck {
        allowed: true,
        model_id: model_id.to_string(),
        estimated_vram_mb: Some(req_mb),
        total_vram_mb: profile.total_vram_mb,
        dwm_ui_headroom_mb: profile.dwm_ui_headroom_mb,
        usable_aux_vram_mb: profile.usable_aux_vram_mb,
        reason: format!(
            "Model '{model_id}' (~{req_mb} MiB) fits within {} MiB safe auxiliary VRAM budget.",
            profile.usable_aux_vram_mb
        ),
    }
}

fn infer_conservative_model_vram_mb(model_id: &str) -> Option<u64> {
    let lower = model_id.to_ascii_lowercase();
    if lower.contains("70b") || lower.contains("72b") {
        Some(44_000)
    } else if lower.contains("32b") || lower.contains("34b") {
        Some(20_000)
    } else if lower.contains("14b") || lower.contains("13b") {
        Some(9_500)
    } else if lower.contains("8b") || lower.contains("9b") {
        Some(5_800)
    } else if lower.contains("7b") {
        Some(5_200)
    } else if lower.contains("4b") {
        Some(3_400)
    } else if lower.contains("3b") {
        Some(2_400)
    } else if lower.contains("1.5b") || lower.contains("1.7b") || lower.contains("2b") {
        Some(1_600)
    } else if lower.contains("0.5b") || lower.contains("0.6b") || lower.contains("1b") {
        Some(900)
    } else {
        None
    }
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn detect_ram_bytes() -> (u64, u64) {
    use core::mem::{size_of, zeroed};
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

    // SAFETY: `status` is properly zero-initialized and `dwLength` is set to the exact struct size.
    unsafe {
        let mut status: MEMORYSTATUSEX = zeroed();
        status.dwLength = u32::try_from(size_of::<MEMORYSTATUSEX>()).unwrap_or(0);
        if GlobalMemoryStatusEx(&mut status) != 0 {
            (status.ullTotalPhys, status.ullAvailPhys)
        } else {
            (16 * GIB, 8 * GIB)
        }
    }
}

#[cfg(not(windows))]
fn detect_ram_bytes() -> (u64, u64) {
    if let Ok(meminfo) = std::fs::read_to_string("/proc/meminfo") {
        let mut total_kib = 0u64;
        let mut avail_kib = 0u64;
        for line in meminfo.lines() {
            if let Some(rest) = line.strip_prefix("MemTotal:") {
                if let Some(v) = rest.split_whitespace().next().and_then(|s| s.parse().ok()) {
                    total_kib = v;
                }
            } else if let Some(rest) = line.strip_prefix("MemAvailable:") {
                if let Some(v) = rest.split_whitespace().next().and_then(|s| s.parse().ok()) {
                    avail_kib = v;
                }
            }
        }
        if total_kib > 0 {
            return (total_kib * 1024, avail_kib * 1024);
        }
    }
    (16 * GIB, 8 * GIB)
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn detect_vram_bytes() -> u64 {
    use core::ffi::c_void;

    type Hkey = *mut c_void;
    const HKEY_LOCAL_MACHINE: Hkey = 0x8000_0002_usize as Hkey;
    const KEY_READ: u32 = 0x20019;
    const ERROR_SUCCESS: u32 = 0;
    const REG_BINARY: u32 = 3;
    const REG_DWORD: u32 = 4;
    const REG_QWORD: u32 = 11;

    #[link(name = "advapi32")]
    extern "system" {
        fn RegOpenKeyExW(
            hkey: Hkey,
            sub_key: *const u16,
            options: u32,
            sam_desired: u32,
            result: *mut Hkey,
        ) -> u32;
        fn RegQueryValueExW(
            hkey: Hkey,
            value_name: *const u16,
            reserved: *mut u32,
            reg_type: *mut u32,
            data: *mut u8,
            data_len: *mut u32,
        ) -> u32;
        fn RegCloseKey(hkey: Hkey) -> u32;
    }

    fn encode_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    let value_name = encode_wide("HardwareInformation.qwMemorySize");
    let mut max_vram: u64 = 0;

    for idx in 0..8u32 {
        let subkey = encode_wide(&format!(
            "SYSTEM\\ControlSet001\\Control\\Class\\{{4d36e968-e325-11ce-bfc1-08002be10318}}\\{idx:04}"
        ));
        let mut hkey: Hkey = std::ptr::null_mut();
        // SAFETY: `subkey` is NUL-terminated UTF-16 and `hkey` is a valid stack pointer.
        let open_rc =
            unsafe { RegOpenKeyExW(HKEY_LOCAL_MACHINE, subkey.as_ptr(), 0, KEY_READ, &mut hkey) };
        if open_rc != ERROR_SUCCESS || hkey.is_null() {
            continue;
        }

        let mut reg_type: u32 = 0;
        let mut buf = [0u8; 8];
        let mut buf_len: u32 = 8;
        // SAFETY: `hkey` is an open registry key handle, `value_name` is NUL-terminated UTF-16,
        // and `buf` has length `buf_len` (8 bytes).
        let query_rc = unsafe {
            RegQueryValueExW(
                hkey,
                value_name.as_ptr(),
                std::ptr::null_mut(),
                &mut reg_type,
                buf.as_mut_ptr(),
                &mut buf_len,
            )
        };
        // SAFETY: `hkey` was successfully opened by `RegOpenKeyExW`.
        unsafe {
            let _ = RegCloseKey(hkey);
        }

        if query_rc == ERROR_SUCCESS {
            let parsed = match (reg_type, buf_len) {
                (REG_QWORD | REG_BINARY, 8) => u64::from_le_bytes(buf),
                (REG_DWORD | REG_BINARY, 4) => {
                    u64::from(u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]))
                }
                _ => 0,
            };
            if parsed > max_vram {
                max_vram = parsed;
            }
        }
    }

    max_vram
}

#[cfg(not(windows))]
fn detect_vram_bytes() -> u64 {
    0
}

/// Disk capacity & utilization record for a local drive (e.g. `C:\`, `D:\`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskDriveInfo {
    pub drive: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
    pub used_bytes: u64,
    pub used_pct: f64,
}

/// Resident memory telemetry for a running `omnia*` process.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessMemoryInfo {
    pub pid: u32,
    pub name: String,
    pub rss_bytes: u64,
    pub peak_rss_bytes: u64,
}

/// Active local listening TCP port discovered via Win32 IP Helper (`GetExtendedTcpTable`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListeningPortInfo {
    pub protocol: String,
    pub bind_addr: String,
    pub port: u16,
    pub pid: u32,
    pub process_name: Option<String>,
    pub category: String,
}

/// Complete host telemetry snapshot (CPU/RAM/VRAM, Disks, `omnia-*` RSS, listening dev ports).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSystemSnapshot {
    pub hardware: HardwareProfile,
    pub cpu_load_pct: Option<f64>,
    pub disks: Vec<DiskDriveInfo>,
    pub omnia_processes: Vec<ProcessMemoryInfo>,
    pub total_omnia_rss_bytes: u64,
    pub listening_ports: Vec<ListeningPortInfo>,
}

/// Collects a real-time host system snapshot (zero subprocesses, dynamic `iphlpapi.dll` load).
#[must_use]
pub fn collect_host_system_snapshot() -> HostSystemSnapshot {
    let hardware = detect_hardware_profile();
    let cpu_load_pct = detect_cpu_load_pct();
    let disks = detect_local_disks(&["C:\\", "D:\\"]);
    let (omnia_processes, pid_names) = enumerate_processes_and_omnia_rss();
    let total_omnia_rss_bytes = omnia_processes.iter().map(|p| p.rss_bytes).sum();
    let listening_ports = enumerate_listening_tcp_ports(&pid_names);
    HostSystemSnapshot {
        hardware,
        cpu_load_pct,
        disks,
        omnia_processes,
        total_omnia_rss_bytes,
        listening_ports,
    }
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn detect_cpu_load_pct() -> Option<f64> {
    use windows_sys::Win32::Foundation::FILETIME;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetSystemTimes(
            idle: *mut FILETIME,
            kernel: *mut FILETIME,
            user: *mut FILETIME,
        ) -> i32;
    }

    fn ft_u64(ft: FILETIME) -> u64 {
        (u64::from(ft.dwHighDateTime) << 32) | u64::from(ft.dwLowDateTime)
    }

    let sample = || -> Option<(u64, u64, u64)> {
        let mut idle = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let mut kernel = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let mut user = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        // SAFETY: Output pointers refer to valid stack `FILETIME` structs.
        if unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) } != 0 {
            Some((ft_u64(idle), ft_u64(kernel), ft_u64(user)))
        } else {
            None
        }
    };

    let (i0, k0, u0) = sample()?;
    std::thread::sleep(std::time::Duration::from_millis(80));
    let (i1, k1, u1) = sample()?;
    let idle_d = i1.saturating_sub(i0);
    let kernel_d = k1.saturating_sub(k0);
    let user_d = u1.saturating_sub(u0);
    let total = kernel_d.saturating_add(user_d);
    if total == 0 {
        return Some(0.0);
    }
    let busy = total.saturating_sub(idle_d);
    let pct = ((busy as f64) / (total as f64)) * 100.0;
    Some(((pct.clamp(0.0, 100.0)) * 10.0).round() / 10.0)
}

#[cfg(not(windows))]
fn detect_cpu_load_pct() -> Option<f64> {
    None
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn detect_local_disks(drives: &[&str]) -> Vec<DiskDriveInfo> {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(
            directory_name: *const u16,
            free_bytes_available: *mut u64,
            total_bytes: *mut u64,
            total_free_bytes: *mut u64,
        ) -> i32;
    }

    let mut out = Vec::new();
    for drive in drives {
        let wide: Vec<u16> = drive.encode_utf16().chain(std::iter::once(0)).collect();
        let mut avail = 0u64;
        let mut total = 0u64;
        let mut total_free = 0u64;
        // SAFETY: `wide` is NUL-terminated UTF-16 and output pointers are valid stack locals.
        let ok = unsafe {
            GetDiskFreeSpaceExW(wide.as_ptr(), &mut avail, &mut total, &mut total_free)
        };
        if ok != 0 && total > 0 {
            let used = total.saturating_sub(avail);
            let used_pct = (((used as f64) / (total as f64)) * 1000.0).round() / 10.0;
            out.push(DiskDriveInfo {
                drive: (*drive).to_string(),
                total_bytes: total,
                free_bytes: avail,
                used_bytes: used,
                used_pct,
            });
        }
    }
    out
}

#[cfg(not(windows))]
fn detect_local_disks(_drives: &[&str]) -> Vec<DiskDriveInfo> {
    Vec::new()
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn enumerate_processes_and_omnia_rss(
) -> (Vec<ProcessMemoryInfo>, std::collections::HashMap<u32, String>) {
    use core::mem::{size_of, zeroed};
    use std::collections::HashMap;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    let mut omnia = Vec::new();
    let mut names = HashMap::new();

    // SAFETY: Standard Win32 Toolhelp process enumeration.
    let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snap == INVALID_HANDLE_VALUE || snap.is_null() {
        return (omnia, names);
    }

    let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;

    if unsafe { Process32FirstW(snap, &mut entry) } != 0 {
        loop {
            let nul = entry
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..nul]);
            let pid = entry.th32ProcessID;
            let lower = name.to_ascii_lowercase();
            names.insert(pid, name.clone());

            if lower.starts_with("omnia") {
                let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
                if !h.is_null() {
                    let mut pmc: PROCESS_MEMORY_COUNTERS = unsafe { zeroed() };
                    pmc.cb = size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
                    if unsafe { GetProcessMemoryInfo(h, &mut pmc, pmc.cb) } != 0 {
                        omnia.push(ProcessMemoryInfo {
                            pid,
                            name,
                            rss_bytes: pmc.WorkingSetSize as u64,
                            peak_rss_bytes: pmc.PeakWorkingSetSize as u64,
                        });
                    }
                    unsafe {
                        let _ = CloseHandle(h);
                    }
                }
            }

            if unsafe { Process32NextW(snap, &mut entry) } == 0 {
                break;
            }
        }
    }
    unsafe {
        let _ = CloseHandle(snap);
    }
    omnia.sort_by_key(|a| std::cmp::Reverse(a.rss_bytes));
    (omnia, names)
}

#[cfg(not(windows))]
fn enumerate_processes_and_omnia_rss(
) -> (Vec<ProcessMemoryInfo>, std::collections::HashMap<u32, String>) {
    (Vec::new(), std::collections::HashMap::new())
}

fn classify_listening_port(port: u16, proc_name: Option<&str>) -> &'static str {
    let lower = proc_name.unwrap_or("").to_ascii_lowercase();
    if lower.starts_with("omnia") || matches!(port, 8787 | 8790) {
        "omnia"
    } else if matches!(port, 7890 | 7897 | 8317 | 10808 | 10809 | 2080 | 8888 | 1080) {
        "proxy"
    } else if matches!(port, 3000 | 3001 | 4173 | 5173 | 5174 | 8000 | 8080 | 9222 | 9229)
        || lower.contains("node")
        || lower.contains("bun")
        || lower.contains("python")
        || lower.contains("vite")
        || lower.contains("cargo")
    {
        "dev"
    } else {
        "system"
    }
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn enumerate_listening_tcp_ports(
    pid_names: &std::collections::HashMap<u32, String>,
) -> Vec<ListeningPortInfo> {
    use core::ffi::c_void;
    use std::collections::BTreeSet;
    use std::mem::{size_of, transmute};
    use std::net::{Ipv4Addr, Ipv6Addr};
    use windows_sys::Win32::Foundation::FreeLibrary;
    use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

    #[repr(C)]
    struct MibTcpRowOwnerPid {
        dw_state: u32,
        dw_local_addr: u32,
        dw_local_port: u32,
        dw_remote_addr: u32,
        dw_remote_port: u32,
        dw_owning_pid: u32,
    }

    #[repr(C)]
    struct MibTcp6RowOwnerPid {
        uc_local_addr: [u8; 16],
        dw_local_scope_id: u32,
        dw_local_port: u32,
        uc_remote_addr: [u8; 16],
        dw_remote_scope_id: u32,
        dw_remote_port: u32,
        dw_state: u32,
        dw_owning_pid: u32,
    }

    let wide: Vec<u16> = "iphlpapi.dll".encode_utf16().chain(std::iter::once(0)).collect();
    let hmod = unsafe { LoadLibraryW(wide.as_ptr()) };
    if hmod.is_null() {
        return Vec::new();
    }
    let sym = unsafe { GetProcAddress(hmod, c"GetExtendedTcpTable".as_ptr().cast()) };
    let Some(sym_fn) = sym else {
        unsafe {
            let _ = FreeLibrary(hmod);
        }
        return Vec::new();
    };
    type GetExtendedTcpTableFn =
        unsafe extern "system" fn(*mut c_void, *mut u32, i32, u32, u32, u32) -> u32;
    let get_table: GetExtendedTcpTableFn = unsafe { transmute(sym_fn) };

    const AF_INET: u32 = 2;
    const AF_INET6: u32 = 23;
    const TCP_TABLE_OWNER_PID_LISTENER: u32 = 3;

    let mut out = Vec::new();
    let mut seen = BTreeSet::new();

    // IPv4 listeners
    let mut size = 0u32;
    unsafe {
        let _ = get_table(std::ptr::null_mut(), &mut size, 1, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0);
    }
    if (4..=4 * 1024 * 1024).contains(&size) {
        let mut buf = vec![0u8; size as usize];
        if unsafe { get_table(buf.as_mut_ptr().cast(), &mut size, 1, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0) } == 0 {
            let count = u32::from_ne_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
            let max_rows = (buf.len().saturating_sub(4)) / size_of::<MibTcpRowOwnerPid>();
            let base = unsafe { buf.as_ptr().add(4).cast::<MibTcpRowOwnerPid>() };
            for i in 0..count.min(max_rows) {
                let row = unsafe { &*base.add(i) };
                let ip = Ipv4Addr::from(row.dw_local_addr.to_ne_bytes());
                let port = u16::from_be((row.dw_local_port & 0xFFFF) as u16);
                let pname = pid_names.get(&row.dw_owning_pid).cloned();
                let cat = classify_listening_port(port, pname.as_deref());
                // Focus on loopback, omnia, proxy, and dev ports so output stays high-signal
                if (ip.is_loopback() || cat != "system" || port >= 1024)
                    && seen.insert((port, row.dw_owning_pid, ip.to_string()))
                {
                    out.push(ListeningPortInfo {
                        protocol: "tcp4".to_string(),
                        bind_addr: ip.to_string(),
                        port,
                        pid: row.dw_owning_pid,
                        process_name: pname,
                        category: cat.to_string(),
                    });
                }
            }
        }
    }

    // IPv6 listeners
    let mut size6 = 0u32;
    unsafe {
        let _ = get_table(std::ptr::null_mut(), &mut size6, 1, AF_INET6, TCP_TABLE_OWNER_PID_LISTENER, 0);
    }
    if (4..=4 * 1024 * 1024).contains(&size6) {
        let mut buf = vec![0u8; size6 as usize];
        if unsafe { get_table(buf.as_mut_ptr().cast(), &mut size6, 1, AF_INET6, TCP_TABLE_OWNER_PID_LISTENER, 0) } == 0 {
            let count = u32::from_ne_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
            let max_rows = (buf.len().saturating_sub(4)) / size_of::<MibTcp6RowOwnerPid>();
            let base = unsafe { buf.as_ptr().add(4).cast::<MibTcp6RowOwnerPid>() };
            for i in 0..count.min(max_rows) {
                let row = unsafe { &*base.add(i) };
                let ip = Ipv6Addr::from(row.uc_local_addr);
                let port = u16::from_be((row.dw_local_port & 0xFFFF) as u16);
                let pname = pid_names.get(&row.dw_owning_pid).cloned();
                let cat = classify_listening_port(port, pname.as_deref());
                if (ip.is_loopback() || cat != "system")
                    && seen.insert((port, row.dw_owning_pid, ip.to_string()))
                {
                    out.push(ListeningPortInfo {
                        protocol: "tcp6".to_string(),
                        bind_addr: ip.to_string(),
                        port,
                        pid: row.dw_owning_pid,
                        process_name: pname,
                        category: cat.to_string(),
                    });
                }
            }
        }
    }

    unsafe {
        let _ = FreeLibrary(hmod);
    }
    out.sort_by(|a, b| a.port.cmp(&b.port).then_with(|| a.protocol.cmp(&b.protocol)));
    out.truncate(64);
    out
}

#[cfg(not(windows))]
fn enumerate_listening_tcp_ports(
    _pid_names: &std::collections::HashMap<u32, String>,
) -> Vec<ListeningPortInfo> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hardware_tier_handles_optimus_16gb_ram_threshold() {
        assert_eq!(classify_hardware_tier(8 * GIB), HardwareTier::Compact8Gb);
        assert_eq!(classify_hardware_tier(14 * GIB), HardwareTier::Compact8Gb);
        // Optimus 16 GB laptop reporting 15.8 GiB usable physical RAM
        let optimus_ram = (15 * GIB) + (800 * MIB);
        assert_eq!(
            classify_hardware_tier(optimus_ram),
            HardwareTier::Standard16Gb
        );
        assert_eq!(
            classify_hardware_tier(32 * GIB),
            HardwareTier::Workstation32Gb
        );
    }

    #[test]
    fn vram_guard_rejects_8b_q4_on_4gb_an515_and_allows_compact_3b() {
        let an515 = HardwareProfile::from_metrics(16 * GIB, 8 * GIB, 4 * GIB, 8);
        assert_eq!(an515.total_vram_mb, 4096);
        assert_eq!(an515.dwm_ui_headroom_mb, 1024);
        assert_eq!(an515.usable_aux_vram_mb, 3072);

        let check_8b = validate_local_aux_model_vram(&an515, "qwen3-8b-q4_k_m.gguf", None);
        assert!(!check_8b.allowed);
        assert!(check_8b.reason.contains("exceeding safe auxiliary budget"));

        let check_3b = validate_local_aux_model_vram(&an515, "qwen2.5-coder-3b-q4_k_m.gguf", None);
        assert!(check_3b.allowed);

        let check_explicit_oversize =
            validate_local_aux_model_vram(&an515, "custom-aux.gguf", Some(3200));
        assert!(!check_explicit_oversize.allowed);
    }

    #[test]
    fn live_hardware_detection_succeeds_without_subprocesses() {
        let profile = detect_hardware_profile();
        assert!(profile.total_ram_bytes > 0);
        assert!(profile.logical_cpus >= 1);
        assert_eq!(profile.dwm_ui_headroom_mb, DEFAULT_DWM_UI_HEADROOM_MB);
    }
}

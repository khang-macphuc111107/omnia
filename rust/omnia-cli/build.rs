//! Delay-load non-startup Windows DLLs for `omnia.exe` so `--version` and
//! `--profile-startup` skip eager subsystem initialization (`<15 ms` cold start).

fn main() {
    #[cfg(target_env = "msvc")]
    {
        println!("cargo:rustc-link-lib=delayimp");
        // Note: intentionally omit `ws2_32.dll` — Rust `std::net` imports `WS2_32.dll`
        // (uppercase) while `windows-sys`/`mio` import `ws2_32.dll` (lowercase), which
        // triggers a dual-casing IAT-offset underflow (`STATUS_ACCESS_VIOLATION`) inside
        // MSVC `__delayLoadHelper2` when `std::net::TcpStream::connect_timeout` calls `select`.
        for dll in [
            "winsqlite3.dll",
            "shell32.dll",
            "combase.dll",
            "user32.dll",
            "bcrypt.dll",
            "psapi.dll",
            "userenv.dll",
        ] {
            println!("cargo:rustc-link-arg-bin=omnia=/DELAYLOAD:{dll}");
        }
    }
}

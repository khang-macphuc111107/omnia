//! Delay-load non-startup Windows DLLs for `omnia.exe` so `--version` and
//! `--profile-startup` skip eager subsystem initialization (`<15 ms` cold start).

fn main() {
    #[cfg(target_env = "msvc")]
    {
        println!("cargo:rustc-link-lib=delayimp");
        for dll in [
            "winsqlite3.dll",
            "shell32.dll",
            "combase.dll",
            "user32.dll",
            "ws2_32.dll",
            "bcrypt.dll",
            "psapi.dll",
            "userenv.dll",
        ] {
            println!("cargo:rustc-link-arg-bin=omnia=/DELAYLOAD:{dll}");
        }
    }
}

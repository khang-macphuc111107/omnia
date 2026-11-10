#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(windows)]
mod session_panel;
#[cfg(windows)]
mod win32;

fn main() {
    #[cfg(windows)]
    if let Err(error) = win32::run() {
        // GUI subsystem has no console; surface startup failures to the user.
        win32::show_error(&error);
        std::process::exit(1);
    }
    #[cfg(not(windows))]
    {
        eprintln!("omnia-native currently requires Windows. No web runtime fallback is started.");
        std::process::exit(1);
    }
}

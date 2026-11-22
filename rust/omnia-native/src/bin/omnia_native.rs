#![cfg_attr(not(test), windows_subsystem = "windows")]

use omnia_native::{run_native_shell, show_startup_error};

fn main() {
    if let Err(err) = run_native_shell() {
        show_startup_error(&err.message);
        std::process::exit(1);
    }
}

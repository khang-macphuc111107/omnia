//! `omnia`: Ultra-lightweight headless Full Native Rust CLI entrypoint.
//!
//! Skeleton binary registered in Wave 1 for disjoint Wave 2 implementation.

use mimalloc::MiMalloc;
use std::env;
use std::process::ExitCode;

#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("omnia {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }
    println!(
        "omnia {} (crates: {}, {}, {})",
        env!("CARGO_PKG_VERSION"),
        omnia_agent::CRATE_NAME,
        omnia_downloader::CRATE_NAME,
        omnia_notebook::CRATE_NAME
    );
    ExitCode::SUCCESS
}

fn main() {
    tauri_build::build();

    // Tauri embeds the Windows application manifest only into binary targets.
    // Native test harnesses also link code that imports Common Controls v6
    // entry points, so they must receive the same generated resource library.
    // Without it, Windows loads the legacy Common Controls assembly and exits
    // before test discovery with STATUS_ENTRYPOINT_NOT_FOUND.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let resource_library = std::path::PathBuf::from(
            std::env::var_os("OUT_DIR").expect("Cargo must provide OUT_DIR to build scripts"),
        )
        .join("resource.lib");

        println!("cargo:rustc-link-arg-tests={}", resource_library.display());
    }
}

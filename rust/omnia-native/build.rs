use std::path::PathBuf;

fn main() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let manifest = manifest_dir
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.join("native").join("app.manifest"))
        .expect("repo root for native/app.manifest");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg-bin=omnia-native=/MANIFEST:EMBED");
    println!(
        "cargo:rustc-link-arg-bin=omnia-native=/MANIFESTINPUT:{}",
        manifest.display()
    );
    println!("cargo:rustc-link-lib=d2d1");
    println!("cargo:rustc-link-lib=dwrite");
    println!("cargo:rustc-link-lib=uiautomationcore");
    println!("cargo:rustc-link-lib=dwmapi");
    println!("cargo:rustc-link-lib=uxtheme");
    println!("cargo:rustc-link-lib=comctl32");
    println!("cargo:rustc-link-lib=ole32");
    println!("cargo:rustc-link-lib=oleaut32");
    println!("cargo:rustc-link-lib=user32");
    println!("cargo:rustc-link-lib=gdi32");
    println!("cargo:rustc-link-lib=psapi");
}

fn main() {
    println!("cargo:rerun-if-env-changed=LITEHOUSE_UPDATER_PUBLIC_KEY");
    println!(
        "cargo:rustc-env=LITEHOUSE_TARGET_TRIPLE={}",
        std::env::var("TARGET").unwrap()
    );
    if std::env::var_os("LITEHOUSE_UPDATER_PUBLIC_KEY").is_some() {
        println!("cargo:rustc-cfg=litehouse_updater_configured");
    }
    println!("cargo::rustc-check-cfg=cfg(litehouse_updater_configured)");
    tauri_build::build()
}

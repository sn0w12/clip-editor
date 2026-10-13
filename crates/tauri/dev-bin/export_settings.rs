//! Regenerates the frontend settings contract at
//! `src/lib/settings/settings.generated.ts` from the builtin schema.
//!
//! Usage: `cargo run -p seraphis --bin export_settings`
//!
//! Lives in `dev-bin/` instead of `src/bin/` so the tauri bundler never
//! treats this dev tool as an app binary (tauri-apps/tauri#15325).

fn main() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let path = std::path::Path::new(manifest_dir).join(seraphis_lib::settings::GENERATED_TS_PATH);
    std::fs::write(&path, seraphis_lib::settings::typescript_contract())
        .unwrap_or_else(|error| panic!("failed to write {}: {error}", path.display()));
    println!("wrote {}", path.display());
}

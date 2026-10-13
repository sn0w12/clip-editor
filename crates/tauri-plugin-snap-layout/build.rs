const COMMANDS: &[&str] = &["update_snap_bounds", "detach_snap_bounds"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}

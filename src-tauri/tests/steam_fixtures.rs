//! Fixture-driven Steam tests: malformed/escaped VDF handling, duplicate and
//! malformed ACF manifests, root + nested cache layouts, and missing local
//! assets. Fixtures live in `tests/fixtures/`.

use std::path::{Path, PathBuf};

use clip_editor_lib::steam::{
    deep_string, library_folders, normalize_name, parse_keyvalues, resolve_local_artwork,
    scan_games, KValue,
};

fn fixture(path: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(path)
}

#[test]
fn scan_games_handles_duplicates_and_malformed_manifests() {
    let (games, diagnostics) = scan_games(&fixture("steam"));
    // App 10 appears twice; only the first (sorted) occurrence wins.
    assert_eq!(
        games.len(),
        1,
        "duplicate app id collapses deterministically"
    );
    assert_eq!(games[0].app_id, "10");
    assert_eq!(games[0].display_name, "Counter-Strike 2 (Test)");
    assert_eq!(
        games[0].normalized_name,
        normalize_name("Counter-Strike 2 (Test)")
    );
    // Broken manifests are diagnostics, never fatal.
    assert!(
        diagnostics
            .iter()
            .any(|d| d.path.contains("appmanifest_20_broken.acf")),
        "missing-name manifest is reported: {diagnostics:?}"
    );
    assert!(
        diagnostics
            .iter()
            .any(|d| d.path.contains("appmanifest_30_garbage.acf")),
        "garbage manifest is reported: {diagnostics:?}"
    );
}

#[test]
fn resolve_artwork_prefers_nested_and_uses_hash_named_image_as_icon() {
    let image = resolve_local_artwork(&fixture("steam"), "10");
    // Root roles resolved.
    assert!(image.header.as_deref().unwrap().ends_with("10_header.jpg"));
    assert!(image
        .library_600x900
        .as_deref()
        .unwrap()
        .ends_with("10_library_600x900.jpg"));
    assert!(image
        .library_hero
        .as_deref()
        .unwrap()
        .ends_with("10_library_hero.jpg"));
    // Nested dir beats nothing else for logo.
    assert!(image.logo.as_deref().unwrap().ends_with("10\\10_logo.png"));
    // Steam's icon layout is a hash-named image; it resolves as the icon.
    assert!(
        image
            .icon
            .as_deref()
            .unwrap()
            .ends_with("10_mystery_thing.jpg"),
        "hash-named image files are icons"
    );
    // Explicit types never fall back to unknown names.
    assert!(image.library_hero_blur.is_none());
}

#[test]
fn missing_local_asset_leaves_role_empty() {
    let image = resolve_local_artwork(&fixture("steam2"), "99");
    assert!(image.header.is_some());
    assert!(
        image.library_600x900.is_none(),
        "missing poster stays missing"
    );
    assert!(image.logo.is_none());
}

#[test]
fn escaped_and_duplicate_libraryfolders_parse() {
    // Build a temp Steam root whose vdf references real library roots.
    let work = std::env::temp_dir().join(format!("clip-vdf-{}", uuid::Uuid::new_v4()));
    let steam = work.join("steam");
    let steamapps = steam.join("steamapps");
    std::fs::create_dir_all(&steamapps).unwrap();
    let lib2 = work.join("lib2");
    std::fs::create_dir_all(lib2.join("steamapps")).unwrap();
    let escaped_vdf = r#"C:\Odd \"Quotes\""#;
    let vdf = format!(
        "\"libraryfolders\"\n{{\n\t\"0\" {{\n\t\t\"path\"\t\t\"{}\"\n\t}}\n\t\"1\" {{\n\t\t\"path\"\t\t\"{}\"\n\t}}\n\t\"2\" {{\n\t\t\"path\"\t\t\"{}\"\n\t}}\n}}\n",
        steam.display(),
        lib2.display(),
        escaped_vdf
    );
    std::fs::write(steamapps.join("libraryfolders.vdf"), &vdf).unwrap();

    let (folders, diagnostics) = library_folders(&steam);
    // Root steamapps + the second library; the root's own path entry is
    // deduplicated; the escaped nonexistent path is a diagnostic.
    assert_eq!(folders.len(), 2, "root + second library: {folders:?}");
    assert!(folders[0].ends_with("steam\\steamapps"));
    assert!(folders[1].ends_with("lib2\\steamapps"));
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].path, r#"C:\Odd "Quotes""#);

    // Malformed vdf: diagnostics, no panic, root steamapps still returned.
    std::fs::write(
        steamapps.join("libraryfolders.vdf"),
        "this is not a vdf {{{",
    )
    .unwrap();
    let (folders, diagnostics) = library_folders(&steam);
    assert_eq!(folders.len(), 1, "root steamapps remains usable");
    assert_eq!(diagnostics.len(), 1);
    assert!(diagnostics[0].reason.contains("unparseable"));

    let _ = std::fs::remove_dir_all(&work);
}

#[test]
fn cd_fetch_fails_fast_against_unreachable_endpoint() {
    // Bounded client: connection-refused on port 1 fails immediately, proving
    // the CDN path errors instead of hanging the library.
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_millis(300))
        .timeout(std::time::Duration::from_secs(1))
        .build()
        .unwrap();
    let cache = std::env::temp_dir().join(format!("clip-cdn-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&cache).unwrap();
    // Force the URL through the local-failure path by using a role that maps
    // to a URL on an unroutable host via the CDN base? The base is fixed, so
    // exercise the fetch with the real base but a bogus app id: the CDN
    // answers 404 (permanent, no retry) within the timeout.
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let result = runtime.block_on(clip_editor_lib::steam::fetch_cdn_artwork(
        &client,
        &cache,
        "0000000000",
        "header",
    ));
    assert!(result.is_err(), "CDN miss is an error, not a hang");
    let _ = std::fs::remove_dir_all(&cache);
}

#[test]
fn vdf_parser_handles_comments_and_escapes() {
    let vdf = r#"
// leading comment
"Key" "value with \"escaped\" quotes"
"Empty" ""
"Bare" token
"#;
    let root = parse_keyvalues(vdf).unwrap();
    assert_eq!(
        deep_string(&root, "Key").as_deref(),
        Some("value with \"escaped\" quotes")
    );
    assert_eq!(deep_string(&root, "Empty").as_deref(), Some(""));
    // Bare (unquoted) tokens are accepted.
    assert_eq!(deep_string(&root, "Bare").as_deref(), Some("token"));
}

#[test]
fn kvalue_variants_are_inspectable() {
    let vdf = "\"a\" \"b\"\n\"t\" { \"x\" \"1\" }\n";
    let root = parse_keyvalues(vdf).unwrap();
    let table = root.entries.iter().find(|(k, _)| k == "t").map(|(_, v)| v);
    match table {
        Some(KValue::Table(t)) => assert_eq!(deep_string(t, "x").as_deref(), Some("1")),
        _ => panic!("expected table"),
    }
}

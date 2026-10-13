# Repository guidelines

## Project overview

Seraphis is a Tauri 2 desktop app (Rust workspace) plus a React 19 frontend for
recording, editing, organizing, and exporting game clips. It was built on the
tauri-kit shell: the tabbed window chrome, sidebar, schema-driven settings, a
persisted session, and the typed backend bridge.

- `crates/core/` is the domain library every command delegates to. It owns the
  error type, the bounded worker pool, cooperative cancellation, the `Backend`
  facade, and the clip domain: SQLite persistence, library scanning/watching,
  the FFmpeg media pipeline, Steam scanning, the replay buffer, clipboard, and
  the embedded media server. It has no Tauri dependency; it emits events
  through the `EventSink` trait (`crates/core/src/events.rs`).
- `crates/tauri/` holds the Tauri commands and app setup, bridging
  webview ↔ backend over IPC, plus the two shell-level stores (settings,
  session), the Tauri event sink, the native save dialog, the tray, and
  autostart.
- `crates/screencap/` is the Windows capture and replay-buffer engine.
- `crates/tauri-plugin-snap-layout/` is vendored upstream code, not domain:
  native Windows 11 snap layouts for the frameless window, wired to the
  maximize button in `window-controls/`. Keep its sources untouched.

## Architecture and data flow

```
React UI (src/)
  → BackendClient (src/lib/backend/transport/client.ts)   ← only place with command names
    → invokeCommand (src/lib/backend/transport/invoke.ts) → Tauri IPC
      → #[tauri::command] fns (crates/tauri/src/commands/) → Backend facade (crates/core/src/application/backend.rs)
        → scheduler / blocking pool → the work
```

- Frontend state: TanStack Store singletons in `src/stores/` (not
  zustand/redux), each exporting a `store` const, plain action functions, and
  selectors. Data fetching: TanStack Query v5. Routing: TanStack Router, one
  memory-history router per app tab, each built from a fresh route tree
  (`src/routes/route-tree.tsx:createTabRouteTree`) because routers mutate
  their route nodes. Never share or cache route trees. Hidden tabs stay
  mounted via React `<Activity>` boundaries
  (`src/components/active-tab-host.tsx`).
- Result discipline: every `BackendClient` method returns
  `Result<T> = {ok:true,value} | {ok:false,error}` and never rejects. Unwrap
  with `expectOk()` only at react-query boundaries (queryFn / mutation
  callbacks).
- Backend errors: the `Error` enum (`crates/core/src/error/mod.rs`,
  thiserror, no anyhow) serializes to `{code, message, retryable, detail}`
  with stable camelCase codes; commands return
  `CommandResult<T> = Result<T, SerializedError>`.
- Settings: the Rust schema is the source of truth. The frontend receives it
  with the merged values and renders from it, so a new setting needs one
  `schema.rs` edit plus `cargo run -p seraphis --bin export_settings`.
- Session: the frontend owns the document's shape; `crates/tauri/src/session.rs`
  treats it as opaque versioned JSON and writes it atomically.

## Key directories

| Path                 | Purpose                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `src/stores/`        | TanStack Store singletons: `app-store` (tabs), `settings-store`, `theme-store`, `tab-runtime` (per-tab, non-persisted)          |
| `src/lib/`           | Framework-free core: `backend/` (the whole Rust bridge), `routing/`, `bootstrap/`, `settings/settings.generated.ts` (generated) |
| `src/hooks/`         | One concern per file, kebab-case `use-*.ts`                                                                                     |
| `src/contexts/`      | Minimal: services, per-tab id, promise-queued confirm dialog                                                                    |
| `src/components/`    | Feature folders (`settings/`, `markdown/`, `titlebar/`, `window-controls/`, `updates/`, `dnd/`) + generic `ui/` primitives      |
| `src/routes/`        | Page components + `route-tree.tsx`                                                                                              |
| `crates/core/src/`   | `api/` (DTOs), `application/backend.rs` (facade), `error/`, `runtime/` (scheduler, cancellation)                                |
| `crates/tauri/src/`  | `lib.rs` (builder + command registration), `state.rs`, `session.rs`, `settings/`, `commands/`                                   |
| `src/components/ui/` | Vendored coss/shadcn registry code. Upstream comments stay untouched.                                                           |

## Development commands

```bash
npm install
npm run tauri dev        # desktop app with hot reload
npm run dev              # frontend only, port 3000 (strict)
npm run build            # vite build (frontend)
npm run tauri build      # installer bundle

# Gates. just ci runs them all through one scheduler (scripts/ci.mjs); the
# same checks on their own:
just ci                  # every gate, concurrent, summary table
npm run format:check     # oxfmt --check
npm run lint             # oxlint
npm run typecheck        # tsc --noEmit
cargo fmt --all --check
cargo check --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Regenerate the settings TS contract after changing the Rust settings schema:

```bash
cargo run -p seraphis --bin export_settings   # rewrites src/lib/settings/settings.generated.ts
```

There is no frontend test runner configured. Add one (vitest, tests in a
top-level `tests/` tree mirroring `src/`) when the first test is worth having,
and add it to the CI job in the same change.

## Code conventions and common patterns

### Formatting

oxfmt-enforced, match manually: double quotes, semicolons, 4-space indent,
printWidth 80, ES5 trailing commas, sorted imports (packages, then `@/…`,
relative last). Rust: default rustfmt, clippy denies warnings.

### Comments

Default is no comment. Write one only when the code cannot say what it says. A
comment earns its place by explaining a non-obvious why, such as an invariant,
a workaround, or a rationale for something that looks wrong:

- Good: library quirks (`@dnd-kit` snapshot shapes drop prototype getters),
  measurement guards (hidden tabs report 0x0), crash-safety ordering (flush
  before rename so a crash cannot truncate), parity notes, protocol/wire
  contracts.
- Bad, never add these:
    - Restating the name or the next line: `/// Tunables for the icon service`,
      `// Re-render when runtimes are created/disposed`.
    - Usage/condition docs on props, fields, constants: `/** Present when X */`,
      `/** Used by the fetch button */`, `/** Whether this panel is visible */`.
    - Styling/intent narration on class constants (`TRIGGER_EXTRAS`,
      `KIND_ROW_CLASS`); the Tailwind string says what it does.
    - Section banners and dividers: `// NAVIGATION`, `// ---- internals ----`.
    - Changelog-style or speculative notes ("will be used later" prose) without
      a concrete contract.

`///` rustdoc follows the same rule: document public API only where it adds
semantics beyond the signature, such as invariants, defaults, and failure
behavior; omit it when it would just restate the item name. Vendored
directories (`src/components/ui/`, `src/components/window-controls/`) keep
their upstream comments untouched.

When editing code whose comment you invalidate (renamed threshold, changed
ladder, moved file path), fix the comment in the same change; stale
why-comments are worse than none.

### TypeScript

strict mode plus `noUnusedLocals`, `noUnusedParameters`,
`verbatimModuleSyntax`; use `import type` for type-only imports. Alias
`@/*` → `src/*`.

### Frontend patterns

- Named-export function components everywhere (no default exports). Hooks live
  above any early return (fixed hook order).
- Never call `invoke` or add command names outside
  `src/lib/backend/transport/client.ts`; hand-maintain the protocol twin
  `src/lib/backend/protocol.ts`.
- Queries via `queryOptions()` factories
  (`src/lib/backend/queries/app-queries.ts`) + structured keys
  (`query-keys.ts`).
- Store ownership: durable tab data → `appStore`; settings → `settingsStore`;
  theme → `theme-store`; ephemeral per-tab UI → `tab-runtime.ts`. Setters
  return unchanged state when nothing changed.
- Errors surfaced via `toastError(title, error)` (`src/lib/toast-error.ts`);
  destructive actions go through `useConfirm()`.
- Never use html titles, never use custom font sizes.

### Critical invariants

- `getSetting`/`setSetting` throw before settings init; bootstrap order in
  `src/main.tsx` is load-bearing (settings → session → theme → render).
- Generated files are never hand-edited: `src/lib/settings/settings.generated.ts`
  (a freshness test fails if stale). Routing here is code-based, so there is no
  generated route tree.
- IPC operation ids are process-local. Never persist one.

### Rust patterns

- Commands are thin: `#[tauri::command] async fn git_xxx(state: SharedState<'_>, …) -> CommandResult<T>`
  delegating to `state.backend.<method>(…).map_err(to_serialized)`; register
  in the flat `generate_handler!` list in `crates/tauri/src/lib.rs`. Domain
  commands take a domain prefix (the template's stubs use `app_`); settings,
  session and icon commands are unprefixed.
- Serde enums sent over IPC (tagged unions like `SettingType`, error wire
  shapes) need both `rename_all = "camelCase"` AND
  `rename_all_fields = "camelCase"`: the first only renames variant names, so
  fields would hit the frontend as snake_case and read back as `undefined` with
  no error.
- Blocking work goes through the scheduler (`crates/core/src/runtime/scheduler.rs`,
  semaphore-bounded → `spawn_blocking`). In-app tasks use
  `tauri::async_runtime::{spawn, spawn_blocking}`, never raw `tokio::spawn` in
  setup.

## Anti-slop

Every word written in this repo follows this: comments, markdown docs, commit
messages, PR descriptions.

- Em dashes are out, including en dashes and hyphens doing a dash's job. End
  the sentence or use a comma.
- Straight quotes only, never curly.
- Plain verbs win: use, change, help. Not utilize, leverage, facilitate.
- Retired vocabulary: crucial, seamless, robust, comprehensive, showcase,
  foster, delve, pivotal, testament, landscape (abstract sense). Reaching for
  one means the point isn't made yet.
- Cut filler: "in order to" is "to", "due to the fact that" is "because", "it
  is important to note that" is deleted outright.
- Keep sentences active and name the actor. An adverb propping up a weak verb
  gets replaced by a number ("significantly faster" becomes "2.4x faster").
- Describe mechanisms, not vibes. "Preserves scroll position across tab
  switches" beats "feels buttery smooth".
- No bold-label spam, no title-cased headings in markdown, no decorative emoji,
  no forced groups of three, no "not just X but Y".

## Important files

- `src/main.tsx`: async bootstrap (settings → session → theme → render);
  failure renders `BootstrapError`.
- `src/lib/backend/transport/client.ts`: typed backend client; single choke
  point for command names.
- `src/lib/bootstrap/app-runtime.ts`: process-wide `{backend, queryClient}`
  singleton (`resetAppRuntime()` for tests).
- `src/routes/route-tree.tsx`: per-tab route tree factory; loaders set the tab
  title so restored tabs hydrate before first paint.
- `src/components/providers/app-services-provider.tsx`: context provider. Must
  export only the component or HMR Fast Refresh breaks.
- `crates/tauri/src/lib.rs`: plugin wiring and all command registrations.
  `crates/tauri/src/state.rs` defines `AppState { backend, settings, session }`.
- `crates/tauri/tauri.conf.json`: devUrl port 3000,
  `beforeBuildCommand: npm run build`. `visible: false` and
  `decorations: false` are what make the custom chrome mandatory.
- `components.json`: coss registry config; add primitives via
  `npx shadcn@latest add @coss/button` into `src/components/ui/`.
- `scripts/ci.mjs`: the gate registry and scheduler behind `just ci`. A gate's
  `lock` decides scheduling (`null` runs concurrently, `"cargo"` serializes on
  the build lock); each test gate is tallied into passed/skipped/failed counts.

## Runtime and tooling preferences

- npm is the package manager (`package-lock.json`, CI uses `npm ci`).
- Tauri pins: every `@tauri-apps/*` package is pinned to an exact version, and
  the `overrides` block forces a single `@tauri-apps/api` copy. The Rust
  version of each crate and its npm counterpart must stay on the same
  major/minor, or the app logs "Error Found version mismatched Tauri
  packages" at startup and the IPC bridge is not trustworthy. Bump both sides
  together: `cargo update -p tauri -p tauri-plugin-*`, then set each npm
  package to the newest release in the Rust crate's minor line, then
  `npm install`. Note `@tauri-apps/api` versions do not track the `tauri`
  crate exactly (`tauri` 2.11.5 pairs with `@tauri-apps/api` 2.11.1).
- Node LTS, Rust 1.85+ (workspace `rust-version = "1.85"`; `crates/core` uses
  edition 2024).
- Lint/format: oxlint + oxfmt, not ESLint/Prettier (VS Code defaults to the
  oxc extension, Prettier disabled). oxlint `correctness` rules are errors;
  React purity/immutability/exhaustive-deps warnings exist, so don't add code
  that trips them.
- Tailwind CSS v4 CSS-first (no tailwind.config): theme tokens in
  `src/styles.css`, dark mode is a `.dark` class on `<html>` via theme-store.
  Icons: lucide-react.
- Release builds run through the GitHub Actions tag workflow (`v*.*.*`) using
  tauri-action; bundles nsis/msi/dmg/appimage/deb.

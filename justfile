set shell := ["pwsh", "-NoLogo", "-Command"]
set dotenv-load := false

# Every gate through one scheduler: just ci [--changed] [--gate fmt] [--verbose]
ci *args="":
    node scripts/ci.mjs{{ if args == "" { "" } else { " " + args } }}

check:
    npm run typecheck
    cargo check --workspace --all-targets

fmt:
    cargo fmt --all
    npm run format

lint:
    npm run lint
    cargo clippy --workspace --all-targets -- -D warnings

lint-fix:
    npm run lint:fix
    cargo clippy --fix --workspace --all-targets -- -D warnings

dev:
    npm run tauri dev

# Run against a throwaway session file so a dev session never clobbers the real one.
dev-session *path=".dev-session/session.json":
    npm run tauri dev -- -- -- --session "{{ path }}"

build:
    npm run tauri build

settings:
    cargo run -p seraphis --bin export_settings

# Bump the version, commit it, and tag it: just bump [patch|minor|major|x.y.z] [--dry-run] [--push] [--no-commit] [--no-tag]
bump *args="":
    node scripts/version.mjs {{ if args == "" { "patch" } else { args } }}

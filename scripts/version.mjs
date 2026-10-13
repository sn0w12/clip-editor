import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const BUMPS = new Set(["major", "minor", "patch"]);

const MANAGED_FILES = [
    "package.json",
    "package-lock.json",
    "Cargo.toml",
    "Cargo.lock",
    "crates/tauri/tauri.conf.json",
];

function usage() {
    return [
        "Usage: node scripts/version.mjs [major|minor|patch|<semver>] [options]",
        "",
        "Set the version across package.json, package-lock.json, Cargo.toml,",
        "Cargo.lock and crates/tauri/tauri.conf.json, then commit and tag it.",
        "",
        "  major | minor | patch   bump that part of the current version",
        "                        (default when only options are given)",
        "  x.y.z                 set an explicit version (leading v allowed)",
        "",
        "Options:",
        "  --no-commit           update files only, skip the git commit",
        "  --no-tag              commit without creating the v<version> tag",
        "  --push                push the new commit and tag to origin",
        '  -m, --message <msg>   custom commit message (default "bump version")',
        "  --dry-run             show the plan without changing anything",
        "  -h, --help            show this help",
        "",
    ].join("\n");
}

function fail(message) {
    process.stderr.write(`${message}\n`);
    process.exit(1);
}

function parseArgs(argv) {
    const options = {
        target: null,
        commit: true,
        tag: true,
        push: false,
        message: null,
        dryRun: false,
    };
    let index = 0;
    while (index < argv.length) {
        const arg = argv[index];
        if (arg === "--no-commit") {
            options.commit = false;
        } else if (arg === "--no-tag") {
            options.tag = false;
        } else if (arg === "--push") {
            options.push = true;
        } else if (arg === "--dry-run") {
            options.dryRun = true;
        } else if (arg === "-h" || arg === "--help") {
            process.stdout.write(usage());
            process.exit(0);
        } else if (arg === "-m" || arg === "--message") {
            options.message = argv[index + 1] ?? null;
            if (!options.message) {
                fail(`Missing value for ${arg}.\n\n${usage()}`);
            }
            index += 1;
        } else if (arg.startsWith("-")) {
            fail(`Unknown option: ${arg}\n\n${usage()}`);
        } else if (!options.target) {
            options.target = arg;
        } else {
            fail(`Unexpected argument: ${arg}\n\n${usage()}`);
        }
        index += 1;
    }
    if (!options.target) {
        if (argv.length === 0) {
            fail(usage());
        }
        options.target = "patch";
    }
    return options;
}

function readCurrentVersion() {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    const cargo = readFileSync(resolve(root, "Cargo.toml"), "utf8").match(
        /^version = "([^"]+)"/m
    );
    const tauri = JSON.parse(
        readFileSync(resolve(root, "crates/tauri/tauri.conf.json"), "utf8")
    );
    const versions = new Map([
        ["package.json", pkg.version],
        ["Cargo.toml", cargo?.[1]],
        ["crates/tauri/tauri.conf.json", tauri.version],
    ]);
    if (new Set(versions.values()).size !== 1 || !pkg.version) {
        const detail = [...versions]
            .map(([file, version]) => `  ${file}: ${version ?? "not found"}`)
            .join("\n");
        fail(`Version files disagree, align them first:\n${detail}`);
    }
    return pkg.version;
}

function resolveTarget(raw, current) {
    const kind = raw.toLowerCase();
    if (BUMPS.has(kind)) {
        const match = current.match(SEMVER);
        if (!match) {
            fail(
                `Current version ${current} is not plain semver, ` +
                    `pass an explicit version instead.`
            );
        }
        const major = Number(match[1]);
        const minor = Number(match[2]);
        const patch = Number(match[3]);
        if (kind === "major") {
            return `${major + 1}.0.0`;
        }
        if (kind === "minor") {
            return `${major}.${minor + 1}.0`;
        }
        return `${major}.${minor}.${patch + 1}`;
    }
    const explicit = raw.replace(/^v/, "");
    if (!SEMVER.test(explicit)) {
        fail(`Invalid target: ${raw}\n\n${usage()}`);
    }
    return explicit;
}

function replacementFor(file, version) {
    switch (file) {
        case "package.json":
        case "crates/tauri/tauri.conf.json":
            return [/"version"\s*:\s*"[^"]+"/, `"version": "${version}"`];
        case "package-lock.json":
            return [
                /(name":\s*"seraphis",)(\s*\n\s*"version":\s*)"[^"]+"/g,
                `$1$2"${version}"`,
            ];
        case "Cargo.toml":
            return [/^version = "[^"]+"/m, `version = "${version}"`];
        case "Cargo.lock":
            return [
                /name = "(?:seraphis-core|seraphis)"\r?\nversion = "[^"]+"/g,
                (match) =>
                    match.replace(
                        /version = "[^"]+"/,
                        `version = "${version}"`
                    ),
            ];
        default:
            throw new Error(`No version pattern for ${file}`);
    }
}

function git(args) {
    return execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    }).trim();
}

function inGitRepo() {
    try {
        git(["rev-parse", "--is-inside-work-tree"]);
        return true;
    } catch {
        return false;
    }
}

function tagExists(tag) {
    try {
        git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]);
        return true;
    } catch {
        return false;
    }
}

function stagedOutsideManaged() {
    return git(["diff", "--cached", "--name-only"])
        .split("\n")
        .map((line) => line.trim().replace(/\\/g, "/"))
        .filter((line) => line && !MANAGED_FILES.includes(line));
}

const options = parseArgs(process.argv.slice(2));
const current = readCurrentVersion();
const version = resolveTarget(options.target, current);
if (version === current) {
    fail(`Already at version ${current}, nothing to do.`);
}
const tag = `v${version}`;
const message = options.message ?? "bump version";

const sources = new Map(
    MANAGED_FILES.map((file) => [
        file,
        readFileSync(resolve(root, file), "utf8"),
    ])
);
const replacements = new Map(
    MANAGED_FILES.map((file) => [file, replacementFor(file, version)])
);
for (const [file, source] of sources) {
    if (!replacements.get(file)[0].test(source)) {
        fail(`! ${file}: version not found.`);
    }
}

const willTag = options.tag && options.commit;
if (options.dryRun) {
    const lines = [
        `Current version: ${current}`,
        `Next version: ${version} (${options.target})`,
        `Files: ${MANAGED_FILES.join(", ")}`,
        options.commit ? `Commit: "${message}"` : "Commit: skipped",
        willTag ? `Tag: ${tag}` : "Tag: skipped",
        options.push && (options.commit || willTag)
            ? "Push: origin"
            : "Push: skipped",
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    process.exit(0);
}

if (options.commit || options.tag) {
    if (!inGitRepo()) {
        fail("Not inside a git repository, rerun with --no-commit --no-tag.");
    }
    if (willTag && tagExists(tag)) {
        fail(`Tag ${tag} already exists.`);
    }
    if (options.commit) {
        const foreign = stagedOutsideManaged();
        if (foreign.length > 0) {
            fail(
                `Unrelated staged changes would be swept into the version ` +
                    `commit, unstage them first:\n  ${foreign.join("\n  ")}`
            );
        }
    }
}

let changed = 0;
for (const [file, source] of sources) {
    const [pattern, replacement] = replacements.get(file);
    const updated = source.replace(pattern, replacement);
    if (updated !== source) {
        writeFileSync(resolve(root, file), updated);
        changed += 1;
    }
}
process.stdout.write(
    `Version ${version} in effect across all files (${changed} updated).\n`
);

if (!options.commit) {
    if (options.tag) {
        process.stdout.write(`Tag ${tag} skipped without a commit.\n`);
    }
    process.exit(0);
}

git(["add", "--", ...MANAGED_FILES]);
git(["commit", "-m", message]);
process.stdout.write(
    `Committed "${message}" (${git(["rev-parse", "--short", "HEAD"])}).\n`
);

if (willTag) {
    git(["tag", tag]);
    process.stdout.write(`Created tag ${tag}.\n`);
}

if (options.push) {
    const refspecs = ["HEAD"];
    if (willTag) {
        refspecs.push(tag);
    }
    git(["push", "origin", ...refspecs]);
    process.stdout.write(`Pushed ${refspecs.join(" and ")} to origin.\n`);
}

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

const version = process.argv[2]?.replace(/^v/, "");
if (!version || !SEMVER.test(version)) {
    process.stderr.write(`Usage: node scripts/version.mjs <semver>\n`);
    process.exit(1);
}

const jsonRe = (replacement) => [
    /"version"\s*:\s*"[^"]+"/,
    `"version": "${replacement}"`,
];

const cargoTomlRe = (replacement) => [
    /^version = "[^"]+"/m,
    `version = "${replacement}"`,
];

const cargoLockRe = (replacement) => [
    /name = "clip-editor"\nversion = "[^"]+"/,
    `name = "clip-editor"\nversion = "${replacement}"`,
];

const packageLockRe = (replacement) => [
    /(name":\s*"clip-editor",)(\s*\n\s*"version":\s*)"[^"]+"/g,
    `$1$2"${replacement}"`,
];

const files = [
    ["package.json", jsonRe],
    ["package-lock.json", packageLockRe],
    ["src-tauri/Cargo.toml", cargoTomlRe],
    ["src-tauri/Cargo.lock", cargoLockRe],
    ["src-tauri/tauri.conf.json", jsonRe],
].map(([file, re]) => ({
    file,
    path: resolve(root, file),
    source: readFileSync(resolve(root, file), "utf8"),
    re: re(version),
}));

for (const { file, source, re } of files) {
    if (!re[0].test(source)) {
        process.stderr.write(`! ${file}: version not found.\n`);
        process.exit(1);
    }
}

let changed = 0;
for (const { file, path, source, re } of files) {
    const updated = source.replace(re[0], re[1]);
    if (updated !== source) {
        writeFileSync(path, updated);
        changed += 1;
    }
}

process.stdout.write(`Version ${version} in effect across all files (${changed} updated).\n`);
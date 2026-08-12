import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const steps = [
    { label: "Frontend (oxfmt)", command: "npx --no-install oxfmt", cwd: root },
    { label: "App crate (cargo fmt)", command: "cargo fmt", cwd: resolve(root, "src-tauri") },
    {
        label: "Screencap crate (cargo fmt)",
        command: "cargo fmt",
        cwd: resolve(root, "crates", "screencap"),
    },
];

let failed = false;

for (const { label, command, cwd } of steps) {
    process.stdout.write(`\n> ${label}\n`);
    const result = spawnSync(command, { cwd, stdio: "inherit", shell: true });
    if (result.status !== 0) {
        process.stderr.write(`! ${label} failed (exit ${result.status ?? "error"}).\n`);
        failed = true;
    }
}

if (failed) {
    process.stderr.write("\nFormatting failed.\n");
    process.exit(1);
}

process.stdout.write("\nAll formatting complete.\n");

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @typedef {object} Gate
 * @property {string} id
 * @property {string} label
 * @property {string|null} lock null when the gate takes no build lock
 * @property {"web"|"rust"} scope
 * @property {string[]|null} cmd
 * @property {boolean} [optional]
 * @property {string|null} [note]
 */

/**
 * @typedef {object} GateState
 * @property {Gate} gate
 * @property {"pending"|"running"|"ok"|"fail"|"skip"} status
 * @property {string|null} reason
 * @property {number} startedAt
 * @property {number|null} durationMs
 * @property {number|null} code
 * @property {Counts|null} counts
 */

/**
 * @typedef {object} Options
 * @property {string[]} only
 * @property {string[]} skip
 * @property {boolean} withCheck
 * @property {boolean} changed
 * @property {string} base
 * @property {number} jobs
 * @property {boolean} verbose
 * @property {boolean|null} nextest
 * @property {boolean} list
 * @property {boolean} help
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const logDir = resolve(root, "node_modules/.cache/seraphis-ci");

const NEXTEST_CMD = ["cargo", "nextest", "run", "--workspace"];
const CARGO_TEST_CMD = ["cargo", "test", "--workspace"];

// `optional` gates stay out of the default set. cargo check earns nothing next
// to clippy: both run the same check pass over the same target dir, share no
// build artifacts, so running both is the same compilation twice.
/** @type {Gate[]} */
export const GATES = [
    {
        id: "fmt",
        label: "oxfmt",
        lock: null,
        scope: "web",
        cmd: ["npm", "run", "--silent", "format:check"],
    },
    {
        id: "lint",
        label: "oxlint",
        lock: null,
        scope: "web",
        cmd: ["npm", "run", "--silent", "lint"],
    },
    {
        id: "types",
        label: "tsc",
        lock: null,
        scope: "web",
        cmd: ["npm", "run", "--silent", "typecheck"],
    },
    {
        id: "fmt:rust",
        label: "rustfmt",
        lock: null,
        scope: "rust",
        cmd: ["cargo", "fmt", "--all", "--check"],
    },
    {
        id: "check:rust",
        label: "cargo check",
        lock: "cargo",
        scope: "rust",
        optional: true,
        cmd: ["cargo", "check", "--workspace", "--all-targets"],
    },
    {
        id: "lint:rust",
        label: "clippy",
        lock: "cargo",
        scope: "rust",
        cmd: [
            "cargo",
            "clippy",
            "--workspace",
            "--all-targets",
            "--",
            "-D",
            "warnings",
        ],
    },
    {
        id: "test:rust",
        label: "cargo test",
        lock: "cargo",
        scope: "rust",
        cmd: null,
    },
];

const CHANGE_SCOPES = {
    web: [
        "src/",
        "package.json",
        "package-lock.json",
        "vite.config.ts",
        "tsconfig.json",
        "index.html",
        "components.json",
        ".oxfmtrc.json",
        ".oxlintrc.json",
    ],
    rust: ["crates/", "Cargo.toml", "Cargo.lock", "rust-toolchain", ".cargo/"],
};

const USAGE = [
    "Usage: node scripts/ci.mjs [options]",
    "",
    "Run every pre-commit gate through one scheduler and print a summary.",
    "Each test gate is tallied into a passed/skipped/failed test count.",
    "",
    "Selection:",
    "  -g, --gate <ids>     only run these gates, comma separated",
    "                       prefixes work: fmt, lint, types, check",
    "  -s, --skip <ids>     skip these gates, comma separated",
    "      --with-check     add the redundant cargo check gate",
    "      --changed        skip gates whose paths did not change",
    "      --base <ref>     compare against this ref (default HEAD)",
    "",
    "Execution:",
    "  -j, --jobs <n>       max concurrent unlocked gates (default: cpu count)",
    "                       the first failure kills gates still in flight",
    "  -v, --verbose        stream gate output live instead of buffering it",
    "                       (counts are read from the buffered output, so",
    "                        verbose mode does not report them)",
    "",
    "Other:",
    "      --no-nextest     force cargo test even when nextest is installed",
    "      --list           print the gate table and exit",
    "  -h, --help           show this help",
    "",
];

/** @returns {Gate[]} */
export function resolveGates({ nextest, withCheck = false }) {
    return GATES.filter((gate) => withCheck || !gate.optional).map((gate) =>
        gate.cmd
            ? gate
            : {
                  ...gate,
                  cmd: nextest ? NEXTEST_CMD : CARGO_TEST_CMD,
                  note: nextest ? "nextest" : null,
                  tests: nextest ? "nextest" : "cargo",
              }
    );
}

/**
 * @param {string} value
 * @returns {string[]}
 */
export function parseGateIds(value) {
    return value
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
}

function gateMatches(gate, ids) {
    const head = gate.id.split(":")[0];
    return ids.some((id) => id === gate.id || id === head);
}

/**
 * @param {Gate[]} gates
 * @param {{only?: string[], skip?: string[]}} [selection]
 * @returns {Gate[]}
 */
export function selectGates(gates, { only = [], skip = [] } = {}) {
    return gates.filter(
        (gate) =>
            (only.length === 0 || gateMatches(gate, only)) &&
            !gateMatches(gate, skip)
    );
}

// A null diff means "no change information". It must never collapse into
// "nothing to run", so callers pass null whenever the diff is untrustworthy.
/**
 * @param {Gate[]} gates
 * @param {string[]|null} changed
 * @returns {Gate[]}
 */
export function filterByChanges(gates, changed) {
    if (changed === null) return gates;
    return gates.filter((gate) =>
        CHANGE_SCOPES[gate.scope].some((scope) =>
            changed.some((file) => file.startsWith(scope))
        )
    );
}

/**
 * @param {Gate[]} gates
 * @param {number} jobs
 * @returns {{lock: string|null, gateIds: string[], concurrency: number}[]}
 */
export function planSchedule(gates, jobs) {
    const lanes = new Map();
    for (const gate of gates) {
        const key = gate.lock === null ? "free" : gate.lock;
        if (!lanes.has(key)) {
            lanes.set(key, { lock: gate.lock, gateIds: [] });
        }
        lanes.get(key).gateIds.push(gate.id);
    }
    return [...lanes.values()].map((lane) => ({
        lock: lane.lock,
        gateIds: lane.gateIds,
        concurrency: Math.max(
            1,
            Math.min(lane.lock === null ? jobs : 1, lane.gateIds.length)
        ),
    }));
}

// flag -> [option key, how it consumes its value]
const FLAGS = {
    "-h": ["help", "flag"],
    "--help": ["help", "flag"],
    "-v": ["verbose", "flag"],
    "--verbose": ["verbose", "flag"],
    "--list": ["list", "flag"],
    "--changed": ["changed", "flag"],
    "--with-check": ["withCheck", "flag"],
    "--no-nextest": ["nextest", "off"],
    "-j": ["jobs", "count"],
    "--jobs": ["jobs", "count"],
    "--base": ["base", "text"],
    "-g": ["only", "list"],
    "--gate": ["only", "list"],
    "-s": ["skip", "list"],
    "--skip": ["skip", "list"],
};

/**
 * @param {string[]} argv
 * @returns {Options}
 */
export function parseArgs(argv) {
    const options = {
        only: [],
        skip: [],
        withCheck: false,
        changed: false,
        base: "HEAD",
        jobs: availableParallelism(),
        verbose: false,
        nextest: null,
        list: false,
        help: false,
    };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        // `just` forwards a literal `--`, and typing one is muscle memory.
        if (arg === "--") continue;
        const spec = Object.hasOwn(FLAGS, arg) ? FLAGS[arg] : null;
        if (spec === null) throw new Error(`unknown argument: ${arg}`);
        const [key, arity] = spec;
        if (arity === "flag") {
            options[key] = true;
        } else if (arity === "off") {
            options[key] = false;
        } else if (arity === "list") {
            options[key].push(...parseGateIds(argv[++index] ?? ""));
        } else if (arity === "count") {
            options[key] = Number(argv[++index]);
        } else {
            options[key] = argv[++index];
        }
    }
    if (!Number.isInteger(options.jobs) || options.jobs < 1) {
        throw new Error("--jobs needs a positive integer");
    }
    return options;
}

function hasCommand(commandLine) {
    if (process.platform === "win32") {
        return (
            spawnSync(commandLine, { stdio: "ignore", shell: true }).status ===
            0
        );
    }
    const [command, ...args] = commandLine.split(" ");
    return spawnSync(command, args, { stdio: "ignore" }).status === 0;
}

function gitLines(args) {
    const result = spawnSync("git", args, {
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
    });
    return result.status === 0
        ? result.stdout.split("\n").filter((line) => line.length > 0)
        : null;
}

/**
 * @param {string} base
 * @returns {string[]|null}
 */
export function collectChangedFiles(base) {
    const tracked = gitLines(["diff", "--name-only", base]);
    const untracked = gitLines(["ls-files", "--others", "--exclude-standard"]);
    if (tracked === null || untracked === null) return null;
    const files = [...new Set([...tracked, ...untracked])];
    return files.length > 0 ? files : null;
}

/**
 * @typedef {object} Counts
 * @property {number} passed
 * @property {number} failed
 * @property {number} skipped
 */

const TEST_PARSERS = {
    // `  Summary [   0.126s] 236 tests run: 236 passed, 0 skipped, 0 failed`
    nextest: (output) => tallyFrom(output.match(/tests run: (.+)$/m)?.[1]),
    // One `test result:` line per target, so this sums the whole workspace.
    // Filtered-out tests are not counted as skipped: nextest never runs them,
    // so counting them would make the two runners disagree.
    cargo: (output) => {
        let total = null;
        for (const match of output.matchAll(
            /^test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored;/gm
        )) {
            total ??= { passed: 0, failed: 0, skipped: 0 };
            total.passed += Number(match[1]);
            total.failed += Number(match[2]);
            total.skipped += Number(match[3]);
        }
        return total;
    },
};

function tallyFrom(line) {
    if (line === undefined) return null;
    const counts = {
        passed: Number(line.match(/(\d+) passed/)?.[1] ?? 0),
        failed: Number(line.match(/(\d+) failed/)?.[1] ?? 0),
        skipped: Number(line.match(/(\d+) skipped/)?.[1] ?? 0),
    };
    return counts.passed + counts.failed + counts.skipped > 0 ? counts : null;
}

export function parseTestCounts(tool, output) {
    if (tool === null || tool === undefined) return null;
    return TEST_PARSERS[tool]?.(output) ?? null;
}

function sumCounts(list) {
    return list.reduce(
        (total, counts) => ({
            passed: total.passed + counts.passed,
            failed: total.failed + counts.failed,
            skipped: total.skipped + counts.skipped,
        }),
        { passed: 0, failed: 0, skipped: 0 }
    );
}

const useColor =
    (process.stdout.isTTY === true || process.env.FORCE_COLOR === "1") &&
    process.env.NO_COLOR === undefined;
const paint = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const colors = {
    green: (text) => paint("32", text),
    red: (text) => paint("31", text),
    cyan: (text) => paint("36", text),
    bold: (text) => paint("1", text),
    dim: (text) => paint("2", text),
};

function formatSeconds(ms) {
    return `${(ms / 1000).toFixed(1)}s`;
}

function killTree(child) {
    if (child.exitCode !== null || child.pid === undefined) return;
    if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
            stdio: "ignore",
        });
        return;
    }
    try {
        process.kill(-child.pid, "SIGTERM");
    } catch {
        child.kill("SIGTERM");
    }
}

const liveChildren = new Set();

function runGate(gate, { onStart, onFinish, verbose }) {
    return new Promise((done) => {
        onStart(gate);
        const startedAt = performance.now();
        const chunks = [];
        // Windows has no executable npm, only npm.cmd, and CreateProcess
        // refuses to run a batch file without a shell. Passing one joined
        // string instead of an argv array keeps Node's shell-injection
        // deprecation quiet; every command here is a literal from GATES.
        const shell = process.platform === "win32";
        const child = spawn(
            shell ? gate.cmd.join(" ") : gate.cmd[0],
            shell ? [] : gate.cmd.slice(1),
            {
                cwd: root,
                shell,
                windowsHide: true,
                detached: !shell,
                stdio: verbose ? "inherit" : ["ignore", "pipe", "pipe"],
                env: {
                    ...process.env,
                    // Kept in step with the reporter so a piped log never gets
                    // escape codes the reader cannot render.
                    CARGO_TERM_COLOR: useColor ? "always" : "never",
                },
            }
        );
        liveChildren.add(child);

        let settled = false;
        const settle = (code, signal) => {
            if (settled) return;
            settled = true;
            liveChildren.delete(child);
            onFinish(
                gate,
                {
                    code,
                    signal,
                    durationMs: performance.now() - startedAt,
                    output: Buffer.concat(chunks).toString("utf-8"),
                },
                child
            );
            done();
        };

        if (!verbose) {
            const collect = (chunk) => chunks.push(chunk);
            child.stdout.on("data", collect);
            child.stderr.on("data", collect);
        }
        child.on("error", (error) => {
            chunks.push(Buffer.from(`${gate.cmd[0]}: ${error.message}\n`));
            settle(127, null);
        });
        child.on("close", (code, signal) => settle(code, signal));
    });
}

async function runLane(lane, gates, context) {
    const queue = [...lane.gateIds];
    const workers = Array.from({ length: lane.concurrency }, async () => {
        while (queue.length > 0) {
            if (context.failed > 0) return;
            const gate = gates.get(queue.shift());
            if (gate === undefined) return;
            await runGate(gate, context);
        }
    });
    await Promise.all(workers);
}

/**
 * @param {Map<string, GateState>} states
 * @param {Gate[]} visible
 * @param {{live?: boolean}} [options]
 */
export function createReporter(states, visible, { live = false } = {}) {
    const pad = Math.max(...visible.map((gate) => gate.label.length), 0);
    let rendered = 0;

    const line = (state) => {
        const { gate, status, durationMs, code, startedAt, counts } = state;
        const label = gate.label.padEnd(pad);
        const note = gate.note ? ` ${colors.dim(gate.note)}` : "";
        const tally =
            counts == null
                ? ""
                : ` ${colors.dim(
                      `${counts.passed + counts.failed + counts.skipped} tests`
                  )}`;
        if (status === "running") {
            const elapsed = colors.dim(
                formatSeconds(performance.now() - startedAt)
            );
            return `  ${colors.cyan("▸")} ${label}  ${elapsed}${note}`;
        }
        if (status === "ok") {
            const took = formatSeconds(durationMs);
            return `  ${colors.green("✔")} ${label}  ${took}${tally}${note}`;
        }
        if (status === "fail") {
            const code_ = colors.red(`exit ${code ?? "signal"}`);
            return `  ${colors.red("✖")} ${label}  ${code_}${tally}${note}`;
        }
        if (status === "skip") {
            const why = colors.dim(state.reason ?? "skipped");
            return `  ${colors.dim("–")} ${label}  ${why}${note}`;
        }
        return `  ${colors.dim("·")} ${label}  ${colors.dim("queued")}${note}`;
    };

    return {
        line(gate) {
            return line(states.get(gate.id));
        },
        render() {
            if (!live) return;
            const body = visible.map((gate) => line(states.get(gate.id)));
            const rewind = rendered > 0 ? `\x1b[${rendered}A` : "";
            process.stdout.write(
                `${rewind}${body.map((row) => `\x1b[2K${row}`).join("\n")}\n`
            );
            rendered = body.length;
        },
    };
}

function reportFailure(state, write) {
    const logPath = writeLogFile(state.gate.id, state.output);
    write(
        `\n${colors.red(colors.bold(`FAIL ${state.gate.id}`))} ${colors.dim(
            `exit ${state.code ?? "signal"} in ${formatSeconds(state.durationMs)}`
        )}\n`
    );
    write(`${state.output.split("\n").slice(-40).join("\n")}\n`);
    if (logPath !== null) {
        write(`${colors.dim(`full log: ${logPath}`)}\n`);
    }
    write("\n");
}

/**
 * @param {Map<string, GateState>} states
 * @param {(text: string) => unknown} write
 */
export function reportCounts(states, write) {
    const all = [...states.values()];
    const groups = [...new Set(all.map((state) => state.gate.scope))]
        .map((scope) => ({
            scope,
            counts: sumCounts(
                all
                    .filter(
                        (state) => state.gate.scope === scope && state.counts
                    )
                    .map((state) => state.counts)
            ),
        }))
        .filter(
            ({ counts }) => counts.passed + counts.failed + counts.skipped > 0
        );
    if (groups.length === 0) return;
    const cell = (label, counts) => {
        const total = counts.passed + counts.failed + counts.skipped;
        const show = (n, text) =>
            n > 0 ? colors.bold(`${n} ${text}`) : colors.dim(`0 ${text}`);
        return `  ${label.padEnd(7)} ${colors.bold(String(total))}  ${colors.green(
            show(counts.passed, "passed")
        )}  ${colors.dim(show(counts.skipped, "skipped"))}  ${colors.red(
            show(counts.failed, "failed")
        )}`;
    };
    const total = sumCounts(groups.map((group) => group.counts));
    const rows = [
        cell("tests", total),
        ...groups.map((g) => cell(g.scope, g.counts)),
    ];
    write(`\n${rows.join("\n")}\n`);
}

/**
 * @param {Map<string, GateState>} states
 * @returns {{passed: number, failed: number, skipped: number, serialMs: number, failedStates: GateState[]}}
 */
export function tallyStates(states) {
    const tally = { passed: 0, failed: 0, skipped: 0, serialMs: 0 };
    const failedStates = [];
    for (const state of states.values()) {
        if (state.status === "skip") {
            tally.skipped++;
            continue;
        }
        tally.serialMs += state.durationMs;
        if (state.status === "ok") {
            tally.passed++;
        } else if (state.status === "fail") {
            tally.failed++;
            failedStates.push(state);
        }
    }
    return { ...tally, failedStates };
}

/**
 * @param {{passed: number, failed: number, skipped: number, serialMs: number, failedStates: GateState[]}} tally
 * @param {number} wallMs
 * @param {(text: string) => unknown} write
 * @returns {number} the process exit code
 */
export function reportSummary(tally, wallMs, write) {
    const parts = [
        colors.green(`${tally.passed} passed`),
        tally.failed > 0 ? colors.red(`${tally.failed} failed`) : "0 failed",
    ];
    if (tally.skipped > 0) parts.push(colors.dim(`${tally.skipped} skipped`));
    parts.push(colors.bold(formatSeconds(wallMs)));
    parts.push(colors.dim(`${formatSeconds(tally.serialMs)} serial`));
    const savedMs = tally.serialMs - wallMs;
    if (savedMs >= 1000) {
        parts.push(colors.dim(`${formatSeconds(savedMs)} saved`));
    }
    write(`\n  ${parts.join(colors.dim(" | "))}\n`);
    return tally.failed === 0 ? 0 : Math.min(tally.failed, 255);
}

function writeLogFile(id, output) {
    const name = `${id.replace(/[:/]/g, "_")}.log`;
    const path = resolve(logDir, name);
    try {
        mkdirSync(logDir, { recursive: true });
        writeFileSync(path, output);
    } catch {
        return null;
    }
    return path;
}

async function runCi(options) {
    const nextest = options.nextest ?? hasCommand("cargo nextest --version");
    const gates = selectGates(
        resolveGates({ nextest, withCheck: options.withCheck }),
        options
    );

    const changed = options.changed ? collectChangedFiles(options.base) : null;
    const enabled = new Set(
        filterByChanges(gates, changed).map((gate) => gate.id)
    );
    if (enabled.size === 0) {
        process.stdout.write(
            `  no gate matched the changed paths${colors.dim(
                " (run without --changed to check everything)"
            )}\n`
        );
        return 0;
    }

    const states = new Map();
    for (const gate of gates) {
        const skipped = !enabled.has(gate.id);
        states.set(gate.id, {
            gate,
            status: skipped ? "skip" : "pending",
            reason: skipped ? `no ${gate.scope} changes` : null,
            startedAt: 0,
            durationMs: null,
            code: null,
            counts: null,
            output: "",
        });
    }

    const live = process.stdout.isTTY === true && !options.verbose;
    const reporter = createReporter(states, gates, { live });
    const write = (text) => process.stdout.write(text);
    const context = {
        failed: 0,
        aborted: false,
        abortedChildren: new Set(),
        verbose: options.verbose,
        abort() {
            if (context.aborted) return;
            context.aborted = true;
            for (const child of liveChildren) {
                // A child that already exited is reporting its own result;
                // do not relabel a real failure as killed by the abort.
                if (child.exitCode !== null) continue;
                context.abortedChildren.add(child);
                killTree(child);
            }
        },
        onStart(gate) {
            const state = states.get(gate.id);
            state.startedAt = performance.now();
            state.status = "running";
            reporter.render();
        },
        onFinish(gate, result, child) {
            const state = states.get(gate.id);
            const aborted = context.abortedChildren.delete(child);
            Object.assign(state, result, {
                status: aborted ? "skip" : result.code === 0 ? "ok" : "fail",
                reason: aborted ? "killed, fail-fast" : null,
                counts:
                    aborted || options.verbose
                        ? null
                        : parseTestCounts(gate.tests, result.output),
            });
            if (!aborted && result.code !== 0) {
                context.failed++;
                context.abort();
            }
            reporter.render();
            // A piped reader has no live block to watch, and a failure is the
            // one thing they cannot afford to wait out.
            if (!live) {
                write(`${reporter.line(gate)}\n`);
                if (state.status === "fail") reportFailure(state, write);
            }
        },
    };

    reporter.render();
    const ticker = live ? setInterval(() => reporter.render(), 100) : null;
    ticker?.unref();

    const startedAt = performance.now();
    const byId = new Map(gates.map((gate) => [gate.id, gate]));
    const lanes = planSchedule(
        gates.filter((gate) => enabled.has(gate.id)),
        options.jobs
    );
    await Promise.all(lanes.map((lane) => runLane(lane, byId, context)));
    const wallMs = performance.now() - startedAt;
    if (ticker !== null) clearInterval(ticker);

    for (const state of states.values()) {
        if (state.status === "pending") {
            state.status = "skip";
            state.reason = "not run, fail-fast";
        }
    }

    const tally = tallyStates(states);
    if (live) {
        for (const state of tally.failedStates) reportFailure(state, write);
    }
    reportCounts(states, write);
    return reportSummary(tally, wallMs, write);
}

function listGates(gates) {
    const pad = Math.max(...gates.map((gate) => gate.label.length));
    for (const gate of gates) {
        const lock = gate.lock === null ? "concurrent" : `serial ${gate.lock}`;
        const optional = gate.optional ? " (opt in)" : "";
        process.stdout.write(
            `  ${gate.id.padEnd(12)} ${gate.label.padEnd(pad)}  ${colors.dim(
                `${(gate.scope + optional).padEnd(16)}${lock}`
            )}\n`
        );
    }
}

async function main(argv) {
    let options;
    try {
        options = parseArgs(argv);
    } catch (error) {
        process.stderr.write(`${colors.red(error.message)}\n`);
        return 2;
    }
    if (options.help) {
        process.stdout.write(USAGE.join("\n"));
        return 0;
    }
    if (options.list) {
        listGates(
            selectGates(
                resolveGates({
                    nextest: false,
                    withCheck: options.withCheck,
                }),
                options
            )
        );
        return 0;
    }
    const selected = selectGates(
        resolveGates({ nextest: false, withCheck: options.withCheck }),
        options
    );
    if (selected.length === 0) {
        process.stderr.write("no gates selected\n");
        return 2;
    }
    return runCi(options);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
        for (const child of liveChildren) killTree(child);
        process.exit(signal === "SIGINT" ? 130 : 143);
    });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    process.exitCode = await main(process.argv.slice(2));
}

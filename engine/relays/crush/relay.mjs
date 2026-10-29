import { spawn, spawnSync, execSync } from "node:child_process";
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir, constants } from "node:os";

const IMPLEMENTER_KEY = "crush";

function fail(message, code = 2) {
 process.stderr.write(`relay: ${message}\n`);
 process.exit(code);
}

function parseArgs(argv) {
 const flagged = new Set();
 const opts = {
 lane: null,
 laneSource: null,
 brief: null,
 cd: process.cwd(),
 model: null,
 effort: null,
 timeout: null,
 outDir: null,
 mission: null,
 };

 for (let i = 0; i < argv.length; i += 1) {
 const arg = argv[i];
 const next = () => {
 const value = argv[i + 1];
 if (value === undefined) fail(`${arg} requires a value`);
 i += 1;
 return value;
 };

 switch (arg) {
 case "-h":
 case "--help":
 process.stdout.write(headerComment());
 process.exit(0);
 break;
 case "--brief": opts.brief = next(); break;
 case "--cd": opts.cd = resolve(next()); break;
 case "--lane": opts.lane = next(); break;
 case "--model": opts.model = next(); flagged.add("model"); break;
 case "--effort": opts.effort = next(); flagged.add("effort"); break;
 case "--read-only": fail("crush has no read-only mode");
 case "--timeout": opts.timeout = next(); flagged.add("timeout"); break;
 case "--out-dir": opts.outDir = resolve(next()); break;
 case "--mission": opts.mission = next(); break;
 default: fail(`unknown option: ${arg}`);
 }
 }

 applyFleetLane(opts, flagged);

 if (opts.model !== null && !/^[A-Za-z0-9][A-Za-z0-9._:@~/#-]*$/.test(opts.model)) {
 fail("--model contains unsupported characters (allowed: letters, digits, . _ : @ ~ / # -)");
 }

 if (opts.effort !== null && !/^[a-z]+$/.test(opts.effort)) {
 fail("--effort must be lowercase letters only");
 }

 if (opts.timeout !== null && parseDuration(opts.timeout) === null) {
 fail(`--timeout "${opts.timeout}" is invalid or too long; use a positive h/m/s duration`);
 }

 return opts;
}

function parseDuration(duration) {
 const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(duration);
 if (!match || (!match[1] && !match[2] && !match[3])) return null;
 try {
 const seconds =
 BigInt(match[1] || 0) * 3600n +
 BigInt(match[2] || 0) * 60n +
 BigInt(match[3] || 0);
 const milliseconds = seconds * 1000n;
 return Number(milliseconds);
 } catch {
 return null;
 }
}

function applyFleetLane(opts, flagged) {
 if (!opts.lane) return;
 const script = join(dirname(fileURLToPath(import.meta.url)), "../../delegate-setup/scripts/lane.mjs");
 if (!existsSync(script)) {
 fail("--lane requires the delegate-setup skill installed beside this relay");
 }
 const r = spawnSync(
 process.execPath,
 [script, "resolve", "--cwd", opts.cd, "--lane", opts.lane, "--implementer", IMPLEMENTER_KEY],
 { encoding: "utf8", env: process.env },
 );

 if (r.error) fail(`lane resolve failed: ${r.error.message}`);
 if (r.status !== 0) {
 fail((r.stderr || "lane resolve failed").trim().replace(/^lane\.mjs:\s*/, ""));
 }

 let resolved;
 try {
 const lines = (r.stdout || "").trim().split("\n").filter(Boolean);
 resolved = JSON.parse(lines[lines.length - 1]);
 } catch {
 fail("lane resolve returned invalid JSON");
 }

 opts.laneSource = resolved.source;
 for (const [field, value] of Object.entries(resolved.dials || {})) {
 if (flagged.has(field)) continue;
 opts[field] = value;
 }
}

function headerComment() {
 const src = readFileSync(new URL(import.meta.url), "utf8");
 const match = src.match(/\/\*\*([\s\S]*?)\*\//);
 if (!match) return "relay.mjs — dispatch a brief to crush run\n";
 return match[1].replace(/^\s*\* ?/gm, "").trim() + "\n";
}

function readBrief(opts) {
 if (opts.brief) {
 if (!existsSync(opts.brief)) fail(`brief file not found: ${opts.brief}`);
 return readFileSync(opts.brief, "utf8");
 }

 if (process.stdin.isTTY) {
 fail("no --brief given and stdin is a TTY; pass --brief <file> or pipe the brief on stdin");
 }

 let stdin = "";
 try {
 stdin = readFileSync(0, "utf8");
 } catch {
 stdin = "";
 }
 return stdin;
}

function crushVersion() {
 try {
 const version = execSync("crush --version", { encoding: "utf8", timeout: 10_000 }).trim();
 return { version: version || "unknown", error: null };
 } catch (error) {
 if (error?.code === "ENOENT") return { version: null, error: null };
 return { version: null, error };
 }
}

function gitTouchedFiles(cwd) {
 try {
 const output = execSync("git status --porcelain", {
 cwd,
 encoding: "utf8",
 timeout: 10_000,
 });
 return output.split("\n").map((line) => line.trimEnd()).filter(Boolean);
 } catch {
 return null;
 }
}

function timestamp() {
 return new Date().toISOString().replace(/[:.]/g, "-");
}

function prepareRunDir(opts, brief) {
 const startedAt = new Date().toISOString();
 const outDir = opts.outDir || join(tmpdir(), "delegate-relay", `${basename(opts.cd) || "repo"}-${timestamp()}`);
 mkdirSync(outDir, { recursive: true });
 const run = {
 startedAt,
 resultPath: join(outDir, "result.json"),
 };
 writeFileSync(join(outDir, "brief.txt"), brief, "utf8");
 return run;
}

function makeResultWriter(opts, version, run) {
 return (extra) => {
 const result = {
 schema: "delegate-relay.result.v1",
 lane: opts.lane,
 laneSource: opts.laneSource,
 tool: "crush",
 workdir: opts.cd,
 model: opts.model,
 effort: opts.effort,
 crushVersion: version,
 startedAt: run.startedAt,
 finishedAt: new Date().toISOString(),
 ...extra,
 };

 const temporary = `${run.resultPath}.${process.pid}.tmp`;
 writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, "utf8");
 renameSync(temporary, run.resultPath);
 return result;
 };
}

function reportUnavailable(writeResult, resultPath) {
 const result = writeResult({
 status: "crush_unavailable",
 exitCode: 127,
 signal: null,
 sessionId: null,
 finalMessage: "",
 touchedFiles: null,
 cost: null,
 });
 printSummary(result, resultPath);
 process.stderr.write("relay: `crush` not found on PATH. Install it.\n");
 process.exit(127);
}

function dispatchToCrush(opts, brief, run, writeResult) {
 // crush run is non-interactive: it auto-accepts permissions and writes files headlessly
 // (verified v0.98.2), so no --yolo is needed — and `run` rejects --yolo as an unknown flag.
 const argv = ["run", "--quiet"];
 if (opts.model) argv.push("-m", opts.model);
 if (opts.effort) argv.push("--reasoning-effort", opts.effort);
 argv.push("-c", opts.cd);
 // Deliver the brief as crush's prompt argument (crush run takes [prompt...]); the relay
 // never wrote it to stdin, so without this crush ran with an empty prompt and did nothing.
 argv.push(brief);

 const child = spawn("crush", argv, {
 cwd: opts.cd,
 env: { ...process.env },
 stdio: ["pipe", "pipe", "pipe"],
 });

 let stdout = "";
 let stderr = "";

 child.stdout.on("data", (chunk) => { stdout += chunk; });
 child.stderr.on("data", (chunk) => { stderr += chunk; });

 let settled = false;
 let watchdogFired = false;
 let watchdogTimer = null;
 const timeoutMs = opts.timeout === null ? null : parseDuration(opts.timeout);

 if (timeoutMs !== null) {
 watchdogTimer = setTimeout(() => {
 watchdogFired = true;
 child.kill();
 }, timeoutMs);
 }

 const clearWatchdog = () => {
 if (watchdogTimer) clearTimeout(watchdogTimer);
 };

 for (const sig of ["SIGTERM", "SIGINT"]) {
 process.on(sig, () => {
 if (settled) return;
 settled = true;
 clearWatchdog();
 child.kill();
 const result = writeResult({
 status: "aborted",
 exitCode: 128 + (constants.signals[sig] || 15),
 signal: sig,
 sessionId: null,
 finalMessage: "",
 touchedFiles: gitTouchedFiles(opts.cd),
 cost: null,
 error: `the relay was killed by ${sig}; crush was terminated with it`,
 });
 printSummary(result, run.resultPath);
 process.exit(result.exitCode);
 });
 }

 // Spawn failure (e.g. crush not on PATH -> ENOENT) emits 'error', not 'exit'. Without this handler
 // the unhandled 'error' event crashes the relay and no result.json is written.
 child.on("error", (err) => {
 if (settled) return;
 settled = true;
 clearWatchdog();
 const enoent = err && err.code === "ENOENT";
 const result = writeResult({
 status: enoent ? "crush_unavailable" : "failed",
 exitCode: enoent ? 127 : 1,
 signal: null,
 sessionId: null,
 finalMessage: "",
 touchedFiles: gitTouchedFiles(opts.cd),
 cost: null,
 error: `failed to spawn crush: ${err && err.message ? err.message : String(err)}`,
 });
 printSummary(result, run.resultPath);
 process.exit(result.exitCode);
 });

 child.on("exit", (code, signal) => {
 if (settled) return;
 settled = true;
 clearWatchdog();
 const touchedFiles = gitTouchedFiles(opts.cd);
 const succeeded = code === 0;
 const result = writeResult({
 status: succeeded ? "completed" : watchdogFired ? "timeout" : "failed",
 exitCode: code ?? (signal ? 128 + (constants.signals[signal] || 15) : 1),
 signal: signal ?? null,
 sessionId: null,
 finalMessage: stdout.trim(),
 touchedFiles,
 cost: null,
 ...(watchdogFired ? { error: `crush did not finish within --timeout ${opts.timeout}; killed by the relay watchdog` } : {}),
 });
 recordLedger(opts, result);
 printSummary(result, run.resultPath);
 process.exit(result.exitCode);
 });

 child.stdin.write(brief);
 child.stdin.end();
}

// Best-effort economy ledger spend record (dispatch-only: this relay captures no tokens/cost).
// Never throws and never alters the exit code.
function recordLedger(opts, result) {
  try {
    if (result.status !== "completed" || !opts.mission || !opts.model) return;
    spawnSync(process.execPath, ["/home/kali/.config/delegate-skills/economy.mjs", "spend", "--model", opts.model, "--mission", opts.mission], { stdio: "ignore", timeout: 30_000 });
  } catch {}
}

function printSummary(result, resultPath) {
 const lines = [];
 lines.push("");
 lines.push(`relay: ${result.status} (exit ${result.exitCode}${result.signal ? `, killed by ${result.signal}` : ""})  ·  crush ${result.crushVersion ?? "?"}`);
 lines.push(`touched files: ${result.touchedFiles?.length || 0}`);
 lines.push("");
 lines.push("--- crush final report ---");
 lines.push(result.finalMessage || "(no final message captured)");
 lines.push("--- end report ---");
 lines.push("");
 lines.push(`result: ${resultPath}`);
 process.stdout.write(`${lines.join("\n")}\n`);
}

function main() {
 const opts = parseArgs(process.argv.slice(2));
 const brief = readBrief(opts);
 if (!brief.trim()) fail("empty brief (pass --brief <file> or pipe the brief on stdin)");

 const run = prepareRunDir(opts, brief);
 const probe = crushVersion();
 const writeResult = makeResultWriter(opts, probe.version, run);

 if (!probe.version && !probe.error) {
 reportUnavailable(writeResult, run.resultPath);
 return;
 }

 dispatchToCrush(opts, brief, run, writeResult);
}

main();
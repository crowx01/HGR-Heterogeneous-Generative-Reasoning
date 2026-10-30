// mission.mjs — SEQUENTIAL salary+handover mission driver for the delegation economy.
// Picks a starting model by role/intelligence/salary/pool-health, dispatches it via its relay with a
// per-task BUDGET + COMPLETION PROTOCOL brief, and on completion/failure/429/budget-exhaustion hands
// the work forward (HANDOFF.md accumulates) down the model's handover chain until done or stuck.
// Usage: node mission.mjs --brief <file> --role <deep|analysis|code|grind> --mission <name>
//        [--cd <dir>] [--out-dir <dir>] [--max-steps <n>] [--timeout <dur>]
import { spawn, execFileSync } from "node:child_process";
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, statSync, copyFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { snapshotCritical } from './guard.mjs';

const DIR = process.env.CONFIG_DIR || "/home/kali/.config/delegate-skills";
const SKILLS = "/home/kali/.claude/skills";
const QUOTA_RE = /resource.?exhausted|exceeded your current quota|insufficient_quota|quota.*exceeded|\b429\b|too many requests|rate.?limit/i;

const HELP = `
mission.mjs — sequential salary+handover mission driver.

Usage:
  node mission.mjs --brief <file> --role <deep|analysis|code|grind> --mission <name> \\
       [--cd <dir>] [--out-dir <dir>] [--max-steps <n>] [--timeout <dur>]

  --brief <file>    REQUIRED. Original task brief (text file).
  --role <role>     REQUIRED. Starting role: deep | analysis | code | grind.
  --mission <name>  REQUIRED. Ledger/mission label (ledger.<name>.json).
  --cd <dir>        Working root passed to each relay (default: cwd). HANDOFF.md lives here.
  --out-dir <dir>   Where per-step dirs + MISSION_RESULT.json land (default: fresh tmp dir).
  --max-steps <n>   Max sequential dispatches (default: 8).
  --timeout <dur>   Passed through to each relay (e.g. "20m").
  -h, --help        Print this help, exit 0.

Exit codes: 0 complete · 2 bad args · 3 none/stuck/incomplete.
`;

// -------- pure helpers (exercised by --self-test) --------

function parseArgv(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "-h" || t === "--help") { a.help = true; continue; }
    if (t === "--self-test") { a.selfTest = true; continue; }
    if (t.startsWith("--")) { a[t.slice(2)] = argv[i + 1]; i++; }
  }
  return a;
}

// economy id -> relay --model (strip leading "<cli>/" segment).
function stripModel(cli, id) {
  return id.replace(new RegExp("^" + cli.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/"), "");
}

function salaryRemaining(model, ledger) {
  if (model.salary_dispatches === "inf") return "inf";
  const salary = typeof model.salary_dispatches === "number" ? model.salary_dispatches : Infinity;
  const used = ledger.dispatches?.[model.id] || 0;
  return Math.max(0, salary - used);
}

function hasSalary(model, ledger) {
  const r = salaryRemaining(model, ledger);
  return r === "inf" || r > 0;
}

// -------- io helpers (best-effort) --------

function loadJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch (e) {
    if (existsSync(path)) {
      console.error('ERROR: ' + path + ' is not valid JSON: ' + e.message);
      process.exit(2);
    }
    return fallback;
  }
}

function loadLedger(mission) {
  const l = loadJson(join(DIR, `ledger.${mission}.json`), {});
  l.dispatches = l.dispatches || {};
  l.chokes = l.chokes || [];
  return l;
}

function readText(path) {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

function handoffMtime(cd) {
  try { return statSync(join(cd, "HANDOFF.md")).mtimeMs; } catch { return 0; }
}

function writeResult(outDir, obj) {
  try { writeFileSync(join(outDir, "MISSION_RESULT.json"), JSON.stringify(obj, null, 2) + "\n"); }
  catch (e) { console.warn("WARN could not write MISSION_RESULT.json:", e.message); }
}

// -------- model selection --------

function upFn(poolStatus) {
  return (pool) => {
    const p = poolStatus.pools?.[pool];
    if (!p) return false;
    if (p.status === "UP" || p.status === "UP_THROTTLED") return true;
    if ((p.status === "EXHAUSTED" || p.status === "DOWN_429") && p.reset && Date.parse(p.reset) <= Date.now()) return true;
    return false;
  };
}

// Eligible + healthy: pool up, salary left, not choked. (Fallback pick applies the same filter across
// all roles rather than up()-only — a choked/broke model is never a good START; assumption noted in report.)
function usable(model, ledger, up) {
  if (!model) return false;
  if (ledger.chokes.includes(model.id)) return false;
  if (!up(model.quota_pool)) return false;
  return hasSalary(model, ledger);
}

function pickStart(role, models, ledger, up) {
  const byIntel = (a, b) => (b.intelligence - a.intelligence) || a.id.localeCompare(b.id);
  const inRole = models.filter((m) => m.role === role && usable(m, ledger, up)).sort(byIntel);
  if (inRole.length) return inRole[0];
  const any = models.filter((m) => usable(m, ledger, up)).sort(byIntel);
  return any[0] || null;
}

// Next model after a choke: honor choke's handover_to if healthy, else walk the choked model's chain.
function nextInChain(chokedModel, chokeHandoverId, models, ledger, up) {
  const byId = (id) => models.find((m) => m.id === id);
  const cand = chokeHandoverId ? byId(chokeHandoverId) : null;
  if (usable(cand, ledger, up)) return cand;
  for (const id of chokedModel.handover_to || []) {
    const m = byId(id);
    if (usable(m, ledger, up)) return m;
  }
  return null;
}

// -------- dispatch --------

function buildBrief(outDir, step, model, role, remaining, cd, briefPath) {
  const parts = [];
  parts.push(
    `BUDGET: you are model ${model.id} (role ${role}). You have ${remaining} dispatch(es) of salary ` +
    `for this mission. Spend them efficiently.`
  );
  parts.push(
    "COMPLETION PROTOCOL: When the mission is fully done, end your final message with the exact token " +
    "MISSION_COMPLETE on its own line. If you CANNOT finish within your budget, write a file HANDOFF.md " +
    "in the working directory containing sections: ## Done, ## Remaining, ## Artifacts (paths), " +
    "## Next steps; then end your message with the exact token INCOMPLETE on its own line. Never " +
    "fabricate completion."
  );
  parts.push("TOOLING: You are running on Kali Linux with full access to its installed command-line tools (nmap, ffuf, gobuster, curl, jq, sqlmap, nuclei, httpx, python3, node, git, and the rest) plus the project toolbelt. Actually RUN the appropriate real tools to accomplish the task. Do NOT hand-simulate, guess, or describe output you did not produce. Prefer a real tool invocation over manual reasoning whenever one fits the step.");
  const prior = readText(join(cd, "HANDOFF.md"));
  if (prior.trim()) {
    parts.push("PRIOR HANDOFF (continue this work, do not restart):\n" + prior);
  }
  parts.push(readText(briefPath));
  const file = join(outDir, `attempt-step-${step}.txt`);
  writeFileSync(file, parts.join("\n\n"));
  return file;
}

async function dispatch(model, attemptBrief, cd, stepDir, timeout) {
  const relayPath = join(SKILLS, model.cli + "-delegate", "scripts", "relay.mjs");
  if (!existsSync(relayPath)) return { status: "no_relay", relayPath };
  mkdirSync(stepDir, { recursive: true });
  const args = [relayPath, "--brief", attemptBrief, "--cd", cd, "--out-dir", stepDir,
    "--model", stripModel(model.cli, model.id)];
  if (timeout) args.push("--timeout", timeout);

  await new Promise((resolve) => {
    try {
      const child = spawn("node", args, { stdio: "inherit" });
      child.on("exit", resolve);
      child.on("error", (e) => { console.warn("WARN relay spawn error:", e.message); resolve(); });
    } catch (e) { console.warn("WARN relay spawn threw:", e.message); resolve(); }
  });

  const resultPath = join(stepDir, "result.json");
  if (!existsSync(resultPath)) return { status: "no_result" };
  const result = loadJson(resultPath, null);
  if (!result) return { status: "bad_result" };
  result._events = readText(join(stepDir, "events.jsonl"));
  return result;
}

function spend(model, mission) {
  try {
    const out = execFileSync("node", ["economy.mjs", "spend", "--model", model.id, "--mission", mission],
      { cwd: DIR, encoding: "utf8" });
    try {
      const lines = String(out).trim().split("\n").filter(Boolean);
      const r = JSON.parse(lines[lines.length - 1]);
      if (r && r.model === null) return false; // economy rejected: model not eligible
    } catch { /* non-JSON output: assume spent */ }
    return true;
  } catch (e) { console.warn(`WARN spend failed for ${model.id}:`, e.message); return false; }
}

function choke(model, mission, why) {
  try {
    const out = execFileSync("node",
      ["economy.mjs", "choke", "--model", model.id, "--mission", mission, "--why", why],
      { cwd: DIR, encoding: "utf8" });
    return (JSON.parse(out) || {}).handover_to || null;
  } catch (e) {
    console.warn(`WARN choke failed for ${model.id}:`, e.message);
    return null; // fall back to in-code chain walk
  }
}

// -------- main --------

async function main() {
  const a = parseArgv(process.argv.slice(2));
  if (a.help) { console.log(HELP); process.exit(0); }
  if (a.selfTest) { return selfTest(); }

  const briefPath = a.brief;
  const role = a.role;
  const mission = a.mission;
  const missing = [];
  if (!briefPath) missing.push("--brief");
  if (!role) missing.push("--role");
  if (!mission) missing.push("--mission");
  if (missing.length) { console.error(`ERROR missing required: ${missing.join(", ")}\n${HELP}`); process.exit(2); }
  if (!existsSync(briefPath)) { console.error(`ERROR brief file not found: ${briefPath}`); process.exit(2); }
  if (!["deep", "analysis", "code", "grind"].includes(role)) {
    console.error(`ERROR --role must be one of deep|analysis|code|grind (got "${role}")`); process.exit(2);
  }

  const cd = a.cd || process.cwd();
  const outDir = a["out-dir"] || join(tmpdir(), `mission-${Date.now()}`);
  const maxSteps = Number.parseInt(a["max-steps"], 10) > 0 ? Number.parseInt(a["max-steps"], 10) : 8;
  const timeout = a.timeout;
  mkdirSync(outDir, { recursive: true });

  // 1. Refresh live pool status (best-effort).
  try { execFileSync("node", ["route.mjs", "--json"], { cwd: DIR, stdio: "inherit" }); }
  catch (e) { console.warn("WARN route.mjs refresh failed (using stale pool_status):", e.message); }

  // 2. Load state.
  const models = loadJson(join(DIR, "models.json"), { models: [] }).models || [];
  const poolStatus = loadJson(join(DIR, "pool_status.json"), { pools: {} });
  const up = upFn(poolStatus);
  let ledger = loadLedger(mission);

  // 3. Starting model.
  let current = pickStart(role, models, ledger, up);
  if (!current) {
    console.error("MISSION-NONE all pools down");
    writeResult(outDir, { mission, status: "none", role, steps: [] });
    process.exit(3);
  }

  const steps = [];
  let lastHandoff = null;
  const visited = new Set();

  // 4. Sequential loop.
  for (let k = 1; k <= maxSteps; k++) {
    ledger = loadLedger(mission);
    visited.add(current.id);
    const remaining = salaryRemaining(current, ledger);
    console.log(`\n=== step ${k}: ${current.id} (role ${current.role}, salary ${remaining}) ===`);

    const attemptBrief = buildBrief(outDir, k, current, role, remaining, cd, briefPath);
    const hBefore = handoffMtime(cd);

    const spendOk = spend(current, mission); // (c) record dispatch; false => economy rejected (ineligible)
    ledger = loadLedger(mission); // reflect the spend for budget accounting
    const ineligible = !spendOk;

    const stepDir = join(outDir, `step-${k}-${current.cli}`);
    let result;
    if (ineligible) {
      result = { status: "ineligible", finalMessage: "" }; // skip dispatch; hand over below
    } else {
      const _g = snapshotCritical(cd);
      result = await dispatch(current, attemptBrief, cd, stepDir, timeout);
      _g.restore();
    }

    const finalMessage = result.finalMessage || "";
    const status = result.status || "";
    const exitCode = typeof result.exitCode === "number" ? result.exitCode : null;
    const errStr = Array.isArray(result.error) ? result.error.join(" ") : (result.error || "");
    const blob = `${result._events || ""} ${result.stderrTail || ""} ${errStr} ${finalMessage}`;
    const hAfter = handoffMtime(cd);
    const freshHandoff = hAfter > 0 && hAfter !== hBefore;

    const failed = status === "failed" || status === "no_result" || status === "bad_result"
      || status === "no_relay" || (exitCode !== null && exitCode !== 0);
    const quota = QUOTA_RE.test(blob);
    const remAfter = current.salary_dispatches === "inf" ? Infinity
      : (typeof current.salary_dispatches === "number" ? current.salary_dispatches : Infinity)
        - (ledger.dispatches?.[current.id] || 0);
    const budgetDone = remAfter <= 0;
    const incomplete = /(^|\n)\s*INCOMPLETE\s*(\n|$)/.test(finalMessage) || freshHandoff;

    const stepRec = { step: k, model: current.id, cli: current.cli, status, exitCode };

    // (f) decide. Completion wins.
    if (/(^|\n)\s*MISSION_COMPLETE\s*(\n|$)/.test(finalMessage)) {
      stepRec.outcome = "complete";
      steps.push(stepRec);
      console.log(`MISSION_COMPLETE at step ${k} by ${current.id}`);
      writeResult(outDir, { mission, status: "complete", steps, finalModel: current.id });
      process.exit(0);
    }

    if (failed || quota || budgetDone || incomplete || ineligible) {
      const reason = ineligible ? "economy ineligible (budget/pool/cost cap)"
        : failed ? (status || `exit ${exitCode}`)
        : quota ? "quota/429"
        : budgetDone ? "salary exhausted"
        : "incomplete";
      stepRec.outcome = "handover";
      stepRec.reason = reason;
      steps.push(stepRec);
      console.log(`handover from ${current.id}: ${reason}`);

      // Archive progress so the chain accumulates context.
      if (existsSync(join(cd, "HANDOFF.md"))) {
        try {
          const archive = join(cd, `HANDOFF.step-${k}.md`);
          copyFileSync(join(cd, "HANDOFF.md"), archive);
        } catch (e) { console.warn("WARN HANDOFF.md archive failed:", e.message); }
      }

      const chokeHandover = choke(current, mission, reason);
      ledger = loadLedger(mission); // chokes list now includes current
      const next = nextInChain(current, chokeHandover, models, ledger, up);
      lastHandoff = { from: current.id, chokeHandover, to: next ? next.id : null, reason };

      if (!next || visited.has(next.id)) {
        console.error("MISSION-STUCK: chain exhausted or cycle detected");
        writeResult(outDir, { mission, status: "stuck", steps, lastHandoff });
        process.exit(3);
      }
      current = next;
      continue;
    }

    // (continue) ran, not complete, not failed, salary remains -> same model next iteration.
    stepRec.outcome = "continue";
    steps.push(stepRec);
    console.log(`continue with ${current.id} (salary left ${remAfter})`);
  }

  // 5. Max steps exhausted.
  console.error("MISSION-INCOMPLETE: max steps");
  writeResult(outDir, { mission, status: "incomplete", steps, lastHandoff });
  process.exit(3);
}

// -------- self-check (no dispatch, no quota) --------

function selfTest() {
  const assert = (c, m) => { if (!c) { console.error("SELF-TEST FAIL:", m); process.exit(1); } };
  assert(stripModel("aider", "aider/sambanova/DeepSeek-V3.2") === "sambanova/DeepSeek-V3.2", "stripModel aider");
  assert(stripModel("kilo", "kilo/kilo-auto/free") === "kilo-auto/free", "stripModel kilo");
  const led = { dispatches: { a: 1 }, chokes: ["c"] };
  assert(salaryRemaining({ id: "a", salary_dispatches: 3 }, led) === 2, "salaryRemaining number");
  assert(salaryRemaining({ id: "x", salary_dispatches: "inf" }, led) === "inf", "salaryRemaining inf");
  assert(hasSalary({ id: "a", salary_dispatches: 3 }, led) === true, "hasSalary left");
  assert(hasSalary({ id: "a", salary_dispatches: 1 }, led) === false, "hasSalary spent");
  const models = [
    { id: "d1", role: "deep", intelligence: 90, quota_pool: "P_UP", salary_dispatches: 2, cli: "aider", handover_to: ["d2", "c1"] },
    { id: "d2", role: "deep", intelligence: 95, quota_pool: "P_DOWN", salary_dispatches: 2, cli: "aider", handover_to: [] },
    { id: "c1", role: "code", intelligence: 70, quota_pool: "P_UP", salary_dispatches: 2, cli: "kilo", handover_to: [] },
  ];
  const ps = { pools: { P_UP: { status: "UP" }, P_DOWN: { status: "DOWN" } } };
  const up = upFn(ps);
  const l0 = { dispatches: {}, chokes: [] };
  assert(pickStart("deep", models, l0, up).id === "d1", "pickStart skips down pool for lower-intel up");
  assert(pickStart("grind", models, l0, up).id === "d1", "pickStart falls back cross-role to best up by intel");
  // choke handover points at a down pool -> walk chain to c1
  assert(nextInChain(models[0], "d2", models, { dispatches: {}, chokes: ["d1"] }, up).id === "c1", "nextInChain walks past down");
  console.log("SELF-TEST OK");
  process.exit(0);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });

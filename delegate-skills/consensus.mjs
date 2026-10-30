import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { inferPool, inferRole } from './infer.mjs';
import { snapshotCritical } from './guard.mjs';

const HELP_TEXT = `
# consensus.mjs
# Fan-out engine for the delegate fleet.
# Given one brief, dispatches the same brief to N fleet lanes in parallel,
# collects every relay's result.json, and writes a single combined consensus.json.
#
# CLI:
#   node consensus.mjs --brief <file> --lanes <l1,l2,l3> [--cd <dir>] [--out-dir <dir>] [--timeout <dur>] [--mission <name>]
#   --brief <file>   REQUIRED. The brief text file. Error if missing/not found.
#   --lanes <csv>    REQUIRED. Comma-separated lane names (e.g. "crush,patch,tests"). Error if <1 lane.
#   --cd <dir>       working root passed to each relay (default: process.cwd()).
#   --out-dir <dir>  where to write consensus.json + per-lane subdirs (default: fresh dir under os.tmpdir()).
#   --timeout <dur>  passed through to each relay as --timeout (optional; e.g. "20m").
#   --mission <name> optional label recorded in consensus.json.
#   -h/--help        print this help, exit 0.
`;

const DSK = process.env.CONFIG_DIR || "/home/kali/.config/delegate-skills";
const configPath = `${DSK}/config.json`;
const economyScript = `${DSK}/economy.mjs`;
const modelsPath = `${DSK}/models.json`;

// Map a lane (implementer + configured model) to its economy model-DB id, which is NOT a lane name.
// Economy ids look like "<implementer>/.../<model-basename>". Fuzzy-match: same implementer prefix,
// id ends with the lane model's last path segment. Returns null if no match (then the dispatch is
// recorded as unmetered rather than spent).
function economyIdFor(implementer, model, modelsDb) {
  if (!model) return null;
  const tail = model.split("/").pop();
  const hit = modelsDb.find((m) => m.id && m.id.startsWith(implementer + "/") && m.id.endsWith(tail));
  return hit ? hit.id : null;
}

// Task 4: after a lane returns, reflect its outcome in pool_status.json. A quota/429 failure marks
// the POOL EXHAUSTED (+reset); any other failure (no_result, bad_result, CLI/preflight) marks the
// LANE degraded, leaving pool status to the scan. Fully synchronous -> atomic across parallel lanes.
// Best-effort: never throws into the lane promise.
function recordOutcome(lane, laneOutDir, result) {
  try {
    const statusStr = (result && result.status) || "";
    const failed = statusStr === "failed" || statusStr === "no_result" || statusStr === "bad_result"
      || (result && typeof result.exitCode === "number" && result.exitCode !== 0);
    if (!failed) return;
    let blob = "";
    try { blob += readFileSync(join(laneOutDir, "events.jsonl"), "utf8"); } catch {}
    if (result) blob += " " + (result.stderrTail || "") + " " + (result.finalMessage || "");
    const EXHAUST = /resource.?exhausted|exceeded your current quota|free_tier.*(limit|count).{0,20}0|insufficient_quota|quota.*exceeded/i;
    const is429 = /\b429\b|too many requests/i.test(blob);
    const ps = JSON.parse(readFileSync(`${DSK}/pool_status.json`, "utf8"));
    ps.pools = ps.pools || {};
    const mdl = JSON.parse(readFileSync(`${DSK}/models.json`, "utf8")).models || [];
    const tail = (lane.model || "").split("/").pop();
    const cur = mdl.find((m) => m.id.startsWith(lane.implementer + "/") && m.id.endsWith(tail));
    const pool = cur && cur.quota_pool;
    if (pool && (is429 || EXHAUST.test(blob))) {
      const m = blob.match(/retryDelay"?\s*:\s*"?(\d+)s/i);
      const reset = m ? new Date(Date.now() + parseInt(m[1], 10) * 1000).toISOString() : null;
      ps.pools[pool] = { ...(ps.pools[pool] || {}), status: "EXHAUSTED", reset, note: `EXHAUSTED via dispatch ${lane.lane}${reset ? `; reset ${reset}` : ""}` };
    } else {
      ps.degraded_lanes = ps.degraded_lanes || {};
      ps.degraded_lanes[lane.lane] = { reason: statusStr || "failed", implementer: lane.implementer, at: new Date().toISOString() };
    }
    writeFileSync(`${DSK}/pool_status.json`, JSON.stringify(ps, null, 2) + "\n");
  } catch { /* best-effort */ }
}

function parseArgv(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "-h" || t === "--help") { a.help = true; continue; }
    if (t.startsWith("--")) { a[t.slice(2)] = argv[i + 1]; i++; }
  }
  return a;
}

function parseArgs(a) {
  const parsed = {
    brief: a.brief,
    lanes: a.lanes?.split(",").filter(Boolean),
    cd: a.cd || process.cwd(),
    outDir: a["out-dir"] || join(tmpdir(), `consensus-${Date.now()}`),
    timeout: a.timeout,
    mission: a.mission,
  };

  if (!parsed.brief) throw new Error("Missing required argument: --brief <file>");
  if (!existsSync(parsed.brief)) throw new Error(`brief file not found: ${parsed.brief}`);
  if (!parsed.lanes || parsed.lanes.length < 1) throw new Error("Missing required argument: --lanes <l1,l2,...>");

  return parsed;
}

async function main() {
  const raw = parseArgv(process.argv.slice(2));
  if (raw.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }
  const args = parseArgs(raw);

  const config = JSON.parse(readFileSync(configPath, "utf8"));
  let modelsDb = [];
  try {
    const mj = JSON.parse(readFileSync(modelsPath, "utf8"));
    modelsDb = Array.isArray(mj.models) ? mj.models : Array.isArray(mj) ? mj : Object.values(mj.models || mj);
  } catch { /* metering is best-effort; no DB -> every dispatch recorded unmetered */ }

  const lanes = args.lanes.map((lane) => {
    const laneConfig = config.lanes?.[lane];
    if (!laneConfig) {
      return { lane, status: "unknown_lane" };
    }

    const relayPath = resolve(
      "/home/kali/.claude/skills", laneConfig.implementer + "-delegate", "scripts", "relay.mjs"
    );

    if (!existsSync(relayPath)) {
      return { lane, implementer: laneConfig.implementer, status: "no_relay" };
    }

    return { lane, implementer: laneConfig.implementer, relayPath, model: laneConfig.model };
  });

  mkdirSync(args.outDir, { recursive: true });

  // Prepend the TOOLING directive so every fan-out lane runs real Kali tools, not simulated work.
  try {
    const TOOLING = "TOOLING: You are running on Kali Linux with full access to its installed command-line tools (nmap, ffuf, gobuster, curl, jq, sqlmap, nuclei, httpx, python3, node, git, and the rest) plus the project toolbelt. Actually RUN the appropriate real tools to accomplish the task. Do NOT hand-simulate, guess, or describe output you did not produce. Prefer a real tool invocation over manual reasoning whenever one fits the step.";
    const wrapped = join(args.outDir, "brief.tooling.txt");
    writeFileSync(wrapped, TOOLING + "\n\n" + readFileSync(args.brief, "utf8"));
    args.brief = wrapped;
  } catch { /* brief unreadable: leave args.brief as-is */ }

  // Pre-dispatch: refresh live pool status (route.mjs runs the cheap scan + a >6h re-tier) and
  // auto-substitute any lane whose pool is EXHAUSTED/DOWN with the best UP model of the same role,
  // switching relay + --model so we never dispatch into a dead pool. Best-effort; never blocks.
  try {
    execFileSync("node", [`${DSK}/route.mjs`, "--json"], { cwd: DSK, stdio: "inherit" });
    const ps = JSON.parse(readFileSync(`${DSK}/pool_status.json`, "utf8"));
    const mdl = JSON.parse(readFileSync(`${DSK}/models.json`, "utf8")).models || [];
    const up = (p) => { const s = ps.pools?.[p]?.status; return s === "UP" || s === "UP_THROTTLED"; };
    const bestForRole = (role) => mdl
      .filter((m) => m.role === role && up(m.quota_pool))
      .sort((a, b) => (b.intelligence - a.intelligence) || a.id.localeCompare(b.id))[0] || null;
    for (const lane of lanes) {
      if (lane.status) continue;
      // Full-path match first (avoid suffix collisions like .../gpt-oss-120b); tail-only fallback.
      const full = String(lane.model);
      const tail = full.split("/").pop();
      const cur = mdl.find((m) => m.id.startsWith(lane.implementer + "/") && (m.id === lane.implementer + "/" + full || m.id.endsWith("/" + full)))
        || mdl.find((m) => m.id.startsWith(lane.implementer + "/") && m.id.endsWith("/" + tail));
      // cur null = config drifted from models.json: infer pool + role so we still avoid dead pools.
      const pool = cur ? cur.quota_pool : inferPool(lane.implementer, lane.model);
      const role = cur ? cur.role : inferRole(lane.lane);
      if (pool && up(pool)) continue; // pool already usable -> leave lane as-is
      const sub = bestForRole(role);
      if (!sub) { console.warn(`ROUTE-NONE lane=${lane.lane} role=${role} all pools down`); continue; }
      const subRelay = resolve("/home/kali/.claude/skills", sub.cli + "-delegate", "scripts", "relay.mjs");
      if (!existsSync(subRelay)) { console.warn(`ROUTE-SWAP skipped lane=${lane.lane}: no relay for ${sub.cli}`); continue; }
      console.log(`ROUTE-SWAP lane=${lane.lane} pool=${pool || "?"} status=${pool ? ps.pools?.[pool]?.status : "unknown"}${cur ? "" : " (inferred)"} -> ${sub.id} (role ${role})`);
      lane.implementer = sub.cli;
      lane.relayPath = subRelay;
      lane.model = sub.id.replace(new RegExp("^" + sub.cli + "/"), ""); // economy id -> provider/model for --model
      lane.substituted = true;
    }
  } catch (e) {
    console.warn("router refresh/substitute failed (continuing with configured lanes):", e.message);
  }

  const lanePromises = lanes.map(async (lane) => {
    if (lane.status) {
      return lane;
    }

    const laneOutDir = join(args.outDir, lane.lane);
    mkdirSync(laneOutDir, { recursive: true });

    const relayArgs = [
      lane.relayPath,
      "--brief", args.brief,
      "--cd", args.cd,
      "--out-dir", laneOutDir,
    ];

    // A substituted lane runs a different implementer's relay, so pass the model explicitly instead
    // of --lane (which would re-resolve the original implementer's config).
    if (lane.substituted) {
      relayArgs.push("--model", lane.model);
    } else {
      relayArgs.push("--lane", lane.lane);
    }

    if (args.timeout) {
      relayArgs.push("--timeout", args.timeout);
    }

    // Economy metering (best-effort): record the dispatch against the model's quota ledger so a
    // consensus run can't drain a shared pool invisibly. Non-fatal — a missing id/mission just means
    // the lane is recorded unmetered.
    let metered = false;
    const economyId = economyIdFor(lane.implementer, lane.model, modelsDb);
    if (economyId && args.mission) {
      try {
        execFileSync("node", [economyScript, "spend", "--model", economyId, "--mission", args.mission], { stdio: "ignore" });
        metered = true;
      } catch { /* model-not-found or ledger error: leave metered=false */ }
    }

    const child = spawn("node", relayArgs, { stdio: "inherit" });
    await new Promise((resolve) => child.on("exit", resolve));

    const resultPath = join(laneOutDir, "result.json");
    if (!existsSync(resultPath)) {
      recordOutcome(lane, laneOutDir, { status: "no_result" });
      return { ...lane, status: "no_result", metered, economyId };
    }

    let result;
    try {
      result = JSON.parse(readFileSync(resultPath, "utf8"));
    } catch (e) {
      recordOutcome(lane, laneOutDir, { status: "bad_result" });
      return { ...lane, status: "bad_result", metered, economyId, error: String(e.message || e) };
    }
    recordOutcome(lane, laneOutDir, result);
    return { ...lane, ...result, metered, economyId };
  });

  const _g = snapshotCritical(DSK);
  const laneResults = await Promise.all(lanePromises);
  _g.restore();

  const consensus = {
    schema: "delegate-consensus.v1",
    mission: args.mission || null,
    brief_path: resolve(args.brief),
    cd: resolve(args.cd),
    generated: new Date().toISOString(),
    lanes: laneResults.map((lane) => ({
      lane: lane.lane,
      implementer: lane.implementer,
      model: lane.model,
      status: lane.status,
      exitCode: lane.exitCode ?? null,
      metered: lane.metered ?? false,
      economyId: lane.economyId ?? null,
      finalMessage: lane.finalMessage ?? null,
      touchedFiles: lane.touchedFiles ?? null,
    })),
  };

  const consensusPath = join(args.outDir, "consensus.json");
  writeFileSync(consensusPath, JSON.stringify(consensus, null, 2));

  laneResults.forEach((lane) => {
    console.log(`${lane.lane} | ${lane.implementer}/${lane.model} | ${lane.status}`);
  });

  console.log(`Consensus written to ${consensusPath}`);

  const success = laneResults.some((lane) => lane.status === "completed");
  process.exit(success ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

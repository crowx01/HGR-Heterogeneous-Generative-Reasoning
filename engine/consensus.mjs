import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

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

const configPath = "/home/kali/.config/delegate-skills/config.json";
const DSK = "/home/kali/.config/delegate-skills";
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
      "--lane", lane.lane,
      "--out-dir", laneOutDir,
    ];

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
      return { ...lane, status: "no_result", metered, economyId };
    }

    let result;
    try {
      result = JSON.parse(readFileSync(resultPath, "utf8"));
    } catch (e) {
      return { ...lane, status: "bad_result", metered, economyId, error: String(e.message || e) };
    }
    return { ...lane, ...result, metered, economyId };
  });

  const laneResults = await Promise.all(lanePromises);

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

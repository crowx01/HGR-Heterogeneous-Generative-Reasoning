// route.mjs — pre-dispatch brain for the delegation economy.
// Refreshes live pool status (cheap scan always; full re-tier only when >6h stale), then emits the
// best UP model per role, or resolves a specific role/lane (auto-substituting a down lane's pool).
// Usage: node route.mjs [--role deep|analysis|code|grind] [--lane <laneName>] [--json] [--no-refresh]
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { inferPool, inferRole } from './infer.mjs';

const DIR = process.env.CONFIG_DIR || '/home/kali/.config/delegate-skills';
const REFRESH_THRESHOLD = 6 * 3600 * 1000; // 6h: full PONG re-tier only when pool_status older than this
const ORD = { T1_deep: 0, T2_strong: 1, T3_code: 2, T4_grind: 3 };

function parseArgs() {
  const a = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--role') a.role = argv[++i];
    else if (argv[i] === '--lane') a.lane = argv[++i];
    else if (argv[i] === '--json') a.json = true;
    else if (argv[i] === '--no-refresh') a.noRefresh = true;
  }
  return a;
}

function refreshStatus() {
  const p = `${DIR}/pool_status.json`;
  let stale = !fs.existsSync(p);
  if (!stale) {
    try {
      const gen = JSON.parse(fs.readFileSync(p, 'utf8')).generated;
      stale = !gen || (Date.now() - Date.parse(gen)) > REFRESH_THRESHOLD;
    } catch { stale = true; }
  }
  if (stale) { try { execFileSync('node', ['live-tier.mjs'], { cwd: DIR, stdio: 'inherit' }); } catch (e) { console.error('WARN full re-tier failed, using stale pool_status:', e.message); } }
  try { execFileSync('node', ['live-tier.mjs', '--status'], { cwd: DIR, stdio: 'inherit' }); } catch (e) { console.error('WARN status scan failed, using stale pool_status:', e.message); }
}

const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch (e) {
    console.error('ERROR: ' + p + ' is not valid JSON: ' + e.message);
    process.exit(1);
  }
};

function main() {
  const args = parseArgs();
  if (!args.noRefresh) refreshStatus();

  const models = (readJson(`${DIR}/models.json`).models) || [];
  const poolStatus = readJson(`${DIR}/pool_status.json`);
  const up = (pool) => {
    const p = poolStatus.pools?.[pool];
    if (!p) return false;
    if (p.status === 'UP' || p.status === 'UP_THROTTLED') return true;
    if ((p.status === 'EXHAUSTED' || p.status === 'DOWN_429') && p.reset && Date.parse(p.reset) <= Date.now()) return true;
    return false;
  };

  const bestByRole = {};
  for (const role of ['deep', 'analysis', 'code', 'grind']) {
    const up_models = models.filter((m) => m.role === role && up(m.quota_pool));
    up_models.sort((a, b) => (b.intelligence - a.intelligence) || a.id.localeCompare(b.id));
    bestByRole[role] = up_models[0] || null;
  }

  if (args.role) {
    console.log(bestByRole[args.role]?.id || '');
    return;
  }

  if (args.lane) {
    const config = readJson(`${DIR}/config.json`);
    const lc = config.lanes?.[args.lane];
    if (!lc) { console.error(`lane ${args.lane} not found in config.json`); process.exit(1); }
    // Match on the FULL configured model path (not just the last segment) so two models sharing a
    // suffix (e.g. sambanova/gpt-oss-120b vs cloudflare/.../gpt-oss-120b) don't collide; tail-only fallback.
    const full = String(lc.model);
    const tail = full.split('/').pop();
    const cur = models.find((m) => m.id.startsWith(lc.implementer + '/') && (m.id === lc.implementer + '/' + full || m.id.endsWith('/' + full)))
      || models.find((m) => m.id.startsWith(lc.implementer + '/') && m.id.endsWith('/' + tail));
    // cur may be null when config.json has drifted from a re-tiered models.json: infer pool + role.
    const pool = cur ? cur.quota_pool : inferPool(lc.implementer, lc.model);
    const role = cur ? cur.role : inferRole(args.lane);
    if (pool && up(pool)) { console.log(cur ? cur.id : `${lc.implementer}/${lc.model}`); return; }
    const sub = bestByRole[role] || bestByRole.deep;
    if (!sub) { console.error(`ROUTE-NONE role=${role} all pools down`); process.exit(3); }
    console.error(`ROUTE-SWAP lane=${args.lane} pool=${pool || '?'} status=${pool ? poolStatus.pools?.[pool]?.status : 'unknown'}${cur ? '' : ' (inferred)'} -> ${sub.id} (role ${role})`);
    console.log(sub.id);
    return;
  }

  // default / --json: best UP model id per role
  const out = { deep: bestByRole.deep?.id || null, analysis: bestByRole.analysis?.id || null, code: bestByRole.code?.id || null, grind: bestByRole.grind?.id || null };
  console.log(JSON.stringify(out, null, 2));
  if (!out.deep && !out.analysis && !out.code && !out.grind) process.exit(3);
}

main();

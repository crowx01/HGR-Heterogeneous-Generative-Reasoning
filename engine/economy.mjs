import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG_DIR = process.env.CONFIG_DIR || '/home/kali/.config/delegate-skills';
const MODELS_FILE = process.env.MODELS_FILE || join(CONFIG_DIR, 'models.json');
const TEMPLATE_FILE = process.env.TEMPLATE_FILE || join(CONFIG_DIR, 'ledger.template.json');

function loadModels() {
  return JSON.parse(readFileSync(MODELS_FILE, 'utf8'));
}

function loadTemplate() {
  return JSON.parse(readFileSync(TEMPLATE_FILE, 'utf8'));
}

function ledgerPath(mission) {
  return join(CONFIG_DIR, `ledger.${mission}.json`);
}

function loadLedger(mission) {
  const path = ledgerPath(mission);
  if (!existsSync(path)) {
    const tpl = loadTemplate();
    const ledger = {
      ...tpl,
      mission_id: mission,
      started: new Date().toISOString().split('T')[0],
      objective: '',
      dispatches: {},
      pool_used: {},
      chokes: [],
      handovers: [],
      status: 'active'
    };
    writeFileSync(path, JSON.stringify(ledger, null, 2));
    return ledger;
  }
  const ledger = JSON.parse(readFileSync(path, 'utf8'));
  ledger.dispatches = ledger.dispatches || {};
  ledger.pool_used = ledger.pool_used || {};
  ledger.chokes = ledger.chokes || [];
  ledger.handovers = ledger.handovers || [];
  return ledger;
}

function saveLedger(mission, ledger) {
  writeFileSync(ledgerPath(mission), JSON.stringify(ledger, null, 2));
}

function parseLimit(limit) {
  if (typeof limit === 'number') return limit;
  if (typeof limit === 'string') {
    const m = limit.match(/(\d+)/);
    if (m) return parseInt(m[1], 10);
  }
  return Infinity;
}

function isEligible(model, ledger, modelsData) {
  if (model.tier === 'DEAD' || model.tier?.status === 'dead') return false;
  if (ledger.chokes.includes(model.id)) return false;

  const used = ledger.dispatches[model.id] || 0;
  const salary = model.salary_dispatches === 'inf' ? Infinity : (model.salary_dispatches || Infinity);
  if (used >= salary) return false;

  const pool = model.quota_pool;
  if (pool && modelsData.quotas[pool]) {
    const poolUsed = ledger.pool_used[pool] || 0;
    const poolLimit = parseLimit(modelsData.quotas[pool].limit);
    if (poolLimit !== Infinity && poolUsed >= poolLimit) return false;
  }
  return true;
}

function roleChain(role) {
  const chain = ['deep', 'analysis', 'code', 'grind'];
  const idx = chain.indexOf(role);
  return idx >= 0 ? chain.slice(idx) : [role];
}

function pickBest(role, ledger, modelsData) {
  const models = modelsData.models || [];
  const chain = roleChain(role);

  for (const r of chain) {
    const candidates = models.filter(m => m.role === r && isEligible(m, ledger, modelsData));
    if (candidates.length === 0) continue;

    candidates.sort((a, b) => {
      if (b.intelligence !== a.intelligence) return b.intelligence - a.intelligence;

      const aFree = a.salary_dispatches === 'inf' || (a.quota_pool && modelsData.quotas[a.quota_pool]?.limit === '~1000/mo, 20 RPM (trial key)');
      const bFree = b.salary_dispatches === 'inf' || (b.quota_pool && modelsData.quotas[b.quota_pool]?.limit === '~1000/mo, 20 RPM (trial key)');
      if (aFree !== bFree) return aFree ? -1 : 1;

      const aPool = a.quota_pool ? parseLimit(modelsData.quotas[a.quota_pool]?.limit) : Infinity;
      const bPool = b.quota_pool ? parseLimit(modelsData.quotas[b.quota_pool]?.limit) : Infinity;
      if (aPool !== bPool) return aPool - bPool;

      return a.id.localeCompare(b.id);
    });

    return candidates[0];
  }
  return null;
}

function formatPick(model, ledger, modelsData) {
  if (!model) return { model: null, reason: 'no eligible model in role chain' };

  const salary = model.salary_dispatches === 'inf' ? Infinity : (model.salary_dispatches || 0);
  const used = ledger.dispatches[model.id] || 0;
  const salaryRemaining = salary === Infinity ? 'inf' : Math.max(0, salary - used);

  let poolRemaining = 'inf';
  if (model.quota_pool && modelsData.quotas[model.quota_pool]) {
    const poolUsed = ledger.pool_used[model.quota_pool] || 0;
    const poolLimit = parseLimit(modelsData.quotas[model.quota_pool].limit);
    poolRemaining = poolLimit === Infinity ? 'inf' : Math.max(0, poolLimit - poolUsed);
  }

  return {
    model: model.id,
    cli: model.cli,
    lane: model.lane,
    quota_pool: model.quota_pool,
    salary_remaining: salaryRemaining,
    pool_remaining: poolRemaining,
    handover_to: model.handover_to || []
  };
}

async function cmdPick(args) {
  const role = args['--role'];
  const mission = args['--mission'];
  if (!role || !mission) {
    console.error('Usage: pick --role <role> --mission <id>');
    process.exit(1);
  }
  const modelsData = loadModels();
  const ledger = loadLedger(mission);
  const model = pickBest(role, ledger, modelsData);
  console.log(JSON.stringify(formatPick(model, ledger, modelsData)));
}

async function cmdSpend(args) {
  const mission = args['--mission'];
  if (!mission) {
    console.error('Usage: spend --role <role> --mission <id>  OR  spend --model <id> --mission <id>');
    process.exit(1);
  }
  const modelsData = loadModels();
  const ledger = loadLedger(mission);

  let modelId = args['--model'];
  if (!modelId) {
    const role = args['--role'];
    if (!role) {
      console.error('Usage: spend --role <role> --mission <id>  OR  spend --model <id> --mission <id>');
      process.exit(1);
    }
    const model = pickBest(role, ledger, modelsData);
    if (!model) {
      console.log(JSON.stringify({ model: null, reason: 'no eligible model in role chain' }));
      return;
    }
    modelId = model.id;
  }

  const model = modelsData.models.find(m => m.id === modelId);
  if (!model) {
    console.error(`Model not found: ${modelId}`);
    process.exit(1);
  }

  if (!isEligible(model, ledger, modelsData)) {
    console.log(JSON.stringify({ model: null, reason: 'model not eligible' }));
    return;
  }

  ledger.dispatches[modelId] = (ledger.dispatches[modelId] || 0) + 1;
  if (model.quota_pool) {
    ledger.pool_used[model.quota_pool] = (ledger.pool_used[model.quota_pool] || 0) + 1;
  }
  saveLedger(mission, ledger);
  console.log(JSON.stringify(formatPick(model, ledger, modelsData)));
}

async function cmdChoke(args) {
  const modelId = args['--model'];
  const mission = args['--mission'];
  const why = args['--why'] || 'choked';
  const pool = process.argv.includes('--pool');
  if (!modelId || !mission) {
    console.error('Usage: choke --model <id> --mission <id> [--why <str>] [--pool]');
    process.exit(1);
  }
  const modelsData = loadModels();
  const ledger = loadLedger(mission);

  // Find the target model
  const targetModel = modelsData.models.find(m => m.id === modelId);
  const targetPool = targetModel?.quota_pool;
  
  // Add target model
  if (targetModel && !ledger.chokes.includes(targetModel.id)) {
    ledger.chokes.push(targetModel.id);
  }
  
  // If --pool flag is present and target has a quota_pool, add all models from same pool
  if (pool && targetPool) {
    const poolModels = modelsData.models.filter(m => m.quota_pool === targetPool);
    for (const poolModel of poolModels) {
      if (!ledger.chokes.includes(poolModel.id)) {
        ledger.chokes.push(poolModel.id);
      }
    }
  }

  // Find handover from the target model (even if other pool models were added)
  let handoverTo = null;
  if (targetModel?.handover_to) {
    for (const h of targetModel.handover_to) {
      const hModel = modelsData.models.find(m => m.id === h);
      if (hModel && isEligible(hModel, ledger, modelsData)) {
        handoverTo = h;
        break;
      }
    }
  }

  ledger.handovers.push({ from: modelId, to: handoverTo, why });
  saveLedger(mission, ledger);
  console.log(JSON.stringify({ handover_to: handoverTo }));
}

async function cmdStatus(args) {
  const mission = args['--mission'];
  if (!mission) {
    console.error('Usage: status --mission <id>');
    process.exit(1);
  }
  const modelsData = loadModels();
  const ledger = loadLedger(mission);

  const lanes = [];
  for (const [pool, quota] of Object.entries(modelsData.quotas || {})) {
    if (quota.status === 'dead') continue;
    const used = ledger.pool_used[pool] || 0;
    const limit = parseLimit(quota.limit);
    lanes.push({
      pool,
      used,
      limit: limit === Infinity ? 'inf' : limit,
      remaining: limit === Infinity ? 'inf' : Math.max(0, limit - used)
    });
  }

  console.log(JSON.stringify({
    mission: ledger.mission_id,
    objective: ledger.objective,
    lanes,
    spent: ledger.dispatches,
    chokes: ledger.chokes
  }));
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      args[argv[i]] = argv[i + 1]?.startsWith('--') ? true : argv[i + 1];
      if (args[argv[i]] !== true) i++;
    }
  }
  return args;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    console.error('Usage: economy.mjs <pick|spend|choke|status> [args...]');
    process.exit(1);
  }
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  try {
    switch (cmd) {
      case 'pick': await cmdPick(args); break;
      case 'spend': await cmdSpend(args); break;
      case 'choke': await cmdChoke(args); break;
      case 'status': await cmdStatus(args); break;
      default:
        console.error(`Unknown command: ${cmd}`);
        process.exit(1);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

main();
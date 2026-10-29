#!/usr/bin/env node
// live-tier.mjs — live tiering engine for the delegation economy.
// Enumerates free models across keyed providers + CLI-native catalogs, probes each with a test
// prompt, drops paid imposters / non-serving phantoms, scores intelligence (rubric + param-size),
// tiers by intelligence, derives salary from quota, builds cross-pool fallback chains, and writes
// free_models.json + models.json. Re-runnable: this IS the live tiering (run on demand or schedule).
//
// Keys are read from the aider env file at runtime (never passed on a command line), so running this
// via a delegate brief leaks no secrets. Usage: node live-tier.mjs [--no-probe] [--dry]
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const DIR = process.env.CONFIG_DIR || '/home/kali/.config/delegate-skills';
const ENVFILE = '/home/kali/.config/aider/providers.env';
const NOPROBE = process.argv.includes('--no-probe');
const DRY = process.argv.includes('--dry');
const PROMPT = 'Reply with the single word PONG';

// ---- keys (parse env file; also honor process.env) ----
const K = { ...process.env };
try { for (const line of fs.readFileSync(ENVFILE, 'utf8').split('\n')) { const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/); if (m) K[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}

// ---- intelligence rubric (first match wins) ----
const RUBRIC = [
  [/claude-opus/, 97], [/claude-sonnet/, 92], [/claude-haiku/, 80],
  [/mistral-large|large-4|large-2/, 88], [/deepseek-v3/, 86], [/deepseek-r1(?!.*distill)/, 85],
  [/nemotron-3-ultra-550b|nemotron.*550b|nemotron-3-ultra/, 85], [/llama-4|llama.*405b|405b/, 85],
  [/qwen3.*(235b|max)/, 85], [/gemini-(2\.5-pro|3\.1-pro|4-argon)/, 90],
  [/command-a-plus/, 84], [/deepseek-v4(?!.*flash)/, 84], [/gpt-oss-120b/, 82], [/command-a-reasoning/, 82],
  [/nemotron-3-super|nemotron-3-120b|nemotron.*120b/, 80], [/glm-5(?!\.3)/, 80], [/qwen3.*(72b|110b)/, 80],
  [/llama-3\.3-70b|nemotron-70b|llama.*70b/, 78], [/command-a-03-2025|command-a-translate/, 78],
  [/deepseek-v4.*flash|deepseek.*flash/, 76], [/minimax-m3|minimax-m2/, 74], [/command-r-plus/, 74],
  [/gemini-2\.5-flash-lite/, 62], [/gemini-2\.5-flash/, 77], [/aya-expanse-32b/, 72],
  [/r1-distill.*(70b|72b)|deepseek-r1-distill-llama/, 74], [/r1-distill|deepseek-r1-distill/, 68],
  [/qwen3\.?8?.*(27b|30b|32b)|qwen3-30b|qwen3-32b|qwen3\.8/, 70], [/qwen3/, 66],
  [/glm-4\.6|glm-4\.7|glm-5\.3|glm-4\.5/, 70], [/gpt-oss-20b/, 70], [/codestral/, 68],
  [/gemini-3[.\-].*flash-lite|gemini-3\.1-flash-lite/, 60], [/gemini-3[.\-].*flash|gemini-3-flash|gemini-3\.8-flash/, 72],
  [/laguna-s/, 64], [/nemotron-3-nano|nemotron-3\.5-lightning|nano-omni/, 66],
  [/command-r-|command-r$|command-r-08/, 66], [/sea-lion.*27b|gemma-sea-lion/, 62],
  [/dots-3-note|dots-3/, 62], [/north-mini-code/, 62], [/xing4\.0-29b|xing4/, 60], [/gemma-4-31b|gemma.*31b/, 60],
  [/mimo.*flash|mimo-v2/, 58], [/gemma-4-26b|gemma.*26b/, 55], [/flint-40b/, 62], [/flint/, 55],
  [/beam-free|beam/, 58], [/command-r7b/, 56], [/inkling-small/, 50], [/inkling/, 58],
  [/laguna-xs/, 52], [/lfm-2\.5|lfm-/, 42], [/tiny-aya/, 40],
];
function sizeScore(s) {
  if (/(\d+(?:\.\d+)?)\s*t\b/.test(s)) return 88;
  const b = (s.match(/(\d+(?:\.\d+)?)\s*b\b/g) || []).map(x => parseFloat(x));
  if (b.length) { const n = Math.max(...b); return n >= 200 ? 84 : n >= 100 ? 80 : n >= 70 ? 78 : n >= 32 ? 68 : n >= 20 ? 62 : n >= 13 ? 58 : n >= 7 ? 54 : 50; }
  return 50;
}
const score = id => { const s = String(id).toLowerCase(); for (const [re, n] of RUBRIC) if (re.test(s)) return n; return sizeScore(s); };
const tierOf = n => n >= 85 ? ['T1_deep', 'deep'] : n >= 75 ? ['T2_strong', 'analysis'] : n >= 60 ? ['T3_code', 'code'] : ['T4_grind', 'grind'];
const SALARY = { openrouter_free: 6, gemini_direct: 12, cohere_trial: 10, nvidia_nim_free: 10, sambanova_free: 6, cloudflare_free: 8, opencode_gateway: 10, kilo_subscription: 12, agy_antigravity: 2 };

const NONCHAT = /embed|rerank|reward|guard|content-safety|-vision|vision-|lyria|clip|whisper|tts|parse|moderation|translate|ocr|image|flux|diffusion|sdxl|openrouter\/free$|video|synthetic/i;
const PAID = /insufficient|add credits|requires? (credit|payment|more credit)|payment required|billing|not available on your plan|upgrade your|purchase|out of credit|credit_balance|enterprise|paid plan|only available/i;
const THROTTLE = /rate.?limit|too many|high demand|exhaust|resource.?exhausted|free_tier.*(limit|count).{0,20}0|exceeded your current quota|temporarily|overloaded/i;

async function getJSON(url, headers, method = 'GET', body = null) {
  try { const c = new AbortController(); const t = setTimeout(() => c.abort(), 22000);
    const r = await fetch(url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined, signal: c.signal });
    clearTimeout(t); const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = null; }
    return { ok: r.ok, status: r.status, json: j, txt }; } catch (e) { return { ok: false, status: 0, txt: e.message }; }
}
// verdict for a probe response: keep ANSWERED + THROTTLED; drop everything else.
function keep(status, text) {
  if (status === 200) return true;
  const s = (text || '') + ' s' + status;
  if (status === 403 || status === 402 || PAID.test(s)) return false;        // imposter / paid
  if (status === 404) return false;                                           // phantom
  if (status === 429 && /exceeded your current quota|free_tier/i.test(s)) return false; // quota-0 imposter
  if (status === 429 || THROTTLE.test(s)) return true;                        // free but busy -> keep
  return false;                                                               // auth/other -> drop
}
const oaiProbe = (base, key, model) => getJSON(`${base}/chat/completions`, { authorization: `Bearer ${key}` }, 'POST', { model, messages: [{ role: 'user', content: PROMPT }], max_tokens: 8 });

// ---- enumerate + probe each keyed provider ----
const pools = {};
async function keyedPool(pool, cli, prefix, endpoint, listUrl, listHeaders, extract, toModel, probe) {
  const lr = await getJSON(listUrl, listHeaders);
  if (!lr.json) { console.log(pool, 'LIST ERR', lr.status); return; }
  let ids = extract(lr.json).filter(id => id && !NONCHAT.test(id));
  const kept = [];
  if (NOPROBE) { for (const id of ids) kept.push(id); }
  else { const CONC = 6; let i = 0;
    const work = async () => { while (i < ids.length) { const id = ids[i++]; const pr = await probe(toModel(id)); if (keep(pr.status, pr.txt)) kept.push(id); } };
    await Promise.all(Array.from({ length: CONC }, work)); }
  pools[pool] = { providers: [cli], model_prefix: prefix, endpoint, shared: false, daily_limit: null, count: kept.length, models: [...new Set(kept)].map(id => ({ id, ctx: 0 })) };
  console.log(pool, '->', kept.length, '/', ids.length);
}

if (K.OPENROUTER_API_KEY) await keyedPool('openrouter_free', 'opencode', 'openrouter/', 'https://openrouter.ai/api/v1',
  'https://openrouter.ai/api/v1/models', { authorization: `Bearer ${K.OPENROUTER_API_KEY}` },
  j => j.data.filter(m => /:free$/.test(m.id) || (m.pricing && +m.pricing.prompt === 0 && +m.pricing.completion === 0)).map(m => m.id),
  id => id, m => oaiProbe('https://openrouter.ai/api/v1', K.OPENROUTER_API_KEY, m));
if (K.NVIDIA_NIM_API_KEY) await keyedPool('nvidia_nim_free', 'aider', 'nvidia_nim/', 'https://integrate.api.nvidia.com/v1',
  'https://integrate.api.nvidia.com/v1/models', { authorization: `Bearer ${K.NVIDIA_NIM_API_KEY}` },
  j => j.data.map(m => 'nvidia_nim/' + m.id), id => id.replace(/^nvidia_nim\//, ''), m => oaiProbe('https://integrate.api.nvidia.com/v1', K.NVIDIA_NIM_API_KEY, m));
if (K.SAMBANOVA_API_KEY) await keyedPool('sambanova_free', 'aider', 'sambanova/', 'https://api.sambanova.ai/v1',
  'https://api.sambanova.ai/v1/models', { authorization: `Bearer ${K.SAMBANOVA_API_KEY}` },
  j => j.data.map(m => 'sambanova/' + m.id), id => id.replace(/^sambanova\//, ''), m => oaiProbe('https://api.sambanova.ai/v1', K.SAMBANOVA_API_KEY, m));
if (K.COHERE_API_KEY) await keyedPool('cohere_trial', 'opencode', 'cohere/', 'https://api.cohere.com/v1',
  'https://api.cohere.com/v1/models?page_size=300', { authorization: `Bearer ${K.COHERE_API_KEY}` },
  j => (j.models || []).filter(m => (m.endpoints || []).includes('chat')).map(m => m.name), id => id,
  m => getJSON('https://api.cohere.com/v2/chat', { authorization: `Bearer ${K.COHERE_API_KEY}` }, 'POST', { model: m, messages: [{ role: 'user', content: PROMPT }] }));
if (K.GEMINI_API_KEY) await keyedPool('gemini_direct', 'opencode', 'google/', 'https://generativelanguage.googleapis.com/v1beta',
  `https://generativelanguage.googleapis.com/v1beta/models?key=${K.GEMINI_API_KEY}&pageSize=200`, {},
  j => (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name.replace(/^models\//, '')), id => id,
  m => getJSON(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${K.GEMINI_API_KEY}`, {}, 'POST', { contents: [{ parts: [{ text: PROMPT }] }], generationConfig: { maxOutputTokens: 8 } }));
if (K.CLOUDFLARE_API_KEY && K.CLOUDFLARE_ACCOUNT_ID) await keyedPool('cloudflare_free', 'aider', 'cloudflare/', 'https://api.cloudflare.com/client/v4',
  `https://api.cloudflare.com/client/v4/accounts/${K.CLOUDFLARE_ACCOUNT_ID}/ai/models/search?per_page=200`, { authorization: `Bearer ${K.CLOUDFLARE_API_KEY}` },
  j => (j.result || []).filter(m => m.task && /text.?generation/i.test(m.task.name || '')).map(m => 'cloudflare/' + m.name), id => id.replace(/^cloudflare\//, ''),
  m => getJSON(`https://api.cloudflare.com/client/v4/accounts/${K.CLOUDFLARE_ACCOUNT_ID}/ai/run/${m}`, { authorization: `Bearer ${K.CLOUDFLARE_API_KEY}` }, 'POST', { messages: [{ role: 'user', content: PROMPT }] }));

// ---- CLI-native free catalogs (own auth; no API probe) ----
function cliPool(pool, cli, prefix, endpoint, cmd, filter) {
  try { const out = execSync(cmd, { encoding: 'utf8', timeout: 60000 });
    const ids = [...new Set(out.split('\n').map(l => l.trim()).filter(filter).filter(id => !NONCHAT.test(id)))];
    pools[pool] = { providers: [cli], model_prefix: prefix, endpoint, shared: false, daily_limit: null, count: ids.length, models: ids.map(id => ({ id, ctx: 0 })) };
    console.log(pool, '->', ids.length);
  } catch (e) { console.log(pool, 'ERR', e.message.slice(0, 60)); }
}
cliPool('kilo_subscription', 'kilo', 'kilo/', 'Kilo Gateway (oauth)', 'kilo models', l => /^kilo\//.test(l) && /free/.test(l));
cliPool('opencode_gateway', 'opencode', '', 'opencode hosted gateway', 'opencode models', l => /^opencode\//.test(l) && /free/.test(l));
cliPool('agy_antigravity', 'agy', '', 'Antigravity CLI (own metered quota)', 'agy models', l => l && !/\s/.test(l.split('\t')[0]) ? false : /\t/.test(l)); // handled below

// agy: tab-separated id\tLabel
try { const out = execSync('agy models', { encoding: 'utf8', timeout: 60000 });
  const ids = [...new Set(out.split('\n').map(l => l.split('\t')[0].trim()).filter(l => l && !/\s/.test(l) && !/Fetching|available/i.test(l) && !NONCHAT.test(l)))];
  pools.agy_antigravity = { providers: ['agy'], model_prefix: '', endpoint: 'Antigravity CLI (own metered quota)', shared: false, daily_limit: null, count: ids.length, models: ids.map(id => ({ id, ctx: 0 })) };
  console.log('agy_antigravity ->', ids.length);
} catch (e) { console.log('agy ERR', e.message.slice(0, 60)); }

// ---- write free_models.json ----
const free = { version: 'free-models.v1', generated: new Date().toISOString(),
  note: 'Live-tiered by live-tier.mjs: enumerated + probed; imposters/phantoms dropped; kept answered+throttled.', pools };
if (!DRY) fs.writeFileSync(`${DIR}/free_models.json`, JSON.stringify(free, null, 2) + '\n');

// ---- build models.json economy from the live roster ----
function fleetId(pool, cli, raw) {
  if (pool === 'gemini_direct') return `${cli}/google/${raw}`;
  if (pool === 'cohere_trial') return `${cli}/cohere/${raw}`;
  if (raw.startsWith(cli + '/')) return raw;
  return `${cli}/${raw}`;
}
const models = [];
const seen = new Set();
for (const [pool, v] of Object.entries(pools)) {
  const cli = v.providers[0];
  for (const mm of v.models) {
    const id = fleetId(pool, cli, mm.id); if (seen.has(id)) continue; seen.add(id);
    const intel = score(id); const [tier, role] = tierOf(intel);
    models.push({ id, cli, tier, intelligence: intel, role, salary_dispatches: SALARY[pool] || 6, quota_pool: pool, lane: pool, handover_to: [], note: 'live-tiered', cost_salary_usd: 0.01 });
  }
}
const ORD = { T1_deep: 0, T2_strong: 1, T3_code: 2, T4_grind: 3 };
models.sort((a, b) => (ORD[a.tier] - ORD[b.tier]) || (b.intelligence - a.intelligence) || a.id.localeCompare(b.id));
// cross-pool fallback chains ending at a stable tail
const byIntel = [...models].sort((a, b) => b.intelligence - a.intelligence || a.id.localeCompare(b.id));
const idset = new Set(models.map(x => x.id));
const TAIL = idset.has('kilo/kilo-auto/free') ? 'kilo/kilo-auto/free' : (models.filter(x => x.tier === 'T4_grind').slice(-1)[0] || {}).id;
for (const mod of models) {
  const i = byIntel.findIndex(x => x.id === mod.id); const chain = [], pseen = new Set([mod.quota_pool]);
  for (let j = i + 1; j < byIntel.length && chain.length < 3; j++) { const c = byIntel[j]; if (pseen.has(c.quota_pool)) continue; chain.push(c.id); pseen.add(c.quota_pool); }
  if (TAIL && mod.id !== TAIL && !chain.includes(TAIL)) chain.push(TAIL);
  mod.handover_to = chain;
}
// preserve the existing quotas/tiers/cost_model header; swap the models array
const mj = JSON.parse(fs.readFileSync(`${DIR}/models.json`, 'utf8'));
mj.models = models;
if (!DRY) fs.writeFileSync(`${DIR}/models.json`, JSON.stringify(mj, null, 2) + '\n');

const t = {}; for (const x of models) t[x.tier] = (t[x.tier] || 0) + 1;
const totalFree = Object.values(pools).reduce((a, p) => a + (p.count || 0), 0);
console.log(`\nLIVE-TIER DONE${DRY ? ' (dry run, no write)' : ''} | free roster ${totalFree} across ${Object.keys(pools).length} pools | economy ${models.length} models | tiers ${JSON.stringify(t)}`);
const dangle = models.flatMap(x => x.handover_to || []).filter(h => !idset.has(h));
console.log('dangling handovers', dangle.length, '| dup ids', models.map(x => x.id).filter((v, i, a) => a.indexOf(v) !== i).length);

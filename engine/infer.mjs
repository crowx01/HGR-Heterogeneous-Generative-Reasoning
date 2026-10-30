export function inferPool(implementer, model) {
  if (implementer === 'agy') return 'agy_antigravity';
  if (implementer === 'kilo') return 'kilo_subscription';
  const m = String(model);
  if (/(^|\/)google\//.test(m)) return 'gemini_direct';
  if (/(^|\/)cohere\//.test(m)) return 'cohere_trial';
  if (/nvidia_nim\//.test(m)) return 'nvidia_nim_free';
  if (/sambanova\//.test(m)) return 'sambanova_free';
  if (/cloudflare\//.test(m)) return 'cloudflare_free';
  if (/openrouter\/|:free\b/.test(m)) return 'openrouter_free';
  return null;
}
export function inferRole(lane) {
  const l = String(lane).toLowerCase();
  if (/deep|complex|reason/.test(l)) return 'deep';
  if (/review|analysis|debate/.test(l)) return 'analysis';
  if (/grind|patch|test|bulk/.test(l)) return 'grind';
  return 'code';
}

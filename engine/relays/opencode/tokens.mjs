// Sum every numeric leaf in an opencode step_finish `part.tokens` object.
// Shape is provider-dependent (e.g. {input,output,reasoning,cache:{read,write}}),
// so sum defensively rather than naming fields. cacheWrite dominates real usage.
export function sumTokens(t) {
  if (t == null || typeof t !== "object") return 0;
  let n = 0;
  for (const v of Object.values(t)) {
    if (typeof v === "number" && Number.isFinite(v)) n += v;
    else if (v && typeof v === "object") n += sumTokens(v);
  }
  return n;
}

// Pure helpers shared by the RAG benchmark and tests.
export function percentile(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}
export function summarizeTokens(xs) {
  return { mean: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length), p95: percentile(xs, 95), max: Math.max(...xs) };
}
// Workers AI neuron pricing: neurons = (tin*in_per_m + tout*out_per_m)/1e6; usd = neurons/1000 * usd_per_1k.
export function costPerTask(pricing, model, tin, tout) {
  const p = pricing[model];
  if (!p) throw new Error(`no pricing for ${model}`);
  const neurons = (tin * p.in_neurons_per_m + tout * p.out_neurons_per_m) / 1e6;
  return +((neurons / 1000) * pricing.usd_per_1k_neurons).toFixed(7);
}

// Reproducible local gateway benchmark: MOCK providers on localhost, seeded fault injection.
// Measures client-side TTFT / total latency, success (exact expected text), and tokens billed per task.
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { createMockProvider, tokensFor } from '../src/mock-provider.js';
import { createGateway } from '../src/gateway.js';
import { readSSE } from '../src/sse.js';
import { percentile } from '../../rag-teardown/bench/lib.mjs';

const N = Number(process.env.N || 200), CONC = 10, NTOK = 40;
// ILLUSTRATIVE prices (USD per 1M output tokens) to show the shape of fallback cost; not any vendor's list price.
const PRICE = { primary: 10, secondary: 2 };

export async function consume(url, prompt) {
  const t0 = performance.now(); let ttft = null; const toks = []; let final = null; let switches = 0;
  try {
    const res = await fetch(url, { method: 'POST', body: JSON.stringify({ prompt }) });
    if (!res.ok) return { ok: false, ttft, total: performance.now() - t0, error: `http_${res.status}` };
    for await (const e of readSSE(res.body)) {
      if (e.event === 'message' && e.data !== '[DONE]') { if (ttft == null) ttft = performance.now() - t0; toks.push(JSON.parse(e.data).token); }
      else if (e.event === 'meta') switches++;
      else if (e.event === 'done' || e.event === 'error' || e.data === '[DONE]') final = e.event === 'error' ? 'error' : 'done';
    }
  } catch (err) { return { ok: false, ttft, total: performance.now() - t0, error: String(err.message) }; }
  const ok = final === 'done' && toks.join(' ') === tokensFor(prompt, NTOK).join(' ');
  return { ok, ttft, total: performance.now() - t0, switches, n: toks.length };
}

async function pool(n, conc, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: conc }, async () => { while (i < n) { const k = i++; out[k] = await fn(k); } }));
  return out;
}

async function scenario({ name, faults = {}, policy = 'resume', direct = false, seed = 11 }) {
  const primary = createMockProvider({ name: 'primary', ttftMs: 300, jitterMs: 50, interTokenMs: 10, nTokens: NTOK, faults, seed });
  const secondary = createMockProvider({ name: 'secondary', ttftMs: 500, jitterMs: 100, interTokenMs: 15, nTokens: NTOK, seed: seed + 1 });
  const pu = await primary.listen(); const su = await secondary.listen();
  const gw = createGateway({ providers: [{ name: 'primary', url: pu }, { name: 'secondary', url: su }], policy, ttftTimeoutMs: 1000, idleTimeoutMs: 300 });
  const gu = await gw.listen();
  const target = direct ? pu : `${gu}/v1/stream`;
  const rows = await pool(N, CONC, (k) => consume(target, `request ${k} summarise the incident timeline`));
  await gw.close(); await primary.close(); await secondary.close();
  const okRows = rows.filter((r) => r.ok);
  const ttft = okRows.map((r) => r.ttft), total = okRows.map((r) => r.total);
  const billed = { primary: primary.stats.tokens_sent, secondary: secondary.stats.tokens_sent };
  const usd = (billed.primary * PRICE.primary + billed.secondary * PRICE.secondary) / 1e6;
  const r2 = (x) => (x == null ? null : Math.round(x * 10) / 10);
  return {
    scenario: name, path: direct ? 'direct-to-primary' : 'gateway', policy: direct ? null : policy, faults, n: N,
    success_rate: okRows.length / N,
    ttft_ms: { p50: r2(percentile(ttft, 50)), p95: r2(percentile(ttft, 95)) },
    total_ms: { p50: r2(percentile(total, 50)), p95: r2(percentile(total, 95)) },
    requests_with_fallback: rows.filter((r) => r.switches > 0).length,
    upstream_faults: primary.stats.faults,
    tokens_billed: billed,
    tokens_billed_per_success: okRows.length ? r2((billed.primary + billed.secondary) / okRows.length) : null,
    illustrative_usd_per_1k_successful_tasks: okRows.length ? +((usd / okRows.length) * 1000).toFixed(4) : null,
  };
}

const scenarios = [
  { name: 'baseline-direct', direct: true },
  { name: 'gateway-healthy' },
  { name: 'primary-503-20pct', faults: { '503': 0.2 } },
  { name: 'primary-stall-20pct', faults: { stall: 0.2 } },
  { name: 'primary-drop-20pct-policy-error', faults: { drop: 0.2 }, policy: 'error' },
  { name: 'primary-drop-20pct-policy-resume', faults: { drop: 0.2 }, policy: 'resume' },
];
if (process.argv[1] === new URL(import.meta.url).pathname) {
const results = [];
for (const s of scenarios) { const r = await scenario(s); results.push(r); console.log(JSON.stringify({ s: r.scenario, ok: r.success_rate, ttft: r.ttft_ms, total: r.total_ms, tok: r.tokens_billed_per_success })); }
writeFileSync(new URL('../../results/gateway-teardown.json', import.meta.url), JSON.stringify({
  label: 'MOCK upstream providers on localhost with seeded fault injection; prices are ILLUSTRATIVE',
  date: new Date().toISOString().slice(0, 10),
  machine: `${os.arch()} ${os.platform()} ${os.cpus()[0].model}, Node ${process.version}`,
  config: { n_per_scenario: N, concurrency: CONC, tokens_per_answer: NTOK, primary: { ttft_ms: '300±50', inter_token_ms: 10 },
    secondary: { ttft_ms: '500±100', inter_token_ms: 15 }, gateway: { ttft_timeout_ms: 1000, idle_timeout_ms: 300 }, price_usd_per_m_out: PRICE },
  results,
}, null, 2));
}

// Reproducible local benchmark of braylo-si-rag @ pinned commit (no Workers AI, no network after fetch).
// 1) re-runs the repo's own tests and offline evals; 2) context-size (top-k) sweep: recall vs prompt tokens
// vs cost-per-task; 3) extractive-path latency over repeated runs.
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { DIR, COMMIT } from './fetch.mjs';
import { costPerTask, percentile, summarizeTokens } from './lib.mjs';

const head = execFileSync('git', ['-C', DIR, 'rev-parse', 'HEAD']).toString().trim();
if (head !== COMMIT) throw new Error(`vendor checkout is ${head}, expected ${COMMIT}; run npm run rag:fetch`);

const imp = (p) => import(new URL(p, `file://${DIR}`).href);
const { labelled } = await imp('evals/lib.mjs');
const { bm25Ids } = await imp('src/retrieve.js');
const { recallAtK, mean } = await imp('src/metrics.js');
const { answer, SYSTEM } = await imp('src/agent.js');
const { KB } = await imp('src/kb.js');
const { PRICING, estTokens } = await imp('src/obs.js');
const { routeIntent } = await imp('src/tools.js');
const { MODEL } = await imp('src/core.js');

// 1) the repo's own test suite and eval script
const testOut = execFileSync('node', ['--import', './test/support/register.mjs', '--test', 'test/agent.test.js'], { cwd: DIR, encoding: 'utf8' });
const tests = Object.fromEntries([...testOut.matchAll(/^ℹ (tests|pass|fail) (\d+)/gm)].map((m) => [m[1], +m[2]]));
execFileSync('node', ['evals/run.mjs'], { cwd: DIR, stdio: 'ignore' });
const repoEval = JSON.parse(readFileSync(`${DIR}evals/results.json`, 'utf8'));

// 2) top-k sweep
const L = labelled();
const byId = new Map(KB.chunks.map((c) => [c.id, c]));
const ctx = (ids) => ids.map((id, i) => { const h = byId.get(id); return `[${i + 1}] (${h.doc}) ${h.text}`; }).join('\n\n');
const sweep = [];
for (const k of [1, 3, 5, 8, 10]) {
  const rows = L.map((q) => {
    const ids = bm25Ids(q.q, 50).slice(0, k);
    const prompt = SYSTEM + `SOURCES:\n${ctx(ids)}\n\nQUESTION: ${q.q}`;
    return { split: q.split, recall: recallAtK(bm25Ids(q.q, 50), q.relevant, k), tin: estTokens(prompt), tool: !!routeIntent(q.q) };
  });
  const tin = rows.map((r) => r.tin);
  sweep.push({
    k,
    recall_all: +mean(rows.map((r) => r.recall)).toFixed(3),
    recall_test: +mean(rows.filter((r) => r.split === 'test').map((r) => r.recall)).toFixed(3),
    prompt_tokens_est: summarizeTokens(tin),
    cost_usd_per_task: {
      one_call_out150: costPerTask(PRICING, MODEL, mean(tin), 150),
      one_call_out400max: costPerTask(PRICING, MODEL, mean(tin), 400),
      // tool path: second call re-sends the prompt + ~300 tokens of tool JSON
      two_call_tool_path_out150x2: costPerTask(PRICING, MODEL, 2 * mean(tin) + 300, 300),
    },
    share_routed_to_tool_by_rules: +mean(rows.map((r) => (r.tool ? 1 : 0))).toFixed(3),
  });
}

// 3) latency of the no-model (extractive) path
for (const q of L) await answer({}, q.q, { noModel: true }); // warm-up
const totals = []; const spans = {};
const REPS = 30;
for (let r = 0; r < REPS; r++) for (const q of L) {
  const out = await answer({}, q.q, { noModel: true });
  totals.push(out.duration_ms);
  for (const s of out.spans) (spans[s.name] ||= []).push(s.duration_ms);
}

const result = {
  subject: `braylo-si-rag @ ${COMMIT}`,
  date: new Date().toISOString().slice(0, 10),
  machine: `${os.arch()} ${os.platform()} ${os.cpus()[0].model}, Node ${process.version}`,
  token_note: 'Prompt tokens use the repo\'s own estTokens (chars/4) — an ESTIMATE, not a Llama tokenizer count.',
  cost_note: `Cost uses the repo's PRICING table for ${MODEL} (neurons, read by that repo from developers.cloudflare.com/workers-ai/platform/pricing on 2026-10-27). The free tier pays $0. Output lengths 150/400 are ASSUMPTIONS, not measured.`,
  repo_tests: tests,
  repo_eval_reproduced: {
    bm25_all: repoEval.retrieval.bm25.all, bm25_test: repoEval.retrieval.bm25.test,
    scope_guard_test: repoEval.scope_guard.test, injection_guard: repoEval.injection_guard,
    extractive: { answer_contains_gold_phrase: repoEval.extractive_answers.answer_contains_gold_phrase, wrongly_blocked: repoEval.extractive_answers.wrongly_blocked },
  },
  topk_sweep: sweep,
  extractive_latency_ms: {
    n: totals.length, p50: percentile(totals, 50), p95: percentile(totals, 95), p99: percentile(totals, 99),
    per_span_p50: Object.fromEntries(Object.entries(spans).map(([k, v]) => [k, percentile(v, 50)])),
  },
  not_run: ['vector (bge-base) and hybrid RRF retrieval — needs Workers AI embeddings', 'LLM answer quality and real token usage — needs Workers AI', 'edge latency on Cloudflare'],
};
writeFileSync(new URL('../../results/rag-teardown.json', import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ repo_tests: tests, sweep: sweep.map((s) => [s.k, s.recall_all, s.prompt_tokens_est.mean, s.cost_usd_per_task.one_call_out150]), lat: result.extractive_latency_ms }, null, 1));

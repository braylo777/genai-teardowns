// MOCK LLM provider: streams a deterministic token sequence over SSE with configurable latency and faults.
// Faults (per request, drawn from a seeded RNG): '503' before streaming, 'stall' (no first token),
// 'drop' (connection closes mid-stream).
import { createServer } from 'node:http';
import { writeEvent } from './sse.js';

export function tokensFor(prompt, n) {
  // deterministic "answer": n tokens derived from the prompt, so any provider produces the same text
  const words = String(prompt).toLowerCase().match(/[a-z0-9]+/g) || ['x'];
  return Array.from({ length: n }, (_, i) => `${words[i % words.length]}${i}`);
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function createMockProvider({ name, ttftMs = 200, jitterMs = 50, interTokenMs = 10, nTokens = 40,
  faults = {}, seed = 1 } = {}) {
  const rng = mulberry32(seed);
  const stats = { requests: 0, tokens_sent: 0, faults: { '503': 0, stall: 0, drop: 0 } };
  const sockets = new Set();
  const server = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const { prompt = '', resume_from = 0 } = JSON.parse(body || '{}');
    stats.requests++;
    const r = rng();
    let fault = null; let acc = 0;
    for (const [k, p] of Object.entries(faults)) { acc += p; if (r < acc) { fault = k; break; } }
    if (fault === '503') { stats.faults['503']++; res.writeHead(503).end('overloaded'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    if (fault === 'stall') { stats.faults.stall++; return; } // hold the socket open, send nothing
    const toks = tokensFor(prompt, nTokens).slice(resume_from);
    const dropAt = fault === 'drop' ? Math.max(1, Math.floor(toks.length / 2)) : -1;
    await sleep(ttftMs + (rng() * 2 - 1) * jitterMs);
    for (let i = 0; i < toks.length; i++) {
      if (i === dropAt) { stats.faults.drop++; res.destroy(); return; }
      if (res.destroyed) return;
      writeEvent(res, { token: toks[i], i: i + resume_from, provider: name });
      stats.tokens_sent++;
      if (interTokenMs) await sleep(interTokenMs);
    }
    writeEvent(res, '[DONE]');
    res.end();
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return {
    name, stats, server,
    listen: () => new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise((ok) => { for (const s of sockets) s.destroy(); server.close(() => ok()); }),
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

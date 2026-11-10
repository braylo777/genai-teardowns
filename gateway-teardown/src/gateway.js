// Agent gateway: one SSE stream to the client, fallback routing across upstream providers.
// - Before the first token: 5xx / connect error / no token within ttftTimeoutMs -> try the next provider.
// - Mid-stream (drop, or no token for idleTimeoutMs): policy 'error' ends the stream with an error event;
//   policy 'resume' asks the next provider to continue from the last delivered token index (no duplicates).
import { createServer } from 'node:http';
import { readSSE, writeEvent } from './sse.js';

export class UpstreamError extends Error {
  constructor(kind, delivered) { super(kind); this.kind = kind; this.delivered = delivered; }
}

async function* withTimeouts(iter, ttftMs, idleMs, ctrl, gotFirst) {
  const it = iter[Symbol.asyncIterator]();
  for (;;) {
    const limit = gotFirst() ? idleMs : ttftMs;
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => { ctrl.abort(); rej(new Error(gotFirst() ? 'idle_timeout' : 'ttft_timeout')); }, limit); });
    let r;
    try { r = await Promise.race([it.next(), timeout]); } finally { clearTimeout(timer); }
    if (r.done) return;
    yield r.value;
  }
}

// Stream one upstream attempt; calls onToken for each token. Resolves on [DONE], throws UpstreamError otherwise.
export async function streamFrom(url, prompt, resumeFrom, { ttftTimeoutMs, idleTimeoutMs, onToken, fetchImpl = fetch }) {
  const ctrl = new AbortController();
  let delivered = 0;
  let res;
  const connectTimer = setTimeout(() => ctrl.abort(), ttftTimeoutMs);
  try {
    res = await fetchImpl(url, { method: 'POST', body: JSON.stringify({ prompt, resume_from: resumeFrom }), signal: ctrl.signal });
  } catch {
    throw new UpstreamError(ctrl.signal.aborted ? 'ttft_timeout' : 'connect_error', 0);
  } finally { clearTimeout(connectTimer); }
  if (res.status >= 500) throw new UpstreamError(`http_${res.status}`, 0);
  if (!res.ok) throw new UpstreamError(`http_${res.status}`, 0);
  try {
    for await (const e of withTimeouts(readSSE(res.body), ttftTimeoutMs, idleTimeoutMs, ctrl, () => delivered > 0)) {
      if (e.data === '[DONE]') return { delivered };
      const msg = JSON.parse(e.data);
      delivered++;
      onToken(msg);
    }
  } catch (err) {
    throw new UpstreamError(['ttft_timeout', 'idle_timeout'].includes(err.message) ? err.message : 'stream_drop', delivered);
  }
  throw new UpstreamError('stream_drop', delivered); // ended without [DONE]
}

// Core routing, independent of HTTP so it can be unit tested.
export async function route(prompt, providers, { policy = 'resume', ttftTimeoutMs = 1000, idleTimeoutMs = 500, emit, fetchImpl } = {}) {
  let nextIndex = 0; const attempts = [];
  for (const p of providers) {
    if (nextIndex > 0 && policy === 'error') break;
    const start = nextIndex;
    try {
      await streamFrom(p.url, prompt, nextIndex, { ttftTimeoutMs, idleTimeoutMs, fetchImpl,
        onToken: (m) => { if (m.i === nextIndex) { emit({ type: 'token', token: m.token, provider: p.name }); nextIndex++; } } });
      attempts.push({ provider: p.name, ok: true, from: start, tokens: nextIndex - start });
      return { ok: true, attempts, tokens: nextIndex };
    } catch (err) {
      attempts.push({ provider: p.name, ok: false, error: err.kind || String(err), from: start, tokens: nextIndex - start });
      emit({ type: 'fallback', from: p.name, error: err.kind, at_token: nextIndex });
    }
  }
  return { ok: false, attempts, tokens: nextIndex };
}

export function createGateway({ providers, policy = 'resume', ttftTimeoutMs = 1000, idleTimeoutMs = 500 }) {
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/stream') { res.writeHead(404).end(); return; }
    let body = ''; for await (const c of req) body += c;
    let prompt;
    try { ({ prompt } = JSON.parse(body)); } catch { res.writeHead(400).end('bad json'); return; }
    if (typeof prompt !== 'string' || !prompt) { res.writeHead(400).end('prompt required'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const r = await route(prompt, providers, { policy, ttftTimeoutMs, idleTimeoutMs,
      emit: (e) => (e.type === 'token' ? writeEvent(res, { token: e.token, provider: e.provider }) : writeEvent(res, e, 'meta')) });
    if (r.ok) writeEvent(res, { attempts: r.attempts }, 'done');
    else writeEvent(res, { error: 'all_upstreams_failed', attempts: r.attempts }, 'error');
    res.end();
  });
  return {
    server,
    listen: () => new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}

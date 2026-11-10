import test from 'node:test';
import assert from 'node:assert/strict';
import { SSEParser } from '../gateway-teardown/src/sse.js';
import { createMockProvider, tokensFor, mulberry32 } from '../gateway-teardown/src/mock-provider.js';
import { createGateway, route, streamFrom, UpstreamError } from '../gateway-teardown/src/gateway.js';
import { consume } from '../gateway-teardown/bench/run.mjs';

async function setup(primaryOpts = {}, policy = 'resume') {
  const p = createMockProvider({ name: 'primary', ttftMs: 5, jitterMs: 0, interTokenMs: 2, nTokens: 10, ...primaryOpts });
  const s = createMockProvider({ name: 'secondary', ttftMs: 5, jitterMs: 0, interTokenMs: 0, nTokens: 10, seed: 9 });
  const pu = await p.listen(); const su = await s.listen();
  const providers = [{ name: 'primary', url: pu }, { name: 'secondary', url: su }];
  const close = async () => { await p.close(); await s.close(); };
  return { p, s, providers, close, policy };
}

const collect = async (prompt, providers, opts) => {
  const ev = [];
  const r = await route(prompt, providers, { ttftTimeoutMs: 200, idleTimeoutMs: 100, ...opts, emit: (e) => ev.push(e) });
  return { r, text: ev.filter((e) => e.type === 'token').map((e) => e.token), ev };
};

test('SSE parser handles split chunks and multi-line data', () => {
  const p = new SSEParser();
  assert.deepEqual(p.push('event: meta\nda'), []);
  assert.deepEqual(p.push('ta: a\ndata: b\n\ndata: c\n\n'), [{ event: 'meta', data: 'a\nb' }, { event: 'message', data: 'c' }]);
});

test('tokensFor is deterministic and resume-sliceable', () => {
  assert.deepEqual(tokensFor('Hi there', 3), ['hi0', 'there1', 'hi2']);
  assert.equal(mulberry32(1)(), mulberry32(1)());
});

test('healthy primary serves everything', async () => {
  const t = await setup();
  const { r, text } = await collect('q one', t.providers);
  assert.ok(r.ok); assert.deepEqual(text, tokensFor('q one', 10));
  assert.equal(r.attempts.length, 1); assert.equal(t.s.stats.requests, 0);
  await t.close();
});

test('503 before first token falls back to secondary', async () => {
  const t = await setup({ faults: { '503': 1 } });
  const { r, text, ev } = await collect('q two', t.providers);
  assert.ok(r.ok); assert.deepEqual(text, tokensFor('q two', 10));
  assert.equal(ev.find((e) => e.type === 'fallback').error, 'http_503');
  await t.close();
});

test('stall (no first token) hits the TTFT timeout then falls back', async () => {
  const t = await setup({ faults: { stall: 1 } });
  const t0 = performance.now();
  const { r, ev } = await collect('q three', t.providers);
  assert.ok(r.ok); assert.equal(ev.find((e) => e.type === 'fallback').error, 'ttft_timeout');
  assert.ok(performance.now() - t0 >= 190);
  await t.close();
});

test('mid-stream drop + resume policy: exact text, no duplicates', async () => {
  const t = await setup({ faults: { drop: 1 } });
  const { r, text } = await collect('q four', t.providers);
  assert.ok(r.ok); assert.deepEqual(text, tokensFor('q four', 10));
  assert.equal(r.attempts[0].tokens, 5); assert.equal(r.attempts[1].from, 5);
  assert.equal(t.s.stats.tokens_sent, 5); // secondary only generated the remainder
  await t.close();
});

test('mid-stream drop + error policy: stops, reports failure, partial text', async () => {
  const t = await setup({ faults: { drop: 1 } });
  const { r, text } = await collect('q five', t.providers, { policy: 'error' });
  assert.equal(r.ok, false); assert.equal(text.length, 5); assert.equal(t.s.stats.requests, 0);
  await t.close();
});

test('all upstreams down -> not ok', async () => {
  const { r } = await collect('q', [{ name: 'a', url: 'http://127.0.0.1:9' }, { name: 'b', url: 'http://127.0.0.1:9' }]);
  assert.equal(r.ok, false); assert.equal(r.attempts.length, 2);
});

test('streamFrom throws UpstreamError on 4xx', async () => {
  const fake = async () => new Response('no', { status: 401 });
  await assert.rejects(streamFrom('http://x', 'p', 0, { ttftTimeoutMs: 100, idleTimeoutMs: 100, onToken() {}, fetchImpl: fake }),
    (e) => e instanceof UpstreamError && e.kind === 'http_401');
});

test('gateway HTTP: rejects bad input and unknown routes', async () => {
  const t = await setup({ faults: { '503': 1 } });
  const gw = createGateway({ providers: t.providers, ttftTimeoutMs: 200, idleTimeoutMs: 100 });
  const gu = await gw.listen();
  const bad = await fetch(`${gu}/v1/stream`, { method: 'POST', body: '{}' });
  assert.equal(bad.status, 400);
  assert.equal((await fetch(`${gu}/nope`)).status, 404);
  await gw.close(); await t.close();
});

test('consume() returns ok for a full 40-token answer through the gateway', async () => {
  const p = createMockProvider({ name: 'primary', ttftMs: 5, jitterMs: 0, interTokenMs: 0, nTokens: 40 });
  const pu = await p.listen();
  const gw = createGateway({ providers: [{ name: 'primary', url: pu }] });
  const gu = await gw.listen();
  const r = await consume(`${gu}/v1/stream`, 'hello world');
  assert.equal(r.ok, true); assert.equal(r.n, 40); assert.ok(r.ttft > 0);
  await gw.close(); await p.close();
});

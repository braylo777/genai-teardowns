import test from 'node:test';
import assert from 'node:assert/strict';
import { percentile, summarizeTokens, costPerTask } from '../rag-teardown/bench/lib.mjs';

test('percentile (nearest-rank)', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5, 1, 3], 50), 3);
  assert.equal(percentile([1, 2, 3, 4], 95), 4);
});
test('summarizeTokens', () => {
  assert.deepEqual(summarizeTokens([100, 200, 300]), { mean: 200, p95: 300, max: 300 });
});
test('costPerTask matches neuron formula and rejects unknown models', () => {
  const P = { m: { in_neurons_per_m: 26668, out_neurons_per_m: 204805 }, usd_per_1k_neurons: 0.011 };
  // 1000 in + 100 out -> 26.668 + 20.4805 = 47.1485 neurons -> $0.000518634
  assert.equal(costPerTask(P, 'm', 1000, 100), 0.0005186);
  assert.throws(() => costPerTask(P, 'x', 1, 1));
});

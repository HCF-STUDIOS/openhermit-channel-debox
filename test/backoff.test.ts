import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { computeBackoffMs } from '../src/bot.js';

// Deterministic jitter: random()=0.5 → factor 1.0, so the value equals the
// (capped) exponential term. This is the guard against the debox "Bad Request"
// storm: a persistently failing poll must back off, not re-poll every ~1s.
const noJitter = () => 0.5;

test('debox backoff doubles per consecutive failure', () => {
  assert.equal(computeBackoffMs(1, 1000, 60_000, noJitter), 1000);
  assert.equal(computeBackoffMs(2, 1000, 60_000, noJitter), 2000);
  assert.equal(computeBackoffMs(3, 1000, 60_000, noJitter), 4000);
  assert.equal(computeBackoffMs(4, 1000, 60_000, noJitter), 8000);
});

test('debox backoff caps at maxMs for a long failure streak', () => {
  assert.equal(computeBackoffMs(7, 1000, 60_000, noJitter), 60_000);
  assert.equal(computeBackoffMs(500, 1000, 60_000, noJitter), 60_000);
});

test('debox backoff treats attempt < 1 as the first retry', () => {
  assert.equal(computeBackoffMs(0, 1000, 60_000, noJitter), 1000);
});

test('debox backoff jitter stays within ±20%', () => {
  assert.equal(computeBackoffMs(3, 1000, 60_000, () => 0), 3200); // 4000 * 0.8
  assert.equal(computeBackoffMs(3, 1000, 60_000, () => 1), 4800); // 4000 * 1.2
});

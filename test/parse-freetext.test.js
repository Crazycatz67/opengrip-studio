import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLine } from '../src/parse.js';

test('free-text header keys keep values that contain k=v', () => {
  const r = parseLine('# notes=moved band, gain=2 and rate=100');
  assert.equal(r.kind, 'meta');
  assert.equal(r.meta.notes, 'moved band, gain=2 and rate=100');
});

test('device header lines with several k=v still split', () => {
  const r = parseLine('# nxt_logger v1 channels=6 rate_hz=200');
  assert.equal(r.meta.channels, '6');
  assert.equal(r.meta.rate_hz, '200');
});

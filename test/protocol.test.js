import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultProtocol, stepAt, totalSeconds, timeline, parseProtocolJSON, splitLabel } from '../src/protocol.js';

test('default protocol: calibration first, 3 positions, distractor, timings add up', () => {
  const p = defaultProtocol();
  const labels = p.steps.map((s) => s.label);
  assert.equal(labels[0], 'cal_rest');
  assert.equal(p.steps[0].seconds, 5);
  assert.equal(labels.filter((l) => l === 'cal_squeeze').length, 3);
  for (const pos of ['down', 'elbow90', 'raised']) assert.equal(labels.filter((l) => l === `grip@${pos}`).length, 5, pos);
  assert.equal(labels.filter((l) => l === 'open@down').length, 5);
  assert.equal(labels.filter((l) => l === 'elbow_bend').length, 5);
  assert.equal(labels[labels.length - 1], 'rest');
  assert.ok(!p.steps.some((s) => /as hard as you can/.test(s.instruction) && !/not as hard/.test(s.instruction)));
  // 5 + 3*7 + 10 + 3*(4 + 5*7) + 5*7 + 5*7 + 10
  assert.equal(totalSeconds(p), 5 + 21 + 10 + 3 * 39 + 35 + 35 + 10);
  const tl = timeline(p);
  assert.equal(tl[tl.length - 1].end, totalSeconds(p));
});

test('stepAt: boundaries, progress and done', () => {
  const p = defaultProtocol();
  assert.equal(stepAt(p, 0).step.label, 'cal_rest');
  assert.equal(stepAt(p, 4.99).step.label, 'cal_rest');
  assert.equal(stepAt(p, 5).step.label, 'cal_squeeze');
  assert.ok(Math.abs(stepAt(p, 6).stepRemaining - 2) < 1e-9);
  const total = totalSeconds(p);
  assert.ok(Math.abs(stepAt(p, total / 2).progress - 0.5) < 1e-9);
  assert.equal(stepAt(p, total).done, true);
  assert.equal(stepAt(p, -3).index, 0);
});

test('custom JSON with repeat groups; bad JSON and bad steps are explained', () => {
  const ok = parseProtocolJSON('{"name":"x","steps":[{"label":"rest","seconds":2},{"repeat":3,"steps":[{"label":"grip@down","seconds":1},{"label":"rest","seconds":1}]}]}');
  assert.equal(ok.ok, true);
  assert.equal(ok.protocol.steps.length, 7);
  assert.equal(totalSeconds(ok.protocol), 8);
  assert.match(parseProtocolJSON('{').errors[0], /Not valid JSON/);
  const bad = parseProtocolJSON('{"steps":[{"label":"a,b","seconds":0}]}');
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 2);
  assert.deepEqual(splitLabel('grip@elbow90'), { gesture: 'grip', position: 'elbow90' });
});

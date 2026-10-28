// Movement-aligned labels (relabel.js) against the twin's ground-truth reaction lags, plus the
// twin's opt-in reactionMs / gapS options. Synthetic data: this shows relabel handles the twin,
// not that it times real movements to 30 ms (RISKS B17).
import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../src/sim/twin.js';
import { relabel } from '../src/relabel.js';

const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
// A prompted protocol: 3 s hold + 4 s rest, people react 200-400 ms late.
const lagged = (seed, extra = {}) => generate({ seed, channels: 6, positions: ['down', 'elbow90', 'raised'], reactionMs: [200, 400], holdS: 3, gapS: 7, ...extra });

// |aligned onset - true onset| in ms for every step change (kept steps score their full lag).
function onsetErrors(S, R) {
  const truth = new Map(S.truth.reactions.map((x) => [x.index, x]));
  return R.steps.slice(1).filter((s) => truth.has(s.promptStart)).map((s) => Math.abs(((s.onset - truth.get(s.promptStart).onset) * 1000) / S.rateHz));
}

test('twin: reactionMs is opt-in, delays the body and reports truth.reactions', () => {
  const a = generate({ seed: 3 });
  const b = generate({ seed: 3, reactionMs: 0 });
  assert.deepEqual(a.data, b.data, 'reactionMs 0 is sample-for-sample unchanged');
  assert.equal(a.truth.reactions, undefined);
  const S = generate({ seed: 3, reactionMs: [200, 400], holdS: 3, gapS: 7 });
  assert.deepEqual(S.labels, generate({ seed: 3, holdS: 3, gapS: 7 }).labels, 'prompts (labels) do not move');
  assert.ok(S.truth.reactions.length > 5);
  for (const r of S.truth.reactions) {
    assert.ok(r.lagMs >= 200 && r.lagMs <= 400, `lag ${r.lagMs}`);
    assert.equal(r.onset - r.index, Math.round((r.lagMs * S.rateHz) / 1000));
  }
  // The burst starts at the reaction onset, not at the prompt.
  const firstGrip = S.truth.bursts.find((x) => /^grip/.test(x.label));
  const rx = S.truth.reactions.find((x) => x.label === firstGrip.label && x.onset === firstGrip.start);
  assert.ok(rx, 'a grip burst starts at its reaction onset');
});

test('twin: gapS sets the prompted period (hold + rest)', () => {
  const S = generate({ seed: 1, holdS: 3, gapS: 7, positions: ['down'] });
  const runs = [];
  for (let i = 0; i < S.n;) { let j = i + 1; while (j < S.n && S.labels[j] === S.labels[i]) j++; runs.push([S.labels[i], j - i]); i = j; }
  const grips = runs.map((r, k) => [r, runs[k + 1]]).filter(([r, nx]) => r[0] === 'grip@down' || (r[0] === 'grip' && nx));
  assert.ok(grips.length >= 2);
  assert.ok(grips.some(([r, nx]) => r[1] === 300 && nx[1] >= 350), JSON.stringify(runs));
});

test('relabel: median onset error <= 60 ms on lagged twin sessions, seeds 1-10', () => {
  const all = [];
  for (let seed = 1; seed <= 10; seed++) {
    const S = lagged(seed);
    const R = relabel(S);
    const e = onsetErrors(S, R);
    assert.ok(median(e) <= 60, `seed ${seed}: median ${median(e)} ms`);
    all.push(...e);
    // Prompt timing alone is off by the whole lag.
    assert.ok(median(S.truth.reactions.map((x) => x.lagMs)) >= 200);
  }
  assert.ok(median(all) <= 40, `all seeds: median ${median(all)} ms`);
});

test('relabel: label array shifts only between prompt and onset, deterministic', () => {
  const S = lagged(4);
  const R = relabel(S);
  assert.equal(R.labels.length, S.labels.length);
  assert.deepEqual(relabel(S), R, 'deterministic');
  for (let k = 1; k < R.steps.length; k++) {
    const s = R.steps[k], prev = R.steps[k - 1];
    assert.ok(s.onset >= s.promptStart && s.onset < s.promptEnd, `step ${k} onset inside its prompt`);
    assert.equal(prev.offset, s.onset);
    for (let i = s.promptStart; i < s.onset; i++) assert.equal(R.labels[i], prev.label);
    for (let i = s.onset; i < s.offset; i++) assert.equal(R.labels[i], s.label);
    assert.equal(s.lagMs, Math.round(((s.onset - s.promptStart) * 1000) / S.rateHz));
    if (!s.aligned) { assert.equal(s.onset, s.promptStart); assert.ok(s.reason, 'kept steps say why'); }
  }
  assert.ok(R.summary.aligned >= 12 && R.summary.medianLagMs >= 200 && R.summary.medianLagMs <= 400, JSON.stringify(R.summary));
});

test('relabel: a missing channel and a noisy channel do not break it', () => {
  const S = lagged(2);
  const base = median(onsetErrors(S, relabel(S)));
  const T = { ...S, data: S.data.map((ch, c) => (c === 0 ? ch.map(() => NaN) : c === 1 ? ch.map((v, i) => v + 200 * Math.sin(i * 12.9898) ** 2) : ch)) };
  const R = relabel(T);
  assert.ok(median(onsetErrors(S, R)) <= 60, `median ${median(onsetErrors(S, R))} (clean ${base})`);
  const D = generate({ seed: 2, channels: 6, positions: ['down'], reactionMs: [200, 400], holdS: 3, gapS: 7, faults: ['dropout'] });
  assert.ok(median(onsetErrors(D, relabel(D))) <= 60, 'dropout fault');
});

test('relabel: no signal change keeps prompt timing and says why', () => {
  const n = 1000;
  const labels = Array.from({ length: n }, (_, i) => (Math.floor(i / 250) % 2 ? 'grip' : 'rest'));
  let x = 1;
  const noise = () => ((x = (x * 16807) % 2147483647) / 2147483647 - 0.5) * 6;
  const R = relabel({ data: [Array.from({ length: n }, () => 100 + noise())], labels, rateHz: 100 });
  assert.equal(R.summary.aligned, 0);
  assert.deepEqual(R.labels, labels);
  for (const s of R.steps.slice(1)) assert.match(s.reason, /no channel changes clearly|low confidence/);
  assert.equal(R.steps[0].reason, 'first step: nothing before it to compare');
  // A movement later than maxLagMs is not chased.
  const late = Array.from({ length: n }, (_, i) => ((i >= 250 && i < 500) ? (i >= 290 ? 300 : 100) : 100) + noise());
  const L = relabel({ data: [late], labels, rateHz: 100 }, { maxLagMs: 500 });
  assert.equal(L.steps[1].aligned, true, L.steps[1].reason);
  assert.ok(Math.abs(L.steps[1].onset - 290) <= 3, `onset ${L.steps[1].onset}`);
  const M = relabel({ data: [late], labels, rateHz: 100 }, { maxLagMs: 300 });
  assert.match(M.steps[1].reason, /no movement found within 300 ms/);
});

test('relabel: empty and unlabelled input', () => {
  assert.deepEqual(relabel({ data: [], labels: [] }).steps, []);
  assert.deepEqual(relabel(null).labels, []);
});

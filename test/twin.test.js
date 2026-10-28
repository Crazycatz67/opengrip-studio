// Digital twin: generation, faults + truth, line formats, live source, realism, detector scorecard.
// Synthetic data is for testing and demos, never as evidence of accuracy.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generate, toLines, TwinSource, TWIN_MODEL, FAULT_TYPES, PLACEMENT_FAULTS, siteWeights, realismScore, detectorScorecard } from '../src/sim/twin.js';
import { ringPreset } from '../src/placement.js';
import { detectFormat } from '../src/detect.js';
import { parseText } from '../src/parse.js';
import { analyzeRecording } from '../src/quality.js';
import { ROOT, FIX_CLUB, hasClubFixtures } from './helpers.js';

test('embedded model matches src/sim/twin-model.json', () => {
  assert.deepEqual(TWIN_MODEL, JSON.parse(fs.readFileSync(path.join(ROOT, 'src/sim/twin-model.json'), 'utf8')));
});

test('same seed, same session; channels clamp 1..8; values are 10-bit integers', () => {
  const a = generate({ seed: 3, faults: ['dropout', 'hum'] });
  const b = generate({ seed: 3, faults: ['dropout', 'hum'] });
  assert.deepEqual(a.data, b.data);
  assert.deepEqual(a.truth, b.truth);
  assert.equal(generate({ channels: 12 }).channels, 8);
  assert.equal(generate({ channels: 0 }).channels, 1);
  for (const ch of a.data) for (const v of ch) assert.ok(Number.isInteger(v) && v >= 0 && v <= 1023);
  assert.equal(a.truth.synthetic, true);
});

test('labels carry gesture@position, calibration and the elbow distractor', () => {
  const S = generate({ gesture: 'open', positions: ['down', 'elbow90', 'raised'] });
  const L = new Set(S.labels);
  for (const l of ['cal_rest', 'cal_squeeze', 'open', 'open@elbow90', 'open@raised', 'rest@raised', 'elbow_bend']) assert.ok(L.has(l), l);
});

test('dropout truth points at the zeros, followed by a spike', () => {
  const S = generate({ seed: 5, faults: ['dropout'] });
  const f = S.truth.faults[0];
  const ch = S.data[f.channel];
  assert.ok(ch.slice(f.start, f.end).every((v) => v === 0));
  assert.ok(ch[f.end] > 700, `spike ${ch[f.end]}`);
});

test('faults that cannot apply are listed as skipped, with a reason', () => {
  const S = generate({ rateHz: 100, channels: 1, faults: ['hum', 'crosstalk'] });
  assert.deepEqual(S.truth.skipped.map((s) => s.type), ['hum', 'crosstalk']);
  assert.equal(generate({ rateHz: 500, faults: ['hum'] }).truth.faults[0].type, 'hum');
  assert.throws(() => generate({ faults: ['gremlins'] }), /unknown fault/);
});

test('every format is detected by detect.js with the right channel count', () => {
  const S = generate({ channels: 4, seed: 2 });
  const want = { nxt: ['timed', 4], timed: ['timed', 4], delimited: ['delimited', 4], tsv: ['delimited', 4], space: ['delimited', 4], single: ['single', 1], plotter: ['plotter', 4] };
  for (const [fmt, [kind, ch]] of Object.entries(want)) {
    const lines = toLines(S, fmt);
    assert.match(lines[0], /^# synthetic=true/);
    const d = detectFormat(lines.slice(0, 60));
    assert.equal(d.ok, true, fmt);
    assert.equal(d.kind, kind, fmt);
    assert.equal(d.channels, ch, fmt);
  }
});

test('nxt lines round-trip through parse.js: values, labels, rate', () => {
  const S = generate({ seed: 4 });
  const rec = parseText(toLines(S, 'nxt').join('\n'));
  assert.equal(rec.channels, 6);
  assert.deepEqual(rec.data[2], S.data[2]);
  assert.deepEqual(rec.labels, S.labels);
  assert.equal(rec.rateHz, 100);
});

test('boot junk sticks to the first line; parse.js still reads it and counts garbage', () => {
  const S = generate({ seed: 6, faults: ['boot'] });
  const lines = toLines(S, 'single');
  assert.ok(/[^\x20-\x7E]/.test(lines[1]));
  const rec = parseText(lines.join('\n'));
  assert.equal(rec.data[0][0], S.data[0][0]);
  assert.ok(rec.stats.garbageLines >= 1);
});

test('brownout: junk, header again, device clock restarts near 0, a gap in samples', () => {
  const S = generate({ seed: 7, faults: ['brownout'] });
  const f = S.truth.faults[0];
  assert.ok(S.t[f.start] <= 5 && S.t[f.start - 1] > 1000, `${S.t[f.start - 1]} -> ${S.t[f.start]}`);
  assert.ok(f.gap > 20);
  const lines = toLines(S, 'nxt');
  assert.equal(lines.filter((l) => l.startsWith('# nxt_logger')).length, 2);
  assert.ok(S.hostMs[f.start] - S.hostMs[f.start - 1] >= f.gap * 10 - 20);
});

test('slowlink: 6 channels at 9600 baud only carry ~28 lines/s; arrivals bunch and lag', () => {
  const S = generate({ seed: 8, faults: ['slowlink'] });
  const f = S.truth.faults[0];
  assert.ok(f.capacityHz < 40 && f.dropped > 0);
  const rec = parseText(toLines(S, 'nxt').join('\n'));
  assert.ok(Math.abs(rec.rateHz - f.capacityHz) < 10, `rate ${rec.rateHz} vs ${f.capacityHz}`);
  assert.equal(generate({ channels: 1, rateHz: 50, faults: ['slowlink'] }).truth.skipped[0].type, 'slowlink');
});

test('missing samples and jitter only touch timestamps; crosstalk leaks the previous channel', () => {
  const m = generate({ seed: 9, faults: ['missing'] });
  const f = m.truth.faults[0];
  assert.ok(m.t[f.start] - m.t[f.start - 1] >= f.len * 10);
  const j = generate({ seed: 9, faults: ['jitter'] });
  for (let i = 1; i < j.n; i++) assert.ok(j.t[i] >= j.t[i - 1]);
  const x = generate({ seed: 9, faults: [{ type: 'crosstalk', channel: 1, leak: 0.2 }] });
  const clean = generate({ seed: 9 });
  // Settling error: ch2 reads 0.2 x (ch1 - ch2) extra, within rounding.
  const err = x.data[1].map((v, i) => Math.abs(v - clean.data[1][i] - 0.2 * (clean.data[0][i] - clean.data[1][i])));
  assert.ok(Math.max(...err) <= 1.5, `max error ${Math.max(...err)}`);
  assert.ok(x.data[1].some((v, i) => v - clean.data[1][i] >= 5), 'leak visible where ch1 is high');
});

test('TwinSource: FakeSource interface, deterministic, label-driven bursts', async () => {
  const a = new TwinSource({ channels: 3, seed: 2 }).generateLines(5);
  assert.deepEqual(a, new TwinSource({ channels: 3, seed: 2 }).generateLines(5));
  assert.match(a[0], /^# nxt_logger v1 channels=3 rate_hz=100 source=twin synthetic=true/);
  assert.equal(detectFormat(a.slice(0, 60)).channels, 3);
  let label = 'rest';
  const src = new TwinSource({ channels: 2, labelProvider: () => label });
  const peak = (n) => { let m = 0; for (let i = 0; i < n; i++) m = Math.max(m, Number(src.nextLine().split(',')[1])); return m; };
  const rest = peak(200);
  label = 'grip';
  assert.ok(peak(60) > rest + 100);
  let t = 0;
  const got = [];
  const live = new TwinSource({ channels: 2, now: () => t, speed: 1 });
  await live.start({ onLine: (l) => got.push(l), onStatus: () => {} });
  t = 1000;
  await new Promise((r) => setTimeout(r, 40));
  await live.stop();
  assert.ok(got.length >= 100, `${got.length} lines`);
});

// Needs the real club logs (git-ignored test/fixtures-club/): scoring the twin against its own
// synthetic stand-ins would be circular, so without them this check is skipped, not faked.
test('realism: twin within range of the club logs on most summary statistics', { skip: !hasClubFixtures() && 'no test/fixtures-club/ (club logs are local only)' }, async () => {
  const { loadFixtures } = await import('../tools/twin.mjs'); // here, not at the top: the public export leaves tools/twin.mjs out
  const r = realismScore(loadFixtures(FIX_CLUB));
  const out = Object.entries(r.tasks).flatMap(([t, s]) => Object.entries(s).filter(([, v]) => !v.within).map(([k]) => `${t}.${k}`));
  console.log(`realism ${r.within}/${r.total}; outside: ${out.join(', ')}`);
  // 44/52 on 2026-10-20; the floor catches regressions, not a claim of accuracy.
  assert.ok(r.score >= 0.8, `realism ${r.within}/${r.total}`);
});

test('detector scorecard: quality.js catches the contact faults, never cries dropout on a clean twin', () => {
  const c = detectorScorecard({ parse: parseText, analyze: analyzeRecording, seeds: 6 });
  console.log(Object.entries(c.types).map(([t, r]) => `${t} ${r.hits}/${r.hits + r.misses}`).join(' | '), '| clean', JSON.stringify(c.clean.falseAlarms));
  for (const t of ['dropout', 'loose', 'saturation', 'shift']) assert.ok(c.types[t].hits >= 5, t);
  for (const code of ['dropout', 'spike', 'saturation', 'noisy_rest']) assert.equal(c.clean.falseAlarms[code] ?? 0, 0, code);
  assert.deepEqual(Object.keys(c.types), FAULT_TYPES);
});

// Site-aware gestures (opts.placement): measured straight from the data, not via placement.js.
// Response = 90th percentile during a step minus the median at relax, per channel.
function stepResp(S) {
  const q = (a, f) => { const x = [...a].sort((m, n) => m - n); return x[Math.floor((x.length - 1) * f)]; };
  return S.data.map((ch) => {
    const by = (l) => ch.filter((_, i) => S.labels[i] === l);
    const rest = q(by('relax'), 0.5);
    return Object.fromEntries(['fist', 'wrist_back', 'elbow_bend'].map((l) => [l, q(by(l), 0.9) - rest]));
  });
}

test('check gesture: the 4 placement-check steps as labels, no calibration or distractor by default', () => {
  const S = generate({ seed: 2, channels: 4, gesture: 'check' });
  const L = [...new Set(S.labels)];
  assert.deepEqual(L.sort(), ['elbow_bend', 'fist', 'relax', 'wrist_back']);
  assert.equal(S.labels.filter((l, i) => l === 'fist' && S.labels[i - 1] !== 'fist').length, 2, '2 reps');
  assert.ok(generate({ seed: 2, channels: 4, gesture: 'check', calibration: true }).labels.includes('cal_squeeze'));
});

test('placement: palm sites rise on the fist, back sites on wrist back, elbow pickup grows near the crease', () => {
  const p = ringPreset({ count: 6, cmFromElbowCrease: 8, emg: [{ muscle: 'flexors' }, { muscle: 'extensors' }] });
  const r = stepResp(generate({ seed: 4, channels: 8, gesture: 'check', placement: p }));
  for (const c of [0, 1, 5, 6]) assert.ok(r[c].fist > 2 * r[c].wrist_back, `palm ch${c + 1} ${JSON.stringify(r[c])}`);
  for (const c of [2, 3, 4, 7]) assert.ok(r[c].wrist_back > 1.5 * r[c].fist, `back ch${c + 1} ${JSON.stringify(r[c])}`);
  // Well placed (8 cm): small but real elbow response (5-35% of the main movement).
  for (const c of [0, 3]) { const main = Math.max(r[c].fist, r[c].wrist_back); assert.ok(r[c].elbow_bend > 0.05 * main && r[c].elbow_bend < 0.35 * main, JSON.stringify(r[c])); }
  const near = stepResp(generate({ seed: 4, channels: 8, gesture: 'check', placement: ringPreset({ count: 6, cmFromElbowCrease: 1 }) }));
  assert.ok(near[0].elbow_bend > 3 * r[0].elbow_bend, `near ${near[0].elbow_bend} vs 8 cm ${r[0].elbow_bend}`);
  assert.equal(siteWeights({ sensor: 'FMG' }), null, 'no site entered -> channel-number patterns');
  assert.deepEqual(siteWeights({ ch: 1, ringAngleDeg: 0, cmFromElbowCrease: 8 }, { misplaced: true }).grip, siteWeights({ ch: 1, ringAngleDeg: 180, cmFromElbowCrease: 8 }).grip);
});

test('misplace fault: the channel answers the opposite movement; recorded in truth; not a Doctor fault', () => {
  assert.deepEqual(PLACEMENT_FAULTS, ['misplace']);
  assert.ok(!FAULT_TYPES.includes('misplace'), 'the Doctor scorecard must not expect to see it');
  const p = ringPreset({ count: 4, cmFromElbowCrease: 8 });
  // Channel 1 (palm middle): an edge sensor (90 / 270) turned half a turn stays an edge.
  const S = generate({ seed: 5, channels: 4, gesture: 'check', placement: p, faults: [{ type: 'misplace', channel: 0 }] });
  const f = S.truth.faults[0];
  assert.equal(f.type, 'misplace');
  assert.deepEqual([f.start, f.end], [0, S.n]);
  const r = stepResp(S);
  const clean = stepResp(generate({ seed: 5, channels: 4, gesture: 'check', placement: p }));
  const c = f.channel;
  assert.ok(Math.sign(r[c].fist - r[c].wrist_back) !== Math.sign(clean[c].fist - clean[c].wrist_back), `ch${c + 1} ${JSON.stringify(r[c])} vs ${JSON.stringify(clean[c])}`);
  // No placement: the channel's grip / open pattern rows swap instead.
  const np = stepResp(generate({ seed: 5, channels: 4, gesture: 'check', faults: [{ type: 'misplace', channel: 0 }] }));
  assert.ok(np[0].wrist_back > np[0].fist, JSON.stringify(np[0]));
});

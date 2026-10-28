import test from 'node:test';
import assert from 'node:assert/strict';
import { generate, rng } from '../src/sim/twin.js';
import { toCSV, fromCSV, sidecarJSON } from '../src/csv.js';
import { exportFiles } from '../src/export/index.js';
import {
  ringPreset, siteName, sideOf, ringXY, mirrorPlacement, diffPlacement, placementSummary,
  encodePlacementMap, decodePlacementMap, checkPlacement, liveCheck, checkSummary, emgSite,
} from '../src/placement.js';

const RATE = 100;
const STEP_S = { relax: 5, fist: 3, wrist_back: 3, elbow_bend: 3 };

// Hand-built check recording, kept as a check independent of the twin (which now covers the
// site patterns, see the twin tests below): it also expresses flat and faint channels, explicit
// step indices and 10 channels. resp[c] gives each channel's rise in counts per step; noise sd 3.
function checkRec(resp, { seed = 7, base = 200, sd = 3 } = {}) {
  const R = rng(seed);
  const data = resp.map(() => []);
  const labels = [];
  for (const [step, s] of Object.entries(STEP_S)) {
    const n = s * RATE;
    for (let i = 0; i < n; i++) {
      // Smooth rise and fall inside the step, held in the middle (like a real 3 s hold).
      const env = step === 'relax' ? 0 : Math.min(1, i / 40, (n - i) / 40);
      resp.forEach((r, c) => data[c].push(Math.round(base + (r[step] || 0) * env + R.normal(0, sd))));
      labels.push(step);
    }
  }
  return { data, labels, rateHz: RATE, t: labels.map((_, i) => i * 10) };
}
const PALM = { fist: 150, wrist_back: 20, elbow_bend: 15 };
const BACK = { fist: 20, wrist_back: 150, elbow_bend: 15 };

// 8-ring from palm middle: ch 1,2,8 palm (0, 45, 315), ch 3 at 90 (back by the §7 rule), 4-7 back.
const ring = () => ringPreset({ count: 8, cmFromElbowCrease: 8, arm: 'R', person_id: 'P03', emg: [{ muscle: 'flexors' }, { muscle: 'extensors' }] });
const respFor = (p) => p.channels.map((c) => (c.sensor === 'EMG' ? (/Flex/.test(c.site) ? PALM : BACK) : c.side === 'palm' ? PALM : BACK));

test('ring preset: angles, octant names, sides', () => {
  const p = ring();
  assert.deepEqual(p.channels.slice(0, 8).map((c) => c.ringAngleDeg), [0, 45, 90, 135, 180, 225, 270, 315]);
  assert.deepEqual(p.channels.slice(0, 8).map((c) => c.side), ['palm', 'palm', 'back', 'back', 'back', 'back', 'palm', 'palm']);
  assert.equal(p.channels[0].site, 'Palm middle');
  assert.equal(p.channels[2].site, 'Thumb edge');
  assert.deepEqual(p.channels.slice(8).map((c) => [c.ch, c.sensor, c.site, c.side]), [[9, 'EMG', 'Flexors', 'palm'], [10, 'EMG', 'Extensors', 'back']]);
  const rev = ringPreset({ count: 6, startDeg: 30, dir: -1 });
  assert.deepEqual(rev.channels.map((c) => c.ringAngleDeg), [30, 330, 270, 210, 150, 90]);
  assert.equal(siteName(359), 'Palm middle');
  assert.equal(siteName(null), null);
  assert.equal(sideOf(270), 'palm');
  assert.equal(sideOf(269), 'back');
  assert.equal(ringPreset({ cmFromElbowCrease: 8.3 }).ring.cmFromElbowCrease, 8.5);
  assert.equal(emgSite('extensors').ringAngleDeg, 200);
});

test('left/right: same anatomical angles, the drawing mirrors the thumb side', () => {
  const R = ring();
  const L = mirrorPlacement(R);
  assert.equal(L.arm, 'L');
  assert.deepEqual(L.channels.map((c) => c.ringAngleDeg), R.channels.map((c) => c.ringAngleDeg));
  assert.ok(L.channels.every((c) => c.arm === 'L'));
  const r = ringXY(90, 'R');
  const l = ringXY(90, 'L');
  assert.ok(Math.abs(r.x + 1) < 1e-9 && Math.abs(l.x - 1) < 1e-9, 'thumb on the left for a right arm');
  assert.ok(Math.abs(ringXY(0, 'R').y - 1) < 1e-9, 'palm middle at the bottom');
  assert.deepEqual(diffPlacement(R, L).map((d) => d.kind), ['arm']);
});

test('diff against the previous fit: thresholds and plain words', () => {
  const prev = ring();
  const next = structuredClone(prev);
  next.channels[2].cmFromElbowCrease = 9.5;   // +1.5 cm
  next.channels[3].cmFromElbowCrease = 7.5;   // -0.5 cm: under the 1 cm threshold
  next.channels[4].ringAngleDeg = 210;        // 180 -> 210: 30°
  next.channels[5].ringAngleDeg = 235;        // 225 -> 235: under 20°
  next.channels[0].ringAngleDeg = 340;        // 0 -> 340 the short way round: 20°
  const d = diffPlacement(prev, next);
  assert.deepEqual(d.map((x) => [x.ch, x.kind]), [[1, 'around'], [3, 'along'], [5, 'around']]);
  assert.equal(d[1].text, 'Sensor 3 (thumb edge) is 1.5 cm further from the elbow than last time (8.0 → 9.5 cm).');
  assert.equal(d[0].delta, -20);
  assert.equal(d[2].text, 'Sensor 5 (back, little-finger side) has turned 30° toward the little finger.');
  next.channels[1].cmFromElbowCrease = 6.5;
  assert.equal(diffPlacement(prev, next).find((x) => x.ch === 2).text, 'Sensor 2 (palm, thumb side) is 1.5 cm closer to the elbow than last time (8.0 → 6.5 cm).');
  assert.deepEqual(diffPlacement(prev, structuredClone(prev)), []);
  const fewer = { ...prev, channels: prev.channels.slice(0, 9) };
  assert.deepEqual(diffPlacement(prev, fewer).map((x) => [x.ch, x.kind]), [[10, 'removed']]);
});

test('summary line', () => {
  assert.equal(placementSummary(ring()), 'right arm; 8 FMG evenly spaced ring 8 cm below elbow crease; EMG 9 flexors, 10 extensors; entered by user');
  assert.equal(placementSummary(null), '');
});

test('CSV: placement_map round-trips, even with = and newlines in the landmark', () => {
  const p = { ...ring(), landmark: 'Sensor 1 under the strap buckle; a=b x=1\nnext line', saved_at: '2026-10-21T19:04:00Z' };
  const rec = { t: [0, 10, 20], data: [[1, 2, 3], [4, 5, 6]], labels: ['rest', 'rest', 'grip'], rateHz: 100 };
  const meta = { person_id: 'P03', placement: placementSummary(p), placement_map: p, notes: 'x' };
  const text = toCSV(rec, meta);
  const line = text.split('\n').find((l) => l.startsWith('# placement_map='));
  assert.ok(line && !line.slice('# placement_map='.length).includes('='), 'no raw = after the key');
  const back = fromCSV(text);
  assert.deepEqual(back.meta.placement_map, p);
  assert.equal(back.meta.placement, meta.placement);
  assert.equal(back.meta.notes, 'x');
  assert.deepEqual(fromCSV(toCSV(back, back.meta)).meta.placement_map, p, 'second round trip');
  // The header string form is accepted as input too.
  assert.deepEqual(fromCSV(toCSV(rec, { person_id: 'P03', placement_map: encodePlacementMap(p) })).meta.placement_map, p);
  const broken = fromCSV('# placement_map={nope\nt_ms,ch1,label\n0,1,rest\n');
  assert.equal(broken.meta.placement_map, undefined);
  assert.ok(broken.meta.placement_map_error);
  assert.equal(decodePlacementMap('not json'), null);
  assert.deepEqual(JSON.parse(sidecarJSON({}, { person_id: 'P03', placement_map: encodePlacementMap(p) })).meta.placement_map, p);
});

test('exports carry placement: BIDS columns + description, metadata.json, README note', () => {
  const p = ringPreset({ count: 2, arm: 'L', emg: [{ muscle: 'flexors' }] });
  const S = generate({ seed: 2, channels: 3, gesture: 'grip', reps: 3 });
  const rec = fromCSV(toCSV(S, { person_id: 'P07', sensors: 'FMG,FMG,EMG', placement_map: p }));
  const F = Object.fromEntries(exportFiles([rec]).map((f) => [f.path, f.text]));
  const chPath = Object.keys(F).find((k) => k.endsWith('_channels.tsv'));
  const rows = F[chPath].trim().split('\n').map((l) => l.split('\t'));
  assert.deepEqual(rows[0].slice(5), ['placement', 'placement_side', 'placement_angle_deg', 'placement_cm_from_elbow_crease']);
  assert.deepEqual(rows.slice(1).map((r) => r.slice(5)), [['Palm middle', 'palm', '0', '8'], ['Back middle', 'back', '180', '8'], ['Flexors', 'palm', '20', '5']]);
  const side = JSON.parse(F[chPath.replace('_channels.tsv', '_emg.json')]);
  assert.equal(side.EMGPlacementSchemeDescription, 'left arm; 2 FMG evenly spaced ring 8 cm below elbow crease; EMG 3 flexors; entered by user');
  assert.deepEqual(JSON.parse(F['libemg/metadata.json']).recordings[0].meta.placement_map, p);
  assert.deepEqual(JSON.parse(F['edge-impulse/metadata.json']).recordings[0].meta.placement_map, p);
  assert.match(F['libemg/README.md'], /meta\.placement_map/);
  assert.match(F['README.txt'], /placement_map/);
  // No placement: 'n/a' columns, no README sentence.
  const F2 = Object.fromEntries(exportFiles([fromCSV(toCSV(S, { person_id: 'P07', sensors: 'FMG,FMG,EMG' }))], { formats: ['bids'] }).map((f) => [f.path, f.text]));
  const r2 = F2[Object.keys(F2).find((k) => k.endsWith('_channels.tsv'))].trim().split('\n')[1].split('\t');
  assert.deepEqual(r2.slice(5), ['n/a', 'n/a', 'n/a', 'n/a']);
  assert.doesNotMatch(F2['README.txt'], /placement_map/);
});

// Twin check sessions (twin gesture 'check' + placement): labels are the step ids, responses
// follow each channel's site. Twin channels stop at 8, so a 6-ring + 2 EMG stands in for the
// 8 + 2 layout above.
const ring6 = (o = {}) => ringPreset({ count: 6, cmFromElbowCrease: 8, arm: 'R', person_id: 'P03', emg: [{ muscle: 'flexors' }, { muscle: 'extensors' }], ...o });
const twinCheck = (p, opts = {}) => generate({ seed: 1, channels: p.channels.length, gesture: 'check', placement: p, ...opts });

// Public copy: needs the twin parameters fitted on club logs (withheld from the public copy).
test.skip('check on a twin session: a correct fit works here on every channel', () => {
  const p = ring6();
  for (const seed of [1, 2, 3]) {
    const res = checkPlacement(twinCheck(p, { seed }), p);
    assert.equal(res.length, 8);
    assert.deepEqual(res.map((r) => r.state), Array(8).fill('good'), `seed ${seed}: ${res.map((r) => r.reason).join(' | ')}`);
    assert.deepEqual(res.map((r) => r.missing.length), Array(8).fill(0), 'all 4 steps come from the twin labels');
    assert.ok(res.every((r) => /works here/.test(r.reason) && !/correct position/.test(r.reason)));
  }
  assert.deepEqual(checkPlacement(twinCheck(p), p).map((r) => r.expected), ['fist', 'fist', 'wrist_back', 'wrist_back', 'wrist_back', 'fist', 'fist', 'wrist_back']);
  assert.equal(checkSummary(checkPlacement(twinCheck(p), p)).text, '8 work here.');
  // 8-ring: the 90 / 270 degree edges sit between flexors and extensors, so they react to both
  // movements ('weak', not selective); never 'bad'.
  const p8 = ringPreset({ count: 8, cmFromElbowCrease: 8 });
  for (const seed of [1, 2, 3]) {
    const res = checkPlacement(twinCheck(p8, { seed }), p8);
    assert.ok(res.every((r) => r.state !== 'bad'), res.map((r) => `${r.ch}:${r.code}`).join(' '));
    assert.ok([0, 1, 3, 4, 5, 7].every((c) => res[c].state === 'good'), res.map((r) => `${r.ch}:${r.code}`).join(' '));
  }
});

// Public copy: needs the twin parameters fitted on club logs (withheld from the public copy).
test.skip('check on a twin session: misplace -> wrong movement; loose -> bad with the Doctor fix; near the elbow -> elbow', () => {
  const p = ring6();
  const mis = twinCheck(p, { faults: [{ type: 'misplace', channel: 1 }] });
  assert.deepEqual(mis.truth.faults.map((f) => [f.type, f.channel]), [['misplace', 1]]);
  const rm = checkPlacement(mis, p);
  assert.equal(rm[1].state, 'bad');
  assert.equal(rm[1].code, 'wrong_movement');
  assert.match(rm[1].reason, /reacts to the wrong movement/);
  assert.match(rm[1].fix, /palm side/);
  assert.ok(rm.filter((r, c) => c !== 1).every((r) => r.state === 'good'), 'only the misplaced channel');

  const rl = checkPlacement(twinCheck(p, { faults: [{ type: 'loose', channel: 3 }] }), p);
  assert.equal(rl[3].state, 'bad');
  assert.ok(['dropout', 'spike', 'noisy_rest'].includes(rl[3].code), rl[3].code);
  assert.match(rl[3].fix, /^Sensor 4 /);
  assert.ok(rl.filter((r) => r.state === 'good').length >= 7, 'the others stay good');

  const rd = checkPlacement(twinCheck(p, { faults: [{ type: 'dropout', channel: 3 }] }), p);
  assert.equal(rd[3].code, 'dropout');
  assert.match(rd[3].fix, /^Sensor 4 keeps dropping to 0/);

  // Ring 1.5 cm from the crease: the elbow bend drives it; the EMG pair (5 cm) stays good.
  const near = ring6({ cmFromElbowCrease: 1.5 });
  const rn = checkPlacement(twinCheck(near), near);
  assert.ok(rn.slice(0, 6).filter((r) => r.code === 'elbow').length >= 4, rn.map((r) => `${r.ch}:${r.code}`).join(' '));
  assert.ok(rn.slice(0, 6).every((r) => r.state !== 'good'));
  assert.deepEqual(rn.slice(6).map((r) => r.state), ['good', 'good']);
});

test('check: a channel on the wrong side of the arm, flat, faint, elbow-driven', () => {
  const p = ring();
  const resp = respFor(p);
  resp[0] = BACK;                                            // entered palm, behaves like back
  resp[1] = { fist: 0, wrist_back: 0, elbow_bend: 0 };       // flat
  resp[4] = { fist: 10, wrist_back: 30, elbow_bend: 5 };     // faint but the right movement
  resp[5] = { fist: 10, wrist_back: 120, elbow_bend: 110 };  // the elbow drives it
  const res = checkPlacement(checkRec(resp, { sd: 1 }), p);
  assert.equal(res[0].state, 'bad');
  assert.equal(res[0].code, 'wrong_movement');
  assert.match(res[0].reason, /reacts to the wrong movement/);
  assert.match(res[0].fix, /palm side/);
  assert.equal(res[1].state, 'bad');
  assert.equal(res[4].state, 'weak');
  assert.match(res[4].reason, /faintly/);
  assert.equal(res[5].state, 'bad');
  assert.equal(res[5].code, 'elbow');
  assert.equal(res[2].state, 'good');
});

test('check: steps from explicit indices; missing steps and no place entered', () => {
  const p = ring();
  const rec = checkRec(respFor(p));
  const steps = [{ step: 'relax', start: 0, end: 500 }, { step: 'fist', start: 500, end: 800 }];
  const res = checkPlacement({ ...rec, labels: null }, p, steps);
  assert.deepEqual(res[0].missing, ['wrist_back', 'elbow_bend']);
  assert.equal(res[0].state, 'good');
  assert.equal(res[2].state, 'weak');
  assert.equal(res[2].code, 'not_checked');
  const none = checkPlacement(rec, null);
  assert.ok(none.every((r) => r.state === 'good' && /no place entered/.test(r.reason)));
  assert.deepEqual(checkPlacement({ data: [] }, p), []);
  const empty = checkPlacement({ data: [[]] }, p);
  assert.equal(empty[0].state, 'bad');
});

test('liveCheck: re-judges the step being redone, keeps the rest from the earlier result', () => {
  const p = ring();
  const resp = respFor(p);
  resp[0] = { fist: 30, wrist_back: 5, elbow_bend: 5 };   // faint at first
  const first = checkPlacement(checkRec(resp, { sd: 1 }), p);
  assert.equal(first[0].state, 'weak');
  // The user nudges sensor 1 and holds a fist again: a 2 s window, no labels.
  const R = rng(9);
  const n = 200;
  const win = { rateHz: RATE, data: first.map((r, c) => Array.from({ length: n }, () => Math.round(r.stats.baseline + (c === 0 ? 150 : resp[c].fist) + R.normal(0, 1)))) };
  const now = liveCheck(win, p, { prev: first, step: 'fist' });
  assert.equal(now[0].state, 'good', now[0].reason);
  assert.equal(now[0].stats.resp.wrist_back, first[0].stats.resp.wrist_back, 'wrist response kept from before');
  assert.equal(now[2].state, 'good', 'a back-side band stays good: its wrist response is kept');
  for (let i = 50; i < 90; i++) win.data[2][i] = 0;
  assert.equal(liveCheck(win, p, { prev: first, step: 'fist' })[2].code, 'dropout');
  assert.equal(liveCheck(win, p, { step: 'fist' }).length, 10, 'works without prev');
});

test('diff, review-2 M2: one slider move = one line; exact §12.5 sentences', () => {
  const prev = ringPreset({ count: 6, cmFromElbowCrease: 8, circumferenceCm: 24 });
  const all = ringPreset({ count: 6, cmFromElbowCrease: 9.5, circumferenceCm: 24 });
  const d = diffPlacement(prev, all);
  assert.equal(d.length, 1);
  assert.equal(d[0].text, 'All 6 sensors are 1.5 cm further from the elbow than last time (8.0 → 9.5 cm).');
  assert.deepEqual(d[0].chs, [1, 2, 3, 4, 5, 6]);
  // Three of six, equal: "Sensors 1, 2 and 4"; two equal moves stay two lines.
  const some = structuredClone(prev);
  for (const i of [0, 1, 3]) some.channels[i].cmFromElbowCrease = 6.5;
  assert.deepEqual(diffPlacement(prev, some).map((x) => x.text), ['Sensors 1, 2 and 4 are 1.5 cm closer to the elbow than last time (8.0 → 6.5 cm).']);
  some.channels[3].cmFromElbowCrease = 8;
  assert.equal(diffPlacement(prev, some).length, 2);
  // Single move with the place name; a turn with direction and cm round the arm.
  const one = structuredClone(prev);
  const thumb = one.channels.find((c) => c.ringAngleDeg === 90) || one.channels[0];
  thumb.ringAngleDeg = 90; thumb.cmFromElbowCrease = 9.5;
  const base = structuredClone(prev); base.channels.find((c) => c.ch === thumb.ch).ringAngleDeg = 90;
  assert.equal(diffPlacement(base, one)[0].text, `Sensor ${thumb.ch} (thumb edge) is 1.5 cm further from the elbow than last time (8.0 → 9.5 cm).`);
  const turn = structuredClone(prev); const t0 = structuredClone(prev);
  t0.channels[5].ringAngleDeg = 240; turn.channels[5].ringAngleDeg = 270;
  assert.equal(diffPlacement(t0, turn)[0].text, 'Sensor 6 (little-finger edge) has turned 30° toward the palm (about 2.0 cm round the arm).');
});

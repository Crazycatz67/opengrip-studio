import test from 'node:test';
import assert from 'node:assert/strict';
import { parseText } from '../src/parse.js';
import { analyzeRecording, analyzeChannel, calibrate, bandShift } from '../src/quality.js';
import { fixtureText } from './helpers.js';

const rep = (f) => analyzeRecording(parseText(fixtureText(f)));

test('synth_dropouts: dropouts and spikes detected', () => {
  const r = rep('synth_dropouts.txt');
  assert.equal(r.channels[0].dropouts.length, 4);
  assert.ok(r.channels[0].spikes.length >= 3);
  assert.ok(r.items.some((i) => i.code === 'dropout' && i.level === 'red'));
});

test('synth_grip_startspike: start-up spike detected', () => {
  const r = rep('synth_grip_startspike.txt');
  assert.ok(r.channels[0].spikes.length >= 1);
  assert.ok(r.channels[0].spikes[0].index < 80);
  assert.ok(r.items.some((i) => i.code === 'spike'));
});

test('synth_grip_fade: 4-6 bursts and fade flagged', () => {
  const c = rep('synth_grip_fade.txt').channels[0];
  assert.ok(c.burstCount >= 4 && c.burstCount <= 6, `bursts ${c.burstCount}`);
  assert.equal(c.fade.flagged, true, `ratio ${c.fade.ratio}`);
  assert.equal(c.dropouts.length, 0);
});

test('legacy logs say rate is unknown and unlabelled', () => {
  const codes = rep('synth_squeeze.txt').items.map((i) => i.code);
  assert.ok(codes.includes('no_rate') && codes.includes('no_labels'));
});

test('saturation and empty channels', () => {
  const sat = analyzeChannel(Array.from({ length: 500 }, (_, i) => (i % 50 < 10 ? 1023 : 10)));
  assert.equal(sat.saturation.count, 100);
  assert.equal(analyzeChannel([]).n, 0);
});

// Synthetic labelled recording: arm movement as big as the grip -> red position item;
// later grips at 50% of calibration -> band shift.
function synth({ armAmp, lateGrip }) {
  const labels = [];
  const v = [];
  const seg = (label, n, f) => { for (let i = 0; i < n; i++) { labels.push(label); v.push(f(i, n)); } };
  const hump = (a) => (i, n) => 10 + Math.round(a * Math.sin((Math.PI * i) / n));
  seg('cal_rest', 100, () => 10);
  for (let k = 0; k < 3; k++) { seg('cal_squeeze', 60, hump(300)); seg('cal_rest', 60, () => 10); }
  for (let k = 0; k < 6; k++) { seg('grip@down', 60, hump(k < 3 ? 300 : lateGrip)); seg('rest@down', 60, () => 10); }
  for (let k = 0; k < 3; k++) { seg('elbow_bend', 60, hump(armAmp)); seg('rest', 60, () => 10); }
  return { data: [v], labels, rateHz: 100 };
}

test('position check: arm alone reaching grip level is red; small arm effect green', () => {
  const bad = analyzeRecording(synth({ armAmp: 280, lateGrip: 300 }));
  assert.equal(bad.position[0].crosses, true);
  assert.ok(bad.items.some((i) => i.code === 'position' && i.level === 'red'));
  const ok = analyzeRecording(synth({ armAmp: 20, lateGrip: 300 }));
  assert.ok(ok.items.some((i) => i.code === 'position' && i.level === 'green'));
});

test('calibration levels and band-shift warning', () => {
  const rec = synth({ armAmp: 20, lateGrip: 150 });
  const cal = calibrate(rec);
  assert.equal(cal.rest[0], 10);
  assert.ok(Math.abs(cal.squeeze[0] - 310) <= 2);
  const sh = bandShift(rec, cal)[0];
  assert.equal(sh.flagged, true, JSON.stringify(sh));
  assert.ok(analyzeRecording(rec).items.some((i) => i.code === 'band_shift' && /loosened or moved/.test(i.message)));
  assert.equal(bandShift(synth({ armAmp: 20, lateGrip: 300 }), cal)[0].flagged, false);
});

// Card F1: with labels, fade uses one peak per main-task step (no calibration squeezes or
// distractors) and needs a steady per-rep loss as well as the half ratio. Before F1 every
// calibrated 6-channel squeeze session flagged fade (40/40 seeds); after, 10/40 clean, 30/40 with
// a 0.85-per-rep fade (docs/reference/twin-v2-notes.md, F1).
test('fade (F1): labelled twin squeeze, 5 reps per channel; clean rarely flagged, a real fade mostly', async () => {
  const { generate, toLines, TWIN_MODEL } = await import('../src/sim/twin.js');
  const { parseText } = await import('../src/parse.js');
  const fade = (f) => ({ ...TWIN_MODEL, tasks: { ...TWIN_MODEL.tasks, squeeze: { ...TWIN_MODEL.tasks.squeeze, fade_per_rep: f } } });
  const flagged = (model) => {
    let n = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const r = analyzeRecording(parseText(toLines(generate({ seed, channels: 6, gesture: 'squeeze', model }), 'nxt').join('\n')));
      for (const c of r.channels) assert.equal(c.fade.peaks.length, 5, `seed ${seed}: reps ${c.fade.peaks.length}`);
      if (r.channels.some((c) => c.fade.flagged)) n++;
    }
    return n;
  };
  const clean = flagged(TWIN_MODEL), tired = flagged(fade(0.85));
  assert.ok(clean <= 4, `clean flagged ${clean}/10`);
  assert.ok(tired >= 6, `fade 0.85/rep flagged ${tired}/10`);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseText } from '../src/parse.js';
import { analyzeRecording } from '../src/quality.js';
import { doctorScorecard, timingCheck, humCheck, fixFor, HARDWARE_CODES } from '../src/doctor.js';
import { generate, toLines } from '../src/sim/twin.js';
import { fixtureText } from './helpers.js';

// Regression floor from docs/reference/doctor-scorecard.md (10 seeds, 6 channels, 2026-10-20).
// Raise these when a detector improves; never lower them to make a change pass.
const FLOOR = { dropout: 10, loose: 10, saturation: 10, floating: 9, shift: 10, hum: 10, jitter: 10, missing: 10, boot: 10, slowlink: 10, brownout: 10, crosstalk: 6, creep: 9 }; // crosstalk is a green "possible" item, not an alarm (below 8/10)

// Public copy: needs the twin parameters fitted on club logs (withheld from the public copy).
test.skip('doctor scorecard: hits per fault stay at or above the floor; <= 1 clean session with an alarm', () => {
  const c = doctorScorecard({ generate, toLines, parse: parseText, analyze: analyzeRecording, seeds: 10 });
  for (const [type, min] of Object.entries(FLOOR)) assert.ok(c.types[type].hits >= min, `${type}: ${c.types[type].hits}/10 < ${min}`);
  assert.ok(c.clean.withAlarm <= 1, `clean: ${JSON.stringify(c.clean)}`);
  assert.ok(!c.clean.alarms.band_shift, 'fatigue fade must not raise band_shift');
  assert.ok((c.clean.info.crosstalk ?? 0) <= 1, `clean possible crosstalk ${c.clean.info.crosstalk}`);
  // One root cause per channel: at most 1 follow-on alarm per 10 sessions of any fault.
  for (const [type, row] of Object.entries(c.types)) {
    const same = Object.entries(row.otherAlarms).filter(([k]) => k.endsWith('(same channel)')).reduce((a, [, v]) => a + v, 0);
    assert.ok(same <= 1, `${type}: ${JSON.stringify(row.otherAlarms)}`);
  }
});

test('legacy fixtures: no new warnings, only green information items', () => {
  const before = { 'synth_dropouts.txt': ['dropout', 'spike'], 'synth_grip_startspike.txt': ['dropout', 'spike'], 'synth_grip_fade.txt': ['fade'] };
  for (const f of fs.readdirSync(new URL('./fixtures/', import.meta.url))) {
    const r = analyzeRecording(parseText(fixtureText(f)));
    const warn = r.items.filter((i) => i.level !== 'green' && !['no_rate', 'no_labels'].includes(i.code)).map((i) => i.code);
    assert.deepEqual(warn, before[f] || [], f);
    assert.ok(r.items.some((i) => i.code === 'boot_junk' && i.level === 'green'), `${f}: boot junk`);
    assert.ok(r.items.some((i) => i.code === 'hum_unchecked' && i.level === 'green'), `${f}: hum cannot be checked`);
  }
});

test('every item has a plain fix line; hardware codes all have one', () => {
  const r = analyzeRecording(parseText(fixtureText('synth_dropouts.txt')));
  for (const it of r.items) assert.equal(typeof it.fix, 'string', it.code);
  for (const code of HARDWARE_CODES) assert.ok(fixFor(code, 'A3').length > 10, code);
  assert.match(fixFor('floating', 'A3'), /^A3 looks unconnected/);
});

test('timing: clean clock, gap, reset by clock and by marker, slow link, jitter', () => {
  const t = Array.from({ length: 300 }, (_, i) => i * 10);
  assert.deepEqual(timingCheck({ t }).gaps, []);
  const gap = t.slice(0, 100).concat(t.slice(110));
  assert.equal(timingCheck({ t: gap }).gaps[0].missing, 10);
  const reset = t.slice(0, 150).concat(t.slice(0, 150));
  assert.deepEqual(timingCheck({ t: reset }).resets, [{ at: 150, from: 'clock' }]);
  assert.equal(timingCheck({ t, markers: [{ t: 500, note: 'board reset', index: 50 }] }).resets[0].from, 'marker');
  const slow = Array.from({ length: 300 }, (_, i) => i * 40);
  assert.equal(timingCheck({ t: slow, meta: { rate_hz: '100' } }).slow, true);
  assert.equal(timingCheck({ t: slow }).slow, false, 'no header rate: nothing to compare with');
  let x = 7;
  const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647);
  const jit = t.map((v) => v + Math.round((rnd() - 0.5) * 12));
  assert.equal(timingCheck({ t: jit }).jitter, true);
  assert.equal(timingCheck({ t: [0, null] }), null);
});

test('hum: only checked at >= 500 Hz; 50 Hz tone found', () => {
  assert.equal(humCheck([[1, 2, 3]], 100).checked, false);
  const v = Array.from({ length: 2000 }, (_, i) => 200 + Math.round(20 * Math.sin((2 * Math.PI * 50 * i) / 500)));
  const h = humCheck([v], 500);
  assert.equal(h.channels[0].flagged, true);
  assert.equal(h.channels[0].hz, 50);
});

test('band shift: fatigue on every channel is not a shift; a rest step on one channel is', () => {
  const S = generate({ seed: 1001, channels: 6 });
  const clean = analyzeRecording(parseText(toLines(S, 'nxt').join('\n')));
  assert.ok(clean.bandShift.every((b) => !b.flagged), JSON.stringify(clean.bandShift));
  assert.ok(clean.bandShift.some((b) => b.fatigue));
  const F = generate({ seed: 2, channels: 6, faults: [{ type: 'shift', channel: 3 }] });
  const sh = analyzeRecording(parseText(toLines(F, 'nxt').join('\n'))).bandShift;
  assert.equal(sh[3].flagged, true);
  assert.equal(sh[3].reason, 'rest');
});

test('one root cause: saturation turns the same channel spike/floating/band-shift green and says so', () => {
  const S = generate({ seed: 3, channels: 6, faults: [{ type: 'saturation', channel: 2 }] });
  const r = analyzeRecording(parseText(toLines(S, 'nxt').join('\n')));
  const sat = r.items.find((i) => i.code === 'saturation' && i.channel === 2);
  assert.ok(sat && sat.level !== 'green');
  const follow = r.items.filter((i) => i.channel === 2 && i.causedBy);
  for (const it of follow) assert.equal(it.level, 'green');
  if (follow.length) assert.match(sat.message, /probably caused by this/);
  assert.ok(!r.items.some((i) => i.channel === 2 && ['floating', 'band_shift', 'spike'].includes(i.code) && i.level !== 'green'));
});

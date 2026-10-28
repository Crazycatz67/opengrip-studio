// Writes test/fixtures/*.txt: six SYNTHETIC stand-ins for the club's legacy logs, made with the
// digital twin (src/sim/twin.js) so the repo can be public without the volunteers' recordings.
// The real logs live only in the git-ignored test/fixtures-club/ (see test/fixtures-club.test.js).
//
// Contract
//   SYNTHETIC_FIXTURES: [{ name, gesture, seed, ... }] the recipe per file (seeded, so the bytes
//     are the same on every machine and every run).
//   buildSyntheticFixtures() -> { [name]: Uint8Array } legacy club format: one integer per line
//     (0..1023), CRLF, 3-10 boot-junk bytes glued to the first line, no header, no time, no labels.
//   Phenomena each file must keep (the tests assert them; the generator does not "aim" for them,
//   the seeds were picked once so that the Doctor finds exactly these):
//     synth_dropouts.txt        4 dropouts, each followed by a spike (red dropout)
//     synth_grip_startspike.txt a dropout right after the start, then its spike (index < 80)
//     synth_grip_fade.txt       5 grip bursts that fade (fade flagged), no dropouts
//     synth_squeeze.txt, synth_finger_flex.txt, synth_typing.txt: clean (only info items)
// Run: node tools/make-synthetic-fixtures.mjs   (then node tools/make-browser-fixtures.mjs)
// test/synthetic-fixtures.test.js fails if test/fixtures/ drifts from this script.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate, TWIN_MODEL } from '../src/sim/twin.js';
import { mulberry32, bootJunk } from '../src/sim/uart.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A stronger per-rep fade than the club average (0.86) so "fade" is unmistakable in one file.
const FADING = { ...TWIN_MODEL, tasks: { ...TWIN_MODEL.tasks, grip: { ...TWIN_MODEL.tasks.grip, fade_per_rep: 0.7 } } };
// The elbow log is a grip-shaped burst train: on one channel the twin's 'elbow' gesture (and the
// elbow stats, gap 100 < width + decay) never settles back to rest, so the Doctor reads it as a
// floating input instead of seeing the dropouts this file exists for.

export const SYNTHETIC_FIXTURES = [
  { name: 'synth_dropouts.txt', gesture: 'grip', seed: 21, reps: 8, faults: ['dropout:4'] },
  { name: 'synth_grip_startspike.txt', gesture: 'grip', seed: 22, reps: 5, faults: [{ type: 'dropout', start: 12 }] },
  { name: 'synth_grip_fade.txt', gesture: 'grip', seed: 23, reps: 5, model: FADING },
  { name: 'synth_squeeze.txt', gesture: 'squeeze', seed: 27, reps: 5 }, // 5 holds like the real protocol; seed whose fade ratio (0.78) is closest to the real log (0.80)
  { name: 'synth_finger_flex.txt', gesture: 'finger', seed: 25, reps: 4 },
  // The club's typing log is short and low; a few light finger taps stand in for it.
  { name: 'synth_typing.txt', gesture: 'finger', seed: 26, reps: 3, holdS: 0.4 },
];

export function buildSyntheticFixtures() {
  const out = {};
  for (const f of SYNTHETIC_FIXTURES) {
    const S = generate({ seed: f.seed, channels: 1, gesture: f.gesture, reps: f.reps, calibration: false, distractors: 0, faults: f.faults || [], holdS: f.holdS ?? null, model: f.model || TWIN_MODEL });
    const junk = bootJunk(mulberry32(1000 + f.seed));
    const text = S.data[0].map((v) => String(Math.max(0, Math.min(1023, Math.round(v))))).join('\r\n') + '\r\n';
    const body = new TextEncoder().encode(text);
    const b = new Uint8Array(junk.length + body.length);
    b.set(junk, 0);
    b.set(body, junk.length);
    out[f.name] = b;
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dir = path.join(ROOT, 'test/fixtures');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(buildSyntheticFixtures())) fs.writeFileSync(path.join(dir, name), bytes);
  console.log(`wrote ${SYNTHETIC_FIXTURES.length} synthetic fixtures to test/fixtures/`);
}

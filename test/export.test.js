import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate } from '../src/sim/twin.js';
import { toCSV, fromCSV } from '../src/csv.js';
import { crc32, zipStore, readZip } from '../src/export/zip.js';
import { exportFiles, exportZip, FORMATS, ExportError } from '../src/export/index.js';
import { prepare } from '../src/export/common.js';
import { relabel } from '../src/relabel.js';

const META = { person_id: 'P03', sensors: 'FMG,FMG,EMG', placement: 'forearm band' };
// Known protocol: calibration, then 4 grip reps over two arm positions, plus elbow_bend distractors.
const twin = () => generate({ seed: 3, channels: 3, positions: ['down', 'elbow90'], reps: 4 });
const runs = (labels) => { const r = []; labels.forEach((l, i) => { if (i === 0 || l !== labels[i - 1]) r.push(l); }); return r; };
const byPath = (files) => Object.fromEntries(files.map((f) => [f.path, f.text]));
const csvRows = (text) => text.trim().split('\n').map((l) => l.split(','));

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array()), 0);
});

test('zipStore round-trips through readZip and rejects bad paths', () => {
  const files = [{ path: 'a.txt', text: 'hello\n' }, { path: 'd/ü.csv', text: '1,2\n' }, { path: 'b.bin', bytes: new Uint8Array([0, 255, 7]) }];
  const z = readZip(zipStore(files));
  assert.deepEqual(z.map((e) => e.path), ['a.txt', 'd/ü.csv', 'b.bin']);
  assert.ok(z.every((e) => e.crcOk));
  assert.equal(new TextDecoder().decode(z[1].bytes), '1,2\n');
  assert.deepEqual([...z[2].bytes], [0, 255, 7]);
  for (const bad of ['/abs', '../x', 'a\\b', 'a//b', '']) assert.throws(() => zipStore([{ path: bad, text: '' }]), /zip: bad path/);
  assert.throws(() => zipStore([{ path: 'x', text: '' }, { path: 'x', text: '' }]), /duplicate/);
});

test('the full export ZIP passes unzip -t (when unzip is installed)', (t) => {
  try { execFileSync('unzip', ['-v'], { stdio: 'ignore' }); } catch { t.skip('unzip not installed'); return; }
  const { bytes, files } = exportZip({ recording: twin(), meta: META });
  const dir = mkdtempSync(join(tmpdir(), 'og-zip-'));
  try {
    writeFileSync(join(dir, 'x.zip'), bytes);
    const out = execFileSync('unzip', ['-t', join(dir, 'x.zip')]).toString();
    assert.match(out, /No errors detected/);
    assert.equal((out.match(/ OK/g) || []).length, files.length);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('LibEMG: one file per repetition, class and rep in the name, rows = samples', () => {
  const S = twin();
  const files = exportFiles({ recording: S, meta: META }, { formats: ['libemg'] });
  const F = byPath(files);
  const classes = JSON.parse(F['libemg/classes.json']).classes;
  const segs = runs(S.labels).filter((l) => !/^cal_/.test(l));
  const csvs = files.filter((f) => /_EMG\.csv$/.test(f.path));
  assert.equal(csvs.length, segs.length);
  assert.ok(!Object.values(classes).some((l) => /^cal_/.test(l)), 'calibration is not a class');
  const grip = Object.keys(classes).find((k) => classes[k] === 'grip');
  const gripReps = segs.filter((l) => l === 'grip').length;
  for (let r = 1; r <= gripReps; r++) assert.ok(F[`libemg/P03/R_${r}_C_${grip}_EMG.csv`], `grip rep ${r}`);
  // The first grip file holds exactly the first grip segment's samples, channel order kept.
  const first = S.labels.indexOf('grip');
  let end = first; while (S.labels[end] === 'grip') end++;
  const rows = csvRows(F[`libemg/P03/R_1_C_${grip}_EMG.csv`]);
  assert.equal(rows.length, end - first);
  assert.deepEqual(rows[0].map(Number), S.data.map((ch) => ch[first]));
  // The README regex must match every data file name (as LibEMG's RegexFilter would).
  for (const f of csvs) assert.match(f.path, /libemg\/[^/]+\/R_\d+_C_\d+_EMG\.csv$/);
  assert.match(F['libemg/README.md'], /RegexFilter\(left_bound="_C_", right_bound="_EMG.csv"/);
  assert.match(F['libemg/README.md'], /synthetic=true/);
});

test('Edge Impulse: label.N.csv, timestamp ms from 0, sensor columns', () => {
  const S = twin();
  const files = exportFiles({ recording: S, meta: META }, { formats: ['edge-impulse'] });
  const F = byPath(files);
  const gripN = runs(S.labels).filter((l) => l === 'grip@elbow90').length;
  assert.ok(gripN > 0);
  for (let n = 1; n <= gripN; n++) assert.ok(F[`edge-impulse/grip_elbow90.${n}.csv`], `grip_elbow90.${n}`);
  assert.ok(!files.some((f) => /^edge-impulse\/[^/]*\..*\..*\.csv$/.test(f.path.replace(/\.\d+\.csv$/, ''))), 'no extra dots in labels');
  const rows = csvRows(F['edge-impulse/grip.1.csv']);
  assert.deepEqual(rows[0], ['timestamp', 'ch1', 'ch2', 'ch3']);
  assert.equal(Number(rows[1][0]), 0);
  const ts = rows.slice(1).map((r) => Number(r[0]));
  assert.ok(ts.every((x, i) => i === 0 || x > ts[i - 1]), 'timestamps rise');
  assert.equal(JSON.parse(F['edge-impulse/labels.json']).labels.grip_elbow90, 'grip@elbow90');
});

test('Ninapro-style: rest = 0, movements 1..K, repetitions counted per movement', () => {
  const S = twin();
  const F = byPath(exportFiles({ recording: S, meta: META }, { formats: ['ninapro'] }));
  const j = JSON.parse(F['ninapro/P03_run-1.json']);
  assert.equal(j.label_map.rest, 0);
  assert.equal(j.label_map['rest@elbow90'], 0);
  assert.ok(j.label_map.grip >= 1 && j.label_map['grip@elbow90'] >= 1 && j.label_map.grip !== j.label_map['grip@elbow90']);
  const n = S.labels.filter((l) => !/^cal_/.test(l)).length;
  for (const k of ['emg', 'stimulus', 'restimulus', 'repetition', 't_ms']) assert.equal(j[k].length, n, k);
  assert.equal(j.emg[0].length, 3);
  const gripReps = new Set(j.repetition.filter((_, i) => j.stimulus[i] === j.label_map.grip));
  assert.deepEqual([...gripReps].sort(), Array.from({ length: runs(S.labels).filter((l) => l === 'grip').length }, (_, i) => i + 1));
  assert.ok(j.repetition.every((r, i) => (j.stimulus[i] === 0) === (r === 0)));
  assert.equal(j.synthetic, true);
  assert.equal(csvRows(F['ninapro/P03_run-1.csv']).length, n + 1);
});

test('BIDS-EMG-like: layout, channel types, events and sampling rate', () => {
  const S = twin();
  const F = byPath(exportFiles({ recording: S, meta: META }, { formats: ['bids'] }));
  const b = 'bids/sub-P03/emg/sub-P03_task-guided_run-1';
  for (const s of ['_emg.tsv', '_channels.tsv', '_events.tsv', '_emg.json']) assert.ok(F[b + s], s);
  const side = JSON.parse(F[`${b}_emg.json`]);
  assert.equal(side.SamplingFrequency, S.rateHz);
  assert.equal(side.EMGChannelCount, 1);
  assert.equal(side.SpecStatus, 'BIDS-EMG-like (draft spec)');
  assert.equal(side.Synthetic, true);
  const ch = F[`${b}_channels.tsv`].trim().split('\n').map((l) => l.split('\t'));
  assert.deepEqual(ch.map((r) => r[1]), ['type', 'MISC', 'MISC', 'EMG']);
  assert.equal(F[`${b}_emg.tsv`].trim().split('\n').length, S.t.length);
  const ev = F[`${b}_events.tsv`].trim().split('\n').slice(1).map((l) => l.split('\t'));
  assert.equal(ev.length, runs(S.labels).filter((l) => !/^cal_/.test(l)).length);
  assert.ok(JSON.parse(F['bids/dataset_description.json']).Name.includes('BIDS-EMG-like (draft spec)'));
});

test('every format carries the metadata and synthetic=true; real data does not get the flag', () => {
  const files = exportFiles({ recording: twin(), meta: META });
  for (const f of FORMATS) assert.ok(files.some((x) => x.path.startsWith(`${f.id === 'bids' ? 'bids' : f.id}/`)), f.id);
  for (const p of ['libemg/metadata.json', 'edge-impulse/metadata.json', 'ninapro/metadata.json']) {
    const m = JSON.parse(files.find((x) => x.path === p).text);
    assert.equal(m.synthetic, true, p);
    assert.equal(m.recordings[0].meta.placement, 'forearm band');
  }
  assert.equal(JSON.parse(files.find((x) => x.path === 'manifest.json').text).synthetic, true);
  // A real-looking recording (from a CSV with no twin marks) is not flagged synthetic.
  const S = twin();
  const real = { t: S.t, data: S.data, labels: S.labels, rateHz: S.rateHz, meta: META };
  assert.equal(JSON.parse(exportFiles(real).find((x) => x.path === 'manifest.json').text).synthetic, false);
});

test('names are refused: person ID must be a code, and name-like meta keys are dropped', () => {
  const S = twin();
  assert.throws(() => exportFiles({ recording: S, meta: { person_id: 'Alice Smith' } }), ExportError);
  assert.throws(() => exportFiles({ recording: S, meta: {} }), /person ID/);
  const files = exportFiles({ recording: S, meta: { ...META, name: 'Alice Smith', volunteer: 'Bob', person_name: 'Carol' } });
  assert.ok(!files.some((f) => /Alice|Bob|Carol/.test(f.text)), 'no names in any file');
  assert.throws(() => exportFiles([]), /Nothing to export/);
});

test('two runs of one person: reps continue, files never clash, run numbers set', () => {
  const recs = [{ recording: twin(), meta: META }, { recording: generate({ seed: 4, channels: 3, positions: ['down', 'elbow90'], reps: 4 }), meta: META }];
  const P = prepare(recs);
  assert.deepEqual(P.items.map((it) => it.run), [1, 2]);
  const files = exportFiles(recs);
  assert.equal(new Set(files.map((f) => f.path)).size, files.length);
  assert.ok(files.some((f) => f.path === 'ninapro/P03_run-2.json'));
  assert.ok(files.some((f) => f.path === 'bids/sub-P03/emg/sub-P03_task-guided_run-2_emg.tsv'));
});

test('a saved CSV (toCSV -> fromCSV) exports the same LibEMG files as the live session', () => {
  const S = twin();
  const live = exportFiles({ recording: S, meta: META }, { formats: ['libemg'] }).filter((f) => /_EMG\.csv$/.test(f.path));
  const back = fromCSV(toCSV({ ...S, meta: { synthetic: 'true', source: 'twin' } }, META));
  const saved = exportFiles(back, { formats: ['libemg'] }).filter((f) => /_EMG\.csv$/.test(f.path));
  assert.deepEqual(saved, live);
  assert.match(exportZip(back).name, /^opengrip-P03-dataset-synthetic\.zip$/);
});

test('exports use movement-aligned labels when asked or carried, and say so', () => {
  const S = generate({ seed: 2, channels: 4, positions: ['down'], reactionMs: [200, 400], holdS: 3, gapS: 7 });
  const rec = { ...S, meta: { person_id: 'P07', sensors: 'FMG,FMG,FMG,FMG' } };
  const F = Object.fromEntries(exportFiles(rec, { align: true }).map((f) => [f.path, f.text]));
  const nj = JSON.parse(F['ninapro/P07_run-1.json']);
  assert.equal(nj.restimulus_source, 'movement-aligned (relabel)');
  const diff = nj.restimulus.filter((v, i) => v !== nj.stimulus[i]).length;
  assert.ok(diff > 50, `restimulus differs on ${diff} samples`);
  assert.deepEqual(JSON.parse(F['manifest.json']).label_timing, ['movement-aligned (relabel)']);
  assert.equal(JSON.parse(F['libemg/metadata.json']).recordings[0].label_timing, 'movement-aligned (relabel)');
  const ev = F[Object.keys(F).find((p) => p.endsWith('_events.tsv'))].trim().split('\n').map((l) => l.split('\t'));
  assert.deepEqual(ev[0].slice(5), ['movement_onset', 'movement_duration', 'lag_ms', 'alignment_confidence']);
  const lags = ev.slice(2).map((r) => Number(r[7])).filter(Number.isFinite);
  assert.ok(lags.some((l) => l >= 150 && l <= 450), lags.join(','));
  // Off by default: prompt timing, restimulus a labelled copy, no extra BIDS columns.
  const G = Object.fromEntries(exportFiles(rec).map((f) => [f.path, f.text]));
  const gj = JSON.parse(G['ninapro/P07_run-1.json']);
  assert.deepEqual(gj.restimulus, gj.stimulus);
  assert.match(gj.restimulus_source, /copy of stimulus/);
  assert.equal(G[Object.keys(G).find((p) => p.endsWith('_events.tsv'))].split('\n')[0].split('\t').length, 5);
  // A recording's own alignedLabels win, and LibEMG files are cut on them.
  const own = Object.fromEntries(exportFiles({ ...rec, alignedLabels: relabel(S).labels }).map((f) => [f.path, f.text]));
  assert.equal(JSON.parse(own['manifest.json']).label_timing[0], 'movement-aligned (recording)');
});

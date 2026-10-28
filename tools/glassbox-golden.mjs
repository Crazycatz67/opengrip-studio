#!/usr/bin/env node
// tools/glassbox-golden.mjs: golden check of the Glass Box pipeline (src/glassbox) against the
// Python reference nxt/experiments/feasibility.py on Ninapro DB5, exercise E2, people s1..s10.
//
//   node tools/glassbox-golden.mjs [<folder with s1..s10>]     (default: GLASSBOX_DB5 or the
//   scratch folder below). Exit 0 = every row within 1 point (mean, worst, best), 1 = mismatch,
//   2 = data not found.
//
// Ninapro DB5 is CC-BY-ND: it stays local and is never copied into this repo. Only the Python
// per-person accuracies (derived numbers, from the 2026-10-20 run) are written down here.
// The same split as Python: gestures by repetition (train 1,3,4,6 / test 2,5); rest by time
// (first 66% train, from 70% test, every 4th window). Python scores plain accuracy, so this does.
//
// Contract (for test/glassbox-golden.test.js)
//   DEFAULT_DB5, PY_ROWS, findData(dir) -> dir | null, readMat(buffer) -> { name: { dims, data } }
//   runGolden(dir, { log }) -> { rows: [{ name, py: number[], js: number[] }], best, typical, ok }

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { prepare, evaluate } from '../src/glassbox/evaluate.js';

export const DEFAULT_DB5 = process.env.GLASSBOX_DB5 || 'data/ninapro-db5';

// feasibility.py's output per person s1..s10 (sklearn 1.9.1, numpy 2.5.4). Best pair (4,6),
// typical pair (3,5): chosen by Python from the 28 pair means.
export const PY_ROWS = [
  { name: '16 sensors (2 armbands)', key: 'all16', py: [0.9559, 0.9336, 0.9475, 0.9431, 0.9393, 0.8924, 0.9284, 0.9098, 0.9354, 0.9444] },
  { name: '8 sensors (1 armband)', key: 'all8', py: [0.9283, 0.9192, 0.924, 0.9013, 0.9248, 0.8517, 0.8985, 0.8772, 0.8873, 0.9287] },
  { name: '2 sensors, best pair', key: 'best', py: [0.8566, 0.8357, 0.8166, 0.7807, 0.8524, 0.7897, 0.8468, 0.8254, 0.8265, 0.8777] },
  { name: '2 sensors, typical pair', key: 'typical', py: [0.7999, 0.7529, 0.7884, 0.7745, 0.8503, 0.7416, 0.7672, 0.798, 0.8138, 0.8267] },
  { name: '2 sensors best pair + 3-vote', key: 'best_v3', py: [0.8708, 0.8392, 0.819, 0.782, 0.8655, 0.8079, 0.8541, 0.8427, 0.8366, 0.8882] },
  { name: '3 gestures, 2 sensors best pair', key: 'g3', py: [0.9554, 0.9418, 0.9162, 0.9123, 0.9728, 0.947, 0.9777, 0.9358, 0.9483, 0.9458] },
  { name: '3 gestures, best pair + 3-vote', key: 'g3_v3', py: [0.9554, 0.9469, 0.9181, 0.914, 0.9728, 0.952, 0.9802, 0.9439, 0.9539, 0.9483] },
];
const PY_BEST = [4, 6], PY_TYPICAL = [3, 5];

const matFile = (dir, i) => path.join(dir, `s${i}`, `s${i}`, `S${i}_E2_A1.mat`);
export function findData(dir = DEFAULT_DB5) {
  for (let i = 1; i <= 10; i++) if (!fs.existsSync(matFile(dir, i))) return null;
  return dir;
}

// Minimal MATLAB v5 reader: numeric matrices only (what Ninapro uses), zlib-compressed or not.
const MI = { 1: Int8Array, 2: Uint8Array, 3: Int16Array, 4: Uint16Array, 5: Int32Array, 6: Uint32Array, 7: Float32Array, 9: Float64Array, 12: BigInt64Array, 13: BigUint64Array };
function tagAt(buf, o) {
  const t = buf.readUInt32LE(o);
  if (t >>> 16) return { type: t & 0xffff, n: t >>> 16, data: o + 4, next: o + 8 };
  const n = buf.readUInt32LE(o + 4);
  return { type: t, n, data: o + 8, next: o + 8 + Math.ceil(n / 8) * 8 };
}
function readMatrix(buf, o, end, out) {
  const flags = tagAt(buf, o); const dims = tagAt(buf, flags.next); const nm = tagAt(buf, dims.next);
  const cls = buf.readUInt32LE(flags.data) & 0xff;
  if (cls < 6 || cls > 15) return; // not a numeric array (cell, struct, char...)
  const d = []; for (let k = 0; k < dims.n / 4; k++) d.push(buf.readInt32LE(dims.data + 4 * k));
  const name = buf.toString('latin1', nm.data, nm.data + nm.n);
  const re = tagAt(buf, nm.next);
  const T = MI[re.type];
  if (!T) throw new Error(`MAT: unsupported storage type ${re.type} for ${name}`);
  const raw = buf.subarray(re.data, re.data + re.n);
  const arr = new T(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  out[name] = { dims: d, data: Float64Array.from(arr, Number) };
}
export function readMat(buffer) {
  const out = {};
  let o = 128;
  while (o + 8 <= buffer.length) {
    const tg = tagAt(buffer, o);
    if (tg.type === 15) {
      const inner = zlib.inflateSync(buffer.subarray(tg.data, tg.data + tg.n));
      const it = tagAt(inner, 0);
      if (it.type === 14) readMatrix(inner, it.data, it.data + it.n, out);
      o = tg.data + tg.n; // compressed elements are not padded to 8 bytes
      continue;
    } else if (tg.type === 14) readMatrix(buffer, tg.data, tg.data + tg.n, out);
    o = tg.next;
  }
  return out;
}

function loadSubject(dir, i) {
  const m = readMat(fs.readFileSync(matFile(dir, i)));
  const [n, ch] = m.emg.dims;
  const data = Array.from({ length: ch }, (_, c) => m.emg.data.subarray(c * n, (c + 1) * n)); // column-major
  return { data, labels: Array.from(m.restimulus.data), reps: m.rerepetition.data, rateHz: 200, session: `s${i}` };
}

const PY_SPLIT = { by: 'repetition', testReps: [2, 5], rest: 'time', restTrainBefore: 0.66, restTestFrom: 0.70, restThin: 4 };
const ds = (rec, gest) => prepare([rec], { classOf: (l) => (gest.has(l) ? l : null), isDistractor: () => false, rest: 0, win: 40, step: 10 });
const acc = (d, channels, vote = 1) => evaluate(d, { split: PY_SPLIT, channels, vote }).accuracy;

export function runGolden(dir, { log = () => {} } = {}) {
  const pairs = [];
  for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) pairs.push([a, b]);
  const js = { all16: [], all8: [], pair: pairs.map(() => []), pairV3: pairs.map(() => []), g3: pairs.map(() => []), g3v3: pairs.map(() => []) };
  for (let i = 1; i <= 10; i++) {
    const t0 = Date.now();
    const rec = loadSubject(dir, i);
    const d5 = ds(rec, new Set([0, 5, 6, 7, 1]));
    js.all16.push(acc(d5, null));
    js.all8.push(acc(d5, [0, 1, 2, 3, 4, 5, 6, 7]));
    pairs.forEach((p, k) => { js.pair[k].push(acc(d5, p)); js.pairV3[k].push(acc(d5, p, 3)); });
    const d3 = ds(rec, new Set([0, 5, 6]));
    pairs.forEach((p, k) => { js.g3[k].push(acc(d3, p)); js.g3v3[k].push(acc(d3, p, 3)); });
    log(`s${i}: ${d5.windows.length} windows, ${Date.now() - t0} ms`);
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const pm = pairs.map((_, k) => mean(js.pair[k]));
  const order = pairs.map((_, k) => k).sort((a, b) => pm[a] - pm[b]); // stable, like Python's sorted
  const bestK = pm.indexOf(Math.max(...pm)), medK = order[pairs.length >> 1];
  // Compare on Python's pairs, so a near-tie in the pair choice cannot hide a pipeline difference.
  const kOf = (p) => pairs.findIndex((q) => q[0] === p[0] && q[1] === p[1]);
  const bK = kOf(PY_BEST), tK = kOf(PY_TYPICAL);
  const jsRows = { all16: js.all16, all8: js.all8, best: js.pair[bK], typical: js.pair[tK], best_v3: js.pairV3[bK], g3: js.g3[bK], g3_v3: js.g3v3[bK] };
  const rows = PY_ROWS.map((r) => ({ name: r.name, py: r.py, js: jsRows[r.key] }));
  const pts = (a, b) => Math.abs(a - b) * 100;
  const st = (a) => [mean(a), Math.min(...a), Math.max(...a)];
  for (const r of rows) {
    const [pm_, pn, px] = st(r.py), [jm, jn, jx] = st(r.js);
    r.diff = Math.max(pts(pm_, jm), pts(pn, jn), pts(px, jx));
    r.maxPerson = Math.max(...r.py.map((v, k) => pts(v, r.js[k])));
    r.ok = r.diff <= 1;
  }
  return { rows, best: pairs[bestK], typical: pairs[medK], pyBest: PY_BEST, pyTypical: PY_TYPICAL, ok: rows.every((r) => r.ok) };
}

export function formatTable(res) {
  const f = (v) => `${(v * 100).toFixed(1)}%`;
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const out = ['| Setup | Python mean / worst / best | JS mean / worst / best | Row diff (pts) | Max per-person diff (pts) |', '|---|---|---|---|---|'];
  for (const r of res.rows) {
    out.push(`| ${r.name} | ${f(mean(r.py))} / ${f(Math.min(...r.py))} / ${f(Math.max(...r.py))} | ${f(mean(r.js))} / ${f(Math.min(...r.js))} / ${f(Math.max(...r.js))} | ${r.diff.toFixed(2)} | ${r.maxPerson.toFixed(2)} |`);
  }
  out.push(`JS picks best pair (${res.best}) and typical pair (${res.typical}); Python picked (${res.pyBest}) and (${res.pyTypical}).`);
  return out.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = findData(process.argv[2] || DEFAULT_DB5);
  if (!dir) {
    console.log(`Ninapro DB5 not found at ${process.argv[2] || DEFAULT_DB5} (need s1..s10/sN/SN_E2_A1.mat). Skipped.`);
    process.exit(2);
  }
  const res = runGolden(dir, { log: (s) => console.error(s) });
  console.log(formatTable(res));
  console.log(res.ok ? 'GOLDEN MATCH: every row within 1 point.' : 'GOLDEN MISMATCH: a row differs by more than 1 point.');
  process.exit(res.ok ? 0 : 1);
}

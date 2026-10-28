import test from 'node:test';
import assert from 'node:assert/strict';
import { detectFormat, chooseBaud, scoreLines, BAUD_ORDER, estimateRateFromArrivals, rateLabel } from '../src/detect.js';
import { ingestText, Ingest } from '../src/pipeline.js';
import { analyzeRecording } from '../src/quality.js';
import { parseText, LineBuffer } from '../src/parse.js';
import { uartResample, textToBytes, bootJunk, mulberry32 } from '../src/sim/uart.js';
import { fixtureNames, fixtureBytes, fixtureText, chunkedLines } from './helpers.js';

test('every fixture as raw bytes in random chunks -> same samples and same quality as a clean parse', () => {
  for (const f of fixtureNames()) {
    const ref = parseText(fixtureText(f));
    for (const seed of [1, 2, 3]) {
      const lines = chunkedLines(fixtureBytes(f), seed);
      const vals = [];
      let fmt = null;
      const ing = new Ingest({ onSample: (s) => vals.push(s.values[0]), onFormat: (x) => { fmt = x; } });
      lines.forEach((l, i) => ing.push(l, i * 10));
      assert.equal(fmt.kind, 'single', f);
      assert.equal(fmt.channels, 1, f);
      assert.deepEqual(vals, ref.data[0], `${f} seed ${seed}`);
      const q = analyzeRecording({ data: [vals] });
      assert.equal(q.channels[0].burstCount, analyzeRecording(ref).channels[0].burstCount, f);
    }
  }
});

// Synthetic streams of every supported format, with a cut-off first line and junk.
const N = 120;
const v = (i, c) => 100 + ((i * 7919 + c * 31) % 200); // jumps around like an ADC, never a ramp
const FORMATS = {
  single: { line: (i) => `${v(i, 0)}`, kind: 'single', ch: 1, time: false },
  comma: { line: (i) => `${v(i, 0)},${v(i, 1)},${v(i, 2)}`, kind: 'delimited', ch: 3, time: false },
  tab: { line: (i) => `${v(i, 0)}\t${v(i, 1)}`, kind: 'delimited', ch: 2, time: false },
  space: { line: (i) => `${v(i, 0)} ${v(i, 1)} ${v(i, 2)} ${v(i, 3)}`, kind: 'delimited', ch: 4, time: false },
  plotterSpace: { line: (i) => `a:${v(i, 0)} b:${v(i, 1)}`, kind: 'plotter', ch: 2, time: false, names: ['a', 'b'] },
  plotterComma: { line: (i) => `thumb:${v(i, 0)},index:${v(i, 1)},ring:${v(i, 2)}`, kind: 'plotter', ch: 3, time: false },
  a0text: { line: (i) => `A0: ${v(i, 0)}`, kind: 'plotter', ch: 1, time: false, names: ['A0'] },
  a0multi: { line: (i) => `A0: ${v(i, 0)}  A1: ${v(i, 1)}`, kind: 'plotter', ch: 2, time: false },
  timedBare: { line: (i) => `${1000 + i * 5},${v(i, 0)},${v(i, 1)}`, kind: 'timed', ch: 2, time: true },
  timedHeader: { header: ['# nxt_logger v1 channels=6 rate_hz=100', 't_ms,a0,a1,a2,a3,a4,a5'], line: (i) => `${i * 10},${[0, 1, 2, 3, 4, 5].map((c) => v(i, c)).join(',')}`, kind: 'timed', ch: 6, time: true },
  timedLabel: { line: (i) => `${i * 10},${v(i, 0)},${i % 40 < 20 ? 'rest' : 'grip@down'}`, kind: 'timed', ch: 1, time: true },
  plotterTime: { line: (i) => `t:${i * 10} f1:${v(i, 0)}`, kind: 'plotter', ch: 1, time: true },
};

function streamText(spec, seed) {
  const rand = mulberry32(seed);
  const junk = String.fromCharCode(...bootJunk(rand));
  const first = spec.line(0);
  const body = Array.from({ length: N }, (_, i) => spec.line(i + 1));
  // Port opened mid-line: the first data line is a tail fragment glued to junk.
  return [...(spec.header || []).map((h, k) => (k === 0 ? junk + h : h)), (spec.header ? '' : junk) + first.slice(Math.floor(first.length / 2)), ...body].join('\r\n') + '\r\n';
}

for (const [name, spec] of Object.entries(FORMATS)) {
  test(`format auto-detect: ${name}`, () => {
    for (const seed of [1, 7]) {
      const lines = chunkedLines(textToBytes(streamText(spec, seed)), seed);
      const r = ingestText(lines.join('\n'));
      assert.equal(r.format.ok, true, `${name}: ${r.format.reason}`);
      assert.equal(r.format.kind, spec.kind, name);
      assert.equal(r.format.channels, spec.ch, name);
      assert.equal(r.format.hasTime, spec.time, name);
      if (spec.names) assert.deepEqual(r.format.names, spec.names);
      // All N body lines come through (the cut first line may or may not, it's ambiguous).
      assert.ok(r.samples.length >= N && r.samples.length <= N + 1, `${name}: ${r.samples.length}`);
      const last = r.samples[r.samples.length - 1];
      assert.equal(last.values[0], v(N, 0), name);
      if (spec.time) assert.ok(last.t > 0);
    }
  });
}

test('baud detection: each club baud is found from what the UART would really receive', () => {
  const text = Array.from({ length: 300 }, (_, i) => `${i * 5},${v(i, 0)},${v(i, 1)}`).join('\r\n') + '\r\n';
  for (const dev of BAUD_ORDER) {
    const attempts = BAUD_ORDER.map((baud) => {
      const bytes = uartResample(textToBytes(text), dev, baud);
      const lines = new LineBuffer().feed(new TextDecoder('latin1').decode(bytes)).slice(1);
      return { baud, lines };
    });
    for (const a of attempts) {
      const s = scoreLines(a.lines);
      if (a.baud === dev) assert.ok(s.fraction >= 0.99, `${dev} right baud ${s.fraction}`);
      else assert.ok(s.fraction < 0.8, `device ${dev} read at ${a.baud}: ${s.fraction}`);
    }
    // Probe order as the app does it: first baud reaching 80% wins.
    const firstGood = attempts.find((a) => chooseBaud([a]).baud);
    assert.equal(firstGood.baud, dev);
    assert.equal(chooseBaud(attempts).baud, dev);
  }
});

test('baud detection failure says so in plain words', () => {
  const junk = chooseBaud([{ baud: 115200, lines: ['\xf0\x80\x18', '\xfe\xe6x', '\x80\x00\x80'] }]);
  assert.equal(junk.baud, null);
  assert.match(junk.message, /none of the speeds/);
  const silent = chooseBaud([{ baud: 9600, lines: [] }]);
  assert.match(silent.message, /sends nothing/);
});

test('rate from host arrival times is approximate and robust to USB clumping', () => {
  // 200 lines/s arriving in packets of 16 every 80 ms.
  const t = Array.from({ length: 800 }, (_, i) => Math.floor(i / 16) * 80);
  const r = estimateRateFromArrivals(t);
  assert.ok(Math.abs(r.hz - 200) <= 5, String(r.hz));
  assert.equal(rateLabel(r).startsWith('≈'), true);
  assert.equal(estimateRateFromArrivals([1, 2, 3]).hz, null);
});

test('detectFormat on pure noise says it cannot read the stream', () => {
  const f = detectFormat(['hello', 'world', 'Error: x']);
  assert.equal(f.ok, false);
  assert.ok(f.reason.length > 10);
});

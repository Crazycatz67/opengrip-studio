// The two club sketches (arduino/nxt_logger, arduino/opengrip_selftest) against the app's
// parser and detector. No arduino-cli here, so the sketches' print calls are copied into
// JS generators below; the first test checks those print strings still appear in the .ino
// files, so a sketch edit that changes the format fails here instead of at the club.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.js';
import { parseText, LineBuffer } from '../src/parse.js';
import { detectFormat, chooseBaud, BAUD_ORDER, bandwidthCheck, formatName } from '../src/detect.js';
import { Ingest } from '../src/pipeline.js';
import { uartResample, textToBytes, bootJunk, mulberry32 } from '../src/sim/uart.js';

const LOGGER = path.join(ROOT, 'arduino/nxt_logger/nxt_logger.ino');
const SELFTEST = path.join(ROOT, 'arduino/opengrip_selftest/opengrip_selftest.ino');
const BAUD = 115200;
const RATE = 200;

// Copy of nxt_logger printHeader() + loop() print calls (6 pins, 200 Hz).
function loggerText({ n = 400, t0 = 1234, markerAt = 150 } = {}) {
  const pins = [0, 1, 2, 3, 4, 5];
  const out = [`# nxt_logger v1 channels=6 rate_hz=${RATE} pins=${pins.map((p) => 'A' + p).join(',')}`, `t_ms${pins.map((p) => ',a' + p).join('')}`];
  const rand = mulberry32(7);
  for (let i = 0; i < n; i++) {
    const t = t0 + i * 5;
    out.push(`${t}${pins.map((c) => ',' + Math.floor(80 + c * 40 + rand() * 30)).join('')}`);
    if (i === markerAt) out.push(`# marker t_ms=${t} note=button`);
  }
  return out.join('\r\n') + '\r\n'; // Serial.println ends lines with CRLF
}

// Copy of opengrip_selftest fakeValue() (integer maths, as on the Uno).
function fakeValue(ch, t) {
  const p = t % 4000;
  switch (ch) {
    case 0: return Math.floor((p * 1023) / 3999);
    case 1: return t % 1000 < 500 ? 200 : 800;
    case 2: return p < 2000 ? 100 + Math.floor((p * 800) / 2000) : 900 - Math.floor(((p - 2000) * 800) / 2000);
    case 3: return p >= 1000 && p < 2500 ? 600 : 60;
    case 4: return 512;
    default: return 256;
  }
}

function selftestText({ ch = 4, n = 1600, t0 = 52, switchAt = null } = {}) {
  const pins = Array.from({ length: ch }, (_, i) => i);
  const out = [`# opengrip_selftest v1 mode=fake channels=${ch} rate_hz=${RATE} pins=${pins.map((p) => 'A' + p).join(',')}`, `t_ms${pins.map((p) => ',a' + p).join('')}`];
  for (let i = 0; i < n; i++) {
    const t = t0 + i * 5;
    if (i === switchAt) out.push(`# marker t_ms=${t} note=mode_sensors`);
    const sensors = switchAt != null && i >= switchAt;
    out.push(`${t}${pins.map((c) => ',' + (sensors ? 300 + c : fakeValue(c, t))).join('')}`);
  }
  return out.join('\r\n') + '\r\n';
}

// Bytes the board sends at 115200, read by the app at `rx`, split into lines like Web Serial chunks.
function linesAt(text, rx, seed = 1) {
  const bytes = uartResample(textToBytes(text), BAUD, rx);
  const dec = new TextDecoder('latin1');
  const lb = new LineBuffer();
  const rand = mulberry32(seed);
  const lines = [];
  for (let i = 0; i < bytes.length;) {
    const k = 1 + Math.floor(rand() * 64);
    lines.push(...lb.feed(dec.decode(bytes.subarray(i, i + k), { stream: true })));
    i += k;
  }
  return lines.concat(lb.flush());
}

test('fixture generators match the print calls and settings in both .ino files', () => {
  const lg = fs.readFileSync(LOGGER, 'utf8');
  const st = fs.readFileSync(SELFTEST, 'utf8');
  for (const src of [lg, st]) {
    assert.match(src, /const long BAUD = 115200;/);
    assert.match(src, /const unsigned long RATE_HZ = 200;/);
    assert.match(src, /F\(" rate_hz="\)/);
    assert.match(src, /F\(" pins="\)/);
    assert.match(src, /F\("t_ms"\)/);
    assert.match(src, /F\(",a"\)/);
    assert.match(src, /F\("# marker t_ms="\)/);
    assert.match(src, /Serial\.print\(t\);/);
  }
  assert.match(lg, /F\("# nxt_logger v1 channels="\)/);
  assert.match(lg, /F\(" note=button"\)/);
  assert.match(st, /F\("# opengrip_selftest v1 mode="\)/);
  assert.match(st, /F\(" channels="\)/);
  assert.match(st, /F\(" note=mode_sensors"\)/);
  // fakeValue cases in the sketch are the ones copied above.
  for (const k of ['p * 1023UL / 3999UL', "(t % 1000UL) < 500UL ? 200 : 800", 'p * 800UL / 2000UL', '? 600 : 60', 'return 512', 'return 256']) {
    assert.ok(st.includes(k), `selftest fakeValue lost: ${k}`);
  }
});

test('nxt_logger: parseText reads 6 timed channels at 200 Hz, header and marker', () => {
  const rec = parseText(loggerText());
  assert.equal(rec.hasTime, true);
  assert.equal(rec.channels, 6);
  assert.equal(rec.t.length, 400);
  assert.equal(rec.rateHz, 200);
  assert.equal(rec.meta.device, 'nxt_logger v1');
  assert.equal(rec.meta.channels, '6');
  assert.deepEqual(rec.markers.map((m) => m.note), ['button']);
  assert.equal(rec.stats.badLines, 0);
});

test('nxt_logger: detectFormat says timed, 6 channels, logger format name', () => {
  const f = detectFormat(loggerText().split('\r\n'));
  assert.equal(f.ok, true);
  assert.equal(f.kind, 'timed');
  assert.equal(f.hasTime, true);
  assert.equal(f.channels, 6);
  assert.equal(formatName(f, parseText(loggerText()).meta), 'OpenGrip logger format');
});

// Fixed 2026-10-23: detect.js treats a trailing word as a label only when the rest are numbers.
test('header names a0..aN reach detectFormat (both sketches)', () => {
  assert.deepEqual(detectFormat(loggerText().split('\r\n')).names, ['a0', 'a1', 'a2', 'a3', 'a4', 'a5']);
  assert.deepEqual(detectFormat(selftestText({ ch: 4 }).split('\r\n')).names, ['a0', 'a1', 'a2', 'a3']);
});

test('selftest: parseText reads the fake pattern exactly (ramp, square, triangle, squeeze)', () => {
  for (const ch of [2, 4, 6]) {
    const rec = parseText(selftestText({ ch }));
    assert.equal(rec.hasTime, true, `ch=${ch}`);
    assert.equal(rec.channels, ch);
    assert.equal(rec.rateHz, 200);
    assert.equal(rec.meta.device, 'opengrip_selftest v1');
    assert.equal(rec.meta.mode, 'fake');
    assert.equal(rec.stats.badLines, 0);
    for (let c = 0; c < ch; c++) rec.data[c].forEach((v, i) => assert.equal(v, fakeValue(c, rec.t[i])));
  }
  const rec = parseText(selftestText({ ch: 4 }));
  // 8 s of data: the square wave flips every 0.5 s, the squeeze starts twice.
  let flips = 0;
  let squeezes = 0;
  for (let i = 1; i < rec.t.length; i++) {
    if (rec.data[1][i] !== rec.data[1][i - 1]) flips++;
    if (rec.data[3][i] === 600 && rec.data[3][i - 1] === 60) squeezes++;
  }
  assert.equal(flips, 16); // t = 52..8047 ms crosses 16 half-second edges
  assert.equal(squeezes, 2);
  assert.equal(Math.min(...rec.data[0]), 0);
  assert.ok(Math.max(...rec.data[0]) >= 1020);
});

test('selftest: detectFormat finds the clock and 4 channels; the ramp is not taken for a clock', () => {
  const f = detectFormat(selftestText({ ch: 4 }).split('\r\n'));
  assert.equal(f.kind, 'timed');
  assert.equal(f.timeName, 't_ms');
  assert.equal(f.channels, 4);
  // Port opened mid-stream (header missed): column 0 is still the clock, the ramp is a channel.
  const noHeader = selftestText({ ch: 4 }).split('\r\n').slice(500, 560);
  const g = detectFormat(noHeader);
  assert.equal(g.hasTime, true);
  assert.equal(g.channels, 4);
});

test('both sketches: auto-baud picks 115200 with Uno boot junk in front', () => {
  for (const [name, text] of [['logger', loggerText()], ['selftest', selftestText()]]) {
    const withJunk = bootJunk(mulberry32(3)) + text;
    const attempts = BAUD_ORDER.map((rx) => ({ baud: rx, lines: linesAt(withJunk, rx).slice(0, 60) }));
    assert.equal(chooseBaud(attempts).baud, BAUD, name);
  }
});

test('both sketches: live Ingest at 115200 gives every sample, markers kept, mode switch tolerated', () => {
  const text = selftestText({ ch: 4, n: 600, switchAt: 300 });
  for (const [name, t, expect, notes] of [['logger', loggerText(), 400, ['button']], ['selftest', text, 600, ['mode_sensors']]]) {
    let fmt = null;
    let samples = 0;
    const marks = [];
    const ing = new Ingest({ onSample: () => samples++, onFormat: (x) => { fmt = x; }, onMarker: (m) => marks.push(m.note) });
    linesAt(t, BAUD, 5).forEach((l, i) => ing.push(l, i * 5));
    ing.flush?.();
    assert.equal(fmt.ok, true, name);
    assert.equal(fmt.kind, 'timed', name);
    assert.equal(samples, expect, name);
    assert.deepEqual(marks, notes, name);
  }
});

test('both sketches: 115200 baud has room for 6 channels at 200 Hz (B1) with real line lengths', () => {
  for (const text of [loggerText(), selftestText({ ch: 6 })]) {
    const rows = text.split('\r\n').filter((l) => /^\d/.test(l));
    const lineChars = Math.max(...rows.map((l) => l.length)) + 2;
    const bw = bandwidthCheck({ baud: BAUD, channels: 6, rateHz: RATE, lineChars });
    assert.equal(bw.ok, true, `load ${bw.load}`);
    assert.ok(bw.load < 0.6, `load ${bw.load}`);
  }
});

#!/usr/bin/env node
// replay.mjs: what would the Recorder detect and report for this file?
// Usage: node tools/replay.mjs <file.txt|file.csv> [--json] [--rate HZ]
// Runs the real modules: bytes -> LineBuffer -> Ingest (format auto-detect) -> quality.
// Without timestamps the rate is unknown; --rate HZ tells the checks what to assume.
import fs from 'node:fs';
import path from 'node:path';
import { LineBuffer } from '../src/parse.js';
import { Ingest } from '../src/pipeline.js';
import { describeFormat, rateLabel } from '../src/detect.js';
import { analyzeRecording } from '../src/quality.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && !/^\d+(\.\d+)?$/.test(a));
const asJson = args.includes('--json');
const ri = args.indexOf('--rate');
const forcedRate = ri >= 0 ? Number(args[ri + 1]) : null;
if (!file) {
  console.error('Usage: node tools/replay.mjs <file> [--json] [--rate HZ]');
  process.exit(2);
}

const bytes = fs.readFileSync(file);
const lb = new LineBuffer();
const lines = [...lb.feed(new TextDecoder('latin1').decode(bytes)), ...lb.flush()];
const samples = [];
const markers = [];
let format = null;
const ing = new Ingest({ onSample: (s) => samples.push(s), onMarker: (m) => markers.push(m), onFormat: (f) => { format = f; } });
// Files have no arrival times; space lines 1 ms apart so the ≈ host-rate is not invented.
lines.forEach((l, i) => ing.push(l, i));
if (!format && ing.buf.length) {
  // Short file: never reached the detection threshold. Force a decision like ingestText does.
  const { ingestText } = await import('../src/pipeline.js');
  const r = ingestText(lines.join('\n'));
  format = r.format;
  samples.push(...r.samples);
}
if (!format || !format.ok) {
  console.log(`${path.basename(file)}: cannot read this file. ${format ? format.reason : 'No data lines.'}`);
  process.exit(1);
}

const channels = format.channels;
const data = Array.from({ length: channels }, (_, c) => samples.map((s) => s.values[c]));
const labels = samples.map((s) => s.label);
const rate = format.hasTime ? ing.rate() : (forcedRate ? { hz: forcedRate, approx: true } : { hz: null, approx: true });
const report = analyzeRecording({ data, labels, rateHz: rate.hz, channelNames: format.names });

if (asJson) {
  console.log(JSON.stringify({ file: path.basename(file), format, rate, samples: samples.length, markers, report }, null, 2));
} else {
  const icon = { green: '[ok]  ', amber: '[warn]', red: '[BAD] ' };
  console.log(`${path.basename(file)}`);
  console.log(`  format:   ${describeFormat(format)} (${Math.round(format.parsedFraction * 100)}% of the first lines matched)`);
  console.log(`  channels: ${format.names.join(', ')}`);
  console.log(`  rate:     ${rateLabel(rate)}${rate.hz ? '' : ' (no timestamps; pass --rate HZ if you know it)'}`);
  console.log(`  samples:  ${samples.length}  (lines ${ing.counts.lines}, rejected ${ing.counts.rejected})${markers.length ? `, markers ${markers.length}` : ''}`);
  for (const it of report.items) console.log(`  ${icon[it.level]} ${it.message}`);
}

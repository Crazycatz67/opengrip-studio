// pipeline.js: lines -> samples, with plug-and-play format detection. Pure.
//
// Contract
//   const ing = new Ingest({ onSample, onMeta, onMarker, onFormat, format = null,
//                            detectLines = 50, minDataLines = 20, maxBuffer = 300 })
//   ing.push(line, hostMs)
//     Buffers lines until the format is known (or uses `format` if given), then replays the
//     buffer, so no early sample is lost. '#' lines go to onMeta/onMarker at once.
//   onSample({ t: device ms|null, hostMs, values: number[], label: string|null })
//   onFormat(format)  once; format.ok=false means "can't read this stream" (reason in words)
//   ing.rate() -> { hz, approx }   device timestamps if present, else host arrival times (approx)
//   ing.format, ing.meta, ing.counts { lines, samples, rejected }
//   ingestText(text, opts) -> { format, samples, meta, markers, counts, rate } for files/tests.

import { parseLine, estimateRate, LineBuffer } from './parse.js';
import { detectFormat, makeRowParser, estimateRateFromArrivals } from './detect.js';

const RATE_WINDOW = 1000;

export class Ingest {
  constructor(opts = {}) {
    this.o = { detectLines: 50, minDataLines: 20, maxBuffer: 300, ...opts };
    this.format = opts.format || null;
    this.parseRow = this.format ? makeRowParser(this.format) : null;
    this.buf = [];
    this.meta = {};
    this.counts = { lines: 0, samples: 0, rejected: 0 };
    this.devT = [];
    this.hostT = [];
    this.failed = false;
  }

  push(line, hostMs) {
    this.counts.lines++;
    const p = parseLine(line);
    if (p.kind === 'meta') { Object.assign(this.meta, p.meta); this.o.onMeta?.(p.meta); return; }
    if (p.kind === 'marker') { this.o.onMarker?.({ t: p.t, note: p.note, hostMs }); return; }
    if (p.kind === 'empty') return;
    if (!this.parseRow) {
      this.buf.push([line, hostMs]);
      const dataish = this.buf.filter(([l]) => /\d/.test(l)).length;
      if (dataish < this.o.minDataLines && this.buf.length < this.o.detectLines) return;
      const f = detectFormat(this.buf.map(([l]) => l));
      if (!f.ok && this.buf.length < this.o.maxBuffer) return;
      this.format = f;
      this.o.onFormat?.(f);
      if (!f.ok) { this.failed = true; this.buf = []; return; }
      this.parseRow = makeRowParser(f);
      const pending = this.buf;
      this.buf = [];
      for (const [l, h] of pending) this._row(l, h);
      return;
    }
    this._row(line, hostMs);
  }

  _row(line, hostMs) {
    const r = this.parseRow(line);
    if (!r) { this.counts.rejected++; return; }
    this.counts.samples++;
    if (r.t != null) { this.devT.push(r.t); if (this.devT.length > RATE_WINDOW) this.devT.shift(); }
    this.hostT.push(hostMs);
    if (this.hostT.length > RATE_WINDOW) this.hostT.shift();
    this.o.onSample?.({ t: r.t, hostMs, values: r.values, label: r.label });
  }

  rate() {
    if (this.format?.hasTime) {
      const hz = estimateRate(this.devT);
      if (hz) return { hz, approx: false };
    }
    if (Number(this.meta.rate_hz) > 0 && !this.format?.hasTime) return { hz: Number(this.meta.rate_hz), approx: true };
    return estimateRateFromArrivals(this.hostT);
  }
}

export function ingestText(text, opts = {}) {
  const samples = [];
  const markers = [];
  let format = null;
  const ing = new Ingest({
    ...opts,
    onSample: (s) => samples.push(s),
    onMarker: (m) => markers.push(m),
    onFormat: (f) => { format = f; },
  });
  const lb = new LineBuffer();
  const lines = [...lb.feed(String(text)), ...lb.flush()];
  lines.forEach((l, i) => ing.push(l, opts.hostMsFor ? opts.hostMsFor(i) : i));
  // Short files may never reach the detection threshold; decide with what we have.
  if (!ing.parseRow && !ing.failed && ing.buf.length) {
    const f = detectFormat(ing.buf.map(([l]) => l));
    format = f;
    if (f.ok) {
      ing.format = f;
      ing.parseRow = makeRowParser(f);
      const pending = ing.buf;
      ing.buf = [];
      for (const [l, h] of pending) ing._row(l, h);
    }
  }
  return { format, samples, meta: ing.meta, markers, counts: ing.counts, rate: ing.rate() };
}

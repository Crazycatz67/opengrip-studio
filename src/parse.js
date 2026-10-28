// parse.js: turn serial/log text into samples. Pure; runs in Node and the browser.
//
// Contract
//   cleanLine(raw) -> { text, garbage }    strips control bytes, non-ASCII and any junk
//                                           before the first number (serial-open noise).
//   parseLine(raw) -> one of
//     { kind: 'empty' }
//     { kind: 'meta', meta: {k: v}, words: string[] }   "# key=value" or "# words k=v k=v"
//     { kind: 'marker', t: ms|null, note: string }       "# marker t_ms=123 note=free text"
//     { kind: 'columns', names: string[] }              "t_ms,ch1,ch2,label"
//     { kind: 'row', nums: number[], label: string|null, garbage: boolean }
//     { kind: 'bad', raw }
//   A 'row' is format-neutral: whether nums[0] is a timestamp is decided per file/stream
//   (headers say so, or the first column behaves like a clock). See StreamParser.
//   new StreamParser({ hasTime }) .push(line) -> event|null, events are
//     { type: 'sample', t: ms|null, values: number[], label: string|null }
//     { type: 'meta', meta } | { type: 'marker', t, note } | { type: 'columns', names }
//   parseText(text, { hasTime }) -> Recording:
//     { meta, hasTime, channels, t: (ms|null)[], data: number[][] (per channel),
//       labels: (string|null)[], markers: [{t, note}], rateHz: number|null,
//       stats: { lines, samples, garbageLines, badLines } }
//   estimateRate(tMs[]) -> Hz from the median step, or null if fewer than 3 usable stamps.
//   LineBuffer: feed(chunk) -> complete lines; for serial chunks that split lines.
// Failure behaviour: never throws on bad input; bad lines are counted, not fatal.

const NUM = '-?\\d+(?:\\.\\d+)?';
// A data row anywhere in the line: numbers separated by commas, optional trailing label.
// Unanchored at the start so "\x18f14" (serial-open junk) still yields 14.
const ROW_RE = new RegExp(`(${NUM}(?:\\s*,\\s*${NUM})*)(?:\\s*,\\s*([A-Za-z_][\\w\\-@ ]*?))?\\s*,?\\s*$`);

export function cleanLine(raw) {
  const s = String(raw ?? '');
  // Keep printable ASCII only; garbage on port open is control bytes and high bytes.
  const text = s.replace(/[^\x20-\x7E\t]/g, '').trim();
  return { text, garbage: text.length !== s.replace(/[\r\n]/g, '').trim().length };
}

const FREE_TEXT_KEYS = new Set(['notes', 'note', 'placement', 'placement_map', 'setup', 'description', 'comment']);

function parseComment(body) {
  const b = body.trim();
  if (/^marker\b/i.test(b)) {
    const t = b.match(/\bt_ms=(-?\d+(?:\.\d+)?)/);
    const note = b.match(/\bnote=(.*)$/);
    return { kind: 'marker', t: t ? Number(t[1]) : null, note: note ? note[1].trim() : '' };
  }
  // Single "key=value with spaces" form (notes, placement) keeps the whole value.
  // Free-text keys keep it even when the value itself contains "k=v" (e.g. a note
  // "moved band, gain=2"); other lines like "channels=6 rate_hz=200" still split.
  const single = b.match(/^([A-Za-z_][\w.\-]*)=(.*)$/);
  if (single && (FREE_TEXT_KEYS.has(single[1].toLowerCase()) || !/\s[A-Za-z_][\w.\-]*=/.test(single[2]))) {
    return { kind: 'meta', meta: { [single[1]]: single[2].trim() }, words: [] };
  }
  const meta = {};
  const words = [];
  for (const tok of b.split(/\s+/).filter(Boolean)) {
    const eq = tok.indexOf('=');
    if (eq > 0) meta[tok.slice(0, eq)] = tok.slice(eq + 1);
    else words.push(tok);
  }
  // "# nxt_logger v1 channels=4": the leading words name the device/firmware.
  if (words.length && Object.keys(meta).length) meta.device = words.join(' ');
  return { kind: 'meta', meta, words };
}

export function parseLine(raw) {
  const { text, garbage } = cleanLine(raw);
  if (!text) return { kind: 'empty' };
  const hash = text.indexOf('#');
  // Only treat '#' as a header when nothing numeric precedes it (junk may come first).
  if (hash >= 0 && !/\d/.test(text.slice(0, hash))) return parseComment(text.slice(hash + 1));
  if (/^\s*t(_ms)?\s*,/i.test(text) || /^\s*ch\d+\s*,/i.test(text)) {
    return { kind: 'columns', names: text.split(',').map((s) => s.trim()) };
  }
  const m = text.match(ROW_RE);
  if (!m) return { kind: 'bad', raw: String(raw) };
  const nums = m[1].split(',').map((s) => Number(s.trim()));
  if (nums.some((n) => !Number.isFinite(n))) return { kind: 'bad', raw: String(raw) };
  const prefixJunk = text.slice(0, m.index).trim().length > 0;
  return { kind: 'row', nums, label: m[2] ? m[2].trim() : null, garbage: garbage || prefixJunk };
}

export function estimateRate(tMs) {
  const steps = [];
  for (let i = 1; i < tMs.length; i++) {
    const a = tMs[i - 1];
    const b = tMs[i];
    if (a == null || b == null) continue;
    const d = b - a;
    if (d > 0) steps.push(d);
  }
  if (steps.length < 2) return null;
  steps.sort((x, y) => x - y);
  const med = steps[Math.floor(steps.length / 2)];
  return Math.round((1000 / med) * 100) / 100;
}

// A stream decides once whether column 0 is time. Headers win; otherwise the
// caller can say (parseText does a whole-file look); otherwise assume no time,
// which is right for the club's legacy one-number-per-line logs.
export class StreamParser {
  constructor({ hasTime = null } = {}) {
    this.hasTime = hasTime;
    this.meta = {};
    this.columns = null;
    this.stats = { lines: 0, samples: 0, garbageLines: 0, badLines: 0 };
  }

  push(raw) {
    this.stats.lines++;
    const p = parseLine(raw);
    switch (p.kind) {
      case 'empty':
        return null;
      case 'bad':
        this.stats.badLines++;
        return null;
      case 'meta':
        Object.assign(this.meta, p.meta);
        if (this.hasTime == null && (p.meta.device || '').startsWith('nxt_logger')) this.hasTime = true;
        if (this.hasTime == null && p.meta.columns) this.hasTime = /^t(_ms)?\b/.test(p.meta.columns);
        return { type: 'meta', meta: p.meta };
      case 'marker':
        return { type: 'marker', t: p.t, note: p.note };
      case 'columns':
        this.columns = p.names;
        if (this.hasTime == null) this.hasTime = /^t(_ms)?$/i.test(p.names[0]);
        return { type: 'columns', names: p.names };
      case 'row': {
        if (p.garbage) this.stats.garbageLines++;
        const timed = this.hasTime === true && p.nums.length >= 2;
        this.stats.samples++;
        return {
          type: 'sample',
          t: timed ? p.nums[0] : null,
          values: timed ? p.nums.slice(1) : p.nums,
          label: p.label,
        };
      }
      default:
        return null;
    }
  }
}

// Whole-file guess: column 0 is a clock if rows have >= 2 numbers and it never
// goes backwards and mostly increases. ADC values (0-1023) jitter both ways.
function looksTimed(lines) {
  let rows = 0;
  let up = 0;
  let prev = null;
  for (const line of lines) {
    const p = parseLine(line);
    if (p.kind !== 'row') continue;
    if (p.nums.length < 2) return false;
    if (prev != null) {
      if (p.nums[0] < prev) return false;
      if (p.nums[0] > prev) up++;
    }
    prev = p.nums[0];
    if (++rows >= 200) break;
  }
  return rows >= 3 && up >= (rows - 1) * 0.5;
}

export function parseText(text, { hasTime = null } = {}) {
  const lines = String(text).split(/\r\n|\n|\r/);
  const sp = new StreamParser({ hasTime });
  // Headers first, so a file with "# nxt_logger" or a column row is never guessed.
  for (const l of lines) {
    const p = parseLine(l);
    if (p.kind === 'row') break;
    if (p.kind === 'columns') { sp.hasTime = /^t(_ms)?$/i.test(p.names[0]); break; }
    if (p.kind === 'meta' && ((p.meta.device || '').startsWith('nxt_logger') || p.meta.columns)) break;
  }
  if (sp.hasTime == null && !lines.some((l) => /nxt_logger|columns=/.test(l))) sp.hasTime = looksTimed(lines);

  const rec = { meta: sp.meta, hasTime: false, channels: 0, t: [], data: [], labels: [], markers: [], rateHz: null, stats: sp.stats };
  for (const l of lines) {
    const ev = sp.push(l);
    if (!ev) continue;
    if (ev.type === 'marker') rec.markers.push({ t: ev.t, note: ev.note, index: rec.t.length });
    if (ev.type !== 'sample') continue;
    // Channel count is fixed by the first sample; short rows are padded so arrays stay aligned.
    if (rec.channels === 0) {
      rec.channels = ev.values.length;
      for (let c = 0; c < rec.channels; c++) rec.data.push([]);
    }
    for (let c = 0; c < rec.channels; c++) rec.data[c].push(ev.values[c] ?? NaN);
    rec.t.push(ev.t);
    rec.labels.push(ev.label);
  }
  rec.hasTime = sp.hasTime === true;
  rec.rateHz = rec.hasTime ? estimateRate(rec.t) : null;
  if (rec.rateHz == null && Number(sp.meta.rate_hz) > 0) rec.rateHz = Number(sp.meta.rate_hz);
  return rec;
}

export class LineBuffer {
  constructor() { this.rest = ''; }
  feed(chunk) {
    const s = this.rest + chunk;
    const parts = s.split(/\r\n|\n|\r/);
    // A trailing '\r' may be half of '\r\n'; keep it so the next chunk's '\n' isn't an empty line.
    this.rest = parts.pop();
    return parts.filter((p) => p.length > 0);
  }
  flush() { const r = this.rest; this.rest = ''; return r ? [r] : []; }
}

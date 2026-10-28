// detect.js: plug-and-play format, baud and rate detection. Pure; runs in Node and the browser.
//
// Contract
//   detectFormat(lines: string[]) -> Format
//     Format = { kind: 'single'|'delimited'|'plotter'|'timed', delimiter: ','|'\t'|' '|null,
//                channels, names: string[], hasTime, timeName: string|null,
//                parsedFraction 0..1, sampleLines, ok, reason }
//     Looks at up to the first 50 non-empty lines. Garbage and partial lines are tolerated:
//     the modal field count wins, odd lines only lower parsedFraction.
//     ok=false (with a plain-words reason) when under half the lines look like data.
//   makeRowParser(format) -> (line) -> { t: ms|null, values: number[], label: string|null } | null
//     '#' header/marker lines return null here; route them through parse.js parseLine.
//   scoreLines(lines) -> { lines, dataLines, fraction }   used per baud attempt
//   chooseBaud(attempts: [{ baud, lines }], minFraction = 0.8) -> { baud|null, fraction, results, message }
//   BAUD_ORDER = [115200, 9600, 57600, 38400, 230400]
//   bootJunkFilter: dropLeadingJunk(lines) removes the Uno's reset/bootloader noise before scoring.
//   estimateRateFromArrivals(hostMs: number[]) -> { hz|null, approx: true }   lines-per-second over
//     the span, robust to USB packets delivering many lines at once.
//   rateLabel({ hz, approx }) -> "200 Hz" or "≈ 190 Hz" or "unknown"
//   formatName(format, headers?) -> the Preflight Format row's plain name, e.g.
//     "CSV with time · 6 values", "One number per line", "Serial Plotter labels (a:1 b:2)",
//     "Named pins (A0: 123)", "Tab-separated · 4 values", "OpenGrip logger format".
//     headers: the parsed '# k=v' header (parse.js); a 'nxt_logger'/'opengrip' key or value
//     names our own sketch. Unknown or failed formats give "Unknown format".
//   bandwidthCheck({ baud, channels, rateHz, hasTime = true, lineChars? }) ->
//     { needed, available (chars/s), load 0..n, ok, message|null }
//     8N1 serial moves baud/10 characters a second. lineChars defaults to a worst-case
//     estimate (5 chars per 0-1023 value with its delimiter, 9 for a ms clock, 2 for CRLF).
//     ok = load <= BANDWIDTH_LIMIT (0.7): above that, lines queue up and get cut or dropped.

import { cleanLine, estimateRate } from './parse.js';

export const BAUD_ORDER = [115200, 9600, 57600, 38400, 230400];
const NUM_RE = /^-?\d+(?:\.\d+)?$/;
const PAIR_RE = /([A-Za-z_][\w.]*)\s*[:=]\s*(-?\d+(?:\.\d+)?)/g;
const TIME_NAME_RE = /^(t|t_ms|time|time_ms|ms|millis|timestamp)$/i;

// Classify one cleaned line into a shape; the detector votes over shapes.
function shapeOf(text, allowStrip = true) {
  if (!text || text.startsWith('#')) return null;
  const pairs = [...text.matchAll(PAIR_RE)];
  if (pairs.length) {
    // Serial Plotter / "A0: 123" style. Everything not a pair must be separators.
    const rest = text.replace(PAIR_RE, '').replace(/[\s,;\t|]+/g, '');
    if (rest.length === 0) return { kind: 'plotter', names: pairs.map((p) => p[1]), nums: pairs.map((p) => Number(p[2])) };
  }
  const delim = text.includes(',') ? ',' : text.includes('\t') ? '\t' : /\s/.test(text) ? ' ' : null;
  const parts = delim ? text.split(delim === ' ' ? /\s+/ : delim).map((s) => s.trim()) : [text.trim()];
  // Optional trailing text label (our own t_ms,ch...,label format).
  let label = null;
  // Only a label when everything before it is a number: on a header row ("t_ms,a0,..,a5") the
  // last word is a column name, not a label.
  if (parts.length > 1 && /^[A-Za-z_][\w\-@ ]*$/.test(parts[parts.length - 1]) && parts.slice(0, -1).every((p) => NUM_RE.test(p))) label = parts.pop();
  if (parts.length && parts.every((p) => NUM_RE.test(p))) {
    return { kind: parts.length === 1 ? 'single' : 'delimited', delimiter: parts.length === 1 ? null : delim, nums: parts.map(Number), label };
  }
  if (parts.every((p) => /^[A-Za-z_][\w]*$/.test(p)) && parts.length >= 2) return { kind: 'columns', delimiter: delim, names: parts };
  // Junk glued to the front of a number ("f\x1814" when the port opens): retry from the
  // first digit. Not done for plotter lines, whose names come first by design.
  const m = text.match(/^[^\d\-]+(?=-?\d)/);
  if (m && allowStrip) {
    const r = shapeOf(text.slice(m[0].length), false);
    if (r && r.kind !== 'plotter') return { ...r, stripped: true };
  }
  return null;
}

// The Uno resets when the port opens and the bootloader/first print can emit junk;
// at the wrong baud *every* line is junk. Drop leading lines that do not look like data.
export function dropLeadingJunk(lines) {
  let i = 0;
  while (i < lines.length && !shapeOf(cleanLine(lines[i]).text) && !cleanLine(lines[i]).text.startsWith('#')) i++;
  return lines.slice(i);
}

function printableFraction(s) {
  if (!s.length) return 0;
  let ok = 0;
  for (const ch of s) { const c = ch.charCodeAt(0); if ((c >= 0x20 && c < 0x7f) || c === 9) ok++; }
  return ok / s.length;
}

export function scoreLines(lines) {
  const ls = lines.filter((l) => l.replace(/[\r\n]/g, '').length > 0);
  let data = 0;
  for (const l of ls) {
    // A line counts only if it is mostly printable before cleaning: at the wrong baud,
    // cleaning alone could leave a stray digit and fake a "single int" line.
    const pf = printableFraction(l.replace(/[\r\n]/g, ''));
    const { text } = cleanLine(l);
    if (pf >= 0.9 && (shapeOf(text) || text.startsWith('#'))) data++;
  }
  return { lines: ls.length, dataLines: data, fraction: ls.length ? data / ls.length : 0 };
}

export function chooseBaud(attempts, minFraction = 0.8) {
  const results = attempts.map((a) => ({ baud: a.baud, ...scoreLines(a.lines) }));
  const good = results.find((r) => r.lines >= 3 && r.fraction >= minFraction);
  if (good) return { baud: good.baud, fraction: good.fraction, results, message: `Found the board at ${good.baud} baud.` };
  const silent = results.every((r) => r.lines < 3);
  const message = silent
    ? 'The board is connected but sends nothing. Check the sketch prints with Serial.println, and that nothing else (e.g. Arduino IDE Serial Monitor) has the port open.'
    : `The board sends data, but none of the speeds tried (${results.map((r) => r.baud).join(', ')}) gives readable lines. Check Serial.begin(...) in the sketch.`;
  return { baud: null, fraction: Math.max(0, ...results.map((r) => r.fraction)), results, message };
}

export function detectFormat(rawLines) {
  const lines = dropLeadingJunk(rawLines).map((l) => cleanLine(l).text).filter(Boolean).slice(0, 50);
  const shapes = lines.map(shapeOf);
  const header = shapes.find((s) => s && s.kind === 'columns');
  const data = shapes.filter((s) => s && s.kind !== 'columns');
  const fail = (reason) => ({ kind: null, delimiter: null, channels: 0, names: [], hasTime: false, timeName: null, parsedFraction: lines.length ? data.length / lines.length : 0, sampleLines: lines.length, ok: false, reason });
  if (!lines.length) return fail('No lines received yet.');
  if (!data.length) return fail('Lines arrive but none look like numbers.');

  // Vote on (kind, field count): partial first lines and junk lose the vote.
  const votes = new Map();
  for (const s of data) {
    const key = `${s.kind}|${s.nums.length}|${s.kind === 'plotter' ? s.names.join(',') : s.delimiter}`;
    votes.set(key, (votes.get(key) || 0) + 1);
  }
  const [bestKey, bestCount] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  const winners = data.filter((s) => `${s.kind}|${s.nums.length}|${s.kind === 'plotter' ? s.names.join(',') : s.delimiter}` === bestKey);
  const w = winners[0];
  const parsedFraction = bestCount / lines.filter((l) => !l.startsWith('#') && !(header && shapeOf(l) === header)).length;

  let names;
  let hasTime = false;
  let timeName = null;
  if (w.kind === 'plotter') {
    names = w.names.slice();
    const ti = names.findIndex((n) => TIME_NAME_RE.test(n));
    if (ti === 0) { hasTime = true; timeName = names[0]; names = names.slice(1); }
  } else if (header && header.names.length >= w.nums.length) {
    names = header.names.slice(0, w.nums.length);
    if (TIME_NAME_RE.test(names[0])) { hasTime = true; timeName = names[0]; names = names.slice(1); }
  } else {
    // No names: column 0 is a clock if it never goes back and mostly goes up by similar steps.
    if (w.nums.length >= 2) {
      const col = winners.map((s) => s.nums[0]);
      let up = 0;
      let back = 0;
      for (let i = 1; i < col.length; i++) { if (col[i] > col[i - 1]) up++; else if (col[i] < col[i - 1]) back++; }
      hasTime = col.length >= 3 && back === 0 && up >= (col.length - 1) * 0.6;
      if (hasTime) timeName = 't_ms';
    }
    const n = w.nums.length - (hasTime ? 1 : 0);
    names = Array.from({ length: n }, (_, i) => `ch${i + 1}`);
  }
  const kind = hasTime && w.kind !== 'plotter' ? 'timed' : w.kind;
  const ok = parsedFraction >= 0.5;
  return {
    kind, delimiter: w.kind === 'plotter' ? null : w.delimiter, channels: names.length, names, hasTime, timeName,
    parsedFraction: Math.round(parsedFraction * 1000) / 1000, sampleLines: lines.length, ok,
    reason: ok ? describeFormat({ kind, names, hasTime }) : 'Too few lines match one format; the stream may be noisy or at the wrong speed.',
  };
}

export function describeFormat(f) {
  const kinds = { single: 'one number per line', delimited: 'numbers separated by commas/spaces', plotter: 'Serial Plotter style name:value', timed: 'timestamp then numbers' };
  return `${kinds[f.kind] || f.kind}, ${f.names.length} channel(s)${f.hasTime ? ' with device timestamps' : ''}`;
}

export function makeRowParser(format) {
  const expected = format.channels + (format.hasTime && format.kind !== 'plotter' ? 1 : 0);
  return (line) => {
    const { text } = cleanLine(line);
    const s = shapeOf(text);
    if (!s || s.kind === 'columns') return null;
    if (format.kind === 'plotter') {
      if (s.kind !== 'plotter') return null;
      const map = new Map(s.names.map((n, i) => [n, s.nums[i]]));
      // A cut-off line may miss a channel; drop it rather than fill a fake value.
      if (!format.names.every((n) => map.has(n))) return null;
      return { t: format.hasTime ? map.get(format.timeName) : null, values: format.names.map((n) => map.get(n)), label: null };
    }
    if (s.kind === 'plotter') return null;
    if (s.nums.length !== expected) return null;
    return format.hasTime
      ? { t: s.nums[0], values: s.nums.slice(1), label: s.label }
      : { t: null, values: s.nums, label: s.label };
  };
}

export function estimateRateFromArrivals(hostMs) {
  if (hostMs.length < 10) return { hz: null, approx: true };
  const span = hostMs[hostMs.length - 1] - hostMs[0];
  // Under ~1 s of data, USB packet clumping dominates; wait for more.
  if (span < 1000) return { hz: null, approx: true };
  return { hz: Math.round(((hostMs.length - 1) * 1000) / span), approx: true };
}

export function deviceRate(tMs) {
  const hz = estimateRate(tMs);
  return { hz, approx: false };
}

export function rateLabel(r) {
  if (!r || !r.hz) return 'unknown';
  return r.approx ? `≈ ${Math.round(r.hz)} Hz` : `${r.hz} Hz`;
}

export function formatName(f, headers = null) {
  if (!f || !f.ok || !f.kind) return 'Unknown format';
  const h = headers ? Object.entries(headers).map(([k, v]) => `${k} ${v}`).join(' ') : '';
  if (/nxt_logger|opengrip/i.test(h)) return 'OpenGrip logger format';
  const n = f.names.length;
  const values = `${n} value${n === 1 ? '' : 's'}`;
  if (f.kind === 'single') return 'One number per line';
  if (f.kind === 'plotter') return f.names.every((x) => /^A\d+$/i.test(x)) ? 'Named pins (A0: 123)' : 'Serial Plotter labels (a:1 b:2)';
  const sep = { ',': 'CSV', '\t': 'Tab-separated', ' ': 'Space-separated' }[f.delimiter] || 'Numbers';
  return `${sep}${f.hasTime ? ' with time' : ''} · ${values}`;
}

export const BANDWIDTH_LIMIT = 0.7;

export function bandwidthCheck({ baud, channels, rateHz, hasTime = true, lineChars = null }) {
  const chars = lineChars || channels * 5 + (hasTime ? 9 : 0) + 2;
  const needed = Math.round(chars * (rateHz || 0));
  const available = Math.floor((baud || 0) / 10);
  if (!available || !rateHz) return { needed, available, load: null, ok: true, message: null };
  const load = needed / available;
  const ok = load <= BANDWIDTH_LIMIT;
  const fix = baud < 115200 ? 'use 115200 baud or fewer channels' : 'use fewer channels or a lower sample rate';
  const message = ok ? null : `This link is too slow for ${channels} channels at ${Math.round(rateHz)} Hz: ${fix}.`;
  return { needed, available, load, ok, message };
}

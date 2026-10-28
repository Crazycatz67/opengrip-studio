// ui/plot.js: the Record screen's live signal plot (spec §8.3). One canvas, up to 8 lanes, one
// grey trace colour, the now line at 85 % of the width and the next ~1.8 s of the protocol drawn
// to its right. No framework; a ring buffer of the last 30 s so a frame never allocates.
//
// Contract
//   const plot = createPlot({ box, gutter, names, rateHz = 100, windowSec = 10, sweep = false })
//     sweep: reduced-motion mode (spec §11). The window is a fixed time axis across the full width;
//     an accent cursor moves left->right and overwrites the previous sweep behind a 4 px erase gap.
//     Nothing scrolls, no protocol-ahead bands, and each lane's Fit range is fixed for the sweep,
//     so pixels left of the cursor stay still. plot.sweep is read/write; plot.cursor = its x (canvas px).
//     box: a wrapper with position: relative; min-height: 0 (the canvas goes inside it,
//     position: absolute; inset: 0, sized from the wrapper by a ResizeObserver x devicePixelRatio:
//     the spec §8.3 sizing trap). gutter: an element that gets one row per lane.
//   plot.push(hostMs, values, label|null)   one sample; host ms on the performance.now() clock
//   plot.frame(nowMs, { view: 'fit'|'full'|'norm', cal: { rest[], squeeze[] }|null,
//                       current: label|null, future: [{ startMs, endMs, label, word }],
//                       markers: [{ ms, note }],
//                       issues: [{ lane, level: 'amber'|'red', ms }] })   draws one frame; call from rAF
//     issues: lane markers from the quality strip (ms on the same clock as nowMs). Each draws a
//     shape (▲ amber, ✕ red) at its time, clamped to the left edge once it scrolls off, plus a
//     2 px, 60 % alpha underline on the lane from the issue's time to the now line (review-1 #5:
//     full-width rules read as threshold lines); every trace is clipped to its lane; the gutter row gets [data-level] and a status icon + word, so
//     the problem never reads by colour alone.
//   plot.windowSec (read/write: 5 | 10 | 20 | 30), plot.lanes (≤ 8), plot.count (samples held)
//   plot.stats -> { frames, drawMs (mean of the last 60), lastMs }
//   plot.refreshColours()   re-read the CSS tokens (call after H toggles high contrast)
//   plot.destroy()
//   places (option) / plot.setPlaces(places): one short place line per lane under its name
//     (spec §5.4, e.g. 'FMG · Back·little'; null or '' = no line). The gutter gets .tight while a
//     lane is under 40 px tall, and CSS hides the place line then.
//   Values are drawn as min/max per pixel column when there are more samples than pixels.
//   Channels past 8 are kept by the session but not drawn (Preflight already said so).

import { normalize } from '../quality.js';
import { splitLabel } from '../protocol.js';
import { statusIcon } from './icons.js';

const LANE_WORD = { amber: 'Check', red: 'Fix' };
const LANE_ICON = { amber: 'check', red: 'fix' };

export const MAX_LANES = 8;
export const NOW_AT = 0.85;
const KEEP_SEC = 30;          // longest window ([ ] go up to 30 s)
const FIT_MIN_SPAN = 40;      // counts: noise must not look like a signal (spec §8.3 Fit)
const TOP = 1015;             // "top" saturation line in the Full view
const NORM_LO = -0.15;
const NORM_HI = 1.25;
const MIN_BAND_LABEL_PX = 48;

// Kind of a label for the bands: active gestures get a band, arm-only moves are hatched, rest
// and pauses get nothing. Same rule as the step strip (record.js) so the two always agree.
export function labelKind(label) {
  const g = splitLabel(label).gesture.toLowerCase();
  if (!g || g === 'paused') return 'none';
  if (g === 'cal_rest') return 'cal';
  if (g === 'cal_squeeze') return 'act';
  if (/elbow|bend|distractor/.test(g)) return 'arm';
  if (g === 'rest') return 'rest';
  return 'act';
}

export function createPlot({ box, gutter, names, rateHz = 100, windowSec = 10, sweep = false, places = null }) {
  const lanes = Math.min(MAX_LANES, names.length);
  const cap = Math.max(4096, Math.ceil(KEEP_SEC * Math.max(rateHz || 100, 50) * 1.5));
  const tBuf = new Float64Array(cap);
  const vBuf = new Float32Array(cap * lanes);
  const lBuf = new Array(cap).fill(null);
  const holdSweep = new Float64Array(lanes).fill(NaN); const holdMin = new Float64Array(lanes); const holdMax = new Float64Array(lanes);
  let holdView = 'fit';
  let lastNowX = 0;
  let head = 0; // next write slot
  let count = 0;

  const canvas = document.createElement('canvas');
  canvas.setAttribute('role', 'img');
  box.append(canvas);
  const g = canvas.getContext('2d');
  let W = 0; let H = 0; let dpr = 1;
  let mn = new Float32Array(0); let mx = new Float32Array(0); let seen = new Uint8Array(0);
  const ro = new ResizeObserver(() => resize());
  ro.observe(box);

  gutter.innerHTML = names.slice(0, lanes).map((n, i) => `<div class="lane"><span class="i">${i + 1}</span><span class="nm"></span><span class="lst"></span></div>`).join('');
  [...gutter.querySelectorAll('.nm')].forEach((el, i) => { el.textContent = names[i]; });
  function setPlaces(list) {
    [...gutter.querySelectorAll('.lane')].forEach((row, i) => {
      let el = row.querySelector('.pl');
      const t = list?.[i] || '';
      if (!t) { el?.remove(); return; }
      if (!el) { el = document.createElement('span'); el.className = 'pl'; row.querySelector('.nm').after(el); }
      el.textContent = t;
      el.title = t;
    });
  }
  setPlaces(places);

  let C = {};
  let hatch = null;
  function refreshColours() {
    const cs = getComputedStyle(document.documentElement);
    const v = (k) => cs.getPropertyValue(k).trim();
    C = { bg: v('--panel-2'), line: v('--line'), trace: v('--trace'), accent: v('--accent'), weak: v('--accent-weak'),
      band: v('--band'), muted: v('--muted'), warn: v('--warn'), bad: v('--bad'), tw: Number(v('--tw')) || 1 };
    const p = document.createElement('canvas');
    p.width = p.height = 8;
    const pg = p.getContext('2d');
    pg.strokeStyle = 'rgb(148 163 184 / .35)';
    pg.lineWidth = 2;
    pg.beginPath(); pg.moveTo(0, 8); pg.lineTo(8, 0); pg.stroke();
    hatch = g.createPattern(p, 'repeat');
  }
  refreshColours();

  function resize() {
    dpr = window.devicePixelRatio || 1;
    const r = box.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width * dpr));
    H = Math.max(1, Math.round(r.height * dpr));
    canvas.width = W; canvas.height = H;
    // A hidden box (narrow Body tab) measures 0: keep the last tight state instead of flipping it.
    if (r.height > 0) gutter.classList.toggle('tight', r.height / Math.max(1, lanes) < 40);
    const cols = Math.ceil(W / dpr) + 2;
    mn = new Float32Array(cols * lanes); mx = new Float32Array(cols * lanes); seen = new Uint8Array(cols);
  }
  resize();

  const stats = { frames: 0, drawMs: 0, lastMs: 0 };
  const recent = [];

  const plot = {
    lanes, windowSec, sweep, stats, canvas, refreshColours,
    get count() { return count; },
    get cursor() { return lastNowX; }, // canvas px of the last frame's now line (sweep cursor)
    push(hostMs, values, label) {
      tBuf[head] = hostMs;
      const o = head * lanes;
      for (let c = 0; c < lanes; c++) vBuf[o + c] = values[c];
      lBuf[head] = label;
      head = (head + 1) % cap;
      if (count < cap) count++;
    },
    frame(nowMs, o = {}) {
      const t0 = performance.now();
      draw(nowMs, o);
      stats.lastMs = performance.now() - t0;
      recent.push(stats.lastMs);
      if (recent.length > 60) recent.shift();
      stats.drawMs = recent.reduce((a, b) => a + b, 0) / recent.length;
      stats.frames++;
    },
    setPlaces,
    destroy() { ro.disconnect(); canvas.remove(); },
  };

  let gutterKey = '';
  function paintGutter(iss, key) {
    gutterKey = key;
    const rows = [...gutter.querySelectorAll('.lane')];
    rows.forEach((r, i) => {
      const it = iss.find((x) => x.lane === i);
      const st = r.querySelector('.lst');
      if (it) { r.dataset.level = it.level; st.innerHTML = `${statusIcon(LANE_ICON[it.level], 14)}<span class="vh">${LANE_WORD[it.level]}</span>`; }
      else { delete r.dataset.level; st.innerHTML = ''; }
    });
  }

  // Oldest-first index of the k-th held sample.
  const at = (k) => (head - count + k + cap) % cap;

  function draw(nowMs, o) {
    const view = o.view || 'fit';
    if (view !== holdView) { holdView = view; holdSweep.fill(NaN); }
    const cal = view === 'norm' ? o.cal : null;
    const sw = !!plot.sweep;
    const winMs = plot.windowSec * 1000;
    const pxPerMs = (sw ? W : W * NOW_AT) / winMs;
    // Sweep: the axis restarts every window; the cursor is "now". Samples of the previous sweep
    // sit to the right of the cursor and vanish into the erase gap as it reaches them.
    const sweepStart = Math.floor(nowMs / winMs) * winMs;
    const nowX = sw ? (nowMs - sweepStart) * pxPerMs : W * NOW_AT;
    const gapX = nowX + 4 * dpr;
    lastNowX = nowX;
    const X = sw
      ? (ms) => { const p = ms - sweepStart; if (p >= 0) return p * pxPerMs; const x = (p + winMs) * pxPerMs; return x < gapX ? -1 : x; }
      : (ms) => nowX + (ms - nowMs) * pxPerMs;
    const laneH = H / Math.max(1, lanes);
    g.fillStyle = C.bg;
    g.fillRect(0, 0, W, H);

    // First sample inside the window (binary search on the ring: times are increasing).
    const from = nowMs - plot.windowSec * 1000;
    let lo = 0; let hi = count;
    while (lo < hi) { const m = (lo + hi) >> 1; if (tBuf[at(m)] < from) lo = m + 1; else hi = m; }
    const first = lo;

    // Label bands behind the traces: past runs from the samples, then the protocol ahead.
    g.font = `${12 * dpr}px system-ui, sans-serif`;
    g.textBaseline = 'top';
    let runStart = first; let runLabel = first < count ? lBuf[at(first)] : null;
    for (let k = first + 1; k <= count; k++) {
      const lab = k < count ? lBuf[at(k)] : undefined;
      if (lab === runLabel) continue;
      const isLast = k === count;
      const t0 = tBuf[at(runStart)];
      const x1 = isLast ? nowX : X(tBuf[at(k)]);
      if (sw && t0 < sweepStart) {
        // A run that crosses the wrap: the old part right of the gap, the new part from 0.
        const xa = Math.max(gapX, (t0 - sweepStart + winMs) * pxPerMs);
        const t1 = isLast ? nowMs : tBuf[at(k)];
        if (t1 < sweepStart) band(xa, (t1 - sweepStart + winMs) * pxPerMs, runLabel, null, false);
        else { band(xa, W, runLabel, null, false); band(0, x1, runLabel, null, isLast && runLabel === o.current); }
      } else band(Math.max(0, X(t0)), x1, runLabel, null, isLast && runLabel === o.current);
      runStart = k; runLabel = lab;
    }
    for (const f of sw ? [] : o.future || []) {
      const x0 = Math.max(nowX, X(f.startMs));
      const x1 = Math.min(W, X(f.endMs));
      if (x1 > x0) band(x0, x1, f.label, f.word, f.current);
    }

    // Lane dividers.
    g.fillStyle = C.line;
    for (let l = 1; l < lanes; l++) g.fillRect(0, Math.round(l * laneH), W, dpr);

    // Min/max per CSS-pixel column, every lane in one pass over the window.
    const cols = seen.length;
    seen.fill(0);
    for (let k = first; k < count; k++) {
      const i = at(k);
      const col = Math.floor(X(tBuf[i]) / dpr);
      if (col < 0 || col >= cols) continue;
      const o2 = i * lanes;
      if (!seen[col]) {
        seen[col] = 1;
        for (let c = 0; c < lanes; c++) { const v = vBuf[o2 + c]; mn[c * cols + col] = v; mx[c * cols + col] = v; }
      } else {
        for (let c = 0; c < lanes; c++) {
          const v = vBuf[o2 + c]; const j = c * cols + col;
          if (v < mn[j]) mn[j] = v; else if (v > mx[j]) mx[j] = v;
        }
      }
    }

    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.textBaseline = 'alphabetic';
    for (let c = 0; c < lanes; c++) {
      const top = c * laneH + 4 * dpr;
      const h = laneH - 8 * dpr;
      let vmin; let vmax;
      if (cal) { vmin = NORM_LO; vmax = NORM_HI; }
      else if (view === 'full') { vmin = 0; vmax = 1023; }
      else {
        vmin = Infinity; vmax = -Infinity;
        for (let col = 0; col < cols; col++) if (seen[col]) { const j = c * cols + col; if (mn[j] < vmin) vmin = mn[j]; if (mx[j] > vmax) vmax = mx[j]; }
        const had = Number.isFinite(vmin);
        if (!had) { vmin = 0; vmax = 1023; }
        if (vmax - vmin < FIT_MIN_SPAN) { const m = (vmax + vmin) / 2; vmin = m - FIT_MIN_SPAN / 2; vmax = m + FIT_MIN_SPAN / 2; }
        if (sw) {
          // Fix the range for the whole sweep (taken at its first frame with data) so old pixels never
          // rescale; a bigger value is clipped to the lane until the next sweep re-fits.
          if (holdSweep[c] === sweepStart) { vmin = holdMin[c]; vmax = holdMax[c]; }
          else if (had) { holdSweep[c] = sweepStart; holdMin[c] = vmin; holdMax[c] = vmax; }
        }
      }
      const rest = cal ? cal.rest[c] : 0; const sq = cal ? cal.squeeze[c] : 1;
      const Y = cal
        ? (v) => top + h - ((normalize(v, rest, sq) - vmin) / (vmax - vmin)) * h
        : (v) => top + h - ((v - vmin) / (vmax - vmin)) * h;
      // Reference lines: 0/1 after calibration, the "top" of the ADC in Full.
      // Clip to the lane: a 10x spike on one channel must not draw through its neighbours.
      g.save();
      g.beginPath(); g.rect(0, c * laneH, W, laneH); g.clip();
      if (cal) { refLine(top + h - ((0 - vmin) / (vmax - vmin)) * h, C.muted); refLine(top + h - ((1 - vmin) / (vmax - vmin)) * h, C.muted); }
      else if (view === 'full') refLine(Y(TOP), C.warn);
      g.strokeStyle = C.trace;
      g.lineWidth = 1.5 * C.tw * dpr;
      g.beginPath();
      let started = false;
      const cursorCol = Math.floor(nowX / dpr);
      let prevCol = -1;
      for (let col = 0; col < cols; col++) {
        if (!seen[col]) continue;
        const j = c * cols + col; const x = col * dpr;
        const y1 = Y(mx[j]); const y2 = Y(mn[j]);
        // Sweep: lift the pen across the erase gap so new and old sweeps are not joined.
        if (sw && prevCol >= 0 && prevCol <= cursorCol && col > cursorCol) started = false;
        if (!started) { g.moveTo(x, y1); started = true; } else g.lineTo(x, y1);
        if (y2 !== y1) g.lineTo(x, y2);
        prevCol = col;
      }
      g.stroke();
      g.restore();
      // Axis numbers at the left edge (spec puts them at the gutter's edge; same place, cheaper).
      g.fillStyle = C.muted;
      g.font = `${11 * dpr}px ui-monospace, monospace`;
      const fmt = (v) => (cal ? v.toFixed(1) : String(Math.round(v)));
      g.fillText(fmt(vmax), 4 * dpr, top + 11 * dpr);
      g.fillText(fmt(vmin), 4 * dpr, top + h);
    }

    // Markers: dashed muted line with the note at the top.
    g.setLineDash([3 * dpr, 3 * dpr]);
    g.strokeStyle = C.muted;
    g.lineWidth = dpr;
    g.fillStyle = C.muted;
    g.font = `${11 * dpr}px system-ui, sans-serif`;
    for (const m of o.markers || []) {
      const x = X(m.ms);
      if (x < 0 || (!sw && x > nowX)) continue;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
      g.fillText(m.note, x + 3 * dpr, 12 * dpr);
    }
    g.setLineDash([]);

    // Lane markers from the quality strip.
    const iss = o.issues || [];
    const key = iss.map((i) => `${i.lane}:${i.level}`).join(',');
    if (key !== gutterKey) paintGutter(iss, key);
    g.font = `bold ${13 * dpr}px system-ui, sans-serif`;
    for (const it of iss) {
      if (it.lane >= lanes) continue;
      const col = it.level === 'red' ? C.bad : C.warn;
      const y0 = (it.lane + 1) * laneH;
      const xi = X(it.ms);
      g.fillStyle = col;
      g.globalAlpha = 0.6;
      const uy = Math.round(y0 - 2 * dpr);
      if (sw && xi > nowX) { g.fillRect(xi, uy, W - xi, 2 * dpr); g.fillRect(0, uy, nowX, 2 * dpr); }
      else { const ux = Math.max(0, xi); if (nowX > ux) g.fillRect(ux, uy, nowX - ux, 2 * dpr); }
      g.globalAlpha = 1;
      const x = Math.max(4 * dpr, Math.min(sw ? W - 14 * dpr : nowX - 14 * dpr, xi < 0 ? 0 : xi));
      g.fillText(it.level === 'red' ? '✕' : '▲', x, Math.round(it.lane * laneH + 16 * dpr));
    }

    // The now line: accent, full height, "now" at the bottom.
    g.fillStyle = C.accent;
    g.fillRect(Math.round(nowX - dpr), 0, 2 * dpr, H);
    g.font = `${12 * dpr}px system-ui, sans-serif`;
    g.fillText('now', nowX + 4 * dpr, H - 4 * dpr);

    function band(x0, x1, label, word, current) {
      if (label == null || x1 <= x0) return;
      const kind = labelKind(label);
      if (current && kind !== 'none') g.fillStyle = C.weak;
      else if (kind === 'act') g.fillStyle = C.band;
      else if (kind === 'arm') g.fillStyle = hatch;
      else return;
      g.fillRect(x0, 0, x1 - x0, H);
      if (word && x1 - x0 >= MIN_BAND_LABEL_PX * dpr) { g.fillStyle = C.muted; g.fillText(word, x0 + 4 * dpr, 4 * dpr); }
    }
    function refLine(y, colour) {
      g.save();
      g.setLineDash([4 * dpr, 4 * dpr]);
      g.strokeStyle = colour;
      g.lineWidth = dpr;
      g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
      g.restore();
    }
  }

  return plot;
}

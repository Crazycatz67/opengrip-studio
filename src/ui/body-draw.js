// body-draw.js: the Body view drawing (spec docs/design/body-view-spec.md §5.1-5.3, §8-11, §16).
// Draws where each sensor sits (band ring, arm map, or a table) and lights it with the live level,
// the placement check (good / weak / not here) and the Doctor's pins. Drawing only: no logic about
// what a level means, no storage, no state outside the host element (one shared <style> aside).
//
// Contract
//   createBodyView(host, { placement, names?, lens?: 'ring'|'arm'|'table', smoothMs?: 200, calm?: false })
//   createBodyView(host, { …, fill?: false, lensHost?: Element, lensTabs?: true })
//     -> { update(levels), setChecks(checks), setPins(items), setLens(lens), fit(), destroy(), root }
//   fill: the view takes the host's height (host must be a sized flex/grid child) and the ring or
//     arm is drawn as large as fits both ways, so nothing is cut in a short rail (review-2 B1/B2).
//     The tag and the convention then share one line under the drawing.
//   lensTabs: false hides the Ring/Arm/Table buttons (the Fit sheet's side-by-side pair shows
//     both lenses at once, so per-pane tabs were duplicates). The lens stays opts.lens.
//   lensHost: put the Ring/Arm/Table buttons there (e.g. the rail's own title row) instead of in
//     the view's header; destroy() removes them too.
//   Table lens: a host under 420 px wide gets 4 columns (Ch · Place · Now · Doctor) that wrap,
//     so Now and Doctor are never cut off (review-2 M5).
//   placement: the §7 model ({ arm: 'L'|'R', channels: [{ ch (1-based), sensor: 'FMG'|'EMG'|…,
//     site, ringAngleDeg 0-359 | null, cmFromElbowCrease | null }] }). ringAngleDeg is anatomical:
//     0 palm middle, 90 thumb side, 180 back middle, 270 little-finger side, the same on either arm.
//   names: optional channel names by index (names[ch-1], e.g. 'A0'), shown in the table.
//   levels / checks: an array indexed ch-1, or an object keyed by ch. A level is 0-1 (clamped);
//     null or missing = no level (drawn hollow and dashed, "no level" in words).
//   checks entry: { state: 'good'|'weak'|'bad', reason?, fix? }; anything else clears that sensor.
//   items: Doctor items ({ level: 'red'|'amber'|'green', channel: 0-based index | null, message, fix },
//     or with ch: 1-based). Worst red/amber item per sensor becomes a ▲/✕ pin; green is ignored.
//   Only the shown lens does drawing work; the table text refreshes at most at 2 Hz.
//   fit(): recompute text scaling after the host's size changed (a ResizeObserver also calls it).
//   destroy(): removes everything this view added to the host and stops its observer.
// Failure behaviour: no placed sensors -> the "Places not set" card; unplaced sensors -> a chip
//   row under the drawing and "not placed" table rows; unknown checks/items/levels are ignored.

const NS = 'http://www.w3.org/2000/svg';
const DEG = Math.PI / 180;
const RAMP = [[0x27, 0x34, 0x49], [0x0e, 0x74, 0x90], [0x38, 0xbd, 0xf8], [0xe0, 0xf2, 0xfe]];

// Words moved to words.js (card B4); re-exported so body.html and older imports keep working.
import { BODY_WORDS } from './words.js';
export { BODY_WORDS };
// Plain names for the two forearm bones, shown unless body[data-mode="advanced"] (read at mount,
// like review.js/fit.js). Kept here, not in words.js, because that file is owned by another card;
// the spec's §6 word list has no entry for them. Advanced keeps the anatomy terms.
export const BONE_WORDS_SIMPLE = { radius: 'thumb bone', ulna: 'little-finger bone' };
const boneWords = () => (typeof document !== 'undefined' && document.body && document.body.dataset.mode === 'advanced'
  ? { radius: BODY_WORDS.radius, ulna: BODY_WORDS.ulna } : BONE_WORDS_SIMPLE);
const OCTANT = ['Palm middle', 'Palm, thumb side', 'Thumb edge', 'Back, thumb side', 'Back middle', 'Back, little-finger side', 'Little-finger edge', 'Palm, little-finger side'];
const GLYPH = { good: '✓', weak: '▲', bad: '✕' };

const CSS = `
.bd-root { --bd-skin: #22304a; --bd-skin-edge: var(--edge, #64748b); --bd-bone: rgb(148 163 184 / .16); --bd-sw: 1;
  position: relative; display: flex; flex-direction: column; gap: 8px; min-width: 0; max-width: 100%; box-sizing: border-box;
  color: var(--fg, #f8fafc); font: 14px var(--sans, system-ui, sans-serif); }
:root.hc .bd-root, :root[data-contrast="high"] .bd-root, .bd-root.hc { --bd-skin: #1a2436; --bd-skin-edge: #cbd5e1; --bd-sw: 1.6; }
.bd-root * { box-sizing: border-box; }
.bd-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
.bd-lens[hidden] { display: none; }
.bd-lens { display: inline-flex; border: 1px solid var(--line, #334155); border-radius: 8px; overflow: hidden; }
.bd-lens button { font: 14px var(--sans, sans-serif); color: var(--fg, #f8fafc); background: transparent; border: 0; padding: 6px 12px; cursor: pointer; min-height: 32px; }
.bd-lens button[aria-pressed="true"] { background: var(--accent-weak, rgb(56 189 248 / .14)); color: var(--accent, #38bdf8); font-weight: 600; }
.bd-tag, .bd-conv, .bd-legend, .bd-chips { font-size: 13px; color: var(--muted, #94a3b8); }
.bd-legend, .bd-chips { display: flex; flex-wrap: wrap; gap: 4px 12px; margin: 0; padding: 0; list-style: none; }
.bd-chips span { border: 1px solid var(--line, #334155); border-radius: 999px; padding: 1px 8px; }
.bd-card { border: 1px dashed var(--edge, #64748b); border-radius: 10px; padding: 12px; font-size: 14px; }
.bd-card b { display: block; margin-bottom: 4px; }
.bd-svg { display: block; width: 100%; height: auto; margin: 0 auto; overflow: hidden; }
.bd-ring { max-width: 380px; } .bd-arm { max-width: 440px; }
.bd-svg text { fill: var(--muted, #94a3b8); font-family: var(--sans, sans-serif); font-size: calc(13px * var(--bd-k, 1)); }
.bd-svg text.bd-strong { fill: var(--fg, #f8fafc); font-weight: 600; font-size: calc(14px * var(--bd-k, 1)); }
.bd-skin { fill: var(--bd-skin); stroke: var(--bd-skin-edge); stroke-width: var(--bd-sw); }
.bd-bone { fill: var(--bd-bone); }
.bd-band { fill: none; stroke: var(--line, #334155); stroke-width: 6; }
.bd-crease { stroke: var(--muted, #94a3b8); stroke-dasharray: 2 3; fill: none; }
.bd-edge { stroke: var(--edge, #64748b); stroke-width: var(--bd-sw); }
.bd-off { fill: none !important; stroke-dasharray: 3 3; }
.bd-halo { fill: none; stroke: var(--accent, #38bdf8); }
.bd-glow { fill: var(--accent, #38bdf8); }
.bd-chk { fill: none; stroke-width: calc(3px * var(--bd-sw)); }
.bd-chk.good { stroke: var(--good, #22c55e); } .bd-chk.weak { stroke: var(--warn, #f59e0b); } .bd-chk.bad { stroke: var(--bad, #f87171); animation: bd-pulse 1.6s ease-in-out infinite; }
.bd-svg text .good { fill: var(--good, #22c55e); } .bd-svg text .weak { fill: var(--warn, #f59e0b); } .bd-svg text .bad { fill: var(--bad, #f87171); }
@keyframes bd-pulse { 50% { opacity: .5; } }
@media (prefers-reduced-motion: reduce) { .bd-chk.bad { animation: none; } }
.bd-calm .bd-chk.bad { animation: none; }
.bd-pin circle { fill: var(--bg, #0f172a); stroke-width: 2; }
.bd-pin.red circle { stroke: var(--bad, #f87171); } .bd-pin.amber circle { stroke: var(--warn, #f59e0b); }
.bd-pin.red text { fill: var(--bad, #f87171); } .bd-pin.amber text { fill: var(--warn, #f59e0b); }
.bd-focus { fill: none; stroke: transparent; stroke-width: 2; }
.bd-hit { cursor: pointer; outline: none; }
.bd-hit:focus-visible .bd-focus, .bd-hit:hover .bd-focus { stroke: var(--accent, #38bdf8); }
.bd-tip { position: absolute; z-index: 5; max-width: min(320px, 100%); padding: 8px 10px; border-radius: 8px; font-size: 13px;
  background: var(--panel, #1e293b); border: 1px solid var(--edge, #64748b); box-shadow: 0 4px 16px rgb(0 0 0 / .4); pointer-events: none; }
.bd-tip b { display: block; color: var(--fg, #f8fafc); } .bd-tip div { margin-top: 2px; }
.bd-fill { flex: 1 1 0; min-height: 0; }
.bd-fill .bd-stage { flex: 1 1 0; min-height: 72px; position: relative; overflow: auto; }
.bd-fill .bd-stage > svg.bd-svg { position: absolute; inset: 0; width: 100%; height: 100%; max-width: none; }
.bd-fill .bd-conv { line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bd-table.bd-narrow th, .bd-table.bd-narrow td { white-space: normal; overflow-wrap: anywhere; }
.bd-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.bd-tablewrap { max-width: 100%; overflow-x: auto; }
.bd-table caption { text-align: left; color: var(--muted, #94a3b8); padding-bottom: 4px; }
.bd-table th, .bd-table td { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--line, #334155); white-space: nowrap; }
.bd-meter { display: inline-block; width: 40px; height: 6px; margin-left: 6px; vertical-align: middle; background: var(--line, #334155); border-radius: 3px; overflow: hidden; }
.bd-meter i { display: block; height: 100%; background: var(--accent, #38bdf8); }
`;

function injectStyle(doc) {
  if (doc.getElementById('bd-style')) return;
  const s = doc.createElement('style'); s.id = 'bd-style'; s.textContent = CSS; doc.head.appendChild(s);
}
function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
function html(tag, cls, parent, text) {
  const e = document.createElement(tag); if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}
function svgText(parent, x, y, s, strong, anchor = 'middle') {
  const t = el('text', { x: x.toFixed(1), y: y.toFixed(1), 'text-anchor': anchor }, parent);
  if (strong) t.setAttribute('class', 'bd-strong');
  t.textContent = s; return t;
}
export function liveColour(v) {
  v = Math.max(0, Math.min(1, v)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(v)), f = v - i;
  const c = RAMP[i].map((x, k) => Math.round(x + (RAMP[i + 1][k] - x) * f));
  return `rgb(${c[0]} ${c[1]} ${c[2]})`;
}
const placed = (c) => Number.isFinite(c.ringAngleDeg) && Number.isFinite(c.cmFromElbowCrease);
const pick = (src, ch) => (src == null ? undefined : Array.isArray(src) ? src[ch - 1] : src[ch]);
const octant = (a) => OCTANT[Math.round((((a % 360) + 360) % 360) / 45) % 8];
const siteOf = (c) => c.site || octant(c.ringAngleDeg);

export function createBodyView(host, opts = {}) {
  injectStyle(host.ownerDocument);
  const P = opts.placement || { arm: 'R', channels: [] };
  const W = BODY_WORDS;
  const thumbX = P.arm === 'L' ? 1 : -1; // seen from the elbow, palm down: right thumb on the left
  const chans = (P.channels || []).slice().sort((a, b) => a.ch - b.ch);
  const isPlaced = chans.filter(placed);
  // Tab order = ring order starting at sensor 1 (spec §9), so a keyboard walk goes round the arm.
  const start = (isPlaced.find((c) => c.ch === 1) || isPlaced[0] || {}).ringAngleDeg || 0;
  const ringOrder = isPlaced.slice().sort((a, b) => ((a.ringAngleDeg - start + 360) % 360) - ((b.ringAngleDeg - start + 360) % 360) || a.ch - b.ch);
  const smoothMs = opts.smoothMs ?? 200;
  const reduced = () => !!opts.calm || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);

  let lens = ['ring', 'arm', 'table'].includes(opts.lens) ? opts.lens : 'ring';
  let levels = {}, disp = {}, lastT = 0, checks = {}, pins = {}, tableAt = -1e9;

  const fill = !!opts.fill;
  const root = html('div', 'bd-root', host);
  if (opts.calm) root.classList.add('bd-calm');
  if (fill) root.classList.add('bd-fill');
  const head = html('div', 'bd-head', root);
  const lensBox = html('div', 'bd-lens', opts.lensHost || head); lensBox.setAttribute('role', 'group'); lensBox.setAttribute('aria-label', W.lensLabel);
  if (opts.lensTabs === false) lensBox.hidden = true;
  const lensBtns = {};
  for (const k of ['ring', 'arm', 'table']) {
    const b = html('button', '', lensBox, W.lens[k]); b.type = 'button'; b.dataset.lens = k;
    b.addEventListener('click', () => api.setLens(k)); lensBtns[k] = b;
  }
  // Fill mode: tag + convention make one line under the drawing (saves ~50 px in a short rail).
  const tagText = isPlaced.length ? W.entered : W.enteredNone;
  if (!fill) html('span', 'bd-tag', head, tagText);
  head.hidden = !head.childElementCount;
  const conv = fill ? null : html('div', 'bd-conv', root);
  const stage = html('div', 'bd-stage', root);
  const under = fill ? html('div', 'bd-conv', root) : conv;
  const chips = html('div', 'bd-chips', root);
  const legend = html('ul', 'bd-legend', root);
  for (const s of W.legend) html('li', '', legend, s);
  const tip = html('div', 'bd-tip', root); tip.setAttribute('role', 'tooltip'); tip.hidden = true;

  const unplaced = chans.filter((c) => !placed(c));
  if (unplaced.length && isPlaced.length) {
    html('span', '', chips, `${W.notPlaced}:`).style.border = '0';
    for (const c of unplaced) html('span', '', chips, String(c.ch));
  }

  // ---------- words shared by aria labels, tooltips and the table ----------
  const levelWord = (ch) => (Number.isFinite(disp[ch]) ? disp[ch].toFixed(2) : W.noLevel);
  const checkWord = (ch) => { const k = checks[ch]; return k ? W.check[k.state] : ''; };
  function sensorLabel(c) {
    const where = placed(c) ? `${siteOf(c).toLowerCase()}, ${c.cmFromElbowCrease.toFixed(1)} cm below the elbow crease` : 'not placed';
    const k = checks[c.ch];
    return `Sensor ${c.ch}, ${c.sensor}, ${where}, level ${levelWord(c.ch)}${k ? `, ${W.check[k.state]}${k.reason ? `: ${k.reason}` : ''}` : ''}`;
  }
  function pinLabel(c) { const d = pins[c.ch]; return `Sensor ${c.ch}: ${W.pin[d.level]}. ${d.message || ''} ${W.fixPrefix}${d.fix || ''}`.trim(); }
  function showTip(node, c, pinFirst) {
    tip.replaceChildren();
    html('b', '', tip, `Sensor ${c.ch} · ${c.sensor}`);
    if (placed(c)) html('div', '', tip, `${siteOf(c)} · ${c.cmFromElbowCrease.toFixed(1)} cm below the crease · ${c.ringAngleDeg}°`);
    html('div', '', tip, `Now ${levelWord(c.ch)} (0–1)`);
    const k = checks[c.ch];
    if (k) { html('div', '', tip, `${W.check[k.state]}${k.reason ? ` · ${k.reason}` : ''}`); if (k.fix && !pinFirst) html('div', '', tip, W.fixPrefix + k.fix); }
    const d = pins[c.ch];
    if (d) { html('div', '', tip, `${W.pin[d.level]} · ${d.message || ''}`); if (d.fix) html('div', '', tip, W.fixPrefix + d.fix); }
    tip.hidden = false;
    const r = node.getBoundingClientRect(), h = root.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    // Clamp inside the host so a tooltip never makes the rail scroll sideways at 375 px.
    let x = r.right - h.left + 8; if (x + tw > h.width) x = Math.max(0, r.left - h.left - tw - 8);
    if (x + tw > h.width) x = Math.max(0, h.width - tw);
    const y = Math.max(0, Math.min(r.top - h.top, root.scrollHeight - th));
    tip.style.left = `${x}px`; tip.style.top = `${y}px`;
  }
  const hideTip = () => { tip.hidden = true; };
  function hook(node, c, pinFirst) {
    node.addEventListener('mouseenter', () => showTip(node, c, pinFirst));
    node.addEventListener('focus', () => showTip(node, c, pinFirst));
    node.addEventListener('mouseleave', hideTip); node.addEventListener('blur', hideTip);
  }
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });

  // ---------- ring lens ----------
  const ringXY = (a, r) => [thumbX * Math.sin(a * DEG) * r * 1.1, Math.cos(a * DEG) * r * 0.92];
  const nFmg = isPlaced.filter((c) => c.sensor !== 'EMG').length;
  const half = Math.min(26, 300 / Math.max(1, nFmg)) / 2;
  function addCheckGlyph(t, ch) {
    const k = checks[ch]; if (!k || !GLYPH[k.state]) return;
    const s = el('tspan', { class: k.state, dx: 2 }, t); s.textContent = GLYPH[k.state];
  }
  function drawRing() {
    // viewBox wider than the mock (±192) so pins, glyphs and the side words never touch.
    const svg = el('svg', { class: 'bd-svg bd-ring', viewBox: '-192 -176 384 360', role: 'group',
      'aria-label': `Band ring, ${W.arm[P.arm === 'L' ? 'L' : 'R'].toLowerCase()}, ${W.convention.toLowerCase()}` });
    const deco = el('g', { 'aria-hidden': 'true' }, svg);
    svgText(deco, 0, -156, W.back, true); svgText(deco, 0, 170, W.palm, true);
    const side = (x, s) => { const t = svgText(deco, x, 0, s, true); t.setAttribute('transform', `rotate(${x < 0 ? -90 : 90} ${x} 0)`); t.dataset.side = s === W.thumb ? 'thumb' : 'little'; };
    side(thumbX * 174, W.thumb); side(-thumbX * 174, W.little);
    el('ellipse', { class: 'bd-skin', rx: 82 * 1.1, ry: 82 * 0.92 }, deco);
    const [bx, by] = ringXY(80, 40), [ux, uy] = ringXY(280, 40);
    el('ellipse', { class: 'bd-bone', cx: bx, cy: by, rx: 15, ry: 10 }, deco); el('ellipse', { class: 'bd-bone', cx: ux, cy: uy, rx: 11, ry: 11 }, deco);
    const bw = boneWords(); svgText(deco, bx, by + 4, bw.radius); svgText(deco, ux, uy + 4, bw.ulna);
    el('ellipse', { class: 'bd-band', rx: 90 * 1.1, ry: 90 * 0.92 }, deco);
    const nodes = {};
    const p = (a, r) => ringXY(a, r).map((v) => v.toFixed(1)).join(' ');
    const quad = (a0, a1, r0, r1) => `M${p(a0, r0)} L${p(a0, r1)} L${p(a1, r1)} L${p(a1, r0)} Z`;
    for (const c of ringOrder) {
      const a = c.ringAngleDeg;
      const g = el('g', { class: 'bd-hit', tabindex: 0, role: 'button', 'data-ch': c.ch, 'data-kind': c.sensor === 'EMG' ? 'emg' : 'fmg' }, svg);
      const k = checks[c.ch];
      if (c.sensor !== 'EMG') {
        if (k) el('path', { class: `bd-chk ${k.state}`, d: quad(a - half - 2, a + half + 2, 88, 122) }, g);
        const wedge = el('path', { class: 'bd-edge' }, g);
        el('path', { class: 'bd-focus', d: quad(a - half - 4, a + half + 4, 86, 124) }, g);
        const [lx, ly] = ringXY(a, 136);
        const t = svgText(g, lx, ly + 5, String(c.ch), true); t.setAttribute('class', 'bd-strong bd-num'); addCheckGlyph(t, c.ch);
        nodes[c.ch] = { kind: 'fmg', g, wedge, a };
      } else {
        const [x, y] = ringXY(a, 70);
        const halo = el('circle', { class: 'bd-halo', cx: x, cy: y, r: 10, 'stroke-width': 0 }, g);
        if (k) el('rect', { class: `bd-chk ${k.state}`, x: x - 13, y: y - 13, width: 26, height: 26, rx: 4 }, g);
        const box = el('rect', { class: 'bd-box', x: x - 9, y: y - 9, width: 18, height: 18, rx: 2, fill: 'var(--panel, #1e293b)', stroke: 'var(--fg, #f8fafc)', 'stroke-width': 1.5 }, g);
        el('circle', { cx: x - 3.5, cy: y, r: 2.2, fill: 'var(--fg, #f8fafc)' }, g); el('circle', { cx: x + 3.5, cy: y, r: 2.2, fill: 'var(--fg, #f8fafc)' }, g);
        el('rect', { class: 'bd-focus', x: x - 16, y: y - 16, width: 32, height: 32, rx: 5 }, g);
        // Mock fault: the number sat on top of the halo. Put it towards the centre, clear of the
        // largest halo (r 20 + stroke 3) and of a check glyph beside it.
        const d = Math.hypot(x, y) || 1, L = 40;
        const t = svgText(g, x - (x / d) * L, y - (y / d) * L + 5, String(c.ch), true); t.setAttribute('class', 'bd-strong bd-num'); addCheckGlyph(t, c.ch);
        nodes[c.ch] = { kind: 'emg', g, halo, box };
      }
      g.setAttribute('aria-label', sensorLabel(c)); hook(g, c, false);
    }
    for (const c of ringOrder) {
      const d = pins[c.ch]; if (!d) continue;
      const [x, y] = ringXY(c.ringAngleDeg + 20, 132); // outside the check glow (r 122)
      const pin = el('g', { class: `bd-hit bd-pin ${d.level}`, tabindex: 0, role: 'button', 'data-pin': c.ch, 'aria-label': pinLabel(c) }, svg);
      el('circle', { cx: x, cy: y, r: 11 }, pin);
      el('circle', { class: 'bd-focus', cx: x, cy: y, r: 14 }, pin);
      svgText(pin, x, y + 5, d.level === 'red' ? '✕' : '▲', true).setAttribute('class', 'bd-strong');
      hook(pin, c, true);
    }
    return { svg, nodes, upd() {
      const calm = reduced();
      for (const ch in nodes) {
        const n = nodes[ch], v = disp[ch], on = Number.isFinite(v);
        if (n.kind === 'fmg') {
          n.wedge.setAttribute('d', quad(n.a - half, n.a + half, 92, 97 + (on ? v * 22 : 0)));
          n.wedge.setAttribute('fill', on ? liveColour(v) : 'none'); n.wedge.classList.toggle('bd-off', !on);
        } else {
          n.halo.setAttribute('r', (10 + (on ? v : 0) * 10).toFixed(1));
          n.halo.setAttribute('stroke-width', on && !calm ? (1 + v * 5).toFixed(1) : 0);
          n.halo.setAttribute('stroke', liveColour(Math.max(0.35, on ? v : 0)));
          n.box.classList.toggle('bd-off', !on);
        }
      }
    } };
  }

  // ---------- arm lens ----------
  const PX = 8.5, LEN = 26, AW = 300, AH = 340, elbowY = 290;
  const hw = (cm) => (cm < 6 ? 36 - cm * 0.1 : cm < 10 ? 35.4 - (cm - 6) * 0.4 : 33.8 - (cm - 10) * 0.7);
  function drawArm() {
    const svg = el('svg', { class: 'bd-svg bd-arm', viewBox: `0 0 ${AW} ${AH}`, role: 'group',
      'aria-label': `Arm map, ${W.arm[P.arm === 'L' ? 'L' : 'R'].toLowerCase()}, palm side and back` });
    const deco = el('g', { 'aria-hidden': 'true' }, svg);
    const faces = [{ name: 'palm', cx: 82, title: W.palm }, { name: 'back', cx: 218, title: W.back }];
    const nodes = {};
    const seen = new Set(), focusable = [];
    for (const f of faces) {
      // Palm up, a right arm's thumb is on the right; palm down, on the left.
      const ts = (f.name === 'palm' ? 1 : -1) * (P.arm === 'L' ? -1 : 1);
      let d = ''; for (let cm = 0; cm <= LEN; cm++) d += `${cm ? 'L' : 'M'}${(f.cx - hw(cm)).toFixed(1)} ${elbowY - cm * PX}`;
      for (let cm = LEN; cm >= 0; cm--) d += `L${(f.cx + hw(cm)).toFixed(1)} ${elbowY - cm * PX}`;
      el('path', { class: 'bd-skin', d: d + 'Z' }, deco);
      const wy = elbowY - LEN * PX, hx = hw(LEN);
      el('path', { d: `M${f.cx - hx} ${wy} Q${f.cx - hx - 2} ${wy - 34} ${f.cx} ${wy - 38} Q${f.cx + hx + 2} ${wy - 34} ${f.cx + hx} ${wy} Z`, fill: 'none', stroke: 'var(--bd-skin-edge)', 'stroke-dasharray': '4 3' }, deco);
      const tx = f.cx + ts * (hx + 4);
      el('path', { d: `M${f.cx + ts * hx} ${wy - 4} Q${tx + ts * 10} ${wy - 14} ${tx + ts * 6} ${wy - 26}`, fill: 'none', stroke: 'var(--bd-skin-edge)', 'stroke-width': 2 }, deco);
      // Mock fault: the two "thumb" words met between the faces. Each sits above its own thumb tip.
      const tw = svgText(deco, f.cx + ts * (hx + 10), wy - 44, W.thumbWord); tw.dataset.face = f.name; tw.dataset.thumb = '1';
      svgText(deco, f.cx, AH - 6, f.title, true);
      el('line', { class: 'bd-crease', x1: f.cx - 44, x2: f.cx + 44, y1: elbowY, y2: elbowY }, deco);
      const dots = [];
      for (const c of ringOrder) {
        const a = c.ringAngleDeg, s = Math.sin(a * DEG), cosA = Math.cos(a * DEG);
        const onPalm = cosA > -0.05, onBack = cosA < 0.05; // within ~3° of an edge: on both faces
        if ((f.name === 'palm' && !onPalm) || (f.name === 'back' && !onBack)) continue;
        dots.push({ c, x: f.cx + ts * s * hw(c.cmFromElbowCrease) * 0.9, y: elbowY - c.cmFromElbowCrease * PX });
      }
      // Spec fix (mock showed "878"): a one-height ring puts dots ~9 px apart. Each number takes the
      // first free spot of above / below / right / left, clear of every dot and placed number.
      const taken = dots.map((q) => ({ l: q.x - 9, r: q.x + 9, t: q.y - 9, b: q.y + 9 }));
      for (const q of dots.slice().sort((p, o) => p.x - o.x || p.y - o.y)) {
        const w = 9 * (String(q.c.ch).length + (checks[q.c.ch] ? 1.4 : 0)) + 2, h = 15;
        const spots = [[0, -13, 'middle'], [0, 24, 'middle'], [13, 5, 'start'], [-13, 5, 'end'], [0, -28, 'middle'], [0, 39, 'middle']];
        const boxOf = ([dx, dy, an]) => { const x0 = q.x + dx - (an === 'middle' ? w / 2 : an === 'end' ? w : 0); return { l: x0, r: x0 + w, t: q.y + dy - h + 3, b: q.y + dy + 3 }; };
        const hit = (B) => taken.some((T) => B.l < T.r && T.l < B.r && B.t < T.b && T.t < B.b);
        q.spot = spots.find((sp) => !hit(boxOf(sp))) || spots[0];
        taken.push(boxOf(q.spot));
      }
      for (const q of dots) {
        const { c, x, y } = q;
        const first = !seen.has(c.ch); seen.add(c.ch);
        const g = el('g', { class: 'bd-hit', tabindex: first ? 0 : -1, role: 'button', 'data-ch': c.ch, 'data-face': f.name }, svg);
        const glow = el('circle', { class: 'bd-glow', cx: x, cy: y, r: 10, opacity: 0 }, g);
        const k = checks[c.ch];
        if (k) el('circle', { class: `bd-chk ${k.state}`, cx: x, cy: y, r: 10 }, g);
        const dot = c.sensor === 'EMG' ? el('rect', { x: x - 7, y: y - 7, width: 14, height: 14, rx: 2, stroke: 'var(--fg, #f8fafc)', 'stroke-width': 1.5 }, g)
          : el('circle', { class: 'bd-edge', cx: x, cy: y, r: 7 }, g);
        el('circle', { class: 'bd-focus', cx: x, cy: y, r: 13 }, g);
        const t = svgText(g, x + q.spot[0], y + q.spot[1], String(c.ch), true, q.spot[2]); t.setAttribute('class', 'bd-strong bd-num'); addCheckGlyph(t, c.ch);
        g.setAttribute('aria-label', sensorLabel(c)); if (first) hook(g, c, false);
        (nodes[c.ch] = nodes[c.ch] || []).push({ glow, dot });
        if (first) focusable.push(g);
      }
    }
    // Faces are drawn one after the other; re-append so Tab still goes round the ring from sensor 1.
    const rank = (g) => ringOrder.findIndex((c) => c.ch === +g.dataset.ch);
    for (const g of focusable.sort((p, q) => rank(p) - rank(q))) svg.appendChild(g);
    for (let cm = 0; cm <= 24; cm += 2) { const y = elbowY - cm * PX; el('line', { x1: 30, x2: cm % 4 ? 36 : 40, y1: y, y2: y, stroke: 'var(--muted, #94a3b8)' }, deco); if (cm % 4 === 0) svgText(deco, 26, y + 4, String(cm), false, 'end'); }
    svgText(deco, 26, elbowY + 18, W.cm, false, 'end');
    svgText(deco, 150, elbowY + 18, W.crease);
    return { svg, nodes, upd() {
      const calm = reduced();
      for (const ch in nodes) for (const n of nodes[ch]) {
        const v = disp[ch], on = Number.isFinite(v);
        n.dot.setAttribute('fill', on ? liveColour(v) : 'none'); n.dot.classList.toggle('bd-off', !on);
        n.glow.setAttribute('opacity', on && !calm ? (v * 0.35).toFixed(2) : 0); n.glow.setAttribute('r', (8 + (on ? v : 0) * 10).toFixed(1));
      }
    } };
  }

  // ---------- table lens (the text alternative) ----------
  function drawTable() {
    const wrap = html('div', 'bd-tablewrap');
    const t = html('table', 'bd-table', wrap);
    narrow = isNarrow(); t.classList.toggle('bd-narrow', narrow);
    html('caption', '', t, W.caption);
    const hr = html('tr', '', html('thead', '', t));
    for (const c of narrow ? W.colsShort : W.cols) html('th', '', hr, c).scope = 'col';
    const body = html('tbody', '', t);
    const cells = {};
    for (const c of chans) {
      const tr = html('tr', '', body); tr.dataset.ch = c.ch;
      const nm = opts.names && opts.names[c.ch - 1];
      html('th', '', tr, nm ? `${c.ch} (${nm})` : String(c.ch)).scope = 'row';
      const doctor = () => { const d = pins[c.ch]; return d ? `${W.pin[d.level]} · ${d.fix || d.message || ''}` : '—'; };
      const checkLine = checkWord(c.ch) + (checks[c.ch]?.reason ? ` · ${checks[c.ch].reason}` : '');
      if (narrow) {
        // Same values as the wide table, folded: type, place, angle and depth in one cell; the
        // check joins the Doctor cell.
        html('td', '', tr, [c.sensor || '—', ...(placed(c) ? [siteOf(c), `${c.ringAngleDeg}°`, `${c.cmFromElbowCrease.toFixed(1)} cm`] : ['not placed'])].join(' · '));
        const now = html('td', '', tr); const num = html('span', '', now); const bar = html('i', '', html('span', 'bd-meter', now));
        html('td', '', tr, [checkLine, doctor()].filter((x) => x && x !== '—').join(' · ') || '—');
        cells[c.ch] = { num, bar };
        continue;
      }
      html('td', '', tr, c.sensor || '—');
      html('td', '', tr, placed(c) ? siteOf(c) : 'not placed');
      html('td', '', tr, placed(c) ? `${c.ringAngleDeg}°` : '—');
      html('td', '', tr, placed(c) ? `${c.cmFromElbowCrease.toFixed(1)} cm` : '—');
      const now = html('td', '', tr); const num = html('span', '', now); const bar = html('i', '', html('span', 'bd-meter', now));
      html('td', '', tr, checkLine);
      html('td', '', tr, doctor());
      cells[c.ch] = { num, bar };
    }
    return { svg: wrap, upd() {
      for (const ch in cells) { const v = disp[ch]; cells[ch].num.textContent = levelWord(ch); cells[ch].bar.style.width = `${Number.isFinite(v) ? Math.round(v * 100) : 0}%`; }
    } };
  }

  // ---------- render / fit ----------
  let view = null, narrow = false;
  const NARROW_PX = 420;
  const isNarrow = () => { const w = host.clientWidth; return w > 0 && w < NARROW_PX; };
  function render() {
    hideTip(); stage.replaceChildren();
    for (const k in lensBtns) lensBtns[k].setAttribute('aria-pressed', String(k === lens));
    const convText = `${lens === 'arm' ? W.armConvention : W.convention} · ${W.arm[P.arm === 'L' ? 'L' : 'R']}`;
    under.textContent = fill ? `${tagText} · ${convText}` : convText;
    if (fill) under.title = under.textContent; // one line in fill mode; the full words on hover
    legend.hidden = lens === 'table';
    if (!isPlaced.length && lens !== 'table') {
      const card = html('div', 'bd-card', stage); html('b', '', card, W.notSetTitle); html('span', '', card, W.notSetBody);
      view = null; return;
    }
    view = lens === 'ring' ? drawRing() : lens === 'arm' ? drawArm() : drawTable();
    stage.appendChild(view.svg); tableAt = -1e9; view.upd(); fit();
  }
  // SVG text scales with the viewBox; when the drawing renders narrower than its viewBox the text
  // is scaled back up so it never drops under 13 px on screen (spec §4). In fill mode the drawing
  // is letterboxed (meet) inside the stage, so the scale is set by the tighter of width and height.
  function fit() {
    for (const svg of stage.querySelectorAll('svg.bd-svg')) {
      const vb = svg.viewBox.baseVal, r = svg.getBoundingClientRect();
      const k = r.width > 0 ? Math.max(1, vb.width / r.width, fill && r.height > 0 ? vb.height / r.height : 0) : 1;
      svg.style.setProperty('--bd-k', k.toFixed(3));
    }
  }
  // Re-render the table only when the host crosses the narrow width; otherwise just rescale text.
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (lens === 'table' && view && isNarrow() !== narrow) render(); else fit(); }) : null;
  if (ro) ro.observe(root);

  function relabel() {
    if (!view || lens === 'table') return;
    for (const g of stage.querySelectorAll('[data-ch]')) { const c = chans.find((x) => x.ch === +g.dataset.ch); if (c) g.setAttribute('aria-label', sensorLabel(c)); }
  }

  const api = {
    root,
    update(next) {
      const now = performance.now(), dt = lastT ? now - lastT : Infinity; lastT = now;
      // 200 ms display envelope stops noise flicker; first frame snaps, calm motion never eases.
      const k = reduced() || !smoothMs || !Number.isFinite(dt) ? 1 : 1 - Math.exp(-dt / smoothMs);
      for (const c of chans) {
        const raw = pick(next, c.ch);
        const v = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : null;
        levels[c.ch] = v;
        disp[c.ch] = v == null ? null : Number.isFinite(disp[c.ch]) ? disp[c.ch] + (v - disp[c.ch]) * k : v;
      }
      if (!view) return;
      if (lens === 'table') { if (now - tableAt < 500) return; tableAt = now; }
      view.upd();
      if (lens !== 'table' && now - tableAt >= 500) { tableAt = now; relabel(); }
    },
    setChecks(next) {
      checks = {};
      for (const c of chans) { const k = pick(next, c.ch); if (k && GLYPH[k.state]) checks[c.ch] = { state: k.state, reason: k.reason || '', fix: k.fix || '' }; }
      render();
    },
    setPins(items) {
      pins = {};
      for (const it of items || []) {
        if (!it || (it.level !== 'red' && it.level !== 'amber')) continue;
        const ch = Number.isFinite(it.ch) ? it.ch : Number.isFinite(it.channel) ? it.channel + 1 : null;
        if (ch == null || !chans.some((c) => c.ch === ch)) continue;
        if (!pins[ch] || (pins[ch].level === 'amber' && it.level === 'red')) pins[ch] = { level: it.level, message: it.message || '', fix: it.fix || '' };
      }
      render();
    },
    setLens(next) { if (['ring', 'arm', 'table'].includes(next) && next !== lens) { lens = next; render(); } },
    fit,
    destroy() { if (ro) ro.disconnect(); if (opts.lensHost) lensBox.remove(); root.remove(); view = null; },
  };
  render();
  return api;
}

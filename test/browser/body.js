// Browser test for the Body view drawing (src/ui/body-draw.js): made-up placement, levels, checks
// and Doctor items only; no hardware, no sound.
// Result: document.title 'PASS'|'FAIL' and window.__gate = { done, pass, results }.
// Run: GATE_PAGES=body npm run gate:browser (once 'body' is in the gate list), or open /test/browser/body.html.
import { createBodyView, BODY_WORDS } from '../../src/ui/body-draw.js';

const logEl = document.getElementById('log');
const results = [];
window.__gate = { done: false, pass: false, results };
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail) });
  logEl.textContent += `${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  (${detail})` : ''}\n`;
}

// 8 FSRs evenly round the band 8 cm below the crease (one height: the arm-map crowding case),
// EMG 9 on the flexors and 10 on the extensors, 5 cm below.
function placement(arm, fmg = 8) {
  const channels = [];
  for (let i = 0; i < fmg; i++) channels.push({ ch: i + 1, sensor: 'FMG', site: null, ringAngleDeg: Math.round((i * 360) / fmg), cmFromElbowCrease: 8, arm });
  channels.push({ ch: fmg + 1, sensor: 'EMG', site: 'Flexors', ringAngleDeg: 20, cmFromElbowCrease: 5, arm });
  channels.push({ ch: fmg + 2, sensor: 'EMG', site: 'Extensors', ringAngleDeg: 200, cmFromElbowCrease: 5, arm });
  return { v: 1, arm, entered_by: 'user', method: 'ring', channels };
}
const LEVELS = [0.9, 0.5, 0.1, 0, 0.3, 0.7, 1, 0.2, 1, 0.21];
const CHECKS = { 1: { state: 'good', reason: 'rises with a fist' }, 3: { state: 'weak', reason: 'rises faintly', fix: 'Tighten the band a notch.' }, 6: { state: 'bad', reason: 'reacts to the elbow', fix: 'Move it nearer the wrist.' }, 9: { state: 'good', reason: 'flexors rise with a fist' } };
const ITEMS = [
  { level: 'red', channel: 5, code: 'dropout', message: 'Keeps dropping to 0 (14 times)', fix: 'Sensor 6 keeps dropping to 0: push the plug and wire in firmly.' },
  { level: 'amber', channel: 3, code: 'saturation', message: 'Hits the top of the range', fix: 'Loosen the band a little.' },
  { level: 'green', channel: 1, code: 'crosstalk', message: 'possible', fix: '' },
];
const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const ctr = (r) => [(r.left + r.right) / 2, (r.top + r.bottom) / 2];
const overlap = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

function overflow(root) {
  const R = root.getBoundingClientRect(); const bad = [];
  for (const e of root.querySelectorAll('*')) {
    if (!visible(e) || e.closest('.bd-tablewrap td, .bd-tablewrap th, .bd-tablewrap caption, .bd-tablewrap tr, .bd-tablewrap table')) continue;
    const r = e.getBoundingClientRect();
    if (r.left < R.left - 1 || r.right > R.right + 1) bad.push(`${e.tagName}.${e.getAttribute('class') || ''}${e.textContent.slice(0, 12)}`);
    const svg = e.ownerSVGElement;
    if (svg) { const S = svg.getBoundingClientRect(); if (r.left < S.left - 1 || r.right > S.right + 1 || r.top < S.top - 1 || r.bottom > S.bottom + 1) bad.push(`clip:${e.tagName} ${e.textContent.slice(0, 12)}`); }
  }
  if (root.scrollWidth > root.clientWidth + 1) bad.push(`root scroll ${root.scrollWidth}>${root.clientWidth}`);
  return bad;
}
function smallText(root) {
  const bad = [];
  for (const e of root.querySelectorAll('*')) {
    if (!visible(e) || ![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    let px = parseFloat(getComputedStyle(e).fontSize);
    const svg = e.ownerSVGElement;
    if (svg) px *= svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
    if (px < 12.95) bad.push(`${e.textContent.trim().slice(0, 10)}=${px.toFixed(1)}`);
  }
  return bad;
}

(async () => {
  const box = document.getElementById('box');
  try {
    // --- thumb side mirrored, L vs R ---
    const side = {};
    for (const arm of ['R', 'L']) {
      box.style.width = '600px';
      const v = createBodyView(box, { placement: placement(arm), lens: 'ring', smoothMs: 0 });
      v.update(LEVELS); await frame();
      const svg = box.querySelector('svg.bd-ring'); const S = ctr(svg.getBoundingClientRect())[0];
      const thumb = ctr(svg.querySelector('[data-side="thumb"]').getBoundingClientRect())[0];
      const s3 = ctr(svg.querySelector('[data-ch="3"]').getBoundingClientRect())[0];
      v.setLens('arm'); await frame();
      const palmThumb = box.querySelector('[data-thumb][data-face="palm"]'); const palmCx = 82;
      side[arm] = { thumbLeft: thumb < S, s3Left: s3 < S, palmThumbRight: +palmThumb.getAttribute('x') > palmCx };
      v.destroy();
      check(`${arm}: host empty after destroy`, box.children.length === 0, box.children.length);
    }
    check('right arm ring: thumb side and sensor 3 (90°) on the left', side.R.thumbLeft && side.R.s3Left, JSON.stringify(side.R));
    check('left arm ring: thumb side and sensor 3 on the right', !side.L.thumbLeft && !side.L.s3Left, JSON.stringify(side.L));
    check('arm map palm face: right thumb right, left thumb left', side.R.palmThumbRight && !side.L.palmThumbRight);

    // --- full view: words, focus order, table, pins, checks ---
    box.style.width = '600px';
    const v = createBodyView(box, { placement: placement('R'), names: ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'E0', 'E1'], lens: 'ring', smoothMs: 0 });
    v.update(LEVELS); v.setChecks(CHECKS); v.setPins(ITEMS); v.update(LEVELS); await frame();
    const root = v.root;
    check('"✎ Places entered by you" shown', root.textContent.includes(BODY_WORDS.entered));
    check('convention printed', root.querySelector('.bd-conv').textContent.startsWith('Seen from the elbow, palm down'));
    const tabs = [...root.querySelectorAll('button, [tabindex="0"]')].filter(visible);
    const kinds = tabs.map((e) => (e.tagName === 'BUTTON' ? 'lens' : e.dataset.pin ? 'pin' : 'sensor'));
    const firstPin = kinds.indexOf('pin');
    check('focus order: lens buttons, then sensors, then pins', kinds.slice(0, 3).join() === 'lens,lens,lens' && kinds.lastIndexOf('sensor') < firstPin, kinds.join(','));
    const order = tabs.filter((e) => e.dataset.ch && !e.dataset.pin).map((e) => +e.dataset.ch);
    check('sensors in ring order from sensor 1', order.join() === '1,9,2,3,4,5,10,6,7,8', order.join());
    const l6 = root.querySelector('svg [data-ch="6"]').getAttribute('aria-label');
    check('aria label: name, level, state', /^Sensor 6, FMG, back, little-finger side, 8\.0 cm below the elbow crease, level 0\.70, Fix ✕: reacts to the elbow$/.test(l6), l6);
    check('every sensor has an aria label', [...root.querySelectorAll('svg [data-ch]')].every((g) => /^Sensor \d+, (FMG|EMG), .*level /.test(g.getAttribute('aria-label'))));
    const glyphs = [...root.querySelectorAll('tspan')].map((t) => `${t.parentNode.textContent}:${t.getAttribute('class')}`);
    check('check glyph beside each checked sensor', glyphs.sort().join() === '1✓:good,3▲:weak,6✕:bad,9✓:good', glyphs.join());
    check('check glow drawn for 4 sensors', root.querySelectorAll('.bd-chk').length === 4);
    check('legend has the three state words', ['Working ✓', 'Check ▲', 'Fix ✕'].every((w) => root.querySelector('.bd-legend').textContent.includes(w)));
    const pins = [...root.querySelectorAll('[data-pin]')];
    check('one pin per red/amber sensor, green ignored', pins.map((p) => `${p.dataset.pin}${p.textContent}`).sort().join() === '4▲,6✕', pins.map((p) => p.dataset.pin + p.textContent).join());
    const pin6 = root.querySelector('[data-pin="6"]'); pin6.focus(); await frame();
    const tip = root.querySelector('.bd-tip');
    check('pin focus shows the fix', !tip.hidden && tip.textContent.includes('How to fix: Sensor 6 keeps dropping to 0'), tip.textContent.slice(0, 80));
    check('tooltip stays inside the host', tip.getBoundingClientRect().right <= root.getBoundingClientRect().right + 1);
    pin6.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    check('Esc hides the tooltip', tip.hidden);
    pin6.blur();

    // EMG 9 label clear of its marker even at full level (mock fault).
    const g9 = root.querySelector('svg.bd-ring [data-ch="9"]');
    const n9 = g9.querySelector('.bd-num').getBoundingClientRect();
    const hits = [...g9.querySelectorAll('circle.bd-halo, rect:not(.bd-focus)')].filter((e) => overlap(n9, e.getBoundingClientRect()));
    check('label "9" does not overlap its EMG marker or halo at level 1', hits.length === 0, hits.length);

    // Live glow: wedge length follows the level; no level draws hollow.
    const wedge = () => root.querySelector('svg.bd-ring [data-ch="2"] path.bd-edge');
    const len = () => { const b = wedge().getBBox(); return Math.hypot(b.width, b.height); };
    v.update([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]); const l0 = len();
    v.update([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]); const l1 = len();
    check('FSR wedge grows with level', l1 > l0 + 10, `${l0.toFixed(1)} -> ${l1.toFixed(1)}`);
    check('EMG halo thickens with level', +root.querySelector('svg.bd-ring [data-ch="9"] .bd-halo').getAttribute('stroke-width') >= 5.9);
    v.update([null, 1, 1, 1, 1, 1, 1, 1, null, 1]);
    check('no level: hollow and dashed', wedge() && root.querySelector('svg.bd-ring [data-ch="1"] path.bd-edge').classList.contains('bd-off') && root.querySelector('svg.bd-ring [data-ch="9"] .bd-box').classList.contains('bd-off'));
    v.update(LEVELS);

    // Overflow + text size at 375 and 1440, every lens.
    for (const w of [375, 1440]) for (const lens of ['ring', 'arm', 'table']) {
      box.style.width = `${w}px`; v.setLens(lens); await frame(); v.fit();
      const of = overflow(root), st = smallText(root);
      check(`${lens} at ${w}: nothing clips`, of.length === 0, of.slice(0, 4).join(' | '));
      check(`${lens} at ${w}: text >= 13 px`, st.length === 0, st.slice(0, 4).join(' | '));
    }
    box.style.width = '600px';

    // Arm map: one-height ring labels must not crowd (spec §5.2 fix); thumb words apart.
    v.setLens('arm'); await frame();
    for (const face of ['palm', 'back']) {
      const nums = [...root.querySelectorAll(`svg.bd-arm [data-face="${face}"] .bd-num`)].map((t) => [t.textContent, t.getBoundingClientRect()]);
      const clash = [];
      for (let i = 0; i < nums.length; i++) for (let j = i + 1; j < nums.length; j++) if (overlap(nums[i][1], nums[j][1])) clash.push(`${nums[i][0]}/${nums[j][0]}`);
      check(`arm ${face}: sensor numbers do not overlap`, nums.length >= 5 && clash.length === 0, `${nums.length} labels; ${clash.join(' ')}`);
    }
    const tw = [...root.querySelectorAll('[data-thumb]')].map((t) => t.getBoundingClientRect());
    check('arm: the two "thumb" words apart', tw.length === 2 && !overlap(tw[0], tw[1]));
    const armOrder = [...root.querySelectorAll('svg.bd-arm [tabindex="0"]')].map((g) => g.dataset.ch).join();
    check('arm: each sensor focusable once, in ring order', armOrder === '1,9,2,3,4,5,10,6,7,8', armOrder);

    // Table = the text alternative: one row per channel, words not colour.
    v.setLens('table'); await frame();
    const rows = [...root.querySelectorAll('.bd-table tbody tr')];
    check('table has N rows', rows.length === 10, rows.length);
    check('table caption + header', root.querySelector('.bd-table caption') && root.querySelectorAll('.bd-table thead th').length === 8);
    const r6 = root.querySelector('.bd-table tr[data-ch="6"]').textContent;
    check('table row 6: place, check word, doctor fix', /Back, little-finger side/.test(r6) && r6.includes('Fix ✕ · reacts to the elbow') && r6.includes('✕ Fix'), r6.slice(0, 120));
    check('table names the channel', root.querySelector('.bd-table tr[data-ch="9"] th').textContent === '9 (E0)');
    check('lens buttons pressed state', root.querySelector('[data-lens="table"]').getAttribute('aria-pressed') === 'true');

    // High contrast + calm motion.
    v.setLens('ring'); await frame();
    document.documentElement.classList.add('hc');
    check('.hc on the root swaps the skin colour', getComputedStyle(root).getPropertyValue('--bd-skin').trim() === '#1a2436');
    document.documentElement.classList.remove('hc');
    const rm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    check('bad glow pulses unless reduced motion', getComputedStyle(root.querySelector('.bd-chk.bad')).animationName === (rm ? 'none' : 'bd-pulse'), rm ? 'reduced' : 'motion');
    check('reduced-motion rule present', [...document.getElementById('bd-style').sheet.cssRules].some((r) => r.media && /reduced-motion/.test(r.media.mediaText)));
    v.destroy();
    const calm = createBodyView(box, { placement: placement('R'), calm: true, smoothMs: 0 });
    calm.setChecks(CHECKS); calm.update(LEVELS);
    check('calm: no pulse, no halo', getComputedStyle(calm.root.querySelector('.bd-chk.bad')).animationName === 'none' && +calm.root.querySelector('[data-ch="9"] .bd-halo').getAttribute('stroke-width') === 0);
    calm.destroy();

    // No places, some places.
    const none = createBodyView(box, { placement: { arm: 'R', channels: [{ ch: 1, sensor: 'FMG', ringAngleDeg: null, cmFromElbowCrease: null }] } });
    check('no places: card + "none yet"', /Places not set/.test(none.root.textContent) && none.root.textContent.includes(BODY_WORDS.enteredNone));
    none.destroy();
    const some = placement('R'); some.channels[3] = { ...some.channels[3], ringAngleDeg: null, cmFromElbowCrease: null };
    const sv = createBodyView(box, { placement: some });
    check('some placed: "Not placed" chip row', /Not placed:\s*4/.test(sv.root.querySelector('.bd-chips').textContent), sv.root.querySelector('.bd-chips').textContent);
    sv.destroy();

    // Simple mode: no anatomy words in the drawings (site names are the user's own data, not checked).
    const ANAT = /\b(radius|ulna|ulnar|radial|flexor|extensor|dorsal|volar|palmar|proximal|distal)\b/i;
    const prevMode = document.body.dataset.mode;
    document.body.dataset.mode = 'simple';
    for (const lens of ['ring', 'arm']) {
      const sv2 = createBodyView(box, { placement: placement('R'), lens, smoothMs: 0 });
      const words = [...sv2.root.querySelectorAll('svg text')].map((t) => t.textContent).join(' | ');
      check(`simple ${lens}: no anatomy terms`, !ANAT.test(words), (words.match(ANAT) || [''])[0]);
      sv2.destroy();
    }
    document.body.dataset.mode = 'advanced';
    const av = createBodyView(box, { placement: placement('R'), lens: 'ring', smoothMs: 0 });
    check('advanced ring: keeps radius / ulna', /radius/.test(av.root.textContent) && /ulna/.test(av.root.textContent));
    av.destroy();
    if (prevMode === undefined) delete document.body.dataset.mode; else document.body.dataset.mode = prevMode;

    // Cost: 16 FSRs + 2 EMG, smoothing on, ring lens.
    const big = createBodyView(box, { placement: placement('R', 16) });
    const lv = new Array(18).fill(0); const n = 400; const t0 = performance.now();
    for (let i = 0; i < n; i++) { for (let k = 0; k < 18; k++) lv[k] = (Math.sin(i / 7 + k) + 1) / 2; big.update(lv); }
    const ms = (performance.now() - t0) / n;
    check('update cost <= 1 ms for 18 sensors', ms <= 1, `${ms.toFixed(3)} ms`);
    big.destroy();
  } catch (e) {
    check('no exception', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' / ') : e);
  }
  const pass = results.length > 0 && results.every((r) => r.ok);
  window.__gate = { done: true, pass, results };
  document.title = pass ? 'PASS' : 'FAIL';
  const s = document.getElementById('summary');
  s.textContent = `${pass ? 'PASS' : 'FAIL'}: ${results.filter((r) => r.ok).length}/${results.length}`;
  s.className = pass ? 'pass' : 'fail';
})();

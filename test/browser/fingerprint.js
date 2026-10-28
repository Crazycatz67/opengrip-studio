// Browser test for the Review Body card (src/ui/fingerprint-view.js): twin sessions only (synthetic),
// no hardware, no sound. Result: document.title 'PASS'|'FAIL' and window.__gate = { done, pass, results }.
// Run: GATE_PAGES=/test/browser/fingerprint.html npm run gate:browser, or open /test/browser/fingerprint.html.
import { mountBodyCard, FP_WORDS } from '../../src/ui/fingerprint-view.js';
import { generate } from '../../src/sim/twin.js';
import { ringPreset } from '../../src/placement.js';

const logEl = document.getElementById('log');
const results = [];
window.__gate = { done: false, pass: false, results };
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail) });
  logEl.textContent += `${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  (${detail})` : ''}\n`;
}
const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const join = (a, b) => ({ ...a, data: a.data.map((d, c) => d.concat(b.data[c])), labels: a.labels.concat(b.labels), t: a.t.concat(b.t) });
// Same recipe as test/fingerprint.test.js: a ring at cm from the crease, grip (down + elbow 90) then open.
function twin(cm, extra = {}) {
  const placement = ringPreset({ count: 6, cmFromElbowCrease: cm, emg: [{ muscle: 'flexors' }, { muscle: 'extensors' }] });
  const g = generate({ seed: 1, channels: 8, gesture: 'grip', placement, positions: ['down', 'elbow90'], faults: ['dropout'] });
  const o = generate({ seed: 11, channels: 8, gesture: 'open', placement, calibration: false, distractors: 0 });
  return { rec: { ...join(g, o), meta: { synthetic: true } }, placement, ...extra };
}
function overflow(root) {
  const R = root.getBoundingClientRect(); const bad = [];
  for (const e of root.querySelectorAll('*')) {
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height || e.closest('.fp-scroll')) continue;
    if (r.left < R.left - 1 || r.right > R.right + 1) bad.push(`${e.tagName}.${e.getAttribute('class') || ''}`);
  }
  if (root.scrollWidth > root.clientWidth + 1) bad.push(`root scroll ${root.scrollWidth}>${root.clientWidth}`);
  return bad;
}

async function run() {
  const box = document.getElementById('box');
  const errors = [];
  addEventListener('error', (e) => errors.push(String(e.message)));
  for (const [name, cm, want] of [['near (3 cm)', 3, true], ['far (8 cm)', 8, false]]) {
    const { rec, placement } = twin(cm);
    const card = mountBodyCard(box, rec, { placement });
    await frame();
    const root = card.root, fp = card.fp;
    const rings = root.querySelectorAll('.fp-cell[data-key]').length;
    const slots = root.querySelectorAll('.fp-cell').length;
    check(`${name}: one small ring per recorded gesture x position`, rings === fp.cells.length && rings === 4 && root.querySelectorAll('.fp-cell[data-key] svg').length === rings, `${rings} rings, ${fp.cells.length} cells`);
    check(`${name}: grid has 3 columns per gesture, gaps say "not recorded"`, slots === fp.gestures.length * 3 && root.querySelectorAll('.fp-none').length === slots - rings
      && [...root.querySelectorAll('.fp-none')].every((e) => e.textContent === FP_WORDS.notRecorded), `${slots} slots`);
    const line = root.querySelector('.fp-line[data-a="grip@down"][data-b="elbow_bend@down"], .fp-line[data-b="grip@down"][data-a="elbow_bend@down"]');
    check(`${name}: grip vs elbow bend look-alike line ${want ? 'present' : 'absent'}`, want ? !!line && /looks \d+% like ELBOW BEND/.test(line.textContent) : !line && !!root.querySelector('.fp-ok'),
      line ? line.textContent : root.querySelector('.fp-alike').textContent);
    const trs = root.querySelectorAll('.fp-table tbody tr');
    check(`${name}: table has one row per cell with every channel`, trs.length === fp.cells.length && [...trs].every((tr) => tr.children.length === 3 + 8), `${trs.length} rows`);
    check(`${name}: synthetic labelled, wording "on this recording"`, !!root.querySelector('.fp-synth') && /on this recording/.test(root.textContent));
    check(`${name}: Doctor pin on the main ring`, root.querySelectorAll('.fp-main .bd-pin').length >= 1, root.querySelectorAll('.fp-main .bd-pin').length);
    for (const w of [375, 1440]) {
      box.style.width = `${w}px`; await frame();
      const bad = overflow(root);
      check(`${name}: no overflow at ${w}`, !bad.length, bad.slice(0, 4).join(' '));
      if (w !== 375) continue;
      // Review-2 M4: cells carry no drawn text, grid text is >= 13 px, and nothing in the grid overlaps.
      const grid = root.querySelector('.fp-grid');
      const cells = [...grid.querySelectorAll('.fp-cell[data-key]')];
      check(`${name}: M4 no text in the cell rings, svg aria-hidden, cell aria-label has numbers`, !root.querySelector('.fp-cell svg text')
        && cells.every((c) => c.getAttribute('role') === 'img' && /sensor 1 [\d.-]/.test(c.getAttribute('aria-label') || '') && c.querySelector('svg')?.getAttribute('aria-hidden') === 'true'), cells.length);
      const sizes = [...grid.querySelectorAll('*')].filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())).map((e) => parseFloat(getComputedStyle(e).fontSize));
      check(`${name}: M4 smallest grid text >= 13 px at 375`, sizes.length > 0 && Math.min(...sizes) >= 13, `min ${Math.min(...sizes)} px over ${sizes.length}`);
      const boxes = [...grid.children].map((e) => e.getBoundingClientRect()).filter((b) => b.width && b.height);
      let hits = 0;
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) hits++;
      }
      check(`${name}: M4 no overlapping grid boxes at 375`, hits === 0 && boxes.length > 8, `${hits} overlaps of ${boxes.length}`);
      check(`${name}: M4 table alternative kept`, !!root.querySelector('details.fp-table table'));
    }
    box.style.width = '';
    card.destroy();
    check(`${name}: destroy removes the card`, !box.querySelector('#rv-body'));
  }
  // No places: stand-in ring, and the card says so.
  const { rec } = twin(3);
  const card = mountBodyCard(box, { ...rec, placement: null }, { placement: null });
  check('no places: "places not set" note', card.root.textContent.includes(FP_WORDS.placesNotSet));
  card.destroy();
  check('no page errors', !errors.length, errors.join('; '));
}

run().catch((e) => check('page ran', false, e.stack || e)).finally(() => {
  const pass = results.length > 0 && results.every((r) => r.ok);
  Object.assign(window.__gate, { done: true, pass });
  const s = document.getElementById('summary');
  s.textContent = `${pass ? 'PASS' : 'FAIL'}: ${results.filter((r) => r.ok).length}/${results.length}`;
  s.className = pass ? 'pass' : 'fail';
  document.title = pass ? 'PASS' : 'FAIL';
});

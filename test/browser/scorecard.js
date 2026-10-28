// Browser test for the Design Scorecard screen: twin data only, no hardware, no sound.
// Result: document.title 'PASS'|'FAIL' and window.__gate = { done, pass, results }.
// Run: GATE_PAGES=scorecard npm run gate:browser, or open /test/browser/scorecard.html.
import { generate, rng } from '../../src/sim/twin.js';
import { mountScorecard } from '../../src/ui/scorecard.js';

const logEl = document.getElementById('log');
const results = [];
window.__gate = { done: false, pass: false, results };
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail) });
  logEl.textContent += `${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  (${detail})` : ''}\n`;
}

const BASE = { channels: 4, reps: 8, distractors: 3 };
const clean = generate({ ...BASE, seed: 3 });
const worse = generate({ ...BASE, seed: 4, faults: ['dropout:6', { type: 'shift', channel: 0 }] });
const r = rng(100);
worse.data = worse.data.map((v) => v.map((x) => (x === 0 ? 0 : Math.max(1, Math.min(1023, Math.round(x + r.normal(0, 6)))))));

(async () => {
  const t0 = performance.now();
  const box = document.getElementById('box');
  const saved = []; const said = [];
  try {
    const ui = mountScorecard(box, { a: clean, b: worse, names: ['Spandex', 'Nylon'], say: (s) => said.push(s), download: (n, t) => saved.push({ n, t }) });
    const rows = [...box.querySelectorAll('#sc-rows tr')];
    check('one row per metric', rows.length === 9, rows.length);
    check('one style tag injected', document.querySelectorAll('#sc-style').length === 1);
    const v = (k) => box.querySelector(`#sc-rows tr[data-key="${k}"]`);
    for (const k of ['srr', 'restNoise', 'dropouts', 'drift']) check(`${k}: Spandex wins`, v(k)?.dataset.verdict === 'A' && /Spandex better/.test(v(k).textContent), v(k)?.dataset.verdict);
    check('every row has a dot-and-interval chart', rows.every((tr) => tr.querySelector('svg.sc-ci')));
    check('never colour alone: every chip has words', rows.every((tr) => /better|No clear difference|Not measurable/.test(tr.querySelector('.sc-chip').textContent)));
    const fair = [...box.querySelectorAll('#sc-fair li')].map((li) => li.dataset.code);
    check('fairness warnings at the top, synthetic first', fair[0] === 'synthetic' && fair.includes('order'), fair.join(','));
    check('warnings come before the table', box.querySelector('.sc-warn').compareDocumentPosition(box.querySelector('.sc-table')) & Node.DOCUMENT_POSITION_FOLLOWING);
    check('overall verdict names the winner', /Spandex came out ahead overall/.test(box.querySelector('#sc-overall').textContent), box.querySelector('#sc-overall').textContent.slice(0, 90));
    check('weights shown', /Signal-to-rest ratio 3/.test(box.querySelector('#sc-weights').textContent));
    check('columns named by the user', box.querySelector('#sc-col-a').textContent === 'A: Spandex' && box.querySelector('#sc-col-b').textContent === 'B: Nylon');

    // Keyboard: every control is a native, focusable element.
    const ctrls = [...box.querySelectorAll('input, select, button')];
    check('controls are focusable', ctrls.length === 4 && ctrls.every((el) => { el.focus(); return document.activeElement === el; }));

    const sel = box.querySelector('#sc-view');
    sel.value = '1'; sel.dispatchEvent(new Event('change'));
    check('channel view ch1: drift on the slid band', box.querySelector('#sc-rows tr[data-key="drift"]').dataset.verdict === 'A' && /ch1/.test(box.querySelector('#sc-cap').textContent));
    check('view change announced', said.some((s) => /^Showing ch1/.test(s)));

    const na = box.querySelector('#sc-name-a');
    na.value = 'Flat FSR'; na.dispatchEvent(new Event('change'));
    check('rename updates sentences', /Flat FSR/.test(box.querySelector('#sc-overall').textContent) && box.querySelector('#sc-col-a').textContent === 'A: Flat FSR');
    check('view kept after rename', box.querySelector('#sc-view').value === '1');

    box.querySelector('#sc-export').click();
    const json = saved.find((s) => s.n.endsWith('.json')); const html = saved.find((s) => s.n.endsWith('.html'));
    let parsed = null; try { parsed = JSON.parse(json.t); } catch { /* checked below */ }
    check('export JSON', parsed && parsed.names[0] === 'Flat FSR' && json.n === 'scorecard_Flat-FSR_vs_Nylon.json', json && json.n);
    check('export printable HTML', html && /^<!doctype html>/.test(html.t) && /Design scorecard: Flat FSR vs Nylon/.test(html.t));
    check('export announced', said.some((s) => /^Saved scorecard_/.test(s)));
    ui.destroy();
    check('destroy empties the box', box.innerHTML === '');

    // A against a copy of itself: nothing to declare.
    const same = mountScorecard(box, { a: clean, b: structuredClone(clean), names: ['Spandex', 'Spandex again'] });
    const verdicts = [...box.querySelectorAll('#sc-rows tr')].map((tr) => tr.dataset.verdict);
    check('copy: no clear difference on every row', verdicts.length === 9 && verdicts.every((x) => x === 'none'), verdicts.join(','));
    check('copy: overall no clear difference', /No clear overall difference/.test(box.querySelector('#sc-overall').textContent));
    // Narrow screen: the table scrolls inside its frame instead of widening the page.
    box.style.width = '360px';
    check('narrow: page does not scroll sideways', document.documentElement.scrollWidth <= window.innerWidth + 1, `${document.documentElement.scrollWidth} vs ${window.innerWidth}`);
    box.style.width = '';
    same.destroy();

    // Pooled: two clean sessions against two noisy ones; counts and small-sample label on screen.
    const clean2 = generate({ ...BASE, seed: 11 });
    const worse2 = generate({ ...BASE, seed: 12, faults: ['dropout:6'] });
    worse2.data = worse2.data.map((v) => v.map((x) => (x === 0 ? 0 : Math.max(1, Math.min(1023, Math.round(x + r.normal(0, 6)))))));
    const pool = mountScorecard(box, { a: [clean, clean2], b: [worse, worse2], names: ['Spandex', 'Nylon'], boot: 600 });
    check('pooled: card says pooled', pool.card.pooled === true && pool.card.a.pool.recordings === 2);
    check('pooled: column shows counts', /A: Spandex2 recordings, 0 volunteers \+ 2 unknown/.test(box.querySelector('#sc-col-a').textContent), box.querySelector('#sc-col-a').textContent);
    const pf = [...box.querySelectorAll('#sc-fair li')];
    check('pooled: counts note and small-sample check listed', pf.some((li) => li.dataset.code === 'pool' && /Each recording counts equally/.test(li.textContent)) && pf.filter((li) => li.dataset.code === 'pool-small' && /Check/.test(li.textContent) && /Small sample/.test(li.textContent)).length === 2);
    check('pooled: srr goes to Spandex', box.querySelector('#sc-rows tr[data-key="srr"]').dataset.verdict === 'A');
    check('pooled: footer names 4 recordings', /these 4 recordings/.test(box.querySelector('#sc-weights').textContent));
    pool.destroy();
  } catch (e) { check('threw', false, e?.stack || e); }
  const pass = results.length > 0 && results.every((x) => x.ok);
  const s = document.getElementById('summary');
  s.textContent = `${pass ? 'PASS' : 'FAIL'}: ${results.filter((x) => x.ok).length}/${results.length} checks in ${Math.round(performance.now() - t0)} ms`;
  s.className = pass ? 'pass' : 'fail';
  Object.assign(window.__gate, { done: true, pass });
  document.title = pass ? 'PASS' : 'FAIL';
})();

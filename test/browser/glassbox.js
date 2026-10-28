// Browser test for the Glass Box view (src/ui/glassbox-view.js): twin sessions only (synthetic), no
// hardware, no sound. Result: document.title 'PASS'|'FAIL' and window.__gate = { done, pass, results }.
// Run: GATE_PAGES=/test/browser/glassbox.html npm run gate:browser, or open /test/browser/glassbox.html.
import { mountGlassBox, GB_DEFAULTS, GB_WORDS, demoRecordings } from '../../src/ui/glassbox-view.js';
import { prepare, evaluate, defaultClassOf } from '../../src/glassbox/evaluate.js';
import { H3D_WORDS } from '../../src/ui/hand3d.js';

const logEl = document.getElementById('log');
const results = [];
window.__gate = { done: false, pass: false, results };
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail) });
  logEl.textContent += `${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  (${detail})` : ''}\n`;
}
const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (v) => `${Math.round(v * 100)}%`;
function overflow(root) {
  const R = root.getBoundingClientRect(); const bad = [];
  for (const e of root.querySelectorAll('*')) {
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height || e.closest('.gb-scroll')) continue;
    if (r.left < R.left - 1 || r.right > R.right + 1) bad.push(`${e.tagName}.${e.getAttribute('class') || ''}`);
  }
  if (root.scrollWidth > root.clientWidth + 1) bad.push(`root scroll ${root.scrollWidth}>${root.clientWidth}`);
  return bad;
}
const textSizes = (root) => [...root.querySelectorAll('*')].filter((e) => e.getClientRects().length && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()))
  .map((e) => ({ e, px: parseFloat(getComputedStyle(e).fontSize) }));
// The same numbers, computed straight from the core with the view's settings.
function direct(recs, o) {
  const keep = new Set(o.classes);
  const ds = prepare(recs, { features: o.features, classOf: (l) => { const c = defaultClassOf(l ?? ''); return keep.has(c) ? c : null; } });
  return evaluate(ds, { split: { by: 'repetition', testReps: o.testReps }, vote: o.vote, channels: o.channels.length === ds.nChannels ? null : o.channels,
    lda: { shrinkage: o.shrinkage }, scope: GB_WORDS.scope, names: Object.fromEntries(o.classes.map((c) => [c, GB_WORDS.className(c)])) });
}
function sameScore(name, view, ref) {
  const r = view.result; const root = view.root;
  check(`${name}: balanced accuracy = evaluate()`, r.balancedAccuracy === ref.balancedAccuracy && root.querySelector('.gb-ba').textContent === pct(ref.balancedAccuracy),
    `${root.querySelector('.gb-ba').textContent} vs ${pct(ref.balancedAccuracy)}`);
  check(`${name}: confusion matrix = evaluate()`, JSON.stringify(r.confusion) === JSON.stringify(ref.confusion)
    && [...root.querySelectorAll('.gb-cm tbody td')].map((td) => parseInt(td.textContent, 10)).join() === ref.confusion.matrix.flat().join(), JSON.stringify(ref.confusion.matrix));
  check(`${name}: false triggers + delay = evaluate()`, JSON.stringify(r.falseTriggers) === JSON.stringify(ref.falseTriggers) && JSON.stringify(r.delay) === JSON.stringify(ref.delay)
    && root.querySelector('.gb-delay').textContent === (ref.delay.n ? `${Math.round(ref.delay.medianMs)} ms` : '—'), `${root.querySelector('.gb-ft-rest').textContent} | ${root.querySelector('.gb-ft-bend').textContent} | ${root.querySelector('.gb-delay').textContent}`);
  check(`${name}: summary lines = evaluate()`, [...root.querySelectorAll('.gb-sum li')].map((li) => li.textContent).join('\n') === ref.summary.join('\n'), ref.summary[0]);
}

async function run() {
  const box = document.getElementById('box');
  const errors = [];
  addEventListener('error', (e) => errors.push(String(e.message)));
  addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
  const said = [];

  // ---- simple mode on the twin demo ----
  const view = mountGlassBox(box, { recordings: demoRecordings(), say: (t) => said.push(t) });
  const root = view.root;
  check('simple: one primary button per step', root.querySelectorAll('.gb-primary').length === 3 && !root.querySelector('[data-grp="ch"], [data-grp="feat"], [data-ctl="vote"]'),
    `${root.querySelectorAll('.gb-primary').length} primary`);
  const cls = [...root.querySelectorAll('[data-grp="cls"]')].filter((i) => i.checked).map((i) => i.value);
  check('default gestures are open / close (grip) / rest', cls.join() === 'grip,open,rest', cls.join());
  check('Watch and Score wait for Train', root.querySelector('#gb-watch').hidden && root.querySelector('#gb-score').hidden);
  root.querySelector('[data-act="train"]').click();
  const r = view.result;
  check('Train gives a result', !!r && root.dataset.trained === 'true' && /Trained/.test(said.join(' ')), r && `nTrain ${r.nTrain}, nTest ${r.nTest}`);
  check('honest split shown', /Trained on repetitions 1, 3, 4, 6, tested on 2, 5\./.test(root.querySelector('.gb-split').textContent), root.querySelector('.gb-split').textContent);
  check('view settings are the defaults', view.opts.vote === GB_DEFAULTS.vote && view.opts.features.join() === GB_DEFAULTS.features.join() && view.opts.channels.length === 6, JSON.stringify(view.opts));

  // ---- watch it decide ----
  const words = [];
  for (let k = 0; k < 12; k++) { view.replay.step(); words.push(root.querySelector('.gb-word').textContent); }
  const s = view.replay.state;
  check('Step: decisions update with a big word', words.every((w) => /^(OPEN|CLOSE|REST)$/.test(w)) && s.i != null, words.slice(-4).join(' '));
  check('Step: truth, ✓/✕ and part shown', /^Really: (OPEN|CLOSE|REST)/.test(root.querySelector('.gb-truth').textContent) && /^[✓✕]$/.test(root.querySelector('.gb-mark').textContent) && !!root.querySelector('.gb-part').textContent,
    `${root.querySelector('.gb-truth').textContent} ${root.querySelector('.gb-mark').textContent}`);
  const probs = [...root.querySelectorAll('.gb-prob .gb-bar')];
  const psum = Object.values(s.probs).reduce((a, b) => a + b, 0);
  check('class chances: 3 bars summing to 100%', probs.length === 3 && Math.abs(psum - 1) < 1e-9, probs.map((b) => b.textContent).join(' '));
  check('feature bars: 6 sensors x 5 measures', root.querySelectorAll('.gb-feat .gb-frow').length === 6 && root.querySelectorAll('.gb-feat .gb-fbar').length === 30, root.querySelectorAll('.gb-feat .gb-fbar').length);
  check('vote shows the last 3', root.querySelectorAll('.gb-vote .gb-chip').length === 3);

  const win = root.querySelector('.gb-win').getBoundingClientRect(); const pl = root.querySelector('.gb-plot').getBoundingClientRect();
  check('window highlighted on the plot (200 ms of 5 s)', win.width > 0 && Math.abs(win.width / pl.width - 0.04) < 0.005 && !!root.querySelector('.gb-plot canvas'), `${(win.width / pl.width).toFixed(3)}`);
  const t0 = s.t;
  root.querySelector('.gb-speed').value = '4'; root.querySelector('.gb-speed').dispatchEvent(new Event('input', { bubbles: true }));
  root.querySelector('[data-act="play"]').click();
  await wait(700); // 4x at 100 Hz: about 280 samples; the check allows slow headless frames (> 70)
  const t1 = view.replay.state.t;
  root.querySelector('[data-act="play"]').click(); // pause
  await wait(200);
  const t2 = view.replay.state.t;
  check('Play at 4× moves on; Pause stops', t1 - t0 > 70 && t2 === t1 && !view.replay.state.playing && view.replay.speed === 4, `samples ${Math.round(t0)} -> ${Math.round(t1)} -> ${Math.round(t2)} in 700 ms (280 at full speed)`);
  // ---- the 3D hand beside the decision: its aria-label (canvas, or the fallback box without WebGL) names
  // the VOTED class (the word beside it, never the raw top chance) and the true gesture on every step.
  const hand = view.hand;
  const mode = hand ? await Promise.race([hand.ready, new Promise((r) => setTimeout(() => r('timeout'), 8000))]) : 'none';
  const poseOf = (c) => H3D_WORDS.pose[/^(close|grip|fist|squeeze)$/.test(c) ? 'close' : c];
  const handLabel = () => root.querySelector('.gb-dec .gb-hand .h3d-canvas, .gb-dec .gb-hand .h3d-fallback')?.getAttribute('aria-label') || root.querySelector('.gb-hand .h3d-fallback')?.textContent || '';
  const keyOf = (c) => (/^(close|grip|fist|squeeze)$/.test(c) ? 'close' : c);
  const seen = new Set(); let follows = 0, labelOff = '', agree = 0, steps = 0, rawDiffers = 0, agreeOff = '';
  for (let k = 0; k < 400; k++) {
    if (!view.replay.step()) break; const st = view.replay.state; steps++;
    const rawTop = Object.entries(st.probs).sort((a, b) => b[1] - a[1])[0][0];
    if (keyOf(rawTop) !== keyOf(st.voted)) rawDiffers++;
    const hs = hand.state(); const word = root.querySelector('.gb-word').dataset.cls;
    if (hs.top === keyOf(word) && hs.decision === keyOf(st.voted)) agree++; else if (!agreeOff) agreeOff = `step ${k}: hand ${hs.top} word ${word}`;
    if (k >= 40) continue;
    const sure = Math.round(st.probs[st.voted] * 100);
    const want = H3D_WORDS.decision(poseOf(st.voted), sure) + (st.truth ? H3D_WORDS.truth(poseOf(st.truth)) : '');
    if (handLabel() === want) { follows++; seen.add(st.voted); } else if (!labelOff) labelOff = `${handLabel()} | want ${want}`;
  }
  check('3D hand mounted beside the decision word (model or fallback)', (mode === 'model' || mode === 'fallback') && !!root.querySelector('.gb-dec .gb-hand .h3d'), `mode ${mode}`);
  check('3D hand aria-label names the voted decision and the truth on every step (40 steps)', follows === 40, labelOff || `${follows}/40, poses ${[...seen].join(',')}`);
  check('3D hand pose class = the decision word on every step, incl. steps where the raw top chance differs', agree === steps && steps >= 100 && rawDiffers > 0, agreeOff || `${agree}/${steps} agree; raw top differed from the vote on ${rawDiffers}`);
  let guard = 0;
  while (!view.replay.state.done && guard++ < 5000) view.replay.step();
  const t = view.replay.state.tally;
  check('replay reaches the end; tally of unseen parts', view.replay.state.done && t.total > 0 && /^End of the recording\. Right \d+ of \d+/.test(root.querySelector('.gb-tally').textContent), root.querySelector('.gb-tally').textContent);
  root.querySelector('[data-ctl="rec"]').value = '1'; root.querySelector('[data-ctl="rec"]').dispatchEvent(new Event('change', { bubbles: true }));
  view.replay.step();
  check('second recording replays', view.replay.rec === 1 && view.result.model && view.ds.windows[view.replay.state.i].rec === 1);

  // ---- scorecard ----
  root.querySelector('[data-act="score"]').click();
  const ref = direct(demoRecordings().map((x) => x.rec), { ...GB_DEFAULTS, channels: view.opts.channels, classes: ['grip', 'open', 'rest'] });
  sameScore('simple', view, ref);
  check('scorecard labelled offline + SYNTHETIC', /offline, this recording/i.test(root.querySelector('.gb-scope').textContent) && /SYNTHETIC/.test(root.querySelector('.gb-synth')?.textContent || ''));
  check('confusion matrix in words', /Really/.test(root.querySelector('.gb-cm thead').textContent) && /It said/.test(root.querySelector('.gb-cm thead').textContent) && root.querySelectorAll('.gb-list li').length === 3,
    root.querySelector('.gb-list').textContent.trim().replace(/\s+/g, ' '));

  // ---- layout, text size, keyboard ----
  for (const w of [375, 1440]) {
    box.style.width = `${w}px`; await frame(); await frame();
    const bad = overflow(root);
    check(`no overflow at ${w}`, !bad.length, bad.slice(0, 4).join(' '));
    const sz = textSizes(root); const small = sz.filter((x) => x.px < 13);
    check(`text >= 13 px at ${w}`, sz.length > 20 && !small.length, `min ${Math.min(...sz.map((x) => x.px))} px over ${sz.length}${small.length ? `; ${small.slice(0, 3).map((x) => x.e.className || x.e.tagName).join(' ')}` : ''}`);
  }
  box.style.width = '';
  const ctl = [...root.querySelectorAll('button, input, select')].filter((e) => e.getClientRects().length || e.type === 'file');
  const unreachable = ctl.filter((e) => { e.focus(); return document.activeElement !== e || e.tabIndex < 0; });
  check('keyboard: every control takes focus', ctl.length >= 10 && !unreachable.length, `${ctl.length} controls${unreachable.length ? `; not: ${unreachable.map((e) => e.className || e.tagName).join(' ')}` : ''}`);
  const unlabelled = ctl.filter((e) => e.tagName !== 'BUTTON' && !e.closest('label'));
  check('keyboard: every input has a label', !unlabelled.length, unlabelled.map((e) => e.className).join(' '));

  // ---- errors stay on the page ----
  root.querySelectorAll('[data-grp="cls"]').forEach((i) => { if (i.value !== 'rest') { i.checked = false; i.dispatchEvent(new Event('change', { bubbles: true })); } });
  const bad1 = view.train();
  check('one gesture: plain error, no throw', bad1 === null && !root.querySelector('.gb-err').hidden && /at least 2/.test(root.querySelector('.gb-err').textContent), root.querySelector('.gb-err').textContent);
  view.destroy();
  check('destroy removes the view', !box.children.length);
  check('destroy frees the 3D hand', view.hand === null && hand?.state().running === false, JSON.stringify(hand?.state().mode));

  // ---- advanced mode: toggles feed the same numbers ----
  const adv = mountGlassBox(box, { recordings: demoRecordings(), simple: false });
  const ar = adv.root;
  check('advanced: channel, measure, shrinkage, vote controls', ar.querySelectorAll('[data-grp="ch"]').length === 6 && ar.querySelectorAll('[data-grp="feat"]').length === 6 && !!ar.querySelector('[data-ctl="shrink"]') && !!ar.querySelector('[data-ctl="vote"]'));
  const set = (sel, v) => { const e = ar.querySelector(sel); e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); };
  set('[data-ctl="vote"]', '5'); set('[data-ctl="shrink"]', 'auto');
  for (const c of ['4', '5']) { const e = ar.querySelector(`[data-grp="ch"][value="${c}"]`); e.checked = false; e.dispatchEvent(new Event('change', { bubbles: true })); }
  ar.querySelector('[data-act="train"]').click();
  check('advanced: settings used', adv.opts.vote === 5 && adv.opts.shrinkage === 'auto' && adv.opts.channels.join() === '0,1,2,3', JSON.stringify(adv.opts));
  adv.score();
  sameScore('advanced', adv, direct(demoRecordings().map((x) => x.rec), { ...adv.opts }));
  adv.replay.step();
  check('advanced: feature bars follow the sensors used', ar.querySelectorAll('.gb-feat .gb-frow').length === 4 && ar.querySelectorAll('.gb-vote .gb-chip').length === 1);
  adv.destroy();
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

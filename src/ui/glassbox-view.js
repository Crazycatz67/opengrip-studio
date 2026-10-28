// ui/glassbox-view.js: the Glass Box screen, "watch it decide". Three steps, one button each:
// Train (pick recordings + gestures, see the honest split), Watch (replay a recording and see every
// stage: signal -> window -> feature bars -> class chances -> vote -> decision vs the truth), Score
// (src/glassbox/evaluate.js numbers in words). Logic lives in src/glassbox/*; this file only drives
// it and draws it. Self-contained: words in GB_WORDS, styles scoped to .gb- and injected once, so it
// can be wired into any screen later without touching words.js or style.css.
//
// Contract
//   mountGlassBox(host, { recordings = [], placement = null, say = () => {}, simple = true, demo = true })
//     -> view = { root, train(), replay, score(), result, ds, opts, setRecordings(list), destroy() }
//     recordings: [{ name?, recording | rec, meta? }] or bare recordings ({ data, labels, rateHz, ... }:
//       csv.js fromCSV() or sim/twin.js generate()). A recording is SYNTHETIC when rec.synthetic,
//       rec.meta.synthetic ('true' or true) or rec.meta.source === 'twin'.
//     placement: placement.js model; its channels name the plot lanes ("FMG · palm"). Optional.
//     say(text, urgent?): the app's status line (train done, errors). simple: only Train -> Watch ->
//       Score; false adds channel and feature toggles, shrinkage and vote size. demo: offer "Use demo
//       data" (twin, SYNTHETIC) when there is nothing to train on.
//     view.train() -> Result | null   same as pressing Train. null + an error line when it cannot
//       (no recordings, mixed channel counts, under 2 gestures, evaluate() refusing a split).
//     view.opts: { features, channels, vote, shrinkage, testReps, classes } of the last train; the
//       Score numbers are evaluate(prepare(recs, { features, classOf }), { split: { by: 'repetition',
//       testReps }, vote, channels, lda: { shrinkage } }) exactly (classOf keeps only `classes`).
//     view.replay: { rec, play(), pause(), step() -> window|null, restart(r?), speed, state }
//       state = { t (replay position, samples), i (window index into ds.windows), raw, voted, truth, test (unseen part), right,
//       probs: { cls: 0..1 }, tally: { right, total } (unseen windows only), done }.
//   DOM: .gb[data-simple][data-trained]; section.gb-step#gb-train / #gb-watch / #gb-score;
//     .gb-split (the split sentence); .gb-word[data-cls] (the big decision); .gb-truth; .gb-mark
//     (✓ / ✕); .gb-feat (feature bars); .gb-prob > .gb-bar[data-cls]; .gb-vote; .gb-ba (balanced %);
//     table.gb-cm; .gb-ft-rest / .gb-ft-bend / .gb-delay; ul.gb-sum (evaluator summary lines);
//     .gb-synth when any SYNTHETIC recording was used; .gb-scope always ("offline, this recording").
//     .gb-hand: hand3d.js createHand3D, made on the first replay, posed by setDecision(state.voted, { probs: state.probs }) with a ghost of
//     state.truth on every step, destroyed with the view (view.hand while it lives).
// Failure behaviour: never throws from a button; errors go to .gb-err and say(text, true).
// Not done here (on purpose): live (streamed) decisions; reduced-motion sweep for the replay plot.

import { prepare, evaluate, defaultClassOf, smoothVote } from '../glassbox/evaluate.js';
import { predictProba } from '../glassbox/lda.js';
import { FEATURES, DEFAULT_FEATURES } from '../glassbox/features.js';
import { createPlot, NOW_AT } from './plot.js';
import { fromCSV } from '../csv.js';
import { generate } from '../sim/twin.js';
import { esc } from './dom.js';
import { createHand3D } from './hand3d.js';

// The defaults the Score numbers come from (the test page calls evaluate() with these directly).
// Vote 3: one stray window no longer flips the decision, for ~100 ms more delay (twin sweep: false
// triggers while bending go from up to 167/min to 0 at vote 3 with all five features).
export const GB_DEFAULTS = { features: DEFAULT_FEATURES, vote: 3, shrinkage: 0, testReps: [2, 5], winMs: 200, stepMs: 50 };
const CLOSE_RE = /^(close|grip|fist|squeeze)$/;
const DEFAULT_CLASS_RE = /^(open|close|grip|fist|rest)$/;

export const GB_WORDS = {
  title: 'Glass Box: watch it decide',
  intro: 'Teach the computer your gestures, then watch how it decides, step by step.',
  s1: '1. Train', s2: '2. Watch it decide', s3: '3. Score',
  recordings: 'Recordings to learn from', gestures: 'Gestures to tell apart',
  channels: 'Sensors used', features: 'Signal measures', shrinkage: 'Steadying (shrinkage)', vote: 'Vote over the last',
  voteN: (k) => (k === 1 ? '1 window (no vote)' : `${k} windows`),
  addCsv: 'Add a CSV file', demo: 'Use demo data (synthetic)', train: 'Train', retrain: 'Train again',
  noRecs: 'No recordings yet. Add a CSV file or use the demo data.',
  needTwo: 'Pick at least 2 gestures.', needCh: 'Pick at least 1 sensor.', mixed: 'These recordings have different numbers of sensors; pick ones that match.',
  trained: (n) => `Trained. ${n} windows learned from.`, stale: 'Settings changed: press Train again to use them.',
  split: (tr, te) => `Trained on repetitions ${tr.join(', ')}, tested on ${te.join(', ')}. Elbow bends are never trained on, so every one is a test.`,
  splitNone: 'Not enough repetitions for an honest test: record at least 3 of each gesture.',
  replayOf: 'Recording to replay', play: 'Play', pause: 'Pause', step: 'Step', restart: 'Start again', speed: 'Speed',
  speedX: (v) => `${v}×`, signal: 'Signal (the shaded strip is the window it looks at)',
  featHead: 'What it measures in the window', probHead: 'How sure it is', voteHead: 'Vote',
  decision: 'Decision', truth: 'Really', unseen: 'Unseen part (a fair test)', seen: 'Practice part (it learned from this)',
  waiting: 'Press Play or Step.', tally: (r, n) => `Right ${r} of ${n} on unseen parts`, ended: 'End of the recording.',
  scoreBtn: 'Show the score', scope: 'Offline, this recording', synth: 'SYNTHETIC: demo data, not evidence of accuracy',
  ba: 'Balanced accuracy', chance: (p) => `chance is ${p}`,
  cmHead: 'What it said, for each real gesture', cmRow: 'Really', cmCol: 'It said',
  right: (c, p) => `${c}: right ${p} of the time`,
  ftRest: 'False gestures per minute at rest', ftBend: 'False gestures per minute while bending the elbow',
  delay: 'Median delay to the right answer', none: '—', notTested: 'not tested',
  className: (c) => (CLOSE_RE.test(c) ? 'close' : String(c).replace(/_/g, ' ')),
};
const W = GB_WORDS;
const big = (c) => W.className(c).toUpperCase();
const pct = (v) => `${Math.round(v * 100)}%`;
const isSynth = (rec) => !!rec && (rec.synthetic === true || [true, 'true'].includes(rec.meta?.synthetic) || rec.meta?.source === 'twin');

// Demo: 6 sensors, 6 repetitions of close (grip) and of open, 3 elbow bends in each. Seeds 7/8 are
// ones where the twin separates the gestures well; the badge says SYNTHETIC wherever it shows.
export function demoRecordings() {
  const o = { channels: 6, reps: 6, holdS: 2, distractors: 3 };
  return [{ name: 'Demo: close (synthetic)', rec: generate({ ...o, seed: 7, gesture: 'grip' }) },
    { name: 'Demo: open (synthetic)', rec: generate({ ...o, seed: 8, gesture: 'open' }) }];
}

function normalise(list) {
  return (list || []).map((x, i) => {
    const rec = x && x.data ? x : (x?.recording || x?.rec);
    return rec ? { name: x.name || rec.name || `Recording ${i + 1}`, rec, on: true } : null;
  }).filter(Boolean);
}
const classesIn = (items) => [...new Set(items.flatMap((it) => [...new Set(it.rec.labels)].map((l) => defaultClassOf(l ?? '')).filter(Boolean)))].sort();

export function mountGlassBox(host, { recordings = [], placement = null, say = () => {}, simple = true, demo = true } = {}) {
  injectStyles();
  const root = document.createElement('div');
  root.className = 'gb';
  root.dataset.simple = simple ? 'true' : 'false';
  host.append(root);
  let items = normalise(recordings);
  let chosen = null; let chans = null; let feats = [...GB_DEFAULTS.features];
  let vote = GB_DEFAULTS.vote; let shrinkage = GB_DEFAULTS.shrinkage;
  const view = { root, hand: null, result: null, ds: null, opts: null, train, score: showScore, setRecordings, destroy };

  root.innerHTML = `<h2 class="gb-h">${esc(W.title)}</h2><p class="gb-p">${esc(W.intro)}</p>
    <section class="gb-step" id="gb-train" aria-labelledby="gb-t1"><h3 id="gb-t1">${esc(W.s1)}</h3>
      <div class="gb-pick"></div>
      <p class="gb-err" role="alert" hidden></p>
      <div class="gb-row"><button type="button" class="gb-btn gb-primary" data-act="train">${esc(W.train)}</button></div>
      <p class="gb-split" aria-live="polite"></p></section>
    <section class="gb-step" id="gb-watch" aria-labelledby="gb-t2" hidden><h3 id="gb-t2">${esc(W.s2)}</h3>
      <div class="gb-row gb-ctl">
        <label class="gb-lab">${esc(W.replayOf)} <select class="gb-sel" data-ctl="rec"></select></label>
        <button type="button" class="gb-btn gb-primary" data-act="play">${esc(W.play)}</button>
        <button type="button" class="gb-btn" data-act="step">${esc(W.step)}</button>
        <button type="button" class="gb-btn" data-act="restart">${esc(W.restart)}</button>
        <label class="gb-lab">${esc(W.speed)} <input type="range" class="gb-speed" min="0" max="4" step="1" value="2" aria-valuetext="1×"> <span class="gb-speedv">1×</span></label>
      </div>
      <div class="gb-stage">
        <div class="gb-sig"><p class="gb-cap">${esc(W.signal)}</p><div class="gb-plotwrap"><div class="gutter gb-gut"></div><div class="gb-plot"><div class="gb-win" aria-hidden="true"></div></div></div></div>
        <div class="gb-pipe">
          <div class="gb-box"><p class="gb-cap">${esc(W.featHead)}</p><div class="gb-feat"></div></div>
          <div class="gb-box"><p class="gb-cap">${esc(W.probHead)}</p><div class="gb-prob"></div></div>
          <div class="gb-box"><p class="gb-cap">${esc(W.voteHead)}</p><div class="gb-vote"></div></div>
          <div class="gb-box gb-dec"><div class="gb-dectext"><p class="gb-cap">${esc(W.decision)}</p><p class="gb-word">…</p>
            <p class="gb-truthline"><span class="gb-truth"></span> <span class="gb-mark"></span></p><p class="gb-part"></p></div><div class="gb-hand"></div></div>
        </div>
      </div>
      <p class="gb-tally" aria-live="polite">${esc(W.waiting)}</p></section>
    <section class="gb-step" id="gb-score" aria-labelledby="gb-t3" hidden><h3 id="gb-t3">${esc(W.s3)}</h3>
      <div class="gb-row"><button type="button" class="gb-btn gb-primary" data-act="score">${esc(W.scoreBtn)}</button></div>
      <div class="gb-card" hidden></div></section>`;
  const $ = (s) => root.querySelector(s);
  const errEl = $('.gb-err');
  const fail = (t) => { errEl.textContent = t; errEl.hidden = false; say(t, true); return null; };

  // ---- Step 1: what to learn from ----
  function renderPick() {
    const all = classesIn(items);
    if (!chosen) {
      const d = all.filter((c) => DEFAULT_CLASS_RE.test(c));
      chosen = new Set(d.length >= 2 ? d : all);
    }
    const nCh = items.find((it) => it.on)?.rec.data.length || 0;
    if (!chans || chans.length !== nCh) chans = Array.from({ length: nCh }, () => true);
    const box = (grp, v, label, on) => `<label class="gb-chk"><input type="checkbox" data-grp="${grp}" value="${esc(v)}"${on ? ' checked' : ''}> ${esc(label)}</label>`;
    const synth = (it) => (isSynth(it.rec) ? ' <span class="gb-tag">SYNTHETIC</span>' : '');
    const recRows = items.map((it, i) => `<label class="gb-chk"><input type="checkbox" data-grp="rec" value="${i}"${it.on ? ' checked' : ''}> ${esc(it.name)}${synth(it)}</label>`).join('');
    const adv = simple ? '' : `
      <fieldset class="gb-fs"><legend>${esc(W.channels)}</legend>${chans.map((on, c) => box('ch', c, laneName(c), on)).join('')}</fieldset>
      <fieldset class="gb-fs"><legend>${esc(W.features)}</legend>${FEATURES.map((f) => box('feat', f, f.toUpperCase(), feats.includes(f))).join('')}</fieldset>
      <div class="gb-row"><label class="gb-lab">${esc(W.shrinkage)} <select class="gb-sel" data-ctl="shrink">${[['0', 'none'], ['auto', 'auto'], ['0.1', '0.1'], ['0.5', '0.5']].map(([v, t]) => `<option value="${v}"${String(shrinkage) === v ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
      <label class="gb-lab">${esc(W.vote)} <select class="gb-sel" data-ctl="vote">${[1, 3, 5, 7].map((k) => `<option value="${k}"${k === vote ? ' selected' : ''}>${esc(W.voteN(k))}</option>`).join('')}</select></label></div>`;
    $('.gb-pick').innerHTML = `
      <fieldset class="gb-fs"><legend>${esc(W.recordings)}</legend>${items.length ? recRows : `<p class="gb-p">${esc(W.noRecs)}</p>`}
        <div class="gb-row"><label class="gb-btn gb-file">${esc(W.addCsv)}<input type="file" accept=".csv,text/csv" multiple class="gb-csv"></label>
        ${demo && !items.some((it) => isSynth(it.rec)) ? `<button type="button" class="gb-btn" data-act="demo">${esc(W.demo)}</button>` : ''}</div></fieldset>
      <fieldset class="gb-fs"><legend>${esc(W.gestures)}</legend>${all.map((c) => box('cls', c, W.className(c) === c ? c : `${W.className(c)} (${c})`, chosen.has(c))).join('') || '—'}</fieldset>${adv}`;
  }
  function laneName(c) {
    const p = placement?.channels?.find((x) => Number(x.ch) === c + 1);
    const nm = items.find((it) => it.on)?.rec.channelNames?.[c] || `ch${c + 1}`;
    return p ? `${nm} · ${[p.sensor, p.side || p.muscle].filter(Boolean).join(' ')}` : nm;
  }
  const markStale = () => { if (view.result) { $('.gb-split').textContent = W.stale; root.dataset.stale = 'true'; } };
  root.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.classList.contains('gb-csv')) {
      for (const f of t.files) {
        try { const rec = fromCSV(await f.text()); items.push({ name: f.name, rec, on: true }); } catch (err) { fail(`${f.name}: ${err.message}`); }
      }
      chosen = null; renderPick(); markStale(); return;
    }
    const g = t.dataset.grp;
    if (g === 'rec') { items[+t.value].on = t.checked; chosen = null; renderPick(); }
    else if (g === 'cls') { if (t.checked) chosen.add(t.value); else chosen.delete(t.value); }
    else if (g === 'ch') chans[+t.value] = t.checked;
    else if (g === 'feat') feats = FEATURES.filter((f) => (f === t.value ? t.checked : feats.includes(f)));
    else if (t.dataset.ctl === 'shrink') shrinkage = t.value === 'auto' ? 'auto' : Number(t.value);
    else if (t.dataset.ctl === 'vote') vote = Number(t.value);
    else if (t.dataset.ctl === 'rec') { replay.restart(+t.value); return; }
    else return;
    markStale();
  });
  root.addEventListener('input', (e) => { if (e.target.classList.contains('gb-speed')) setSpeed(+e.target.value); });
  root.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'train') train();
    else if (act === 'demo') { items = items.concat(normalise(demoRecordings())); chosen = null; renderPick(); }
    else if (act === 'play') (replay.state.playing ? replay.pause() : replay.play());
    else if (act === 'step') replay.step();
    else if (act === 'restart') replay.restart();
    else if (act === 'score') showScore();
  });

  function train() {
    errEl.hidden = true;
    replay.pause();
    const use = items.filter((it) => it.on);
    if (!use.length) return fail(W.noRecs);
    if (use.some((it) => it.rec.data.length !== use[0].rec.data.length)) return fail(W.mixed);
    if (chosen.size < 2) return fail(W.needTwo);
    const channels = chans.map((on, c) => (on ? c : -1)).filter((c) => c >= 0);
    if (!channels.length) return fail(W.needCh);
    const features = feats.length ? feats : [...GB_DEFAULTS.features];
    const keep = new Set(chosen);
    const classOf = (l) => { const c = defaultClassOf(l ?? ''); return keep.has(c) ? c : null; };
    const opts = { features, channels, vote, shrinkage, testReps: GB_DEFAULTS.testReps, classes: [...keep].sort() };
    let ds; let res;
    try {
      ds = prepare(use.map((it) => it.rec), { features, classOf, winMs: GB_DEFAULTS.winMs, stepMs: GB_DEFAULTS.stepMs });
      res = evaluate(ds, { split: { by: 'repetition', testReps: opts.testReps }, vote, channels: channels.length === ds.nChannels ? null : channels,
        lda: { shrinkage }, scope: W.scope, names: Object.fromEntries(opts.classes.map((c) => [c, W.className(c)])) });
    } catch (err) { return fail(err.message); }
    Object.assign(view, { ds, result: res, opts, used: use });
    root.dataset.trained = 'true'; delete root.dataset.stale;
    $('.gb-split').textContent = splitSentence(ds, opts);
    say(W.trained(res.nTrain));
    const sel = $('[data-ctl="rec"]');
    sel.innerHTML = use.map((it, i) => `<option value="${i}">${esc(it.name)}</option>`).join('');
    $('#gb-watch').hidden = false; $('#gb-score').hidden = false;
    $('#gb-score .gb-card').hidden = true;
    replay.restart(0);
    return res;
  }
  function splitSentence(ds, opts) {
    const te = new Set(opts.testReps);
    const reps = [...new Set(ds.segments.filter((s) => s.cls != null && s.cls !== ds.rest).map((s) => s.rep))].sort((a, b) => a - b);
    const tr = reps.filter((r) => !te.has(r)); const ts = reps.filter((r) => te.has(r));
    return tr.length && ts.length ? W.split(tr, ts) : W.splitNone;
  }

  // ---- Step 2: replay ----
  const replay = { rec: 0, speed: 1, state: { playing: false, tally: { right: 0, total: 0 } } };
  const SPEEDS = [0.25, 0.5, 1, 2, 4];
  function setSpeed(k) {
    replay.speed = SPEEDS[k] ?? 1;
    const s = $('.gb-speed'); s.setAttribute('aria-valuetext', W.speedX(replay.speed));
    $('.gb-speedv').textContent = W.speedX(replay.speed);
  }
  let plot = null; let hand = null; let wins = []; let wi = -1; let pushed = 0; let cursor = 0; let hist = []; let raf = 0; let lastT = 0;
  let cols = null; let lo = null; let hi = null;
  const recOf = () => view.used?.[replay.rec]?.rec;
  replay.restart = (r = replay.rec) => {
    replay.pause();
    if (!view.ds) return;
    replay.rec = r;
    $('[data-ctl="rec"]').value = String(r);
    const ds = view.ds; const rec = recOf();
    wins = ds.windows.map((w, i) => (w.rec === r ? i : -1)).filter((i) => i >= 0);
    wi = -1; pushed = 0; cursor = 0; hist = [];
    const nCh = ds.nChannels;
    const chs = view.opts.channels.length ? view.opts.channels : Array.from({ length: nCh }, (_, c) => c);
    cols = ds.features.flatMap((_, f) => chs.map((c) => f * nCh + c));
    // Bar scale: where a value sits between the lowest and highest of that measure in this data.
    lo = cols.map(() => Infinity); hi = cols.map(() => -Infinity);
    for (const x of ds.X) cols.forEach((j, k) => { if (x[j] < lo[k]) lo[k] = x[j]; if (x[j] > hi[k]) hi[k] = x[j]; });
    plot?.destroy();
    // The 3D hand is made on the first replay, so three.js and the model load only when Watch is used.
    if (!hand) view.hand = hand = createHand3D($('.gb-hand'));
    hand.setProbs({}); hand.setTruth(null);
    const gut = $('.gb-gut'); gut.innerHTML = '';
    plot = createPlot({ box: $('.gb-plot'), gutter: gut, names: chs.map((c) => laneName(c)), rateHz: rec.rateHz || 100, windowSec: 5 });
    const win = $('.gb-win');
    win.style.width = `${(ds.win / (rec.rateHz || 100) / plot.windowSec) * 100}%`;
    win.style.right = `${(1 - NOW_AT) * 100}%`;
    Object.assign(replay.state, { i: null, raw: null, voted: null, truth: null, test: null, right: null, probs: {}, tally: { right: 0, total: 0 }, done: false });
    $('.gb-word').textContent = '…'; $('.gb-word').removeAttribute('data-cls');
    $('.gb-truth').textContent = ''; $('.gb-mark').textContent = ''; $('.gb-part').textContent = '';
    $('.gb-feat').innerHTML = ''; $('.gb-prob').innerHTML = ''; $('.gb-vote').innerHTML = '';
    $('.gb-tally').textContent = W.waiting;
    plot.frame(0, {});
  };
  replay.play = () => {
    if (!view.ds || replay.state.playing) return;
    if (replay.state.done) replay.restart();
    replay.state.playing = true; $('[data-act="play"]').textContent = W.pause;
    lastT = performance.now();
    const tick = () => {
      if (!replay.state.playing) return;
      const now = performance.now(); // not rAF's frame time: headless Chrome hands out frame times that barely move
      const rate = recOf().rateHz || 100;
        // Clamp: a tab coming back from the background must not jump ahead.
      advance(cursor + ((Math.max(0, Math.min(1000, now - lastT)) / 1000) * rate * replay.speed));
      lastT = now;
      if (replay.state.done) replay.pause(); else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  };
  replay.pause = () => {
    replay.state.playing = false; cancelAnimationFrame(raf);
    const b = root.querySelector('[data-act="play"]'); if (b) b.textContent = W.play;
  };
  replay.step = () => {
    replay.pause();
    if (!view.ds) return null;
    const next = wins[wi + 1];
    if (next == null) { finish(); return null; }
    advance(view.ds.windows[next].end + 1);
    return view.ds.windows[next];
  };
  function advance(to) {
    const ds = view.ds; const rec = recOf(); const n = rec.labels.length;
    cursor = Math.min(n, to);
    replay.state.t = cursor;
    const rate = rec.rateHz || 100;
    const chs = view.opts.channels.length ? view.opts.channels : rec.data.map((_, c) => c);
    for (; pushed < Math.floor(cursor); pushed++) plot.push((pushed * 1000) / rate, chs.map((c) => rec.data[c][pushed]), rec.labels[pushed]);
    let last = null;
    while (wins[wi + 1] != null && ds.windows[wins[wi + 1]].end < pushed) { wi++; last = decide(wins[wi]); }
    plot.frame((Math.max(0, pushed - 1) * 1000) / rate, { current: rec.labels[Math.max(0, pushed - 1)] ?? null });
    if (last) render(last);
    if (cursor >= n || wins[wi + 1] == null) finish();
  }
  function decide(i) {
    const ds = view.ds; const w = ds.windows[i]; const model = view.result.model;
    const prev = wi > 0 ? ds.windows[wins[wi - 1]] : null;
    if (!prev || prev.start + prev.step !== w.start) hist = []; // the vote restarts at a gap, as in evaluate()
    const x = cols.map((j) => ds.X[i][j]);
    const p = predictProba(model, x);
    const raw = model.classes[p.indexOf(Math.max(...p))];
    hist.push(raw); if (hist.length > 16) hist.shift();
    const k = view.opts.vote;
    const voted = smoothVote(hist.slice(-k), k, model.classes).pop();
    const test = w.distractor || view.opts.testReps.includes(w.rep);
    const right = voted === w.truth;
    const s = replay.state;
    if (test) { s.tally.total++; if (right) s.tally.right++; }
    Object.assign(s, { i, raw, voted, truth: w.truth, test, right, bend: w.distractor, x, probs: Object.fromEntries(model.classes.map((c, k2) => [c, p[k2]])) });
    return s;
  }
  function render(s) {
    const ds = view.ds; const nCh = ds.nChannels;
    const chs = view.opts.channels.length ? view.opts.channels : Array.from({ length: nCh }, (_, c) => c);
    const word = $('.gb-word'); word.textContent = big(s.voted); word.dataset.cls = s.voted;
    // Posed by the vote, the same class as the word above (they must never disagree); the raw
    // chances only shade it (DECISION_SHADE), so an unsure window still looks less committed.
    hand?.setDecision(s.voted, { probs: s.probs }); hand?.setTruth(s.truth ?? null);
    $('.gb-truth').textContent = `${W.truth}: ${big(s.truth)}${s.bend ? ' (elbow bend)' : ''}`;
    const m = $('.gb-mark'); m.textContent = s.right ? '✓' : '✕'; m.dataset.ok = s.right ? 'true' : 'false';
    m.setAttribute('aria-label', s.right ? 'right' : 'wrong');
    $('.gb-part').textContent = s.test ? W.unseen : W.seen;
    $('.gb-part').dataset.test = s.test ? 'true' : 'false';
    // Feature bars: one row per sensor, one bar per measure.
    $('.gb-feat').innerHTML = chs.map((c, ci) => `<div class="gb-frow"><span class="gb-fname">${esc(laneName(c))}</span>${ds.features.map((f, fi) => {
      const j = fi * chs.length + ci; const v = hi[j] > lo[j] ? (s.x[j] - lo[j]) / (hi[j] - lo[j]) : 0;
      return `<span class="gb-fbar" title="${esc(f.toUpperCase())} ${s.x[j].toFixed(1)}"><span class="gb-fk">${esc(f.toUpperCase())}</span><span class="gb-ftrack"><span style="width:${Math.round(Math.max(0, Math.min(1, v)) * 100)}%"></span></span></span>`;
    }).join('')}</div>`).join('');
    $('.gb-prob').innerHTML = Object.entries(s.probs).map(([c, p]) => `<div class="gb-bar" data-cls="${esc(c)}"><span class="gb-bn">${esc(big(c))}</span><span class="gb-ftrack"><span style="width:${Math.round(p * 100)}%"></span></span><span class="gb-bv">${pct(p)}</span></div>`).join('');
    const k = view.opts.vote;
    $('.gb-vote').innerHTML = `<p class="gb-p">${esc(k === 1 ? W.voteN(1) : `Last ${k}:`)} ${hist.slice(-k).map((c) => `<span class="gb-chip">${esc(big(c))}</span>`).join(' ')}</p><p class="gb-p">→ <strong>${esc(big(s.voted))}</strong></p>`;
    $('.gb-tally').textContent = W.tally(s.tally.right, s.tally.total);
  }
  function finish() {
    replay.state.done = true; replay.pause();
    const t = replay.state.tally;
    $('.gb-tally').textContent = `${W.ended} ${W.tally(t.right, t.total)}.`;
  }

  // ---- Step 3: the scorecard ----
  function showScore() {
    const r = view.result; if (!r) return null;
    const card = $('#gb-score .gb-card');
    const nm = (c) => big(c);
    const synth = view.used.some((it) => isSynth(it.rec));
    const ft = (b) => (b.minutes > 0 ? `${b.perMin < 10 ? b.perMin.toFixed(1) : Math.round(b.perMin)} <span class="gb-small">(${b.count} in ${b.minutes < 1 ? `${Math.round(b.minutes * 60)} s` : `${b.minutes.toFixed(1)} min`} tested)</span>` : esc(W.notTested));
    const rows = r.confusion.matrix.map((row, t) => {
      const s = row.reduce((a, b) => a + b, 0);
      return `<tr><th scope="row">${esc(nm(r.classes[t]))}</th>${row.map((v, p) => `<td data-diag="${p === t}">${v}${s ? ` <span class="gb-small">${pct(v / s)}</span>` : ''}</td>`).join('')}</tr>`;
    }).join('');
    card.innerHTML = `<p class="gb-scope">${esc(W.scope)}</p>${synth ? `<p class="gb-synth">${esc(W.synth)}</p>` : ''}
      <p class="gb-big"><span class="gb-ba">${pct(r.balancedAccuracy)}</span> ${esc(W.ba)} <span class="gb-small">(${esc(W.chance(pct(1 / r.classes.length)))})</span></p>
      <p class="gb-cap">${esc(W.cmHead)}</p>
      <div class="gb-scroll"><table class="gb-cm"><thead><tr><th scope="col">${esc(W.cmRow)} ↓ / ${esc(W.cmCol)} →</th>${r.classes.map((c) => `<th scope="col">${esc(nm(c))}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
      <ul class="gb-list">${r.classes.filter((c) => c in r.recall).map((c) => `<li>${esc(W.right(nm(c), pct(r.recall[c])))}</li>`).join('')}</ul>
      <dl class="gb-dl"><dt>${esc(W.ftRest)}</dt><dd class="gb-ft-rest">${ft(r.falseTriggers.rest)}</dd>
        <dt>${esc(W.ftBend)}</dt><dd class="gb-ft-bend">${ft(r.falseTriggers.distractor)}</dd>
        <dt>${esc(W.delay)}</dt><dd class="gb-delay">${r.delay.n ? `${Math.round(r.delay.medianMs)} ms` : esc(W.none)}</dd></dl>
      <ul class="gb-sum">${r.summary.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`;
    card.hidden = false;
    return r;
  }

  function setRecordings(list) { items = normalise(list); chosen = null; renderPick(); markStale(); }
  function destroy() { replay.pause(); plot?.destroy(); hand?.destroy(); view.hand = hand = null; root.remove(); }
  view.replay = replay;
  renderPick();
  return view;
}

function injectStyles() {
  if (document.getElementById('gb-style')) return;
  const st = document.createElement('style');
  st.id = 'gb-style';
  // Every text size is >= 13 px (owner rule); the plot's gutter is pinned too because style.css
  // shrinks it to 12 px on narrow screens.
  st.textContent = `
.gb { color: var(--fg); font: 15px/1.45 var(--sans); max-width: 1200px; min-width: 0; }
.gb * { box-sizing: border-box; }
.gb-h { font-size: 22px; margin: 0 0 var(--s2); } .gb h3 { font-size: 18px; margin: 0 0 var(--s3); }
.gb-p { margin: 0 0 var(--s2); } .gb-cap { margin: 0 0 var(--s2); color: var(--muted); font-size: 14px; }
.gb-step { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: var(--s4); margin: 0 0 var(--s4); min-width: 0; }
.gb-row { display: flex; flex-wrap: wrap; gap: var(--s2) var(--s3); align-items: center; margin: var(--s2) 0; }
.gb-fs { border: 1px solid var(--line); border-radius: 8px; padding: var(--s2) var(--s3); margin: 0 0 var(--s3); min-width: 0; display: flex; flex-wrap: wrap; gap: var(--s1) var(--s4); }
.gb-fs legend { font-weight: 600; padding: 0 var(--s1); }
.gb-fs > .gb-row, .gb-fs > .gb-p { flex-basis: 100%; }
.gb-chk { display: inline-flex; gap: var(--s2); align-items: center; min-height: 32px; overflow-wrap: anywhere; }
.gb-chk input { width: 18px; height: 18px; }
.gb-tag { font-size: 13px; font-weight: 700; color: var(--warn); border: 1px solid var(--warn); border-radius: 4px; padding: 0 4px; }
.gb-btn { font: 600 15px var(--sans); min-height: 40px; padding: 0 var(--s4); border-radius: 8px; border: 1px solid var(--edge); background: var(--panel-2); color: var(--fg); cursor: pointer; display: inline-flex; align-items: center; }
.gb-primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
.gb-btn:focus-visible, .gb input:focus-visible, .gb-sel:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.gb-file { position: relative; overflow: hidden; }
.gb-file input { position: absolute; inset: 0; opacity: 0; cursor: pointer; font-size: 13px; }
.gb-file:focus-within { outline: 3px solid var(--accent); outline-offset: 2px; }
.gb-sel { font: 15px var(--sans); min-height: 36px; background: var(--panel-2); color: var(--fg); border: 1px solid var(--edge); border-radius: 6px; max-width: 100%; }
.gb-lab { display: inline-flex; flex-wrap: wrap; gap: var(--s2); align-items: center; max-width: 100%; }
.gb-speed { width: 120px; }
.gb-err { color: var(--bad); font-weight: 600; } .gb-split { font-weight: 600; margin: var(--s2) 0 0; }
.gb-stage { display: grid; gap: var(--s3); grid-template-columns: minmax(0, 1fr); }
.gb-plotwrap { display: grid; grid-template-columns: minmax(70px, 140px) minmax(0, 1fr); height: 220px; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.gb .gutter .lane, .gb .gutter .lane * { font-size: 13px; }
.gb-plot { position: relative; min-height: 0; min-width: 0; }
.gb-plot canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.gb-win { position: absolute; top: 0; bottom: 0; background: var(--accent-weak); border-left: 2px solid var(--accent); border-right: 2px solid var(--accent); z-index: 1; pointer-events: none; }
.gb-pipe { display: grid; gap: var(--s3); grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.gb-box { background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; padding: var(--s3); min-width: 0; }
.gb-frow { display: grid; grid-template-columns: minmax(0, 90px) minmax(0, 1fr); gap: var(--s1) var(--s2); margin-bottom: var(--s2); align-items: center; }
.gb-frow .gb-fbar { grid-column: 2; }
.gb-frow .gb-fname { grid-row: span ${FEATURES.length}; font-size: 13px; overflow-wrap: anywhere; }
.gb-fbar, .gb-bar { display: grid; grid-template-columns: 48px minmax(0, 1fr) auto; gap: var(--s2); align-items: center; font-size: 13px; }
.gb-fbar { grid-template-columns: 44px minmax(0, 1fr); }
.gb-ftrack { height: 10px; background: var(--band); border-radius: 5px; overflow: hidden; display: block; }
.gb-ftrack > span { display: block; height: 100%; background: var(--trace); }
.gb-bar .gb-ftrack { height: 14px; } .gb-bar .gb-ftrack > span { background: var(--accent); }
.gb-bn, .gb-fk { font-family: var(--mono); font-size: 13px; overflow: hidden; text-overflow: ellipsis; }
.gb-chip { font-family: var(--mono); font-size: 13px; border: 1px solid var(--edge); border-radius: 4px; padding: 0 4px; display: inline-block; margin: 2px 0; }
.gb-dec { text-align: center; display: grid; gap: var(--s3); grid-template-columns: minmax(0, 1fr) minmax(120px, 45%); align-items: center; }
.gb-hand { min-width: 0; }
@media (min-width: 900px) { .gb-dec { grid-column: span 2; } }
.gb-word { font-size: 44px; font-weight: 800; letter-spacing: .04em; margin: var(--s2) 0; color: var(--accent); overflow-wrap: anywhere; }
.gb-truthline { font-size: 16px; margin: 0; } .gb-mark { font-weight: 800; font-size: 22px; }
.gb-mark[data-ok="true"] { color: var(--good); } .gb-mark[data-ok="false"] { color: var(--bad); }
.gb-part { font-size: 13px; color: var(--muted); margin: var(--s2) 0 0; } .gb-part[data-test="true"] { color: var(--fg); }
.gb-tally { font-weight: 600; margin: var(--s3) 0 0; }
.gb-scope { font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); font-size: 13px; margin: 0 0 var(--s2); }
.gb-synth { color: var(--warn); font-weight: 700; margin: 0 0 var(--s2); }
.gb-big { font-size: 18px; margin: 0 0 var(--s3); } .gb-ba { font-size: 40px; font-weight: 800; }
.gb-small { font-size: 13px; color: var(--muted); }
.gb-scroll { overflow-x: auto; max-width: 100%; }
.gb-cm { border-collapse: collapse; font-size: 15px; } .gb-cm th, .gb-cm td { border: 1px solid var(--line); padding: var(--s2) var(--s3); text-align: right; }
.gb-cm thead th:first-child { text-align: left; font-weight: 400; color: var(--muted); font-size: 13px; }
.gb-cm td[data-diag="true"] { background: var(--accent-weak); font-weight: 700; }
.gb-list, .gb-sum { margin: var(--s3) 0; padding-left: 1.2em; }
.gb-dl { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--s1) var(--s3); margin: var(--s3) 0; }
.gb-dl dt { color: var(--muted); } .gb-dl dd { margin: 0; font-weight: 700; text-align: right; }
@media (max-width: 600px) { .gb-step { padding: var(--s3); } .gb-word { font-size: 36px; } .gb-plotwrap { grid-template-columns: 64px minmax(0, 1fr); } }
`;
  document.head.append(st);
}

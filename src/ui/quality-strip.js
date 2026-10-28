// ui/quality-strip.js: the Record screen's live quality strip (spec §8.4). Turns LiveQuality
// output into an overall chip plus up to 3 issue chips, each opening a popover with the
// quality.js message, when it was seen and the Hardware Doctor's fix line. Never colour alone:
// every chip and lane marker carries an icon shape and a word.
//
// Contract
//   const strip = createQualityStrip({ box, names, say })
//     box: an empty element (gets the strip and its popover); names: channel names; say(text).
//   strip.update({ items, followOns }, nowT)   LiveQuality.update() result; nowT = the session's
//     latest t (ms, same clock as item.atMs). Call about once a second while recording.
//   strip.lanes() -> [{ lane, level: 'amber'|'red', atMs }]   one per channel with an active
//     problem (worst level, earliest time) for the plot's lane markers.
//   strip.close()   closes the popover (Esc);  strip.isOpen()
// Follow-on items (green with causedBy) are grouped under the active root on the same channel and
// never counted; a follow-on whose root is not present is dropped.
// A chip stays once per code and channel; it fades 30 s after its problem stops (still listed in
// "+n more"). New red chips are announced once: "Problem on ch3: Sensor isn't touching the skin."
// DOM for tests: .qchip.overall[data-level], .qchip[data-code][data-channel][data-level]
//   [data-follow=<n>], .qmore, #q-pop (.msg, .when, .fixline, .follow li).

import { QUALITY as W, STATUS, PLAIN, sensorName } from './words.js';
import { statusIcon } from './icons.js';
import { esc, whyHTML } from './dom.js';

const FADE_MS = 30000;
const SHOWN = 3;
const STATUS_OF = { red: 'fix', amber: 'check', green: 'ok' };

export function createQualityStrip({ box, names, say = () => {} }) {
  box.innerHTML = `<div class="qstrip" role="group" aria-label="${esc(W.label)}"></div>
    <div class="qpop" id="q-pop" role="dialog" aria-modal="false" aria-labelledby="q-pop-h" hidden></div>`;
  const bar = box.firstElementChild;
  const pop = box.querySelector('#q-pop');
  const chips = new Map(); // key -> { item, follow: [], lastSeen, active }
  let nowT = 0;
  let openKey = null;
  let opener = null;
  const announced = new Set();
  const nm = (c) => (c == null ? '' : names[c] || `ch${c + 1}`);
  const short = (it) => (W.chip[it.code] ? W.chip[it.code](it) : it.code.replace(/_/g, ' '));
  const chipText = (it) => (it.channel == null ? short(it) : `${nm(it.channel)}: ${short(it)}`);

  function update({ items = [], followOns = [] } = {}, t = nowT) {
    nowT = t;
    const live = new Set();
    for (const it of items) {
      const key = `${it.code}:${it.channel}`;
      live.add(key);
      const c = chips.get(key);
      if (c) Object.assign(c, { item: { ...it, atMs: Math.min(it.atMs, c.item.atMs) }, lastSeen: t, active: true });
      else chips.set(key, { item: it, lastSeen: t, active: true, follow: [] });
      if (it.level === 'red' && !announced.has(key)) { announced.add(key); say(W.sayRed(nm(it.channel), short(it))); }
    }
    for (const [key, c] of chips) {
      if (!live.has(key)) c.active = false;
      c.follow = c.active ? followOns.filter((f) => f.causedBy === c.item.code && f.channel === c.item.channel) : c.follow;
    }
    paint();
    if (openKey) fill(openKey);
  }

  const isRed = (c) => (c.item.level === 'red' ? 1 : 0);
  const byRedThenNew = (a, b) => isRed(b) - isRed(a) || b.item.atMs - a.item.atMs;

  function paint() {
    const act = [...chips.values()].filter((c) => c.active);
    const red = act.filter((c) => c.item.level === 'red').length;
    const amber = act.filter((c) => c.item.level === 'amber').length;
    const level = red ? 'red' : amber ? 'amber' : 'green';
    const text = red ? W.fixN(red) : amber ? W.checkN(amber) : W.okAll(names.length);
    const st = STATUS_OF[level];
    // Red first, then newest (spec §8.4 after review 1): a red item must never hide behind amber
    // ones in "+N more". Faded chips (problem gone > 30 s) only in the "more" list.
    const all = [...chips.entries()].sort((a, b) => byRedThenNew(a[1], b[1]));
    const recent = all.filter(([, c]) => c.active || nowT - c.lastSeen < FADE_MS);
    const shown = recent.slice(0, SHOWN);
    const rest = all.length - shown.length;
    bar.innerHTML = `<span class="qchip overall" data-level="${level}" role="status" aria-label="${esc(`${STATUS[st]}: ${text}`)}"><span class="st" data-status="${st}">${statusIcon(st)} ${esc(STATUS[st])}</span> ${esc(text)}</span>`
      + shown.map(([key, c]) => chipHtml(key, c)).join('')
      + (rest > 0 ? `<button class="qchip qmore" type="button" data-key="*">${esc(W.more(rest))}</button>` : '');
    for (const b of bar.querySelectorAll('button')) b.onclick = () => open(b.dataset.key, b);
  }

  function chipHtml(key, c) {
    const it = c.item;
    const st = STATUS_OF[it.level];
    const nf = c.follow.length;
    return `<button class="qchip${c.active ? '' : ' cleared'}" type="button" data-key="${esc(key)}" data-code="${esc(it.code)}" data-channel="${it.channel ?? ''}" data-level="${it.level}"${nf ? ` data-follow="${nf}"` : ''}>
      <span class="st" data-status="${st}">${statusIcon(st)} ${esc(STATUS[st])}</span> ${esc(chipText(it))}${nf ? ` <span class="muted">· +${nf}</span>` : ''}</button>`;
  }

  const plainLine = (it) => (PLAIN[it.code]?.say ? PLAIN[it.code].say(sensorName(nm(it.channel))) : it.message);

  function itemHtml(c) {
    const it = c.item;
    const st = STATUS_OF[it.level];
    const ago = W.ago((nowT - it.atMs) / 1000);
    return `<div class="qitem"><h3><span class="st" data-status="${st}">${statusIcon(st)} ${esc(STATUS[st])}</span> ${esc(chipText(it))}</h3>
      <p class="msg">${esc(plainLine(it))}</p>${whyHTML([PLAIN[it.code]?.why, it.message].filter(Boolean).join(' · '), W.why)}<p class="when small muted">${esc(ago)}</p>
      ${it.fix ? `<p class="fixline"><b>${esc(W.fixPrefix)}</b> ${esc(it.fix)}</p>` : ''}
      ${c.follow.length ? `<p class="small">${esc(W.followTitle)}</p><ul class="follow">${c.follow.map((f) => `<li data-code="${esc(f.code)}">${esc(W.followOn(f.code))}: <span class="muted">${whyHTML(f.message, W.why)}</span></li>`).join('')}</ul>` : ''}</div>`;
  }

  function fill(key) {
    const list = key === '*' ? [...chips.values()].sort(byRedThenNew) : [chips.get(key)].filter(Boolean);
    pop.innerHTML = `<h2 id="q-pop-h" class="vh">${esc(W.label)}</h2>${list.map(itemHtml).join('')}
      <button class="btn" type="button" id="q-pop-close">${esc(W.close)} <span class="key">Esc</span></button>`;
    pop.querySelector('#q-pop-close').onclick = close;
  }

  function open(key, from) {
    openKey = key;
    opener = from;
    fill(key);
    pop.hidden = false;
    pop.querySelector('#q-pop-close').focus({ preventScroll: true });
  }

  function close() {
    if (!openKey) return;
    openKey = null;
    pop.hidden = true;
    opener?.isConnected ? opener.focus({ preventScroll: true }) : box.closest('main')?.focus({ preventScroll: true });
  }

  function lanes() {
    const out = new Map();
    for (const c of chips.values()) {
      const it = c.item;
      if (!c.active || it.channel == null || it.level === 'green') continue;
      const o = out.get(it.channel);
      if (!o) out.set(it.channel, { lane: it.channel, level: it.level, atMs: it.atMs });
      else { if (it.level === 'red') o.level = 'red'; o.atMs = Math.min(o.atMs, it.atMs); }
    }
    return [...out.values()];
  }

  paint();
  return { update, lanes, close, isOpen: () => !!openKey };
}

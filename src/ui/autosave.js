// ui/autosave.js: the Record screen's link to store.js (spec §8.6, RISKS B10). Drains the
// session into an AutoSaver and paints the top-bar indicator.
//
// Contract
//   const ctl = startAutosave({ backend, session, meta, persist, now = Date.now, everyMs })
//     backend: Promise<Backend|null> (app.store()); null or a rejection = autosave failed (the
//     rows stay in the session, the indicator says so). persist: () => Promise (B10:
//     navigator.storage.persist(), asked once per page by the caller's wrapper).
//   ctl.pump()          drain new session rows/markers into the saver (call ~4x a second)
//   ctl.flush()         Promise; best effort (leaving the screen)
//   ctl.state() -> { kind: 'pending'|'saved'|'failed', samples (rows in the browser), sinceMs, error }
//   ctl.saver           the AutoSaver once the backend opened (Review's save calls finish())
//   paintAutosave(el, state|null, nowMs?, say?)   null = 'Not recording'; hides nothing (caller
//     shows/hides #autosave per screen). Failure is announced once per failure run (urgent).
//   el[data-state] = 'idle' | 'pending' | 'saved' | 'failed'; el[data-samples] = rows saved.

import { AutoSaver } from '../store.js';
import { SAVE as W } from './words.js';
import { esc } from './dom.js';

export function startAutosave({ backend, session, meta = {}, persist = null, now = () => Date.now(), everyMs = 2000 }) {
  let saver = null;
  let failed = null;
  let held = { rows: [], markers: [] };
  // ?demo learns its format from the first sample, after begin(): copy it into the stored
  // record (written on the next flush) so recovery shows the real channel count (review-1 #14).
  const syncFormat = () => {
    const r = saver?.record;
    if (r && !r.channels && session.channels) { r.channels = session.channels; r.channelNames = session.channelNames.slice(); }
  };
  const ready = Promise.resolve(backend).then(async (b) => {
    if (!b) throw new Error('this browser has no IndexedDB');
    const s = new AutoSaver({ backend: b, everyMs, now });
    await s.begin({ meta, channels: session.channels, channelNames: session.channelNames });
    saver = s;
    syncFormat();
    if (held.rows.length || held.markers.length) await s.add(held.rows, held.markers);
    held = null;
  }).catch((e) => { failed = e?.message || String(e); });
  // B10: ask once; a "no" is fine (Chrome grants it to installed or bookmarked sites).
  try { persist?.()?.catch?.(() => {}); } catch { /* not supported */ }

  return {
    get saver() { return saver; },
    ready,
    pump() {
      const rows = session.drain();
      const markers = session.drainMarkers();
      if (saver) { syncFormat(); saver.add(rows, markers); }
      else if (held) { held.rows.push(...rows); held.markers.push(...markers); }
    },
    async flush() { await ready; this.pump(); await saver?.flush(); },
    state() {
      const err = failed || saver?.lastError || null;
      if (err) return { kind: 'failed', samples: saver?.samples || 0, error: err };
      if (!saver || !saver.samples) return { kind: 'pending', samples: 0 };
      return { kind: 'saved', samples: saver.samples, sinceMs: now() - saver.lastFlush };
    },
  };
}

export function paintAutosave(el, st, _nowMs, say) {
  const kind = st ? st.kind : 'idle';
  if (kind === 'failed' && el.dataset.state !== 'failed') say?.(W.sayFailed, true);
  const prev = Number(el.dataset.samples || 0);
  el.dataset.state = kind;
  el.dataset.samples = String(st?.samples || 0);
  const icon = { idle: '○', pending: '◌', saved: '●', failed: '✕' }[kind];
  const text = kind === 'idle' ? W.idle : kind === 'pending' ? W.pending : kind === 'failed' ? W.failed : W.saved(W.savedShort(st.sinceMs / 1000));
  el.innerHTML = `<span class="dot" aria-hidden="true">${icon}</span> ${esc(text)}`;
  el.title = kind === 'saved' ? `${W.title(st.samples)}. ${W.about}` : W.about;
  // One 300 ms dip on each write (spec §12), no spinner.
  if (kind === 'saved' && st.samples !== prev) { el.classList.remove('wrote'); void el.offsetWidth; el.classList.add('wrote'); }
}

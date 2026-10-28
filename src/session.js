// session.js: recording state, timestamps, the current label and markers. Pure.
//
// Contract
//   const s = new Session({ channels, channelNames?, protocol = null, now = performance.now,
//                           hotkeyLabels = HOTKEY_LABELS })
//   s.start(meta?)            state 'recording'; protocol clock starts now
//   Protocol clock (seconds into the protocol; only moves while recording and not paused):
//   s.clock(nowMs?) -> seconds
//   s.pause(reason = 'user', nowMs?) / s.resume(nowMs?) -> boolean (false if nothing changed)
//     s.paused, s.pauseReason ('user' | 'unplugged' | 'hidden' | ...). Rows that arrive while
//     paused are kept and labelled 'paused' (PAUSED_LABEL), in free mode too.
//   s.redoStep(nowMs?) / s.skipStep(nowMs?) -> boolean   seek to the start / end of the current
//     step (protocol only); markers 'redo <label>' / 'skip <label>'.
//   s.insertSteps(steps, nowMs?) -> { ok, errors, at }   steps (JSON step/group list, e.g.
//     calibrationSteps()) go after the current step; the protocol is a private copy.
//   s.stop()                  state 'stopped'
//   s.push(sample)            sample from Ingest: { t: device ms|null, hostMs, values, label }
//     Time: device t if present (made monotonic across board resets, e.g. after a replug),
//     else hostMs - start. Label: sample.label if the device sent one, else currentLabel().
//   s.currentLabel(nowMs?)    protocol step label while a protocol runs, else the hotkey label
//   s.protocolState(nowMs?)   protocol.stepAt result or null
//   s.hotkey(key) -> { action: 'label'|'marker'|null, label? }
//     '1'..'9' set the label (free mode); ' ' toggles rest <-> last non-rest label; 'm' adds a marker.
//     During a protocol, number keys only add a marker (the protocol owns the label).
//   s.addMarker(note, nowMs?)  markers: [{ t, index, note }]
//   s.disconnected(nowMs) / s.reconnected(nowMs)   add markers, keep all data; disconnected also
//     pauses the clock (reason 'unplugged'); reconnecting does NOT resume (the person decides).
//   Board reset: the device clock going backwards mid-session adds a 'board reset' marker
//     (s.resets counts them) and the timeline continues.
//   s.drain() -> rows since the last drain: [{ t, values, label }]; s.drainMarkers() likewise (autosave)
//   s.recording() -> { channels, channelNames, t, data (per channel), labels, markers, rateHz, meta }
//   Samples with the wrong channel count are counted in s.rejected and dropped.

import { stepAt, stepStart, insertSteps as insertProtocolSteps } from './protocol.js';
import { estimateRate } from './parse.js';

export const HOTKEY_LABELS = ['rest', 'grip', 'open', 'grip@elbow90', 'elbow_bend', 'grip@raised', 'pinch', 'point', 'other'];

export const PAUSED_LABEL = 'paused';

const defaultNow = () => (globalThis.performance ? performance.now() : Date.now());

export class Session {
  constructor(opts = {}) {
    this.channels = opts.channels ?? 0;
    this.channelNames = opts.channelNames ?? Array.from({ length: this.channels }, (_, i) => `ch${i + 1}`);
    // Private copy: insertSteps edits it, and the caller's protocol may be shared.
    this.protocol = opts.protocol ? { ...opts.protocol, steps: opts.protocol.steps.map((x) => ({ ...x })) } : null;
    this.now = opts.now ?? defaultNow;
    this.hotkeyLabels = opts.hotkeyLabels ?? HOTKEY_LABELS;
    this.state = 'idle';
    this.manualLabel = 'rest';
    this.lastActive = 'grip';
    this.t = [];
    this.rows = [];
    this.labels = [];
    this.markers = [];
    this.meta = {};
    this.rejected = 0;
    this._drained = 0;
    this._lastRawT = null;
    this._lastT = null;
    this._offset = 0;
    this._dt = 10;
    this.resets = 0;
    this.paused = false;
    this.pauseReason = null;
    this._clockBase = 0;   // protocol seconds banked before the current run
    this._runFrom = null;  // host ms when the clock last started running; null while paused
  }

  start(meta = {}) {
    this.meta = { ...meta };
    this.startHost = this.now();
    this.state = 'recording';
    this._clockBase = 0;
    this._runFrom = this.startHost;
    this.paused = false;
    this.pauseReason = null;
    this.meta.started_at = this.meta.started_at || new Date().toISOString();
  }

  stop(nowMs = this.now()) {
    if (this.state !== 'recording') return;
    this._clockBase = this.clock(nowMs);
    this._runFrom = null;
    this.state = 'stopped';
  }

  clock(nowMs = this.now()) {
    if (this._runFrom == null) return this._clockBase;
    return this._clockBase + Math.max(0, nowMs - this._runFrom) / 1000;
  }

  pause(reason = 'user', nowMs = this.now(), { marker = true } = {}) {
    if (this.state !== 'recording' || this.paused) return false;
    this._clockBase = this.clock(nowMs);
    this._runFrom = null;
    this.paused = true;
    this.pauseReason = reason;
    if (marker) this.addMarker(reason === 'user' ? 'paused' : `paused (${reason})`, nowMs);
    return true;
  }

  resume(nowMs = this.now()) {
    if (this.state !== 'recording' || !this.paused) return false;
    this._runFrom = nowMs;
    this.paused = false;
    this.pauseReason = null;
    this.addMarker('resumed', nowMs);
    return true;
  }

  _seek(sec, nowMs) {
    this._clockBase = sec;
    if (this._runFrom != null) this._runFrom = nowMs;
  }

  redoStep(nowMs = this.now()) {
    const ps = this.protocolState(nowMs);
    if (!ps || ps.done) return false;
    this._seek(stepStart(this.protocol, ps.index), nowMs);
    this.addMarker(`redo ${ps.step.label}`, nowMs);
    return true;
  }

  skipStep(nowMs = this.now()) {
    const ps = this.protocolState(nowMs);
    if (!ps || ps.done) return false;
    this._seek(stepStart(this.protocol, ps.index + 1), nowMs);
    this.addMarker(`skip ${ps.step.label}`, nowMs);
    return true;
  }

  insertSteps(steps, nowMs = this.now()) {
    const ps = this.protocolState(nowMs);
    if (!ps) return { ok: false, errors: ['No protocol is running'], at: -1 };
    const at = ps.done ? this.protocol.steps.length : ps.index + 1;
    const r = insertProtocolSteps(this.protocol, at, steps);
    if (!r.ok) return { ok: false, errors: r.errors, at: -1 };
    this.protocol = r.protocol;
    this.addMarker(`steps added after step ${at}`, nowMs);
    // Inserted after a finished protocol: carry straight on with them.
    if (ps.done) this._seek(stepStart(this.protocol, at), nowMs);
    return { ok: true, errors: [], at };
  }

  protocolState(nowMs = this.now()) {
    if (!this.protocol || this.state !== 'recording') return null;
    return { ...stepAt(this.protocol, this.clock(nowMs)), paused: this.paused, pauseReason: this.pauseReason };
  }

  currentLabel(nowMs = this.now()) {
    if (this.paused) return PAUSED_LABEL;
    const ps = this.protocolState(nowMs);
    if (ps) return ps.done ? 'rest' : ps.step.label;
    return this.manualLabel;
  }

  _time(sample) {
    if (sample.t == null) return Math.round((sample.hostMs - this.startHost) * 10) / 10;
    const raw = sample.t;
    if (this._lastRawT != null) {
      const d = raw - this._lastRawT;
      if (d > 0 && d < 1000) this._dt = d;
      // Device clock went backwards: the board reset (unplug/replug). Continue the timeline.
      if (raw < this._lastRawT) {
        this._offset = this._lastT + this._dt - raw;
        this._resetPending = true;
      }
    } else {
      this._offset = -raw; // first sample is t = 0
    }
    this._lastRawT = raw;
    this._lastT = raw + this._offset;
    return this._lastT;
  }

  push(sample) {
    if (this.state !== 'recording') return false;
    if (!this.channels) {
      this.channels = sample.values.length;
      if (!this.channelNames.length) this.channelNames = Array.from({ length: this.channels }, (_, i) => `ch${i + 1}`);
    }
    if (sample.values.length !== this.channels) { this.rejected++; return false; }
    const t = this._time(sample);
    this.t.push(t);
    this.rows.push(sample.values.slice());
    // Paused rows are kept but must never train a model as the step they interrupted.
    this.labels.push(this.paused ? PAUSED_LABEL : (sample.label || this.currentLabel(sample.hostMs ?? this.now())));
    if (this._resetPending) {
      // Marked on the first row after the jump, so the marker sits where the gap is.
      this._resetPending = false;
      this.resets++;
      this.markers.push({ t, index: this.t.length - 1, note: 'board reset' });
    }
    return true;
  }

  hotkey(key) {
    const protocolRunning = !!this.protocolState();
    if (key === 'm' || key === 'M') { this.addMarker('key m'); return { action: 'marker' }; }
    if (/^[1-9]$/.test(key)) {
      const label = this.hotkeyLabels[Number(key) - 1];
      if (!label) return { action: null };
      if (protocolRunning) { this.addMarker(`key ${key} (${label})`); return { action: 'marker' }; }
      this.manualLabel = label;
      if (label !== 'rest') this.lastActive = label;
      return { action: 'label', label };
    }
    if (key === ' ') {
      if (protocolRunning) { this.addMarker('key space'); return { action: 'marker' }; }
      this.manualLabel = this.manualLabel === 'rest' ? this.lastActive : 'rest';
      return { action: 'label', label: this.manualLabel };
    }
    return { action: null };
  }

  addMarker(note, nowMs = this.now()) {
    const t = this.t.length ? this.t[this.t.length - 1] : Math.round(nowMs - (this.startHost ?? nowMs));
    this.markers.push({ t, index: this.t.length, note: String(note).replace(/[\r\n]/g, ' ') });
  }

  disconnected(nowMs = this.now()) {
    if (this.state !== 'recording') return;
    this.addMarker('disconnected', nowMs);
    // The 'disconnected' marker already says why; a second 'paused' one would be noise.
    this.pause('unplugged', nowMs, { marker: false });
  }
  reconnected(nowMs) { if (this.state === 'recording') this.addMarker('reconnected', nowMs); }

  drainMarkers() {
    const from = this._markersDrained || 0;
    this._markersDrained = this.markers.length;
    return this.markers.slice(from);
  }

  drain() {
    const out = [];
    for (let i = this._drained; i < this.t.length; i++) out.push({ t: this.t[i], values: this.rows[i], label: this.labels[i] });
    this._drained = this.t.length;
    return out;
  }

  recording() {
    const data = Array.from({ length: this.channels }, (_, c) => this.rows.map((r) => r[c]));
    return {
      channels: this.channels, channelNames: this.channelNames.slice(), t: this.t.slice(), data,
      labels: this.labels.slice(), markers: this.markers.slice(), rateHz: estimateRate(this.t), meta: { ...this.meta },
    };
  }
}

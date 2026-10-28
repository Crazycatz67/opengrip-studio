// sources.js: where lines come from. Every source emits *text lines* with a host arrival
// time; pipeline.js turns lines into samples. One path for serial, fake and files.
//
// Contract (all sources)
//   await src.start({ onLine(line: string, hostMs: number), onStatus(status, detail) })
//   await src.stop()
//   status: 'connecting' | 'detecting' | 'connected' | 'disconnected' | 'reconnecting' | 'stopped' | 'error'
//
// SerialSource({ serial = navigator.serial, baud = null (auto), bauds = BAUD_ORDER,
//                storage = localStorage|null, resetWaitMs = 2000, probeMs = 1500, now })
//   static supported(serial?) -> boolean
//   await choosePort()            user gesture required in a real browser (requestPort)
//   await detectBaud() -> chooseBaud() result; tries the remembered baud first, then BAUD_ORDER.
//                                  Each try: open, wait resetWaitMs (Uno resets on open; boot junk
//                                  is read and dropped), read probeMs, close.
//   await start(handlers)         opens at this.baud (detects first if null); reads until stop/unplug
//   await reconnect()             reopen the same port (same USB ids) at the same baud
//   On unplug: onStatus('disconnected'); if autoReconnect, waits for the 'connect' event and reopens.
//   port.open failing with InvalidStateError/NetworkError throws PortBusyError (code 'port_busy',
//   message PORT_BUSY_MESSAGE); portOpenError(e) does the mapping.
// FakeSource({ channels = 6, rateHz = 100, seed = 1, labelProvider = null, speed = 1 })
//   generateLines(seconds) -> string[] (deterministic; header first); header(), nextLine(). nxt_logger format.
//   Signal: noise + grip bursts (when label says grip, or a built-in schedule), an elbow artifact
//   on 'elbow'/'bend'/'@elbow90'/'@raised', and a 0.3 s dropout on ch2 at t = 20 s of each minute.
// FileSource({ text, linesPerSecond = Infinity })  replays an imported .txt/.csv.

import { LineBuffer } from './parse.js';
import { BAUD_ORDER, chooseBaud } from './detect.js';
import { mulberry32 } from './sim/uart.js';

const defaultNow = () => (globalThis.performance ? performance.now() : Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NON_FATAL = new Set(['BreakError', 'FramingError', 'ParityError', 'BufferOverrunError']);
const BAUD_KEY = 'opengrip.lastBaud';

// Port busy (RISKS B8): Chrome reports a port another program holds (Arduino IDE's Serial
// Monitor, a second tab) as InvalidStateError or NetworkError, with a message that names
// neither. Rethrow with words that say what to do; the original error stays as `cause`.
export const PORT_BUSY_MESSAGE = 'Close the Arduino Serial Monitor or any other tab using the board, then try again.';
export function portOpenError(e) {
  const name = e && e.name;
  if (name !== 'InvalidStateError' && name !== 'NetworkError') return e;
  const err = new Error(PORT_BUSY_MESSAGE, { cause: e });
  err.name = 'PortBusyError';
  err.code = 'port_busy';
  return err;
}
async function openPort(port, baud) {
  try { await port.open({ baudRate: baud }); } catch (e) { throw portOpenError(e); }
}

export class SerialSource {
  constructor(opts = {}) {
    this.serial = opts.serial ?? globalThis.navigator?.serial ?? null;
    this.baud = opts.baud ?? null;
    this.bauds = opts.bauds ?? BAUD_ORDER;
    this.storage = opts.storage === undefined ? (globalThis.localStorage ?? null) : opts.storage;
    this.resetWaitMs = opts.resetWaitMs ?? 2000;
    this.probeMs = opts.probeMs ?? 1500;
    this.autoReconnect = opts.autoReconnect ?? true;
    this.now = opts.now ?? defaultNow;
    this.port = opts.port ?? null;
    this.kind = 'serial';
    this.running = false;
    this.reader = null;
    this.handlers = null;
    this._onConnect = null;
  }

  static supported(serial = globalThis.navigator?.serial) {
    return !!(serial && typeof serial.requestPort === 'function');
  }

  async choosePort() {
    if (!this.serial) throw new Error('Web Serial is not available in this browser. Use Chrome or Edge on a desktop.');
    this.port = await this.serial.requestPort();
    return this.port;
  }

  rememberedBaud() {
    try { const b = Number(this.storage?.getItem(BAUD_KEY)); return b > 0 ? b : null; } catch { return null; }
  }

  async _readFor(ms, onText) {
    const reader = this.port.readable.getReader();
    const dec = new TextDecoder('latin1');
    const timer = setTimeout(() => reader.cancel().catch(() => {}), ms);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) onText(dec.decode(value, { stream: true }));
      }
    } catch (e) {
      if (!NON_FATAL.has(e?.name)) throw e;
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
    }
  }

  async detectBaud(onStatus = () => {}) {
    if (!this.port) await this.choosePort();
    const last = this.rememberedBaud();
    const order = last ? [last, ...this.bauds.filter((b) => b !== last)] : this.bauds.slice();
    const attempts = [];
    for (const baud of order) {
      onStatus('detecting', { baud });
      await openPort(this.port, baud);
      const lb = new LineBuffer();
      const lines = [];
      // One reader for the whole probe: text before resetWaitMs is the Uno's reset/boot
      // junk and is dropped. (A cancelled stream would need re-acquiring per the spec.)
      const t0 = this.now();
      try {
        await this._readFor(this.resetWaitMs + this.probeMs, (t) => {
          const got = lb.feed(t);
          if (this.now() - t0 >= this.resetWaitMs) lines.push(...got);
        });
      } finally {
        await this.port.close().catch(() => {});
      }
      // The first line of a probe is usually cut in half; don't let it count against the baud.
      attempts.push({ baud, lines: lines.slice(1) });
      const r = chooseBaud(attempts.slice(-1));
      if (r.baud) {
        this.baud = r.baud;
        try { this.storage?.setItem(BAUD_KEY, String(r.baud)); } catch { /* private mode */ }
        return { ...r, results: chooseBaud(attempts).results };
      }
    }
    return chooseBaud(attempts);
  }

  async start(handlers) {
    this.handlers = handlers;
    if (!this.port) await this.choosePort();
    if (!this.baud) {
      const r = await this.detectBaud(handlers.onStatus);
      if (!r.baud) { handlers.onStatus?.('error', { message: r.message, results: r.results }); return r; }
    }
    this._watchConnect();
    await this._open();
    return { baud: this.baud };
  }

  async _open() {
    const h = this.handlers;
    h.onStatus?.('connecting', { baud: this.baud });
    await openPort(this.port, this.baud);
    this.running = true;
    h.onStatus?.('connected', { baud: this.baud });
    this._loop = this._readLoop();
  }

  async _readLoop() {
    const h = this.handlers;
    const lb = new LineBuffer();
    const dec = new TextDecoder('latin1');
    let lost = false;
    // A fresh reader after non-fatal errors (framing etc.), as the Web Serial spec intends.
    while (this.running && this.port.readable) {
      this.reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          const t = this.now();
          for (const line of lb.feed(dec.decode(value, { stream: true }))) h.onLine(line, t);
        }
      } catch (e) {
        if (!NON_FATAL.has(e?.name)) { lost = true; break; }
      } finally {
        try { this.reader.releaseLock(); } catch { /* stream errored */ }
        this.reader = null;
      }
    }
    if (lost && this.running) {
      this.running = false;
      await this.port.close().catch(() => {});
      h.onStatus?.('disconnected', { message: 'The board was unplugged or the cable moved. Your recording so far is kept.' });
    }
  }

  _watchConnect() {
    if (this._onConnect || !this.serial?.addEventListener) return;
    this._onConnect = (ev) => {
      if (!this.autoReconnect || this.running || !this.handlers) return;
      if (ev?.target && this.port && !sameDevice(ev.target, this.port)) return;
      this.reconnect().catch((e) => this.handlers.onStatus?.('error', { message: e.message }));
    };
    this.serial.addEventListener('connect', this._onConnect);
  }

  async reconnect() {
    this.handlers?.onStatus?.('reconnecting', { baud: this.baud });
    const ports = (await this.serial.getPorts?.()) || [];
    const p = ports.find((x) => sameDevice(x, this.port)) || this.port;
    this.port = p;
    await this._open();
  }

  async stop() {
    this.running = false;
    if (this._onConnect) { this.serial?.removeEventListener?.('connect', this._onConnect); this._onConnect = null; }
    try { await this.reader?.cancel(); } catch { /* gone */ }
    await this._loop?.catch(() => {});
    await this.port?.close?.().catch(() => {});
    this.handlers?.onStatus?.('stopped', {});
  }
}

function sameDevice(a, b) {
  if (a === b) return true;
  const x = a?.getInfo?.() || {};
  const y = b?.getInfo?.() || {};
  return x.usbVendorId != null && x.usbVendorId === y.usbVendorId && x.usbProductId === y.usbProductId;
}

export class FakeSource {
  constructor(opts = {}) {
    this.channels = opts.channels ?? 6;
    this.rateHz = opts.rateHz ?? 100;
    this.seed = opts.seed ?? 1;
    this.labelProvider = opts.labelProvider ?? null;
    this.speed = opts.speed ?? 1;
    this.now = opts.now ?? defaultNow;
    this.kind = 'fake';
    this._reset();
  }

  _reset() {
    this.rand = mulberry32(this.seed);
    this.i = 0;
    this.env = 0;
    this.arm = 0;
    this.gain = Array.from({ length: this.channels }, (_, c) => 0.5 + 0.5 * Math.abs(Math.sin(c * 1.7 + 1)));
    this.armGain = Array.from({ length: this.channels }, (_, c) => 0.3 + 0.6 * Math.abs(Math.cos(c * 1.3)));
  }

  header() {
    return `# nxt_logger v1 channels=${this.channels} rate_hz=${this.rateHz} source=fake`;
  }

  // One sample line at index i; the label decides grip/arm activity when a provider exists.
  _line() {
    const tMs = Math.round((this.i * 1000) / this.rateHz);
    const tS = tMs / 1000;
    let grip;
    let armMove;
    if (this.labelProvider) {
      const L = String(this.labelProvider() || '');
      grip = /grip|squeeze/.test(L);
      armMove = /elbow|bend|raised/.test(L) && !/^rest$/.test(L);
    } else {
      const ph = tS % 8;
      grip = ph > 2 && ph < 4.5;
      armMove = tS % 40 > 30 && ph > 5 && ph < 7;
    }
    // First-order envelopes: muscles and force sensors ramp, they don't step.
    const k = 1 - Math.exp(-1 / (0.08 * this.rateHz));
    this.env += ((grip ? 1 : 0) - this.env) * k;
    this.arm += ((armMove ? 1 : 0) - this.arm) * k;
    const drop = Math.floor(tS) % 60 === 20 && tS % 1 < 0.3;
    const vals = [];
    for (let c = 0; c < this.channels; c++) {
      let v = 8 + c * 2 + (this.rand() - 0.5) * 6 + this.env * 400 * this.gain[c] + this.arm * 260 * this.armGain[c];
      if (c === 1 && drop) v = 0;
      vals.push(Math.max(0, Math.min(1023, Math.round(v))));
    }
    this.i++;
    return `${tMs},${vals.join(',')}`;
  }

  // Next sample line; for driving the fake from a test clock.
  nextLine() { return this._line(); }

  generateLines(seconds) {
    this._reset();
    const out = [this.header()];
    const n = Math.round(seconds * this.rateHz);
    for (let i = 0; i < n; i++) out.push(this._line());
    return out;
  }

  async start(handlers) {
    this.handlers = handlers;
    this._reset();
    handlers.onStatus?.('connected', { baud: null, fake: true });
    handlers.onLine(this.header(), this.now());
    const t0 = this.now();
    this.timer = setInterval(() => {
      const due = Math.floor(((this.now() - t0) / 1000) * this.rateHz * this.speed);
      const t = this.now();
      while (this.i < due) handlers.onLine(this._line(), t);
    }, 20);
  }

  async stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.handlers?.onStatus?.('stopped', {});
  }
}

export class FileSource {
  constructor({ text, linesPerSecond = Infinity, now = defaultNow } = {}) {
    this.lines = String(text || '').split(/\r\n|\n|\r/).filter((l) => l.length);
    this.linesPerSecond = linesPerSecond;
    this.now = now;
    this.kind = 'file';
  }

  async start(handlers) {
    this.handlers = handlers;
    this.stopped = false;
    handlers.onStatus?.('connected', { file: true });
    if (!Number.isFinite(this.linesPerSecond)) {
      // Imported files carry no arrival times; space them at the device rate if known later.
      this.lines.forEach((l, i) => handlers.onLine(l, i));
      handlers.onStatus?.('stopped', { done: true });
      return;
    }
    const per = 1000 / this.linesPerSecond;
    for (let i = 0; i < this.lines.length && !this.stopped; i++) {
      handlers.onLine(this.lines[i], this.now());
      if (i % 10 === 9) await sleep(per * 10);
    }
    handlers.onStatus?.('stopped', { done: true });
  }

  async stop() { this.stopped = true; }
}

// TwinSource lives in sim/twin.js; re-exported so the UI imports every signal source from here.
export { TwinSource } from './sim/twin.js';

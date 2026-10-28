// sim/mockserial.js: a fake navigator.serial that replays text as a club Arduino would.
// Runs in Node (18+) and the browser; used by the Node e2e test, the browser test page
// and tools/replay.mjs. Not loaded by the app unless a test installs it.
//
//   createMockSerial({ text | lines, deviceBaud = 9600, lineRateHz = 100, speed = 1,
//                      seed = 1, bootJunk = true, resetOnOpen = true, loop = false, maxChunk = 64 })
//     -> { serial, port, unplug(), replug(), sentLines(), atEnd() }
//   serial: { requestPort(), getPorts(), addEventListener(type, fn), removeEventListener }
//   port:   { open({ baudRate }), close(), readable, getInfo(), addEventListener('disconnect') }
//   - Opening "resets the board": boot junk, then lines from the start (resetOnOpen) or from
//     where it left off.
//   - At a baudRate other than deviceBaud the bytes go through uartResample (junk).
//   - Bytes arrive in random-size chunks (1..maxChunk, default 64 like USB packets; 1 = byte by
//     byte) every ~10 ms of sim time.
//   - unplug(): the read rejects with NetworkError, port.readable becomes null, 'disconnect' fires.
//   - speed > 1 replays faster than real time (tests); the line rate the app sees scales too.

import { uartResample, textToBytes, mulberry32, bootJunk as makeJunk } from './uart.js';

export function createMockSerial(opts = {}) {
  const o = { deviceBaud: 9600, lineRateHz: 100, speed: 1, seed: 1, bootJunk: true, resetOnOpen: true, loop: false, maxChunk: 64, ...opts };
  const lines = o.lines || String(o.text || '').split(/\r\n|\n|\r/).filter((l) => l.length);
  const rand = mulberry32(o.seed);
  const serialListeners = { connect: new Set(), disconnect: new Set() };
  let plugged = true;
  let pos = 0;
  let sent = 0;

  const port = {
    readable: null,
    writable: null,
    _open: false,
    _baud: null,
    _ctrl: null,
    _timer: null,
    _listeners: { disconnect: new Set() },
    getInfo: () => ({ usbVendorId: 0x2341, usbProductId: 0x0043 }),
    addEventListener(type, fn) { (this._listeners[type] ||= new Set()).add(fn); },
    removeEventListener(type, fn) { this._listeners[type]?.delete(fn); },
    async open({ baudRate }) {
      if (!plugged) throw new DOMException('The device has been lost.', 'NetworkError');
      if (this._open) throw new DOMException('The port is already open.', 'InvalidStateError');
      this._open = true;
      this._baud = baudRate;
      if (o.resetOnOpen) pos = 0;
      const self = this;
      let pending = o.bootJunk ? Array.from(makeJunk(rand)) : [];
      let last = null;
      this.readable = new ReadableStream({
        start(ctrl) {
          self._ctrl = ctrl;
          const tickMs = 10;
          self._timer = setInterval(() => {
            const now = Date.now();
            const dtSim = last == null ? tickMs : (now - last);
            last = now;
            // Lines due in this tick at the device's line rate (sim time).
            let due = (dtSim / 1000) * o.lineRateHz * o.speed + (self._carry || 0);
            const whole = Math.floor(due);
            self._carry = due - whole;
            let text = '';
            for (let i = 0; i < whole; i++) {
              if (pos >= lines.length) { if (o.loop) pos = 0; else break; }
              text += lines[pos++] + '\r\n';
              sent++;
            }
            if (text) {
              const bytes = uartResample(textToBytes(text), o.deviceBaud, self._baud);
              for (let i = 0; i < bytes.length; i++) pending.push(bytes[i]); // no spread: a long sleep makes this huge
            }
            while (pending.length) {
              const n = Math.min(pending.length, 1 + Math.floor(rand() * o.maxChunk));
              ctrl.enqueue(Uint8Array.from(pending.splice(0, n)));
            }
          }, tickMs);
        },
        cancel() { clearInterval(self._timer); self._timer = null; },
      });
    },
    async close() {
      clearInterval(this._timer);
      this._timer = null;
      this._open = false;
      this.readable = null;
    },
  };

  const serial = {
    async requestPort() { if (!plugged) throw new DOMException('No port selected by the user.', 'NotFoundError'); return port; },
    async getPorts() { return plugged ? [port] : []; },
    addEventListener(type, fn) { serialListeners[type]?.add(fn); },
    removeEventListener(type, fn) { serialListeners[type]?.delete(fn); },
  };

  function unplug() {
    plugged = false;
    clearInterval(port._timer);
    port._timer = null;
    try { port._ctrl?.error(new DOMException('The device has been lost.', 'NetworkError')); } catch { /* already closed */ }
    port._open = false;
    port.readable = null;
    const ev = { type: 'disconnect', target: port };
    port._listeners.disconnect.forEach((fn) => fn(ev));
    serialListeners.disconnect.forEach((fn) => fn(ev));
  }

  function replug() {
    plugged = true;
    serialListeners.connect.forEach((fn) => fn({ type: 'connect', target: port }));
  }

  return { serial, port, unplug, replug, sentLines: () => sent, atEnd: () => port._open && pos >= lines.length };
}

// sim/uart.js: what a UART receiver set to the wrong baud makes of a byte stream. Pure.
// Used to prove baud auto-detection without hardware (Node tests, the mock serial port).
//
//   uartResample(bytes: Uint8Array, txBaud, rxBaud) -> Uint8Array
//     8N1 framing, bytes sent back to back, line idle high. The receiver waits for a
//     falling edge, samples mid-bit at its own rate. Framing errors still deliver the byte
//     (Chrome reports them; either way the data is junk). Same baud -> same bytes.

export function uartResample(bytes, txBaud, rxBaud) {
  if (txBaud === rxBaud) return Uint8Array.from(bytes);
  const txBit = 1 / txBaud;
  const rxBit = 1 / rxBaud;
  const totalT = bytes.length * 10 * txBit;
  const level = (t) => {
    if (t < 0) return 1;
    const idx = Math.floor(t / txBit);
    const byte = Math.floor(idx / 10);
    if (byte >= bytes.length) return 1;
    const bit = idx % 10;
    if (bit === 0) return 0;
    if (bit === 9) return 1;
    return (bytes[byte] >> (bit - 1)) & 1;
  };
  const out = [];
  const step = Math.min(txBit, rxBit) / 8;
  let t = 0;
  while (t < totalT) {
    if (level(t) === 1) { t += step; continue; }
    let v = 0;
    for (let k = 0; k < 8; k++) v |= level(t + rxBit * (1.5 + k)) << k;
    out.push(v);
    // Resume edge search after the receiver's stop bit.
    t += rxBit * 9.5;
    while (t < totalT && level(t) === 0) t += step;
  }
  return Uint8Array.from(out);
}

export function textToBytes(s) {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
}

// Seeded PRNG so "random" chunking and noise are repeatable in tests.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Typical noise a Uno emits when the port opens (reset + bootloader), before the sketch prints.
export function bootJunk(rand = Math.random) {
  const n = 3 + Math.floor(rand() * 8);
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = [0x00, 0x18, 0x1e, 0xf0, 0xfe, 0x80, 0xe6][Math.floor(rand() * 7)];
  return b;
}

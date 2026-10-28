// Shared test helpers: fixtures as raw bytes, random chunking, line reassembly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LineBuffer } from '../src/parse.js';
import { mulberry32 } from '../src/sim/uart.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIX = path.join(ROOT, 'test/fixtures');
// The club's real logs: git-ignored, present only on machines that have them (see README).
export const FIX_CLUB = path.join(ROOT, 'test/fixtures-club');
export const hasClubFixtures = () => fs.existsSync(FIX_CLUB) && fs.readdirSync(FIX_CLUB).some((f) => f.endsWith('.txt'));
export const fixtureNames = () => fs.readdirSync(FIX).filter((f) => f.endsWith('.txt')).sort();
export const fixtureBytes = (name) => new Uint8Array(fs.readFileSync(path.join(FIX, name)));
export const fixtureText = (name) => fs.readFileSync(path.join(FIX, name), 'latin1');

// Bytes -> random-size chunks (1..maxChunk) -> latin1 text -> LineBuffer, like a serial port.
export function chunkedLines(bytes, seed = 1, maxChunk = 64) {
  const rand = mulberry32(seed);
  const dec = new TextDecoder('latin1');
  const lb = new LineBuffer();
  const lines = [];
  for (let i = 0; i < bytes.length;) {
    const n = 1 + Math.floor(rand() * maxChunk);
    lines.push(...lb.feed(dec.decode(bytes.subarray(i, i + n), { stream: true })));
    i += n;
  }
  lines.push(...lb.flush());
  return lines;
}

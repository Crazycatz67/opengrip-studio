// The app must make no network requests and never touch camera/mic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.js';

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? files(p) : /\.(js|mjs|html|ino)$/.test(d.name) ? [p] : [];
  });
}

test('no fetch( / XMLHttpRequest / getUserMedia / sendBeacon / WebSocket in app sources', () => {
  const list = [...files(path.join(ROOT, 'src')), path.join(ROOT, 'index.html'), ...files(path.join(ROOT, 'test/browser')), ...files(path.join(ROOT, 'arduino'))].filter((f) => fs.existsSync(f));
  assert.ok(list.length >= 12, `only ${list.length} files scanned`);
  const banned = /fetch\(|XMLHttpRequest|getUserMedia|sendBeacon|new WebSocket|EventSource\(|<script[^>]+src=["']https?:|<link[^>]+href=["']https?:/;
  for (const f of list) assert.ok(!banned.test(fs.readFileSync(f, 'utf8')), path.relative(ROOT, f));
});

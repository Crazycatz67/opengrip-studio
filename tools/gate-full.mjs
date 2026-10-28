// npm run gate:full — unit tests, then every browser page in parallel, with the unit counts
// written into the run record (browser-gate.mjs reads GATE_UNIT_SUMMARY).
// Exits non-zero if the unit tests fail (browser pages are then skipped, as before).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const tests = fs.readdirSync('test').filter((f) => f.endsWith('.test.js')).map((f) => `test/${f}`);
const unit = spawnSync(process.execPath, ['--test', ...tests], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
process.stdout.write(unit.stdout);

const count = (k) => Number((unit.stdout.match(new RegExp(`^ℹ ${k} (\\d+)`, 'm')) || [])[1] ?? NaN);
const summary = { tests: count('tests'), pass: count('pass'), fail: count('fail'), skipped: count('skipped') };
if (unit.status !== 0) process.exit(unit.status ?? 1);

const browser = spawnSync(process.execPath, ['tools/browser-gate.mjs'], {
  stdio: 'inherit',
  env: { ...process.env, GATE_PARALLEL: '1', GATE_RECORD: '1', GATE_UNIT_SUMMARY: JSON.stringify(summary) },
});
process.exit(browser.status ?? 1);

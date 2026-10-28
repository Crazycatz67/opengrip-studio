// Golden check: the JS Glass Box pipeline must match feasibility.py on Ninapro DB5 within 1 point
// per row. DB5 (CC-BY-ND) is local only and never in the repo, so this skips without it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DB5, findData, runGolden, formatTable } from '../tools/glassbox-golden.mjs';

const dir = findData(DEFAULT_DB5);

test('Glass Box matches feasibility.py on Ninapro DB5 (16 / 8 / 2 sensors, 3 gestures)', { skip: dir ? false : `Ninapro DB5 not found at ${DEFAULT_DB5} (set GLASSBOX_DB5); golden check skipped` }, () => {
  const res = runGolden(dir);
  for (const r of res.rows) assert.ok(r.ok, `${r.name}: off by ${r.diff.toFixed(2)} points\n${formatTable(res)}`);
  assert.deepEqual(res.best, [4, 6]);
  assert.deepEqual(res.typical, [3, 5]);
});

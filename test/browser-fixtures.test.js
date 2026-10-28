import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, FIX, fixtureNames } from './helpers.js';
import { buildFixturesModule } from '../tools/make-browser-fixtures.mjs';
import { buildSyntheticFixtures } from '../tools/make-synthetic-fixtures.mjs';

test('test/browser/fixtures.js matches test/fixtures (run tools/make-browser-fixtures.mjs)', () => {
  assert.equal(fs.readFileSync(path.join(ROOT, 'test/browser/fixtures.js'), 'utf8'), buildFixturesModule());
});

// The public repo carries only synthetic stand-ins; the club's real logs stay in the git-ignored
// test/fixtures-club/. A file here that the seeded script does not make is a leak or a hand edit.
// Public copy: needs the twin parameters fitted on club logs (withheld from the public copy).
test.skip('test/fixtures holds exactly the synthetic files (run tools/make-synthetic-fixtures.mjs)', () => {
  const want = buildSyntheticFixtures();
  assert.deepEqual(fixtureNames(), Object.keys(want).sort());
  for (const [name, bytes] of Object.entries(want)) assert.ok(Buffer.from(bytes).equals(fs.readFileSync(path.join(FIX, name))), name);
});

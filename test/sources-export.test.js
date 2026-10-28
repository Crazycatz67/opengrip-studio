import test from 'node:test';
import assert from 'node:assert/strict';
import * as sources from '../src/sources.js';
import { TwinSource } from '../src/sim/twin.js';

test('sources.js exposes TwinSource (the Demo signal), same class as sim/twin.js', () => {
  assert.equal(typeof sources.TwinSource, 'function');
  assert.equal(sources.TwinSource, TwinSource);
});

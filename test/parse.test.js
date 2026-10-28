import test from 'node:test';
import assert from 'node:assert/strict';
import { parseText, parseLine, estimateRate, LineBuffer, cleanLine } from '../src/parse.js';
import { fixtureNames, fixtureText } from './helpers.js';

test('all 6 legacy-format fixtures parse: 1 channel, every line a sample, garbage on line 1 only', () => {
  const names = fixtureNames();
  assert.equal(names.length, 6);
  for (const f of names) {
    const text = fixtureText(f);
    const lines = text.split(/\r?\n/).filter(Boolean).length;
    const r = parseText(text);
    assert.equal(r.channels, 1, f);
    assert.equal(r.hasTime, false, f);
    assert.equal(r.data[0].length, lines, f);
    assert.equal(r.stats.garbageLines, 1, f);
    assert.equal(r.stats.badLines, 0, f);
    assert.ok(r.data[0].every((v) => v >= 0 && v <= 1023), f);
  }
});

test('first-line garbage is stripped to the real value', () => {
  assert.equal(parseText(fixtureText('synth_grip_startspike.txt')).data[0][0], 13);
  assert.equal(parseText(fixtureText('synth_dropouts.txt')).data[0][0], 13);
  assert.deepEqual(parseLine('\x18\x1ef14').nums, [14]);
  assert.equal(cleanLine('\x00\xfe12').text, '12');
});

test('legacy multi-channel, new timed format with labels, headers and markers', () => {
  const r = parseText('# nxt_logger v1 channels=2 rate_hz=200\n# notes=band felt loose\nt_ms,ch1,ch2,label\n0,5,6,rest\n5,7,8,grip@elbow90\n# marker t_ms=5 note=sneeze\n10,9,9,grip@elbow90\n');
  assert.equal(r.hasTime, true);
  assert.equal(r.channels, 2);
  assert.deepEqual(r.t, [0, 5, 10]);
  assert.deepEqual(r.labels, ['rest', 'grip@elbow90', 'grip@elbow90']);
  assert.equal(r.meta.notes, 'band felt loose');
  assert.equal(r.meta.device, 'nxt_logger v1');
  assert.equal(r.rateHz, 200);
  assert.deepEqual(r.markers.map((m) => m.note), ['sneeze']);
  const legacy = parseText('1,2,3\n4,2,9\n3,5,1\n');
  assert.equal(legacy.hasTime, false);
  assert.equal(legacy.channels, 3);
});

test('estimateRate uses the median step; LineBuffer joins split lines and CRLF', () => {
  assert.equal(estimateRate([0, 5, 10, 15, 40, 45]), 200);
  assert.equal(estimateRate([0]), null);
  const lb = new LineBuffer();
  assert.deepEqual([...lb.feed('12\r'), ...lb.feed('\n3'), ...lb.feed('4\r\n')], ['12', '34']);
});

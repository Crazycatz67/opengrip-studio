import test from 'node:test';
import assert from 'node:assert/strict';
import { toCSV, fromCSV, validateMeta, sidecarJSON, APP_VERSION } from '../src/csv.js';

const rec = {
  channelNames: ['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'],
  t: [0, 10, 20.25, 30],
  data: Array.from({ length: 8 }, (_, c) => [c, 100 + c, 1023, 0]),
  labels: ['rest', 'grip@elbow90', 'grip@elbow90', null],
  markers: [{ t: 10, note: 'button' }],
  rateHz: 100,
};
const meta = { person_id: 'P03', sensors: 'FMG,FMG,FMG,FMG,FMG,FMG,EMG,EMG', placement: 'right forearm, 3 cm below elbow', tightness: 'snug, 1 finger', notes: 'line one\nline two', cal_rest: '5,6,7,8,9,10,11,12' };

test('CSV round-trip keeps data, 8 channels, labels, markers and metadata', () => {
  const text = toCSV(rec, meta);
  assert.match(text, new RegExp(`^# opengrip_studio v${APP_VERSION}\\n`));
  assert.match(text, /\n# notes=line one line two\n/);
  assert.match(text, /\nt_ms,a0,a1,a2,a3,a4,a5,a6,a7,label\n/);
  const back = fromCSV(text);
  assert.equal(back.channels, 8);
  assert.deepEqual(back.channelNames, rec.channelNames);
  assert.deepEqual(back.t, [0, 10, 20.3, 30]);
  assert.deepEqual(back.data, rec.data);
  assert.deepEqual(back.labels, rec.labels);
  assert.equal(back.markers[0].note, 'button');
  assert.equal(back.markers[0].index, 1);
  for (const k of ['person_id', 'sensors', 'placement', 'tightness', 'cal_rest']) assert.equal(back.meta[k], meta[k], k);
  assert.equal(back.meta.rate_hz, '100');
  assert.equal(back.meta.app_version, APP_VERSION);
});

test('person ID must not be a name; sensor types checked', () => {
  assert.deepEqual(validateMeta({ person_id: 'P03', sensors: 'FMG,EMG,both' }), []);
  assert.equal(validateMeta({ person_id: 'Alex' }).length, 1);
  assert.equal(validateMeta({ person_id: 'Alex Smith 2' }).length, 1);
  assert.equal(validateMeta({}).length, 1);
  assert.equal(validateMeta({ person_id: 'P1', sensors: 'FSR' }).length, 1);
});

test('sidecar JSON carries the report', () => {
  const j = JSON.parse(sidecarJSON({ items: [{ level: 'green' }] }, { person_id: 'P03' }));
  assert.equal(j.report.items[0].level, 'green');
  assert.equal(j.app_version, APP_VERSION);
});

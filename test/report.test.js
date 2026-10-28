import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionReportHTML, sparkPath, reportCode } from '../src/report.js';
import { analyzeRecording } from '../src/quality.js';
import { REPORT } from '../src/ui/words.js';

// Two sensors, 20 s at 100 Hz: ch1 has squeezes, ch2 drops to zero for a while (a Doctor finding).
function makeRec(extra = {}) {
  const n = 2000;
  const t = Array.from({ length: n }, (_, i) => i * 10);
  const a = t.map((_, i) => 200 + ((i % 400) < 100 ? 300 : 0) + (i % 7));
  const b = t.map((_, i) => (i > 800 && i < 1100 ? 0 : 300 + (i % 5)));
  return { t, data: [a, b], channelNames: ['ch1', 'ch2'], rateHz: 100, labels: t.map(() => null), meta: { person_id: 'P03', started_at: '2026-10-20T09:15:00Z', sensors: 'FMG,EMG' }, ...extra };
}

const noScriptNoNet = (html) => {
  assert.doesNotMatch(html, /<script/i, 'no script tag');
  assert.doesNotMatch(html, /https?:\/\//i, 'no external URL');
  // Quoted attribute values are escaped text, not markup: blank them so only real attributes count.
  const tags = html.replace(/"[^"]*"/g, '""');
  assert.doesNotMatch(tags, /@import|url\(|<[a-z][^>]*\s(src|href)=|<link/i, 'no fetched resources');
  assert.doesNotMatch(tags, /<[a-z][^>]*\son[a-z]+=/i, 'no inline handlers');
};

test('report: a whole self-contained page with session facts, Doctor, drift, fit, one plot per sensor', () => {
  const rec = makeRec();
  const html = sessionReportHTML(rec, analyzeRecording(rec));
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<style>[\s\S]*@media print[\s\S]*<\/style>/);
  noScriptNoNet(html);
  assert.match(html, /P03/);
  assert.match(html, /2026-10-20 09:15 UTC/);
  assert.match(html, /20 seconds · 2,000 readings/);
  for (const id of ['session', 'doctor', 'drift', 'fit', 'plots']) assert.match(html, new RegExp(`<section id="${id}">`));
  assert.equal((html.match(/<svg class="plot"/g) || []).length, 2);
  assert.match(html, new RegExp(REPORT.fitNone));
  assert.doesNotMatch(html, /id="synthetic"/, 'real data has no demo banner');
});

test('report: Simple uses plain words; Advanced adds channel names, kinds and the rate', () => {
  const rec = makeRec();
  const rep = analyzeRecording(rec);
  const simple = sessionReportHTML(rec, rep);
  assert.match(simple, /Sensor 1, Sensor 2/);
  assert.doesNotMatch(simple, /\bch[12]\b|FMG|EMG/, 'Simple never shows file names or sensor kinds');
  assert.ok(rep.items.some((it) => it.level !== 'green'), 'fixture has a finding');
  assert.match(simple, /data-status="(fix|check)"/);
  const adv = sessionReportHTML(rec, rep, { mode: 'advanced' });
  assert.match(adv, /ch1 \(FMG\), ch2 \(EMG\)/);
  assert.match(adv, /Readings per second<\/dt><dd>100</);
});

test('report: the person ID must be a code; a name never prints', () => {
  assert.equal(reportCode('P03'), 'P03');
  assert.equal(reportCode('Jo Smith'), null);
  assert.equal(reportCode('Jo'), null, 'no digit: a name, not a code');
  const rec = makeRec();
  const html = sessionReportHTML(rec, analyzeRecording(rec), { person_id: 'Jo Smith' });
  assert.doesNotMatch(html, /Jo Smith/);
  assert.match(html, new RegExp(REPORT.noCode));
});

test('report: every value is escaped', () => {
  const evil = '<img src=x onerror=alert(1)>"\'&';
  const rec = makeRec({ channelNames: [evil, 'ch2'] });
  const html = sessionReportHTML(rec, analyzeRecording(rec), { mode: 'advanced', setup: evil, placement: evil, tightness: evil, liveDrift: [], fitChecks: [{ ch: 1, state: evil, reason: evil, fix: evil }] });
  noScriptNoNet(html);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;&quot;&#39;&amp;/);
});

test('report: synthetic data gets the banner (flag on rec, meta, or twin source)', () => {
  for (const extra of [{ synthetic: true }, { meta: { synthetic: 'true' } }]) {
    const rec = makeRec(extra);
    assert.match(sessionReportHTML(rec, analyzeRecording(rec)), /id="synthetic"/);
  }
  const rec = makeRec();
  assert.match(sessionReportHTML(rec, analyzeRecording(rec), { source: 'twin' }), new RegExp(REPORT.synthetic));
});

test('report: fit check results and the live-vs-final drift note show when given', () => {
  const rec = makeRec();
  const html = sessionReportHTML(rec, analyzeRecording(rec), {
    fitChecks: [{ ch: 1, state: 'good', reason: '', fix: '' }, { ch: 2, state: 'bad', reason: 'Sensor 2 stays flat.', fix: 'Press it onto the skin.' }],
    liveDrift: [{ channel: 0, code: 'rest_drift', level: 'amber', status: 'Check', why: { settled: true } }],
  });
  assert.match(html, /Works here/);
  assert.match(html, /Not working here · Sensor 2 stays flat\.<p class="fix"><b>Fix:<\/b> Press it onto the skin\./);
  assert.match(html, /Live screen vs whole session/);
  assert.match(html, /Sensor 1: shown live earlier/);
});

test('report: Fit carried from the Fit page (card A1): checks shown, skipped said, no fit keeps the old line', () => {
  const rec = makeRec();
  const rep = analyzeRecording(rec);
  const fitSec = (m) => sessionReportHTML(rec, rep, m).match(/<section id="fit">[\s\S]*?<\/section>/)[0];
  const checked = fitSec({ fit: { checks: [{ ch: 3, state: 'weak', reason: 'Sensor 3 moves a little.', fix: 'Move it.' }], skipped: false, at: '2026-10-23T10:00:00Z' } });
  assert.match(checked, /Sensor 3/);
  assert.match(checked, /Move it\./);
  const skipped = fitSec({ fit: { checks: null, skipped: true, at: '2026-10-23T10:00:00Z' } });
  assert.match(skipped, /id="fit-skipped"/);
  assert.match(skipped, /Fit was skipped/);
  assert.doesNotMatch(skipped, new RegExp(REPORT.fitNone));
  // A file from Files has no fit data: unchanged wording, never "skipped".
  const none = fitSec({});
  assert.match(none, new RegExp(REPORT.fitNone));
  assert.doesNotMatch(none, /skipped/);
  // fitChecks (older callers) still wins over fit.checks.
  assert.match(fitSec({ fitChecks: [{ ch: 5, state: 'good' }], fit: { checks: [{ ch: 3, state: 'weak' }] } }), /Sensor 5/);
});

test('report: empty or odd input gives a valid page and never throws', () => {
  const html = sessionReportHTML({ t: [], data: [] }, { items: [] });
  noScriptNoNet(html);
  assert.match(html, new RegExp(REPORT.noDate));
  assert.equal(sessionReportHTML(null, null).includes('</html>'), true);
  assert.equal(sparkPath([null, NaN]), '');
  // Gaps break the line: two separate pen-downs.
  assert.equal((sparkPath([1, 2, null, null, 3, 4], 60, 20).match(/M/g) || []).length, 2);
});

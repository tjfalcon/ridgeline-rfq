import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseCsv, route, processDrafts, loadReporting, fetchStock } from '../src/routing.ts';
const root = new URL('../', import.meta.url);
const rules = JSON.parse(await readFile(new URL('config/approval-rules.json', root), 'utf8'));
const reporting = await loadReporting(new URL('data-pack_platform/reporting_db/', root));
const { drafts } = JSON.parse(await readFile(new URL('data-pack_platform/draft_quotes.json', root), 'utf8'));
const fixture = JSON.parse(await readFile(new URL('data-pack_platform/stock_fixture.json', root), 'utf8'));
const fixtureReader = async (part: string) => fixture[part] ?? null;

test('CSV preserves quoted commas and escaped quotes', () => {
  assert.deepEqual(parseCsv('id,description\r\n1,"a, ""b"""\r\n'), [{ id: '1', description: 'a, "b"' }]);
});
for (const [label, net, list, region, expected] of [
  ['15% inclusive specialist', 8500, 10000, 'West', null],
  ['above 15% manager', 8499, 10000, 'West', 'U01'],
  ['25% inclusive manager', 7500, 10000, 'West', 'U01'],
  ['above 25% VP', 7499, 10000, 'West', 'U05'],
  ['below $25000 specialist', 2499999, 2499999, 'West', null],
  ['$25000 inclusive manager', 2500000, 2500000, 'West', 'U01'],
  ['VP precedence over amount', 3000000, 5000000, 'West', 'U05'],
  ['out-of-office Central backup', 8000, 10000, 'Central', 'U04'],
] as const) test(label, () => assert.equal(route(net, list, region, reporting, rules, rules.sampleNow), expected));

test('all ten fixtures: pricing, tiers, low confidence, expiry, duplicate and output shape', async () => {
  const results = await processDrafts(drafts, reporting, rules, rules.sampleNow, fixtureReader);
  assert.deepEqual(results.map(r => r.draft_id), drafts.map((d: any) => d.draft_id));
  assert.deepEqual(results.map(r => r.approver_id), [null, 'U01', 'U05', 'U05', null, 'U04', 'U01', null, 'U04', null]);
  assert.equal(results[1].net_total, 132.46);
  assert.equal(results[2].effective_discount_pct, 26.22);
  assert.equal(results[5].net_total, 47652);
  assert.ok(results[4].specialist_review_flags.some(f => f.line === 3 && f.reason.includes('0.62')));
  assert.ok(results[6].specialist_review_flags.some(f => f.reason.includes('expired contract')));
  assert.equal(results[9].duplicate_of, 'DQ-24102');
  assert.equal(results[9].status, 'duplicate');
  assert.equal(results[9].net_total, null);
  for (const result of results) assert.deepEqual(Object.keys(result), ['draft_id', 'status', 'net_total', 'effective_discount_pct', 'approver_id', 'specialist_review_flags', 'duplicate_of']);
});

test('duplicate identity ignores line order; outside 24h is processed', async () => {
  const original = drafts[1];
  const duplicate = { ...original, draft_id: 'copy', created_at: '2026-10-12T09:00:00-05:00', lines: [...original.lines].reverse() };
  const later = { ...original, draft_id: 'later', created_at: '2026-10-13T08:12:00-05:00' };
  const results = await processDrafts([original, duplicate, later], reporting, rules, rules.sampleNow, fixtureReader);
  assert.equal(results[1].duplicate_of, original.draft_id);
  assert.equal(results[2].duplicate_of, null);
});

test('stale export, stale stock, missing part and zero stock are visible', async () => {
  const staleReports = { ...reporting, exportedAt: '2026-10-10T00:00:00-05:00' };
  const parts = drafts[0].lines;
  const results = await processDrafts([drafts[0]], staleReports, rules, rules.sampleNow, async part => part === parts[0].part_number ? null : { warehouses: { DAL: 0 }, as_of: '2026-10-10T00:00:00-05:00' });
  const flags = results[0].specialist_review_flags;
  for (const phrase of ['reporting export', 'not found', 'out of stock', 'stock older']) assert.ok(flags.some(f => f.reason.includes(phrase)));
});

test('stock unavailable flags quote but does not block routing', async () => {
  const result = await processDrafts([drafts[1]], reporting, rules, rules.sampleNow, async () => undefined);
  assert.equal(result[0].approver_id, 'U01');
  assert.deepEqual(result[0].specialist_review_flags, [{ line: null, reason: 'stock unavailable after retries' }]);
});

test('503 retries respect bounded backoff and recover', async () => {
  let attempts = 0; const waits: number[] = [];
  const fetcher = async () => ++attempts < 3 ? new Response(JSON.stringify({ retry_after_seconds: 2 }), { status: 503 }) : new Response(JSON.stringify(fixture.RL171482));
  assert.ok(await fetchStock('RL171482', rules, fetcher as typeof fetch, async ms => { waits.push(ms); }));
  assert.equal(attempts, 3); assert.deepEqual(waits, [2000, 2000]);
});
test('network failures exhaust three attempts; missing part is not retried', async () => {
  let attempts = 0;
  const failed = async () => { attempts++; throw new Error('offline'); };
  assert.equal(await fetchStock('part', rules, failed as typeof fetch, async () => {}), undefined);
  assert.equal(attempts, 3); attempts = 0;
  const missing = async () => { attempts++; return new Response('{}', { status: 404 }); };
  assert.equal(await fetchStock('part', rules, missing as typeof fetch, async () => {}), null);
  assert.equal(attempts, 1);
});
test('timeout aborts fetch and exhausts retries', async () => {
  let attempts = 0;
  const hanging = async (_url: any, options: any) => { attempts++; await new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('test fetch did not abort')), 200);
    options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
  }); return new Response('{}'); };
  assert.equal(await fetchStock('part', { ...rules, stockTimeoutMs: 5 }, hanging as typeof fetch, async () => {}), undefined);
  assert.equal(attempts, 3);
});
test('missing reporting price fails explicitly rather than inventing a total', async () => {
  await assert.rejects(processDrafts([drafts[0]], { ...reporting, products: [] }, rules, rules.sampleNow, fixtureReader), /Missing price/);
});

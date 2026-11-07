import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateRules } from '../src/config.ts';
import { fetchStock } from '../src/routing.ts';
const rules = JSON.parse(await readFile(new URL('../config/approval-rules.json', import.meta.url), 'utf8'));
test('valid rules load; invalid ranges, URL credentials and zero attempts fail', () => {
  assert.deepEqual(validateRules(rules), rules);
  for (const change of [{ stockAttempts: 0 }, { stockAttempts: 99 }, { confidenceMinimum: 2 }, { specialistMaxDiscountPct: 40 }, { sampleNow: 'bad' }, { stockBaseUrl: 'http://user:password@example.com' }]) assert.throws(() => validateRules({ ...rules, ...change }));
});
test('malformed stock bodies retry and exhaust without accepting invalid inventory', async () => {
  for (const value of [null, [], {}, { warehouses: [], as_of: rules.sampleNow }, { warehouses: {}, as_of: rules.sampleNow }, { warehouses: { DAL: -1 }, as_of: rules.sampleNow }, { warehouses: { DAL: '5' }, as_of: rules.sampleNow }, { warehouses: { DAL: 5 }, as_of: 'bad' }]) {
    let attempts = 0;
    const fetcher = async () => { attempts++; return new Response(JSON.stringify(value)); };
    assert.equal(await fetchStock('part', rules, fetcher as typeof fetch, async () => {}), undefined);
    assert.equal(attempts, 3);
  }
});
test('valid zero stock is retained for human review', async () => {
  const value = { warehouses: { DAL: 0 }, as_of: rules.sampleNow };
  assert.deepEqual(await fetchStock('part', rules, (async () => new Response(JSON.stringify(value))) as typeof fetch), value);
});

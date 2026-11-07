import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const preferences = await import(new URL('../public/preferences.js', import.meta.url).href);
const rules = JSON.parse(await readFile(new URL('../config/approval-rules.json', import.meta.url), 'utf8'));
const fields = ['specialistMaxDiscountPct', 'managerMaxDiscountPct', 'managerMinNetCents', 'confidenceMinimum', 'stockMaxAgeHours', 'reportingMaxAgeHours'];
const defaults = { rules: Object.fromEntries(fields.map(key => [key, rules[key]])), stockMode: 'healthy' };
function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => { values.delete(key); } };
}
test('fresh browser defaults derive from project policy; saves and restores are browser isolated', () => {
  const first = storage(), second = storage();
  assert.deepEqual(preferences.loadPreferences(first, defaults).settings, defaults);
  const changed = { rules: { ...defaults.rules, specialistMaxDiscountPct: 10 }, stockMode: 'stale' };
  assert.equal(preferences.savePreferences(first, changed), true);
  assert.deepEqual(preferences.loadPreferences(first, defaults).settings, changed);
  assert.deepEqual(preferences.loadPreferences(second, defaults).settings, defaults);
  assert.equal(preferences.clearPreferences(first), true);
  assert.deepEqual(preferences.loadPreferences(first, defaults).settings, defaults);
});
test('reload reapplies browser preferences to expired workspace but preserves matching approvals', async () => {
  const saved = storage();
  const changed = { rules: { ...defaults.rules, specialistMaxDiscountPct: 10 }, stockMode: 'healthy' };
  preferences.savePreferences(saved, changed);
  let resets = 0;
  const apply = async (settings: unknown) => { resets++; return settings; };
  assert.deepEqual((await preferences.synchronizePreferences(saved, defaults, defaults, apply)).config, changed);
  assert.equal(resets, 1);
  await preferences.synchronizePreferences(saved, defaults, changed, apply);
  assert.equal(resets, 1);
});
test('corrupt, incompatible and blocked localStorage fall back without preventing the demo', () => {
  for (const raw of ['not json', 'null', JSON.stringify({ version: 99 }), JSON.stringify({ version: 1, rules: { ...defaults.rules, specialistMaxDiscountPct: 90 }, stockMode: 'healthy' })]) {
    const saved = storage(); saved.setItem(preferences.preferenceKey, raw);
    assert.deepEqual(preferences.loadPreferences(saved, defaults).settings, defaults);
  }
  assert.deepEqual(preferences.loadPreferences(null, defaults).settings, defaults);
  assert.equal(preferences.savePreferences(null, defaults), false);
});

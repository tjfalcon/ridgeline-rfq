import { readFile } from 'node:fs/promises';
import type { Rules } from './routing.ts';

export function validateRules(value: unknown): Rules {
  // Fail startup on invalid policy rather than silently route using fallback thresholds.
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Rules must be an object');
  const r = value as Record<string, unknown>;
  for (const key of ['specialistMaxDiscountPct', 'managerMaxDiscountPct', 'managerMinNetCents', 'confidenceMinimum', 'stockMaxAgeHours', 'reportingMaxAgeHours', 'duplicateWindowHours', 'stockAttempts', 'stockTimeoutMs', 'stockBackoffMs', 'stockMaxBackoffMs']) {
    if (typeof r[key] !== 'number' || !Number.isFinite(r[key]) || r[key] < 0) throw new Error(`Invalid rule: ${key}`);
  }
  const rules = r as unknown as Rules;
  if (rules.specialistMaxDiscountPct > rules.managerMaxDiscountPct || rules.managerMaxDiscountPct > 100 || rules.confidenceMinimum > 1) throw new Error('Invalid threshold ordering/range');
  if (!Number.isSafeInteger(rules.managerMinNetCents) || !Number.isInteger(rules.stockAttempts) || rules.stockAttempts < 1 || rules.stockAttempts > 10 || rules.stockTimeoutMs < 1 || rules.stockMaxBackoffMs < rules.stockBackoffMs) throw new Error('Invalid money/retry settings');
  if (typeof rules.sampleNow !== 'string' || !Number.isFinite(Date.parse(rules.sampleNow))) throw new Error('Invalid sample clock');
  if (typeof rules.stockBaseUrl !== 'string') throw new Error('Invalid stock URL');
  const url = new URL(rules.stockBaseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Stock URL must be HTTP(S) without credentials, query or fragment');
  return rules;
}

export async function loadRules(path: URL): Promise<Rules> {
  // Config changes require a restart, but no application code release.
  // Future production: version the rules applied to each quote before adding live updates.
  return validateRules(JSON.parse(await readFile(path, 'utf8')));
}

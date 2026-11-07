import { readFile } from 'node:fs/promises';

type Row = Record<string, string>;
export type Line = { line: number; part_number: string; quantity: number; unit: string; extraction_confidence: number };
export type Draft = { draft_id: string; rfq_id: string; customer_id: string; created_at: string; proposed_discount_pct: number; lines: Line[] };
export type Rules = { sampleNow: string; specialistMaxDiscountPct: number; managerMaxDiscountPct: number; managerMinNetCents: number; confidenceMinimum: number; stockMaxAgeHours: number; reportingMaxAgeHours: number; duplicateWindowHours: number; stockBaseUrl: string; stockAttempts: number; stockTimeoutMs: number; stockBackoffMs: number; stockMaxBackoffMs: number };
export type Reporting = { products: Row[]; customers: Row[]; contracts: Row[]; approvers: Row[]; exportedAt: string };
type Flag = { line: number | null; reason: string };
type Stock = { warehouses: Record<string, number>; as_of: string };
export type Result = { draft_id: string; status: string; net_total: number | null; effective_discount_pct: number | null; approver_id: string | null; specialist_review_flags: Flag[]; duplicate_of: string | null };

// CSV snapshots contain quoted descriptions, including commas and escaped quotes.
export function parseCsv(text: string): Row[] {
  const rows: string[][] = []; let row: string[] = []; let field = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted;
    } else if (!quoted && (c === ',' || c === '\n')) {
      row.push(field.replace(/\r$/, '')); field = '';
      if (c === '\n') { if (row.some(Boolean)) rows.push(row); row = []; }
    } else field += c;
  }
  if (quoted) throw new Error('Unclosed CSV quote');
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  const headers = rows.shift() ?? [];
  return rows.map(values => {
    if (values.length !== headers.length) throw new Error('CSV column count mismatch');
    return Object.fromEntries(headers.map((h, i) => [h, values[i]]));
  });
}

export async function loadReporting(root: URL): Promise<Reporting> {
  // Snapshot files are read-only SAP exports; all quote state belongs to our own store.
  const csv = async (name: string) => parseCsv(await readFile(new URL(name, root), 'utf8'));
  const [products, customers, contracts, approvers, metadata] = await Promise.all([
    csv('products.csv'), csv('customers.csv'), csv('contract_prices.csv'), csv('approvers.csv'),
    readFile(new URL('export_metadata.json', root), 'utf8')
  ]);
  return { products, customers, contracts, approvers, exportedAt: JSON.parse(metadata).exported_at };
}

function timestamp(value: string): number {
  const n = Date.parse(value); if (!Number.isFinite(n)) throw new Error(`Invalid timestamp: ${value}`); return n;
}
function cents(value: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new Error('Invalid price');
  const [whole, fraction = ''] = value.split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(result)) throw new Error('Unsafe price'); return result;
}
const hours = (now: string, then: string) => (timestamp(now) - timestamp(then)) / 3600000;
// Contract and absence dates follow Ridgeline's Central business day, not host timezone.
const day = (now: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));

export function route(netCents: number, listCents: number, region: string, reporting: Reporting, rules: Rules, now: string): string | null {
  // Compare cent totals before rounding the displayed percentage. VP discount wins
  // over the amount rule; exactly 15% stays specialist and exactly 25% stays manager.
  const discountNumerator = (listCents - netCents) * 100;
  const role = discountNumerator > rules.managerMaxDiscountPct * listCents ? 'vp_sales'
    : discountNumerator > rules.specialistMaxDiscountPct * listCents || netCents >= rules.managerMinNetCents ? 'regional_manager' : null;
  if (!role) return null;
  let person = reporting.approvers.find(p => p.role === role && (role === 'vp_sales' || p.region === region));
  const seen = new Set<string>(); const today = day(now);
  // Follow availability backups inclusively by date; never silently drop a required approval.
  while (person) {
    if (seen.has(person.approver_id)) throw new Error('Backup cycle'); seen.add(person.approver_id);
    if (!(person.out_of_office_from && person.out_of_office_from <= today && today <= person.out_of_office_to)) return person.approver_id;
    person = reporting.approvers.find(p => p.approver_id === person!.backup_approver_id);
  }
  throw new Error('No available required approver');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStock(value: unknown): value is Stock {
  return isRecord(value)
    && typeof value.as_of === 'string'
    && Number.isFinite(Date.parse(value.as_of))
    && isRecord(value.warehouses)
    && Object.keys(value.warehouses).length > 0
    && Object.values(value.warehouses).every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0);
}

export async function fetchStock(part: string, rules: Rules, fetcher: typeof fetch = fetch, sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))): Promise<Stock | null | undefined> {
  // null means a known missing part; undefined means unusable/unavailable data.
  // Neither represents zero inventory: the caller must surface a specialist flag.
  for (let attempt = 0; attempt < rules.stockAttempts; attempt++) {
    let wait = rules.stockBackoffMs * 2 ** attempt;
    try {
      const response = await fetcher(`${rules.stockBaseUrl}/v1/stock/${encodeURIComponent(part)}`, { signal: AbortSignal.timeout(rules.stockTimeoutMs) });
      if (response.status === 404) return null;
      if (response.ok) {
        const value: unknown = await response.json();
        if (!isStock(value)) throw new Error('Malformed stock');
        return value;
      }
      if (response.status < 500 && response.status !== 429) return undefined;
      const body: unknown = await response.json().catch(() => null);
      if (isRecord(body) && typeof body.retry_after_seconds === 'number' && Number.isFinite(body.retry_after_seconds) && body.retry_after_seconds >= 0) wait = Math.max(wait, body.retry_after_seconds * 1000);
    } catch { /* Timeout, network failure or malformed response: bounded retry. */ }
    if (attempt + 1 < rules.stockAttempts) await sleep(Math.min(wait, rules.stockMaxBackoffMs));
  }
  return undefined;
}

export function duplicateKey(draft: Draft): string {
  // User-confirmed interpretation of "same lines": RFQ ID plus line numbers,
  // regardless of part, quantity, price or confidence; line order is irrelevant.
  return JSON.stringify([draft.rfq_id, draft.lines.map(l => l.line).sort((a, b) => a - b)]);
}

export async function processDrafts(drafts: Draft[], reporting: Reporting, rules: Rules, now = rules.sampleNow, stockReader = (part: string) => fetchStock(part, rules)): Promise<Result[]> {
  // The sample clock is policy-mandated. Live API imports explicitly supply real time.
  // This function calculates a route only; it never authorizes customer delivery.
  timestamp(now);
  const results: Result[] = []; const seen: Draft[] = []; const stockCache = new Map<string, Stock | null | undefined>();
  for (const draft of drafts) {
    if (!draft.draft_id || !draft.rfq_id || !draft.lines.length || !Number.isFinite(draft.proposed_discount_pct) || draft.proposed_discount_pct < 0 || draft.proposed_discount_pct > 100 || !Number.isInteger(draft.proposed_discount_pct * 100)) throw new Error('Invalid draft or discount precision');
    timestamp(draft.created_at);
    // CLI batch deduplication uses draft timestamps; Workflow uses persisted receipt times.
    const original = seen.find(d => duplicateKey(d) === duplicateKey(draft) && hours(draft.created_at, d.created_at) >= 0 && hours(draft.created_at, d.created_at) <= rules.duplicateWindowHours);
    if (original) { results.push({ draft_id: draft.draft_id, status: 'duplicate', net_total: null, effective_discount_pct: null, approver_id: null, specialist_review_flags: [], duplicate_of: original.draft_id }); continue; }
    const customer = reporting.customers.find(c => c.customer_id === draft.customer_id);
    if (!customer) throw new Error(`Unknown customer in ${draft.draft_id}`);
    const flags: Flag[] = []; let list = 0; let base = 0;
    if (hours(now, reporting.exportedAt) > rules.reportingMaxAgeHours) flags.push({ line: null, reason: 'reporting export older than configured freshness limit' });
    for (const line of draft.lines) {
      if (!Number.isSafeInteger(line.line) || line.line <= 0 || !Number.isSafeInteger(line.quantity) || line.quantity <= 0 || !Number.isFinite(line.extraction_confidence) || line.extraction_confidence < 0 || line.extraction_confidence > 1) throw new Error('Invalid quote line');
      const product = reporting.products.find(p => p.part_number === line.part_number);
      if (!product || product.unit !== line.unit) throw new Error(`Missing price or unit mismatch: ${line.part_number}`);
      const contracts = reporting.contracts.filter(c => c.customer_id === draft.customer_id && c.part_number === line.part_number);
      const valid = contracts.filter(c => c.valid_from <= day(now) && day(now) <= c.valid_to);
      if (valid.length > 1) throw new Error('Overlapping contracts');
      if (!valid.length && contracts.some(c => c.valid_to < day(now))) flags.push({ line: line.line, reason: 'expired contract; list price used' });
      // List total is the approval denominator, even when a contract lowers the base.
      // The proposed discount stacks on the contract/list base, not just list price.
      list += cents(product.list_price) * line.quantity;
      base += cents(valid[0]?.contract_price ?? product.list_price) * line.quantity;
      if (line.extraction_confidence < rules.confidenceMinimum) flags.push({ line: line.line, reason: `extraction confidence ${line.extraction_confidence.toFixed(2)}` });
      // One stock reading per part per batch, including unavailable results after retries.
      if (!stockCache.has(line.part_number)) stockCache.set(line.part_number, await stockReader(line.part_number));
      const stock = stockCache.get(line.part_number);
      if (stock === undefined) {
        if (!flags.some(f => f.reason === 'stock unavailable after retries')) flags.push({ line: null, reason: 'stock unavailable after retries' });
      } else if (stock === null) flags.push({ line: line.line, reason: 'part not found in stock API' });
      else {
        if (Object.values(stock.warehouses).every(n => n === 0)) flags.push({ line: line.line, reason: 'out of stock in all warehouses' });
        if (hours(now, stock.as_of) > rules.stockMaxAgeHours) flags.push({ line: line.line, reason: 'stock older than configured freshness limit' });
      }
    }
    // Apply discount once to quote base, half-up to cents; BigInt avoids float money drift.
    if (!Number.isSafeInteger(base) || !Number.isSafeInteger(list) || list <= 0) throw new Error('Invalid totals');
    const net = Number((BigInt(base) * BigInt(10000 - Math.round(draft.proposed_discount_pct * 100)) + 5000n) / 10000n);
    const approver = route(net, list, customer.region, reporting, rules, now);
    results.push({ draft_id: draft.draft_id, status: approver ? 'approver_required' : 'specialist_only', net_total: net / 100, effective_discount_pct: Math.round((1 - net / list) * 10000) / 100, approver_id: approver, specialist_review_flags: flags, duplicate_of: null });
    seen.push(draft);
  }
  return results;
}

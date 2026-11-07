import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { duplicateKey, processDrafts } from './routing.ts';
import type { Draft, Reporting, Result, Rules } from './routing.ts';

export class ApiError extends Error {
  status: number;
  audited = false;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
// Review/correction precedes manager approval; the specialist signs off only once,
// at the end. Specialist-only quotes can approve directly from specialist_pending.
type State = 'specialist_pending' | 'approver_pending' | 'specialist_final_pending' | 'approved' | 'rejected' | 'duplicate';
type Quote = { draft: Draft; routing: Result; state: State; received_at: string };
type Event = { actor: string; action: string; quote_id: string | null; timestamp: string; before: State | null; after: State | null; note: string };
type Store = { quotes: Quote[]; audit: Event[] };

export class Workflow {
  store: Store = { quotes: [], audit: [] };
  private tail: Promise<unknown> = Promise.resolve();
  path: string;
  reporting: Reporting;
  rules: Rules;
  clock: () => string;
  constructor(path: string, reporting: Reporting, rules: Rules, clock = () => new Date().toISOString()) {
    this.path = path; this.reporting = reporting; this.rules = rules; this.clock = clock;
  }
  async load() {
    try { this.store = JSON.parse(await readFile(this.path, 'utf8')); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
  // Serialize all API operations in one process; publish memory only after atomic save.
  // Future production: use database transactions/locking before multiple processes share state.
  execute<T>(fn: (store: Store) => Promise<T> | T, actor = 'system'): Promise<T> {
    const operation = this.tail.then(async () => {
      const copy = structuredClone(this.store);
      let value: T; let failure: unknown;
      try { value = await fn(copy); } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        // Failed batches must not leave partially imported quotes or decisions.
        copy.quotes = structuredClone(this.store.quotes);
        // Preserve prior events exactly; retain only new denial events on failure.
        copy.audit = [...this.store.audit, ...copy.audit.slice(this.store.audit.length).filter(e => e.action.endsWith('_denied'))];
        if (copy.audit.length === this.store.audit.length) this.event(copy, actor || 'anonymous', 'operation_failed', undefined, null, `HTTP ${error.status}`);
        failure = error;
      }
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(this.path + '.tmp', JSON.stringify(copy, null, 2) + '\n');
      await rename(this.path + '.tmp', this.path);
      this.store = copy;
      if (failure instanceof ApiError) { failure.audited = true; throw failure; }
      return structuredClone(value!);
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
  event(store: Store, actor: string, action: string, quote: Quote | undefined, before: State | null, note = '') {
    store.audit.push({ actor, action, quote_id: quote?.draft.draft_id ?? null, timestamp: this.clock(), before, after: quote?.state ?? null, note });
  }
  user(store: Store, actor: string) {
    // POC identity stub: the server derives roles from exports, never from a client role.
    // Future production: bind this actor to authenticated identity rather than a free header.
    const user = this.reporting.approvers.find(p => p.approver_id === actor);
    if (!user) { this.event(store, actor || 'anonymous', 'access_denied', undefined, null); throw new ApiError(401, 'Known X-User-Id required'); }
    return user;
  }
  recordRequestFailure(actor: string, method: string, path: string, status: number) {
    // Record only endpoint shape/status, never request bodies or query values.
    const endpoint = path === '/' ? '/' : path.split('/').filter(Boolean).map((segment, index) => index === 1 ? ':id' : ['quotes', 'audit', 'samples', 'drafts', 'review', 'approve', 'reject'].includes(segment) ? segment : ':unknown').join('/');
    return this.execute(store => {
      this.event(store, actor || 'anonymous', 'request_failed', undefined, null, `${method} ${endpoint} HTTP ${status}`);
    });
  }
  audit(actor: string) {
    return this.execute(store => {
      this.user(store, actor);
      this.event(store, actor, 'audit_viewed', undefined, null);
      return store.audit;
    }, actor);
  }
  list(actor: string, id?: string, audit = false) {
    return this.execute(store => {
      this.user(store, actor);
      const quote = id ? store.quotes.find(q => q.draft.draft_id === id) : undefined;
      if (id && !quote) throw new ApiError(404, 'Quote not found');
      this.event(store, actor, audit ? 'audit_viewed' : 'quotes_viewed', quote, quote?.state ?? null);
      return audit ? store.audit.filter(e => e.quote_id === id) : quote ?? store.quotes;
    }, actor);
  }
  importDrafts(actor: string, drafts: Draft[], pricingNow?: string) {
    return this.execute(async store => {
      const user = this.user(store, actor);
      if (user.role !== 'quote_specialist') { this.event(store, actor, 'import_denied', undefined, null); throw new ApiError(403, 'Specialist required to import'); }
      if (!Array.isArray(drafts) || !drafts.length) throw new ApiError(400, 'Nonempty drafts array required');
      const imported: Quote[] = [];
      for (const draft of drafts) {
        if (!draft || typeof draft.draft_id !== 'string' || !draft.draft_id || typeof draft.rfq_id !== 'string' || !draft.rfq_id || !Array.isArray(draft.lines) || !draft.lines.length || draft.lines.some(l => !l || !Number.isSafeInteger(l.line) || l.line <= 0) || new Set(draft.lines.map(l => l.line)).size !== draft.lines.length) throw new ApiError(400, 'Draft ID, RFQ ID and unique positive line numbers required');
        const existing = store.quotes.find(q => q.draft.draft_id === draft.draft_id);
        // Identical retries preserve approvals; changed content cannot reuse an approved ID.
        if (existing) {
          if (JSON.stringify(existing.draft) !== JSON.stringify(draft)) throw new ApiError(409, 'Draft ID already exists with different content');
          this.event(store, actor, 'draft_reimported', existing, existing.state); imported.push(existing); continue;
        }
        const receivedAt = this.clock();
        // API duplicates use receipt time, so extractor timestamps cannot extend/evade the window.
        const original = store.quotes.find(q => q.state !== 'duplicate' && duplicateKey(q.draft) === duplicateKey(draft) && Date.parse(receivedAt) - Date.parse(q.received_at) >= 0 && Date.parse(receivedAt) - Date.parse(q.received_at) <= this.rules.duplicateWindowHours * 3600000);
        let routing: Result;
        if (original) routing = { draft_id: draft.draft_id, status: 'duplicate', net_total: null, effective_discount_pct: null, approver_id: null, specialist_review_flags: [], duplicate_of: original.draft.draft_id };
        else {
          try { [routing] = await processDrafts([draft], this.reporting, this.rules, pricingNow ?? receivedAt); }
          catch { throw new ApiError(400, 'Invalid draft or reporting data; import rejected'); }
        }
        const quote: Quote = { draft, routing, received_at: receivedAt, state: original ? 'duplicate' : 'specialist_pending' };
        store.quotes.push(quote); imported.push(quote); this.event(store, actor, original ? 'duplicate_detected' : 'draft_processed', quote, null);
      }
      return imported;
    }, actor);
  }
  decide(actor: string, id: string, action: string, note = '') {
    return this.execute(store => {
      const user = this.user(store, actor);
      const quote = store.quotes.find(q => q.draft.draft_id === id);
      if (!quote) throw new ApiError(404, 'Quote not found');
      const before = quote.state;
      const specialist = user.role === 'quote_specialist';
      // No role alone bypasses the stage gate: managers must be the exact routed ID,
      // and terminal/duplicate quotes cannot be approved or rejected again.
      const allowed = quote.state === 'approver_pending' ? actor === quote.routing.approver_id
        : ['specialist_pending', 'specialist_final_pending'].includes(quote.state) && specialist;
      if (!allowed) { this.event(store, actor, 'decision_denied', quote, before); throw new ApiError(403, 'Actor cannot act at this workflow stage'); }
      if (action === 'reject') quote.state = 'rejected';
      else if (action === 'review' && quote.state === 'specialist_pending' && quote.routing.approver_id) quote.state = 'approver_pending';
      else if (action === 'approve' && quote.state === 'approver_pending') quote.state = 'specialist_final_pending';
      else if (action === 'approve' && (quote.state === 'specialist_final_pending' || (quote.state === 'specialist_pending' && !quote.routing.approver_id))) quote.state = 'approved';
      else { this.event(store, actor, 'decision_denied', quote, before); throw new ApiError(409, 'Invalid action for workflow stage'); }
      // Review is a human attestation that all visible flags were resolved/confirmed.
      // Editing remains a stub: a future edit must reprice/reroute and invalidate approvals.
      if (quote.routing.specialist_review_flags.length && specialist && !note.trim()) {
        quote.state = before; this.event(store, actor, 'decision_denied', quote, before);
        throw new ApiError(400, 'Specialist must document resolution of review flags');
      }
      this.event(store, actor, action, quote, before, note); return quote;
    }, actor);
  }
}

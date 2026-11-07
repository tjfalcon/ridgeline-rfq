import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadRules, validateRules } from './config.ts';
import { loadReporting, fetchStock } from './routing.ts';
import type { Draft, Reporting, Rules, Stock } from './routing.ts';
import { Workflow, ApiError } from './workflow.ts';
import { MemoryWorkspaceRepository, PostgresWorkspaceRepository } from './workspace-store.ts';
import type { Workspace, WorkspaceRepository } from './workspace-store.ts';

const root = new URL('../', import.meta.url);
const editable = ['specialistMaxDiscountPct', 'managerMaxDiscountPct', 'managerMinNetCents', 'confidenceMinimum', 'stockMaxAgeHours', 'reportingMaxAgeHours'] as const;
const modes = ['healthy', 'unavailable', 'stale'];
type Fixtures = { rules: Rules; reporting: Reporting; drafts: Draft[]; stock: Record<string, Stock> };
export async function loadDemoFixtures(): Promise<Fixtures> {
  return {
    rules: await loadRules(new URL('config/approval-rules.json', root)),
    reporting: await loadReporting(new URL('data-pack_platform/reporting_db/', root)),
    drafts: JSON.parse(await readFile(new URL('data-pack_platform/draft_quotes.json', root), 'utf8')).drafts,
    stock: JSON.parse(await readFile(new URL('data-pack_platform/stock_fixture.json', root), 'utf8'))
  };
}

function workflowFor(workspace: Workspace, fixtures: Fixtures) {
  // Hosted demo simulates the HTTP response contract in process; the assessment
  // command still uses the real HTTP adapter and independently running stock mock.
  const stockReader = (part: string) => fetchStock(part, workspace.rules, (async () => {
    if (workspace.stockMode === 'unavailable') return new Response('{}', { status: 503 });
    const item = fixtures.stock[part];
    if (!item) return new Response('{}', { status: 404 });
    const as_of = workspace.stockMode === 'stale'
      ? new Date(Date.parse(workspace.rules.sampleNow) - 48 * 3600000).toISOString()
      : workspace.rules.sampleNow;
    return new Response(JSON.stringify({ ...item, as_of }));
  }) as typeof fetch, async () => {});
  const workflow = new Workflow('', fixtures.reporting, workspace.rules, () => new Date().toISOString(), {
    persist: async store => { workspace.store = store; }, stockReader, policyVersion: workspace.policyVersion
  });
  workflow.store = workspace.store;
  return workflow;
}

async function populate(workspace: Workspace, fixtures: Fixtures) {
  const workflow = workflowFor(workspace, fixtures);
  await workflow.importDrafts('S01', fixtures.drafts, workspace.rules.sampleNow);
}

async function initialWorkspace(fixtures: Fixtures): Promise<Workspace> {
  const now = new Date().toISOString();
  const workspace: Workspace = { version: 1, rules: structuredClone(fixtures.rules), stockMode: 'healthy', policyVersion: 1, store: { quotes: [], audit: [] }, createdAt: now, updatedAt: now };
  await populate(workspace, fixtures);
  return workspace;
}

export function createDemoHandler(repository: WorkspaceRepository, fixtures: Fixtures) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, result: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(result));
    };
    try {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (request.method === 'GET' && path === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(await readFile(new URL('public/index.html', root), 'utf8')); return;
      }
      if (!path.startsWith('/demo/')) throw new ApiError(404, 'Endpoint not found');
      if (request.method === 'POST') {
        const site = request.headers['sec-fetch-site'];
        if (site === 'cross-site') throw new ApiError(403, 'Cross-site changes are not allowed');
        const origin = request.headers.origin;
        if (origin && new URL(origin).host !== request.headers.host) throw new ApiError(403, 'Origin does not match');
      }
      const cookie = request.headers.cookie?.match(/(?:^|;\s*)ridgeline_workspace=([a-f0-9-]{36})(?:;|$)/)?.[1];
      const id = cookie ?? randomUUID();
      if (!cookie) response.setHeader('Set-Cookie', `ridgeline_workspace=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${process.env.VERCEL ? '; Secure' : ''}`);
      let body: any = {};
      if (request.method === 'POST') {
        let raw = '';
        for await (const chunk of request) { raw += chunk; if (Buffer.byteLength(raw) > 10000) throw new ApiError(413, 'Request too large'); }
        try { body = JSON.parse(raw || '{}'); } catch { throw new ApiError(400, 'Invalid JSON'); }
        if (!body || Array.isArray(body) || typeof body !== 'object') throw new ApiError(400, 'JSON object required');
      }
      const actor = String(request.headers['x-user-id'] ?? 'S01');
      const result = await repository.transact(id, () => initialWorkspace(fixtures), async workspace => {
        // This fictional visitor sandbox retains a bounded recent history rather
        // than claiming to be an unlimited production compliance archive.
        if (workspace.store.audit.length > 500) workspace.store.audit = workspace.store.audit.slice(-500);
        const workflow = workflowFor(workspace, fixtures);
        const config = () => ({ rules: Object.fromEntries(editable.map(key => [key, workspace.rules[key]])), stockMode: workspace.stockMode, policyVersion: workspace.policyVersion });
        try {
          if (request.method === 'GET' && path === '/demo/config') return { status: 200, body: config() };
          if (request.method === 'POST' && (path === '/demo/config' || path === '/demo/reset')) {
            const previousPolicy = { rules: structuredClone(workspace.rules), stockMode: workspace.stockMode, version: workspace.policyVersion };
            if (!['S01', 'S02', 'S03'].includes(actor)) throw new ApiError(403, 'Select a specialist to change demo settings');
            if (path === '/demo/config') {
              if (!body.rules || typeof body.rules !== 'object' || Array.isArray(body.rules) || Object.keys(body.rules).some(key => !editable.includes(key as any))) throw new ApiError(400, 'Only displayed policy fields can be changed');
              if (!modes.includes(body.stockMode)) throw new ApiError(400, 'Unknown stock mode');
              try { workspace.rules = validateRules({ ...workspace.rules, ...body.rules }); } catch (error) { throw new ApiError(400, (error as Error).message); }
              workspace.stockMode = body.stockMode;
              workspace.policyVersion++;
            }
            const priorAudit = workspace.store.audit;
            workspace.store = { quotes: [], audit: priorAudit };
            const reset = workflowFor(workspace, fixtures);
            reset.event(workspace.store, actor, path === '/demo/config' ? 'policy_changed_samples_reset' : 'samples_reset', undefined, null, JSON.stringify({ previous: previousPolicy, next: { rules: workspace.rules, stockMode: workspace.stockMode, version: workspace.policyVersion }, approvalsCleared: true }));
            await populate(workspace, fixtures);
            return { status: 200, body: config() };
          }
          if (request.method === 'GET' && path === '/demo/summary') {
            const quotes = workspace.store.quotes;
            const byStage: Record<string, number> = {};
            for (const quote of quotes) byStage[quote.state] = (byStage[quote.state] ?? 0) + 1;
            const durations = quotes.filter(q => q.state === 'approved').map(q => {
              const event = workspace.store.audit.findLast(e => e.quote_id === q.draft.draft_id && e.action === 'approve' && e.after === 'approved');
              return event ? Math.max(0, (Date.parse(event.timestamp) - Date.parse(q.received_at)) / 1000) : null;
            }).filter((v): v is number => v !== null);
            return { status: 200, body: { total: quotes.length, pending: quotes.filter(q => q.state.endsWith('_pending')).length, approved: byStage.approved ?? 0, rejected: byStage.rejected ?? 0, duplicates: byStage.duplicate ?? 0, byStage, averageApprovalSeconds: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null, policyVersion: workspace.policyVersion, stockMode: workspace.stockMode } };
          }
          let data: unknown;
          const segments = path.split('/').filter(Boolean).slice(1);
          if (request.method === 'GET' && segments[0] === 'quotes' && segments.length <= 3 && (segments.length < 3 || segments[2] === 'audit')) data = await workflow.list(actor, segments[1], segments[2] === 'audit');
          else if (request.method === 'GET' && path === '/demo/audit') data = await workflow.audit(actor);
          else if (request.method === 'POST' && path === '/demo/samples') data = await workflow.importDrafts(actor, fixtures.drafts, workspace.rules.sampleNow);
          else if (request.method === 'POST' && segments[0] === 'quotes' && segments.length === 3 && ['review', 'approve', 'reject'].includes(segments[2])) {
            if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 2000)) throw new ApiError(400, 'Note must be at most 2000 characters');
            data = await workflow.decide(actor, segments[1], segments[2], body.note);
          } else throw new ApiError(404, 'Demo endpoint not found');
          return { status: 200, body: data };
        } catch (error) {
          // Persist the workflow's denial audit, while returning controlled failures.
          if (error instanceof ApiError) {
            if (!error.audited) workflow.event(workspace.store, actor, 'demo_request_denied', undefined, null, `HTTP ${error.status}`);
            return { status: error.status, body: { error: error.message } };
          }
          throw error;
        } finally { workspace.updatedAt = new Date().toISOString(); }
      });
      send(result.status, result.body);
    } catch (error) { send(error instanceof ApiError ? error.status : 503, { error: error instanceof ApiError ? error.message : 'Demo temporarily unavailable; please retry.' }); }
  };
}

let handler: ReturnType<typeof createDemoHandler> | undefined;
export async function demoHandler(request: IncomingMessage, response: ServerResponse) {
  if (!handler) {
    const connectionString = process.env.DATABASE_URL;
    if (process.env.VERCEL && !connectionString) { response.writeHead(503); response.end('Demo database not configured'); return; }
    handler = createDemoHandler(connectionString ? new PostgresWorkspaceRepository(connectionString) : new MemoryWorkspaceRepository(), await loadDemoFixtures());
  }
  return handler(request, response);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) createServer(demoHandler).listen(3002, '127.0.0.1', () => console.log('Portfolio demo: http://127.0.0.1:3002'));

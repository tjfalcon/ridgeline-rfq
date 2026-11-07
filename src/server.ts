import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadReporting } from './routing.ts';
import { ApiError, Workflow } from './workflow.ts';
import { loadRules } from './config.ts';

export function createApi(workflow: Workflow, sampleDrafts: unknown) {
  return createServer(async (request, response) => {
    const actor = String(request.headers['x-user-id'] ?? '');
    let pathname = '/';
    try {
      pathname = new URL(request.url!, 'http://localhost').pathname;
      const path = pathname.split('/').filter(Boolean);
      if (request.method === 'GET' && pathname === '/') {
        const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html); return;
      }
      let body: any = {};
      if (request.method === 'POST') {
        let text = '';
        for await (const chunk of request) { text += chunk; if (Buffer.byteLength(text) > 1000000) throw new ApiError(413, 'Body too large'); }
        try { body = text ? JSON.parse(text) : {}; } catch { throw new ApiError(400, 'Invalid JSON'); }
        if (!body || Array.isArray(body) || typeof body !== 'object') throw new ApiError(400, 'JSON object required');
      }
      let result: unknown;
      if (request.method === 'GET' && pathname === '/audit') result = await workflow.audit(actor);
      else if (request.method === 'GET' && path[0] === 'quotes' && path.length <= 3 && (path.length < 3 || path[2] === 'audit')) result = await workflow.list(actor, path[1], path[2] === 'audit');
      else if (request.method === 'POST' && path.join('/') === 'samples') result = await workflow.importDrafts(actor, sampleDrafts as any, workflow.rules.sampleNow);
      // Ordinary drafts use the workflow's real receipt clock; /samples freezes only
      // pricing/availability evaluation, while audit timestamps remain actual times.
      else if (request.method === 'POST' && path.join('/') === 'drafts') result = await workflow.importDrafts(actor, body.drafts);
      else if (request.method === 'POST' && path[0] === 'quotes' && path.length === 3 && ['review', 'approve', 'reject'].includes(path[2])) {
        if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 2000)) throw new ApiError(400, 'Note must be a string up to 2000 characters');
        result = await workflow.decide(actor, path[1], path[2], body.note);
      } else throw new ApiError(404, 'Endpoint not found');
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result));
    } catch (error) {
      // Business failures are already audited transactionally. Parse/route failures
      // are recorded here without copying request bodies or query values into audit.
      let status = error instanceof ApiError ? error.status : 500;
      try {
        if (!(error instanceof ApiError && error.audited)) await workflow.recordRequestFailure(actor, request.method ?? 'UNKNOWN', pathname, status);
      } catch { status = 500; }
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: status === 500 ? 'Internal error' : (error as Error).message }));
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = new URL('../', import.meta.url);
  const rules = await loadRules(new URL('config/approval-rules.json', root));
  // POC snapshots refresh on restart; pending approvers are not rerouted automatically.
  const reporting = await loadReporting(new URL('data-pack_platform/reporting_db/', root));
  const { drafts } = JSON.parse(await readFile(new URL('data-pack_platform/draft_quotes.json', root), 'utf8'));
  const workflow = new Workflow(fileURLToPath(new URL('var/quotes.json', root)), reporting, rules);
  await workflow.load();
  createApi(workflow, drafts).listen(3001, '127.0.0.1', () => console.log('Quote API: http://127.0.0.1:3001 (X-User-Id required)'));
}

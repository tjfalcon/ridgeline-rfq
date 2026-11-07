import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { loadReporting, duplicateKey } from '../src/routing.ts';
import { Workflow } from '../src/workflow.ts';
import { createApi } from '../src/server.ts';
const root = new URL('../', import.meta.url);

test('duplicate identity uses RFQ and line numbers even when parts/quantities change', () => {
  const draft: any = { rfq_id: 'RFQ-1009', lines: [{ line: 1, part_number: 'A', quantity: 2 }] };
  assert.equal(duplicateKey(draft), duplicateKey({ ...draft, lines: [{ line: 1, part_number: 'B', quantity: 99 }] }));
  assert.notEqual(duplicateKey(draft), duplicateKey({ ...draft, lines: [{ line: 2 }] }));
});

test('HTTP workflow, roles, audit, duplicate persistence, rejection and failed batch rollback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ridgeline-workflow-'));
  const rules = JSON.parse(await readFile(new URL('config/approval-rules.json', root), 'utf8'));
  const { drafts } = JSON.parse(await readFile(new URL('data-pack_platform/draft_quotes.json', root), 'utf8'));
  const reporting = await loadReporting(new URL('data-pack_platform/reporting_db/', root));
  const stock = createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ warehouses: { DAL: 100 }, as_of: rules.sampleNow })); });
  stock.listen(0, '127.0.0.1'); await once(stock, 'listening');
  rules.stockBaseUrl = `http://127.0.0.1:${(stock.address() as any).port}`;
  const path = join(directory, 'quotes.json');
  const workflow = new Workflow(path, reporting, rules, () => rules.sampleNow); await workflow.load();
  const api = createApi(workflow, drafts); api.listen(0, '127.0.0.1'); await once(api, 'listening');
  const url = `http://127.0.0.1:${(api.address() as any).port}`;
  const call = async (method: string, path: string, actor = 'S01', body?: any) => {
    const response = await fetch(url + path, { method, headers: { 'X-User-Id': actor, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    assert.equal((await call('GET', '/quotes', '')).status, 401);
    assert.equal((await call('POST', '/samples', 'U01')).status, 403);
    assert.equal((await call('POST', '/drafts', 'S01', { drafts: [null] })).status, 400);
    assert.equal((await call('POST', '/drafts', 'S01', { drafts: [{ draft_id: 'bad', rfq_id: 'RFQ' }] })).status, 400);
    const malformed = await fetch(url + '/drafts', { method: 'POST', headers: { 'X-User-Id': 'S01' }, body: '{secret: do-not-log-this' });
    assert.equal(malformed.status, 400);
    assert.equal((await call('GET', '/not-an-endpoint')).status, 404);
    const failureAudit = (await call('GET', '/audit')).body;
    assert.ok(failureAudit.some((e: any) => e.action === 'operation_failed' && e.actor === 'S01' && e.note === 'HTTP 400'));
    assert.ok(failureAudit.some((e: any) => e.action === 'request_failed' && e.note.includes('POST drafts HTTP 400')));
    assert.ok(failureAudit.some((e: any) => e.action === 'request_failed' && e.note.includes('HTTP 404')));
    assert.equal(JSON.stringify(failureAudit).includes('do-not-log-this'), false);
    const imported = await call('POST', '/samples'); assert.equal(imported.status, 200); assert.equal(imported.body.length, 10);
    assert.equal(imported.body[9].state, 'duplicate');
    const endpoint = '/quotes/DQ-24102';
    assert.equal((await call('POST', endpoint + '/approve', 'U01')).status, 403);
    assert.equal((await call('POST', endpoint + '/approve')).status, 409);
    assert.equal((await call('POST', endpoint + '/review')).body.state, 'approver_pending');
    assert.equal((await call('POST', endpoint + '/approve', 'U03')).status, 403);
    assert.equal((await call('POST', endpoint + '/approve', 'U01')).body.state, 'specialist_final_pending');
    assert.equal((await call('POST', endpoint + '/approve', 'U01')).status, 403);
    assert.equal((await call('POST', endpoint + '/approve')).body.state, 'approved');
    assert.equal((await call('POST', endpoint + '/approve')).status, 403);
    assert.equal((await call('POST', '/quotes/DQ-24101/approve')).body.state, 'approved');
    assert.equal((await call('POST', '/quotes/DQ-24105/approve')).status, 400);
    assert.equal((await call('POST', '/quotes/DQ-24105/approve', 'S01', { note: 'Confirmed extracted line against source RFQ' })).body.state, 'approved');
    assert.equal((await call('POST', '/quotes/DQ-24104/reject')).body.state, 'rejected');
    assert.equal((await call('POST', '/quotes/DQ-24110/approve')).status, 403);
    const audit = (await call('GET', endpoint + '/audit')).body;
    assert.ok(audit.some((e: any) => e.action === 'decision_denied' && e.actor === 'U03'));
    assert.deepEqual(audit.filter((e: any) => ['review', 'approve'].includes(e.action)).map((e: any) => [e.before, e.after]), [['specialist_pending', 'approver_pending'], ['approver_pending', 'specialist_final_pending'], ['specialist_final_pending', 'approved']]);
    const reloaded = new Workflow(path, reporting, rules, () => rules.sampleNow); await reloaded.load();
    assert.equal((await reloaded.list('S01', 'DQ-24102') as any).state, 'approved');
    const duplicate = { ...drafts[1], draft_id: 'new-duplicate', lines: drafts[1].lines.map((l: any) => ({ ...l, quantity: 999 })) };
    assert.equal((await reloaded.importDrafts('S01', [duplicate], rules.sampleNow))[0].routing.duplicate_of, 'DQ-24102');
    const before = reloaded.store.quotes.length;
    await assert.rejects(reloaded.importDrafts('S01', [{ ...drafts[0], draft_id: 'partial', rfq_id: 'new-rfq' }, { ...drafts[0], draft_id: 'invalid', rfq_id: 'bad', customer_id: 'missing' }], rules.sampleNow));
    assert.equal(reloaded.store.quotes.length, before);
  } finally {
    api.closeAllConnections(); stock.closeAllConnections();
    await Promise.all([new Promise<void>(r => api.close(() => r())), new Promise<void>(r => stock.close(() => r()))]);
    await rm(directory, { recursive: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createDemoHandler, loadDemoFixtures } from '../src/demo.ts';
import { MemoryWorkspaceRepository } from '../src/workspace-store.ts';

test('portfolio demo isolates visitors, saves policy, resets approvals, simulates stock and summarizes', async () => {
  const server = createServer(createDemoHandler(new MemoryWorkspaceRepository(), await loadDemoFixtures()));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  let cookie = '';
  const call = async (path: string, body?: any, actor = 'S01', visitor = cookie) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: visitor, 'X-User-Id': actor, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const issued = response.headers.get('set-cookie');
    if (!visitor && issued && !cookie) cookie = issued.split(';')[0];
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const preferenceScript = await fetch(base + '/preferences.js');
    assert.equal(preferenceScript.status, 200);
    assert.match(preferenceScript.headers.get('content-type') ?? '', /javascript/);
    const baseline = (await call('/demo/defaults')).body;
    assert.equal(baseline.rules.specialistMaxDiscountPct, 15);
    assert.equal((await call('/demo/config')).status, 200);
    assert.match(cookie, /^ridgeline_workspace=/);
    const quotes = (await call('/demo/quotes')).body;
    assert.equal(quotes.length, 10);
    assert.equal(quotes[1].policy_version, 1);
    await call('/demo/quotes/DQ-24102/review', {});
    assert.equal((await call('/demo/quotes/DQ-24102/approve', {}, 'U01')).body.state, 'specialist_final_pending');
    await call('/demo/quotes/DQ-24102/approve', {});
    assert.equal((await call('/demo/summary')).body.approved, 1);
    assert.equal((await call('/demo/config', { rules: { stockBaseUrl: 'http://untrusted.invalid' }, stockMode: 'healthy' })).status, 400);
    assert.equal((await call('/demo/config', { rules: { specialistMaxDiscountPct: 50 }, stockMode: 'healthy' })).status, 400);
    const changed = await call('/demo/config', { rules: { specialistMaxDiscountPct: 1 }, stockMode: 'unavailable' });
    assert.equal(changed.status, 200); assert.equal(changed.body.policyVersion, 2);
    assert.deepEqual((await call('/demo/defaults')).body, baseline);
    const reset = (await call('/demo/quotes')).body;
    assert.equal(reset[1].state, 'specialist_pending'); assert.equal(reset[1].policy_version, 2);
    assert.ok(reset[0].routing.specialist_review_flags.some((f: any) => f.reason === 'stock unavailable after retries'));
    assert.equal((await call('/demo/summary')).body.approved, 0);
    const secondVisitor = await call('/demo/config', undefined, 'S01', '');
    assert.equal(secondVisitor.body.policyVersion, 1); assert.equal(secondVisitor.body.rules.specialistMaxDiscountPct, 15);
    const audit = (await call('/demo/audit')).body;
    const policyEvent = audit.find((event: any) => event.action === 'policy_changed_samples_reset');
    assert.equal(JSON.parse(policyEvent.note).previous.rules.specialistMaxDiscountPct, 15);
    assert.equal(JSON.parse(policyEvent.note).next.rules.specialistMaxDiscountPct, 1);
    assert.equal((await call('/demo/config', { rules: { specialistMaxDiscountPct: 15 }, stockMode: 'stale' })).status, 200);
    assert.ok((await call('/demo/quotes')).body[0].routing.specialist_review_flags.some((f: any) => f.reason.includes('stock older')));
    assert.equal((await call('/demo/reset', {})).status, 200);
    const crossSite = await fetch(base + '/demo/reset', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://untrusted.invalid' }, body: '{}' });
    assert.equal(crossSite.status, 403);
    assert.equal((await call('/demo/reset', {}, 'U01')).status, 403);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

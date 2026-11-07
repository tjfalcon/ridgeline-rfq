import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MemoryWorkspaceRepository } from '../src/workspace-store.ts';
import type { Workspace } from '../src/workspace-store.ts';

const rules = JSON.parse(await readFile(new URL('../config/approval-rules.json', import.meta.url), 'utf8'));
const first = '12345678-1234-1234-1234-123456789012';
const second = '22345678-1234-1234-1234-123456789012';
const initial = async (): Promise<Workspace> => ({
  version: 1, rules: structuredClone(rules), stockMode: 'healthy', policyVersion: 1,
  store: { quotes: [], audit: [] }, createdAt: '2026-10-12T14:30:00.000Z', updatedAt: '2026-10-12T14:30:00.000Z'
});

test('workspace updates are isolated and returned references cannot mutate storage', async () => {
  const repository = new MemoryWorkspaceRepository();
  const returned = await repository.transact(first, initial, async workspace => { workspace.policyVersion = 7; return workspace; });
  returned.policyVersion = 99;
  assert.equal(await repository.transact(first, initial, async workspace => workspace.policyVersion), 7);
  assert.equal(await repository.transact(second, initial, async workspace => workspace.policyVersion), 1);
});

test('failed operations roll back and do not block later operations', async () => {
  const repository = new MemoryWorkspaceRepository();
  await repository.transact(first, initial, async () => null);
  await assert.rejects(repository.transact(first, initial, async workspace => { workspace.policyVersion = 8; throw new Error('failed'); }));
  assert.equal(await repository.transact(first, initial, async workspace => workspace.policyVersion), 1);
});

test('overlapping operations on one workspace serialize without lost updates', async () => {
  const repository = new MemoryWorkspaceRepository();
  const updates = Array.from({ length: 12 }, () => repository.transact(first, initial, async workspace => {
    const before = workspace.policyVersion;
    await new Promise(resolve => setTimeout(resolve, 2));
    workspace.policyVersion = before + 1;
  }));
  await Promise.all(updates);
  assert.equal(await repository.transact(first, initial, async workspace => workspace.policyVersion), 13);
});

test('expiry replaces abandoned workspaces and capacity does not silently evict live demos', async () => {
  let now = 1000;
  const repository = new MemoryWorkspaceRepository({ maximum: 1, clock: () => now });
  await repository.transact(first, initial, async workspace => { workspace.policyVersion = 9; });
  await assert.rejects(repository.transact(second, initial, async () => null), /capacity/);
  now += 24 * 60 * 60 * 1000;
  assert.equal(await repository.transact(second, initial, async workspace => workspace.policyVersion), 1);
});

test('invalid workspace identifiers and oversized state are rejected', async () => {
  const repository = new MemoryWorkspaceRepository();
  await assert.rejects(repository.transact('../workspace', initial, async () => null), /Invalid workspace/);
  await assert.rejects(repository.transact(first, initial, async workspace => {
    workspace.store.audit.push({ actor: 'S01', action: 'review', quote_id: null, timestamp: '2026-10-12T14:30:00.000Z', before: null, after: null, note: 'a'.repeat(2 * 1024 * 1024) });
  }), /size limit/);
  assert.equal(await repository.transact(first, initial, async workspace => workspace.store.audit.length), 0);
});

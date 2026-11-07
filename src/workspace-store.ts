import { Pool } from 'pg';
import type { Rules } from './routing.ts';
import type { Store } from './workflow.ts';

export type Workspace = {
  version: number;
  rules: Rules;
  stockMode: 'healthy' | 'unavailable' | 'stale';
  policyVersion: number;
  store: Store;
  createdAt: string;
  updatedAt: string;
};

export interface WorkspaceRepository {
  transact<T>(id: string, initial: () => Promise<Workspace>, operation: (workspace: Workspace) => Promise<T>): Promise<T>;
}

const dayMs = 24 * 60 * 60 * 1000;
const maxBytes = 2 * 1024 * 1024;

function validateId(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('Invalid workspace ID');
  }
}

function serialize(workspace: Workspace): string {
  const body = JSON.stringify(workspace);
  if (Buffer.byteLength(body, 'utf8') > maxBytes) throw new Error('Workspace size limit reached; reset the demo');
  return body;
}

/** Local demo storage: visitor state expires after 24 hours and is lost on restart. */
export class MemoryWorkspaceRepository implements WorkspaceRepository {
  private workspaces = new Map<string, { body: Workspace; expiresAt: number }>();
  private queues = new Map<string, Promise<void>>();
  private maximum: number;
  private clock: () => number;

  constructor(options: { maximum?: number; clock?: () => number } = {}) {
    this.maximum = options.maximum ?? 500;
    this.clock = options.clock ?? Date.now;
  }

  async transact<T>(id: string, initial: () => Promise<Workspace>, operation: (workspace: Workspace) => Promise<T>): Promise<T> {
    validateId(id);
    const previous = this.queues.get(id) ?? Promise.resolve();
    const result = previous.then(async () => {
      const now = this.clock();
      for (const [key, entry] of this.workspaces) {
        if (entry.expiresAt <= now) this.workspaces.delete(key);
      }
      const saved = this.workspaces.get(id);
      if (!saved && this.workspaces.size >= this.maximum) throw new Error('Demo capacity reached; try again later');
      const workspace = structuredClone(saved?.body ?? await initial());
      const output = await operation(workspace);
      workspace.updatedAt = new Date(this.clock()).toISOString();
      serialize(workspace);
      if (!this.workspaces.has(id) && this.workspaces.size >= this.maximum) throw new Error('Demo capacity reached; try again later');
      // Publish only a copy after success: thrown operations cannot partially mutate saved state.
      this.workspaces.set(id, { body: structuredClone(workspace), expiresAt: this.clock() + dayMs });
      return structuredClone(output);
    });
    const settled = result.then(() => {}, () => {});
    this.queues.set(id, settled);
    try { return await result; }
    finally { if (this.queues.get(id) === settled) this.queues.delete(id); }
  }
}

/** Shared persistence for serverless instances; one transaction owns each workspace. */
export class PostgresWorkspaceRepository implements WorkspaceRepository {
  private pool: Pool;
  private schema: Promise<void> | undefined;

  constructor(connectionString: string) {
    if (!connectionString) throw new Error('Database connection is required');
    this.pool = new Pool({ connectionString, max: 3, connectionTimeoutMillis: 10000, idleTimeoutMillis: 10000 });
  }

  private async prepare(): Promise<void> {
    if (!this.schema) {
      this.schema = this.pool.query(`CREATE TABLE IF NOT EXISTS ridgeline_demo_workspaces (
        id text PRIMARY KEY,
        body jsonb NOT NULL,
        expires_at timestamptz NOT NULL
      )`).then(() => {}).catch(error => { this.schema = undefined; throw error; });
    }
    await this.schema;
  }

  async transact<T>(id: string, initial: () => Promise<Workspace>, operation: (workspace: Workspace) => Promise<T>): Promise<T> {
    validateId(id);
    await this.prepare();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // The advisory lock also serializes concurrent first requests before a row exists.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [id]);
      const saved = await client.query<{ body: Workspace; active: boolean }>(
        'SELECT body, expires_at > NOW() AS active FROM ridgeline_demo_workspaces WHERE id = $1 FOR UPDATE', [id]);
      const row = saved.rows[0];
      const workspace = structuredClone(row?.active ? row.body : await initial());
      const result = await operation(workspace);
      workspace.updatedAt = new Date().toISOString();
      await client.query(`INSERT INTO ridgeline_demo_workspaces (id, body, expires_at)
        VALUES ($1, $2::jsonb, NOW() + INTERVAL '24 hours')
        ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body, expires_at = EXCLUDED.expires_at`,
        [id, serialize(workspace)]);
      // Small bounded cleanup makes abandoned demos expire without a separate scheduler.
      await client.query(`DELETE FROM ridgeline_demo_workspaces WHERE id IN (
        SELECT id FROM ridgeline_demo_workspaces WHERE expires_at <= NOW() LIMIT 20 FOR UPDATE SKIP LOCKED
      )`);
      await client.query('COMMIT');
      return structuredClone(result);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async close(): Promise<void> { await this.pool.end(); }
}

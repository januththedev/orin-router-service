/**
 * Neon-backed store. One dependency (@neondatabase/serverless); everything
 * else is SQL in schema.sql. Provider credentials are AES-GCM encrypted
 * with ROUTER_MASTER_KEY — the DB never holds them in plaintext.
 */
import crypto from 'node:crypto';
import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import type { ApiKeyRecord, ProviderDef, RouteDef, UsageLog } from './types.js';

export interface RouterStore {
  getProviders(): Promise<ProviderDef[]>;
  saveProvider(p: ProviderDef): Promise<void>;
  deleteProvider(id: string): Promise<void>;
  getRoutes(): Promise<RouteDef[]>;
  saveRoute(r: RouteDef): Promise<void>;
  deleteRoute(id: string): Promise<void>;
  createKey(rec: ApiKeyRecord): Promise<void>;
  listKeys(): Promise<Omit<ApiKeyRecord, 'hash'>[]>;
  findKeyByHash(hash: string): Promise<ApiKeyRecord | null>;
  revokeKey(id: string): Promise<void>;
  log(entry: UsageLog): Promise<void>;
  queryLogs(opts: { limit?: number; status?: string; provider?: string }): Promise<UsageLog[]>;
  stats(): Promise<{ total: number; ok: number; errors: number; avgLatencyMs: number; byProvider: Record<string, number> }>;
}

function masterKey(): Buffer {
  const raw = process.env.ROUTER_MASTER_KEY || '';
  if (raw.length < 32) throw new Error('ROUTER_MASTER_KEY not configured (min 32 chars)');
  return crypto.createHash('sha256').update(raw).digest();
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${enc.toString('base64')}.${cipher.getAuthTag().toString('base64')}`;
}

export function decryptSecret(blob: string): string {
  const [ivB, encB, tagB] = String(blob).split('.');
  if (!ivB || !encB || !tagB) throw new Error('Bad ciphertext');
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encB, 'base64')), decipher.final()]).toString('utf8');
}

export function neonStore(url: string): RouterStore {
  const sql = neon(url) as NeonQueryFunction<false, false>;

  return {
    async getProviders() {
      const rows = await sql`SELECT id, type, base_url, api_key_enc, models, enabled FROM router_providers`;
      return rows.map((r: any) => ({
        id: r.id, type: r.type, baseUrl: r.base_url,
        apiKey: decryptSecret(r.api_key_enc),
        models: r.models ?? [], enabled: r.enabled !== false,
      }));
    },
    async saveProvider(p) {
      await sql`INSERT INTO router_providers(id, type, base_url, api_key_enc, models, enabled, updated_at)
        VALUES(${p.id}, ${p.type}, ${p.baseUrl}, ${encryptSecret(p.apiKey)}, ${JSON.stringify(p.models ?? [])}::jsonb, ${p.enabled !== false}, now())
        ON CONFLICT(id) DO UPDATE SET type=EXCLUDED.type, base_url=EXCLUDED.base_url, api_key_enc=EXCLUDED.api_key_enc,
          models=EXCLUDED.models, enabled=EXCLUDED.enabled, updated_at=now()`;
    },
    async deleteProvider(id) {
      await sql`DELETE FROM router_providers WHERE id=${id}`;
    },
    async getRoutes() {
      const rows = await sql`SELECT id, hops, enabled FROM router_routes`;
      return rows.map((r: any) => ({ id: r.id, hops: r.hops ?? [], enabled: r.enabled !== false }));
    },
    async saveRoute(r) {
      await sql`INSERT INTO router_routes(id, hops, enabled, updated_at)
        VALUES(${r.id}, ${JSON.stringify(r.hops ?? [])}::jsonb, ${r.enabled !== false}, now())
        ON CONFLICT(id) DO UPDATE SET hops=EXCLUDED.hops, enabled=EXCLUDED.enabled, updated_at=now()`;
    },
    async deleteRoute(id) {
      await sql`DELETE FROM router_routes WHERE id=${id}`;
    },
    async revokeKey(id) {
      await sql`UPDATE router_keys SET enabled=FALSE WHERE id=${id}`;
    },
    async createKey(rec) {
      await sql`INSERT INTO router_keys(id, prefix, hash, name, per_min, enabled, created_at)
        VALUES(${rec.id}, ${rec.prefix}, ${rec.hash}, ${rec.name}, ${rec.perMin ?? 0}, ${rec.enabled !== false}, ${rec.createdAt})`;
    },
    async listKeys() {
      const rows = await sql`SELECT id, prefix, name, per_min, enabled, created_at FROM router_keys ORDER BY created_at DESC`;
      return rows.map((r: any) => ({
        id: r.id, prefix: r.prefix, name: r.name,
        perMin: Number(r.per_min) || 0, enabled: r.enabled !== false, createdAt: Number(r.created_at),
      }));
    },
    async findKeyByHash(hash) {
      const rows = await sql`SELECT id, prefix, hash, name, per_min, enabled, created_at FROM router_keys WHERE hash=${hash} LIMIT 1`;
      const r = rows[0] as any;
      if (!r) return null;
      return {
        id: r.id, prefix: r.prefix, hash: r.hash, name: r.name,
        perMin: Number(r.per_min) || 0, enabled: r.enabled !== false, createdAt: Number(r.created_at),
      };
    },
    async log(e) {
      await sql`INSERT INTO router_logs(request_id, key_prefix, route, provider, model, status, latency_ms, error, prompt_chars, completion_chars, at)
        VALUES(${e.requestId}, ${e.keyPrefix}, ${e.route}, ${e.provider ?? null}, ${e.model ?? null}, ${e.status}, ${e.latencyMs},
          ${e.error ?? null}, ${e.promptChars ?? 0}, ${e.completionChars ?? 0}, ${e.at})`;
    },
    async queryLogs(opts) {
      const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
      const rows = await sql`SELECT request_id, key_prefix, route, provider, model, status, latency_ms, error, prompt_chars, completion_chars, at
        FROM router_logs
        WHERE (${opts.status ?? null} IS NULL OR status=${opts.status ?? ''})
          AND (${opts.provider ?? null} IS NULL OR provider=${opts.provider ?? ''})
        ORDER BY at DESC LIMIT ${limit}`;
      return rows.map((r: any) => ({
        requestId: r.request_id, keyPrefix: r.key_prefix, route: r.route, provider: r.provider ?? undefined,
        model: r.model ?? undefined, status: r.status, latencyMs: Number(r.latency_ms), error: r.error ?? undefined,
        promptChars: Number(r.prompt_chars) || 0, completionChars: Number(r.completion_chars) || 0, at: Number(r.at),
      }));
    },
    async stats() {
      const rows = await sql`SELECT status, provider, AVG(latency_ms)::float AS avg, COUNT(*)::int AS n FROM router_logs GROUP BY status, provider`;
      let total = 0, ok = 0, errors = 0, latSum = 0, latN = 0;
      const byProvider: Record<string, number> = {};
      for (const r of rows as any[]) {
        total += r.n;
        if (r.status === 'ok') ok++; else errors++;
        byProvider[r.provider || 'none'] = (byProvider[r.provider || 'none'] || 0) + r.n;
        latSum += (r.avg || 0) * r.n; latN += r.n;
      }
      return { total, ok, errors, avgLatencyMs: latN ? Math.round(latSum / latN) : 0, byProvider };
    },
  };
}

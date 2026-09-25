import { createHash, randomBytes, randomUUID } from "node:crypto";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { RouterError } from "./errors.js";

export interface GatewayKeyRecord {
  id: string;
  accountId: string;
  label: string;
  fingerprint: string;
  status: "active" | "revoked";
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

export interface GatewayKeyStore {
  insert(record: GatewayKeyRecord & { hash: string }): Promise<void>;
  getByHash(hash: string): Promise<(GatewayKeyRecord & { hash: string }) | null>;
  list(accountId: string): Promise<GatewayKeyRecord[]>;
  revoke(accountId: string, id: string): Promise<boolean>;
  touch(id: string, usedAt: string): Promise<void>;
}

export class MemoryGatewayKeyStore implements GatewayKeyStore {
  private readonly rows = new Map<string, GatewayKeyRecord & { hash: string }>();
  async insert(record: GatewayKeyRecord & { hash: string }) { this.rows.set(record.hash, structuredClone(record)); }
  async getByHash(hash: string) { const row = this.rows.get(hash); return row ? structuredClone(row) : null; }
  async list(accountId: string) { return [...this.rows.values()].filter((row) => row.accountId === accountId).map(({ hash: _hash, ...row }) => structuredClone(row)); }
  async revoke(accountId: string, id: string) { for (const [hash, row] of this.rows) if (row.accountId === accountId && row.id === id) { row.status = "revoked"; this.rows.set(hash, row); return true; } return false; }
  async touch(id: string, usedAt: string) { for (const [hash, row] of this.rows) if (row.id === id) { row.lastUsedAt = usedAt; this.rows.set(hash, row); } }
}

export class NeonGatewayKeyStore implements GatewayKeyStore {
  private readonly sql: NeonQueryFunction<false, false>;
  constructor(databaseUrl: string) { this.sql = neon(databaseUrl) as NeonQueryFunction<false, false>; }
  async insert(record: GatewayKeyRecord & { hash: string }) { await this.sql`INSERT INTO orin_router.gateway_keys(id, account_id, label, fingerprint, key_hash, status, created_at, expires_at, last_used_at) VALUES(${record.id}, ${record.accountId}, ${record.label}, ${record.fingerprint}, ${record.hash}, ${record.status}, ${record.createdAt}, ${record.expiresAt}, ${record.lastUsedAt})`; }
  async getByHash(hash: string) { const rows = await this.sql`SELECT id, account_id, label, fingerprint, key_hash, status, created_at, expires_at, last_used_at FROM orin_router.gateway_keys WHERE key_hash=${hash} LIMIT 1`; return rows[0] ? this.row(rows[0]) : null; }
  async list(accountId: string) { const rows = await this.sql`SELECT id, account_id, label, fingerprint, key_hash, status, created_at, expires_at, last_used_at FROM orin_router.gateway_keys WHERE account_id=${accountId} ORDER BY created_at DESC`; return rows.map((row) => { const { hash: _hash, ...safe } = this.row(row); return safe; }); }
  async revoke(accountId: string, id: string) { const result = await this.sql`UPDATE orin_router.gateway_keys SET status='revoked' WHERE id=${id} AND account_id=${accountId} AND status='active'`; return Number(result?.[0]?.count ?? 0) > 0; }
  async touch(id: string, usedAt: string) { await this.sql`UPDATE orin_router.gateway_keys SET last_used_at=${usedAt} WHERE id=${id}`; }
  private row(row: any): GatewayKeyRecord & { hash: string } { return { id: String(row.id), accountId: String(row.account_id), label: String(row.label), fingerprint: String(row.fingerprint), hash: String(row.key_hash), status: row.status, createdAt: new Date(row.created_at).toISOString(), expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null, lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null }; }
}

export class GatewayKeyManager {
  private readonly store: GatewayKeyStore;
  constructor(store: GatewayKeyStore) { this.store = store; }

  async create(accountId: string, label: string): Promise<{ record: GatewayKeyRecord; secret: string }> {
    if (!/^[\w-]{3,80}$/.test(accountId)) throw new RouterError("ORIN_VALIDATION_FAILED", "Invalid account id.");
    const cleanLabel = String(label || "default").trim().slice(0, 80);
    if (!cleanLabel) throw new RouterError("ORIN_VALIDATION_FAILED", "Key label is required.");
    const secret = `orin_${randomBytes(32).toString("base64url")}`;
    const record: GatewayKeyRecord & { hash: string } = { id: randomUUID(), accountId, label: cleanLabel, fingerprint: createHash("sha256").update(secret).digest("hex").slice(0, 16), hash: createHash("sha256").update(secret).digest("hex"), status: "active", createdAt: new Date().toISOString(), expiresAt: null, lastUsedAt: null };
    await this.store.insert(record);
    const { hash: _hash, ...safe } = record;
    return { record: safe, secret };
  }

  async list(accountId: string) { return this.store.list(accountId); }
  async revoke(accountId: string, id: string) { if (!(await this.store.revoke(accountId, id))) throw new RouterError("ORIN_MODEL_NOT_FOUND", "Gateway key not found."); }
  async verify(secret: string): Promise<GatewayKeyRecord | null> {
    if (!/^orin_[A-Za-z0-9_-]{43}$/.test(secret)) return null;
    const row = await this.store.getByHash(createHash("sha256").update(secret).digest("hex"));
    if (!row || row.status !== "active" || (row.expiresAt && Date.parse(row.expiresAt) <= Date.now())) return null;
    await this.store.touch(row.id, new Date().toISOString());
    return row;
  }
}

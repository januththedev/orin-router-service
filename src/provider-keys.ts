import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { RouterError } from "./errors.js";

const ALLOWED_PROVIDERS = new Set(["openai", "anthropic", "openrouter", "groq", "deepseek", "google", "custom"]);
const VERSION = 1;

export interface ProviderKeyRecord {
  id: string;
  accountId: string;
  provider: string;
  label: string;
  fingerprint: string;
  status: "active" | "revoked";
  createdAt: string;
  lastRevealedAt: string | null;
  expiresAt: string | null;
}

interface StoredProviderKey extends ProviderKeyRecord {
  encrypted: EncryptedKey;
}

export interface EncryptedKey { v: number; iv: string; tag: string; ciphertext: string; }
export interface ProviderKeyStore {
  insert(record: StoredProviderKey): Promise<void>;
  get(id: string): Promise<StoredProviderKey | null>;
  list(accountId: string): Promise<StoredProviderKey[]>;
  update(record: StoredProviderKey): Promise<void>;
}

export class MemoryProviderKeyStore implements ProviderKeyStore {
  private readonly rows = new Map<string, StoredProviderKey>();
  async insert(record: StoredProviderKey) { this.rows.set(record.id, structuredClone(record)); }
  async get(id: string) { const row = this.rows.get(id); return row ? structuredClone(row) : null; }
  async list(accountId: string) { return [...this.rows.values()].filter((row) => row.accountId === accountId).map((row) => structuredClone(row)); }
  async update(record: StoredProviderKey) { this.rows.set(record.id, structuredClone(record)); }
}

export class NeonProviderKeyStore implements ProviderKeyStore {
  private readonly sql: NeonQueryFunction<false, false>;
  constructor(databaseUrl: string) { this.sql = neon(databaseUrl) as NeonQueryFunction<false, false>; }
  async insert(record: StoredProviderKey) {
    await this.sql`INSERT INTO orin_router.provider_keys(id, account_id, provider, label, fingerprint, status, created_at, last_revealed_at, expires_at, encrypted) VALUES(${record.id}, ${record.accountId}, ${record.provider}, ${record.label}, ${record.fingerprint}, ${record.status}, ${record.createdAt}, ${record.lastRevealedAt}, ${record.expiresAt}, ${JSON.stringify(record.encrypted)})`;
  }
  async get(id: string) {
    const rows = await this.sql`SELECT id, account_id, provider, label, fingerprint, status, created_at, last_revealed_at, expires_at, encrypted FROM orin_router.provider_keys WHERE id=${id} LIMIT 1`;
    return rows[0] ? this.row(rows[0]) : null;
  }
  async list(accountId: string) {
    const rows = await this.sql`SELECT id, account_id, provider, label, fingerprint, status, created_at, last_revealed_at, expires_at, encrypted FROM orin_router.provider_keys WHERE account_id=${accountId} ORDER BY created_at DESC`;
    return rows.map((row) => this.row(row));
  }
  async update(record: StoredProviderKey) {
    await this.sql`UPDATE orin_router.provider_keys SET label=${record.label}, status=${record.status}, last_revealed_at=${record.lastRevealedAt}, expires_at=${record.expiresAt}, encrypted=${JSON.stringify(record.encrypted)} WHERE id=${record.id}`;
  }
  private row(row: any): StoredProviderKey {
    return { id: String(row.id), accountId: String(row.account_id), provider: String(row.provider), label: String(row.label), fingerprint: String(row.fingerprint), status: row.status, createdAt: new Date(row.created_at).toISOString(), lastRevealedAt: row.last_revealed_at ? new Date(row.last_revealed_at).toISOString() : null, expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null, encrypted: typeof row.encrypted === 'string' ? JSON.parse(row.encrypted) : row.encrypted };
  }
}

function decodeKek(raw: string): Buffer {
  const value = Buffer.from(raw, "base64");
  if (value.length !== 32) throw new RouterError("ORIN_VALIDATION_FAILED", "Provider key encryption key is not 32 bytes.");
  return value;
}

function encrypt(secret: string, kek: Buffer): EncryptedKey {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", kek, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return { v: VERSION, iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") };
}

function decrypt(value: EncryptedKey, kek: Buffer): string {
  if (value.v !== VERSION) throw new RouterError("ORIN_VALIDATION_FAILED", "Provider key envelope is not supported.");
  const decipher = createDecipheriv("aes-256-gcm", kek, Buffer.from(value.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

function fingerprint(secret: string) { return createHash("sha256").update(secret).digest("hex").slice(0, 16); }
function metadata(row: StoredProviderKey): ProviderKeyRecord { const { encrypted: _encrypted, ...safe } = row; return safe; }

export class ProviderKeyManager {
  private readonly store: ProviderKeyStore;
  private readonly kek: string;
  constructor(store: ProviderKeyStore, kek: string) { this.store = store; this.kek = kek; }

  async create(accountId: string, provider: string, label: string, secret: string): Promise<{ record: ProviderKeyRecord; secret?: string }> {
    if (!/^[\w-]{3,80}$/.test(accountId)) throw new RouterError("ORIN_VALIDATION_FAILED", "Invalid account id.");
    if (!ALLOWED_PROVIDERS.has(provider)) throw new RouterError("ORIN_VALIDATION_FAILED", "Unsupported provider.");
    const cleanLabel = String(label || "default").trim().slice(0, 80);
    if (!cleanLabel) throw new RouterError("ORIN_VALIDATION_FAILED", "Key label is required.");
    if (typeof secret !== "string" || secret.length < 16 || secret.length > 4096) throw new RouterError("ORIN_VALIDATION_FAILED", "Provider key length is invalid.");
    const row: StoredProviderKey = {
      id: randomUUID(), accountId, provider, label: cleanLabel, fingerprint: fingerprint(secret), status: "active",
      createdAt: new Date().toISOString(), lastRevealedAt: null, expiresAt: null, encrypted: encrypt(secret, decodeKek(this.kek)),
    };
    await this.store.insert(row);
    return { record: metadata(row), secret };
  }

  async list(accountId: string) { return (await this.store.list(accountId)).map(metadata); }

  async revealOnce(accountId: string, id: string): Promise<string | null> {
    const row = await this.store.get(id);
    if (!row || row.accountId !== accountId || row.status !== "active" || row.lastRevealedAt) return null;
    const secret = decrypt(row.encrypted, decodeKek(this.kek));
    row.lastRevealedAt = new Date().toISOString();
    await this.store.update(row);
    return secret;
  }

  async revoke(accountId: string, id: string) {
    const row = await this.store.get(id);
    if (!row || row.accountId !== accountId) throw new RouterError("ORIN_MODEL_NOT_FOUND", "Provider key not found.");
    row.status = "revoked";
    await this.store.update(row);
    return metadata(row);
  }

  async rotate(accountId: string, id: string, secret: string) {
    const old = await this.store.get(id);
    if (!old || old.accountId !== accountId || old.status !== "active") throw new RouterError("ORIN_MODEL_NOT_FOUND", "Active provider key not found.");
    old.status = "revoked";
    await this.store.update(old);
    return this.create(accountId, old.provider, old.label, secret);
  }
}

export function constantTimeEqual(a: string, b: string) {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

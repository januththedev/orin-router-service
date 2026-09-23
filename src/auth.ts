/**
 * Owner auth: accepts an Orin session token OR an Orin MCP credential
 * (same scheme as Orin core + Orin Console). Returns the Orin uid that owns
 * the providers/keys/logs touched by this request. Fail closed everywhere.
 */
import crypto from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { OrinError } from './errors.js';

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function verifySessionToken(token: string, key: string): string {
  const parts = token.split('.');
  if (parts.length !== 3) throw new OrinError('authentication', 'Invalid session.');
  const [h, p, s] = parts;
  let header: any, payload: any;
  try {
    header = JSON.parse(b64urlDecode(h).toString('utf8'));
    payload = JSON.parse(b64urlDecode(p).toString('utf8'));
  } catch {
    throw new OrinError('authentication', 'Invalid session.');
  }
  if (header.alg !== 'HS256' || payload.iss !== 'orin' || typeof payload.uid !== 'string') {
    throw new OrinError('authentication', 'Invalid session.');
  }
  const expect = crypto.createHmac('sha256', key).update(`${h}.${p}`).digest();
  const got = b64urlDecode(s);
  if (expect.length !== got.length || !crypto.timingSafeEqual(expect, got)) {
    throw new OrinError('authentication', 'Invalid session.');
  }
  if (typeof payload.exp === 'number' && Date.now() / 1000 > payload.exp) {
    throw new OrinError('authentication', 'Session expired.');
  }
  return payload.uid as string;
}

async function sessionRevoked(dbUrl: string, token: string): Promise<boolean> {
  try {
    const sql: any = neon(dbUrl);
    const rows = await sql`SELECT revoked FROM sessions WHERE token = ${token} LIMIT 1`;
    if (rows.length === 0) return true;
    return rows[0].revoked === true;
  } catch {
    return true; // DB unreachable -> deny
  }
}

async function verifyMcpToken(dbUrl: string, token: string): Promise<string> {
  const secret = token.slice('orin_mcp_'.length);
  const jti = secret.split('.')[0];
  if (!jti) throw new OrinError('authentication', 'Invalid credential.');
  const hash = crypto.createHash('sha256').update(secret).digest('hex');
  try {
    const sql: any = neon(dbUrl);
    const rows = await sql`SELECT user_id, secret_hash, expires_at, revoked_at
      FROM mcp_credentials WHERE jti = ${jti} LIMIT 1`;
    if (!rows.length) throw new OrinError('authentication', 'Invalid credential.');
    const r = rows[0];
    const a = Buffer.from(r.secret_hash, 'hex');
    const b = Buffer.from(hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new OrinError('authentication', 'Invalid credential.');
    }
    if (r.revoked_at || new Date(r.expires_at).getTime() < Date.now()) {
      throw new OrinError('authentication', 'Credential revoked or expired.');
    }
    return r.user_id as string;
  } catch (e) {
    if (e instanceof OrinError) throw e;
    throw new OrinError('authentication', 'Authentication unavailable.');
  }
}

/** req is a Vercel Node req (headers object). Returns owner uid. */
export async function requireOwner(req: any, cfg: { databaseUrl: string; tokenKey: string }): Promise<string> {
  const h = req.headers?.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(h).trim());
  if (!m) throw new OrinError('authentication', 'Missing bearer token.');
  const token = m[1];
  if (token.startsWith('orin_mcp_')) return verifyMcpToken(cfg.databaseUrl, token);
  const uid = verifySessionToken(token, cfg.tokenKey);
  if (await sessionRevoked(cfg.databaseUrl, token)) throw new OrinError('authentication', 'Session revoked.');
  return uid;
}

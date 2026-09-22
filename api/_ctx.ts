/** Shared Vercel plumbing: config, store singleton, admin gate, errors. */
import { loadConfig } from '../src/config.js';
import { OrinError } from '../src/errors.js';
import { neonStore, type RouterStore } from '../src/store.js';

let store: RouterStore | null = null;
let adminSecret = '';

export function ctx(): { store: RouterStore; adminSecret: string } {
  if (!store) {
    const cfg = loadConfig();
    store = neonStore(cfg.databaseUrl);
    adminSecret = cfg.adminSecret;
  }
  return { store, adminSecret };
}

export function requireAdmin(req: any): void {
  const { adminSecret } = ctx();
  const got = (req.headers?.['x-admin-secret'] as string) || '';
  if (!got || got !== adminSecret) throw new OrinError('authorization', 'Admin secret required (X-Admin-Secret).');
}

export function sendError(res: any, e: unknown): void {
  if (e instanceof OrinError) {
    res.status(e.status).json(e.toResponse());
    return;
  }
  res.status(500).json({ error: { message: 'Router failed.', type: 'internal', code: 'internal' } });
}

export function jsonBody(req: any): any {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body) {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return {};
}

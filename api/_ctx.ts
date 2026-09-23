/** Shared Vercel plumbing: config, store singleton, owner auth, errors. */
import { loadConfig, type RouterConfig } from '../src/config.js';
import { requireOwner } from '../src/auth.js';
import { OrinError } from '../src/errors.js';
import { neonStore, type RouterStore } from '../src/store.js';

let store: RouterStore | null = null;
let cfg: RouterConfig | null = null;

export function ctx(): { store: RouterStore; cfg: RouterConfig } {
  if (!store || !cfg) {
    cfg = loadConfig();
    store = neonStore(cfg.databaseUrl);
  }
  return { store, cfg };
}

/** Owner uid from Orin session or MCP credential. Throws OrinError (401). */
export async function owner(req: any): Promise<{ uid: string; store: RouterStore }> {
  const c = ctx();
  const uid = await requireOwner(req, c.cfg);
  return { uid, store: c.store };
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

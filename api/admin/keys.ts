/**
 * Admin: API keys. The full secret is returned EXACTLY ONCE at creation and
 * never again — list shows prefixes only, hashes never leave the database.
 */
import crypto from 'node:crypto';
import { mintKey } from '../../src/keys.js';
import { ctx, jsonBody, requireAdmin, sendError } from '../_ctx.js';

export const config = { maxDuration: 30 };

export default async function handler(req: any, res: any): Promise<void> {
  try {
    requireAdmin(req);
    const { store } = ctx();
    if (req.method === 'GET') {
      res.status(200).json({ keys: await store.listKeys() });
      return;
    }
    if (req.method === 'POST') {
      const b = jsonBody(req);
      const { name = '', perMin = 0 } = b ?? {};
      const minted = mintKey();
      await store.createKey({
        id: 'key_' + crypto.randomBytes(8).toString('hex'),
        prefix: minted.prefix,
        hash: minted.hash,
        name: String(name || '').slice(0, 100),
        perMin: Math.max(0, Number(perMin) || 0),
        enabled: true,
        createdAt: Date.now(),
      });
      res.status(200).json({ key: minted.secret, prefix: minted.prefix, note: 'Shown once — store it now.' });
      return;
    }
    if (req.method === 'DELETE') {
      const id = String(req.query?.id || '');
      if (!id) {
        res.status(400).json({ error: { message: 'Query ?id required.', type: 'validation', code: 'validation' } });
        return;
      }
      await store.revokeKey(id);
      res.status(200).json({ ok: true });
      return;
    }
    res.setHeader('Allow', 'GET, POST, DELETE');
    res.status(405).json({ error: { message: 'GET/POST/DELETE only', type: 'validation', code: 'validation' } });
  } catch (e) {
    sendError(res, e);
  }
}

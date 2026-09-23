/**
 * User gateway keys: mint the ONE api key, list prefixes, revoke.
 * The secret is shown exactly once at mint — never stored, never re-shown.
 */
import { mintUserKey } from '../src/service.js';
import { jsonBody, owner, sendError } from './_ctx.js';

export const config = { maxDuration: 30 };

export default async function handler(req: any, res: any): Promise<void> {
  try {
    const { uid, store } = await owner(req);
    if (req.method === 'GET') {
      res.status(200).json({ keys: await store.listKeys(uid) });
      return;
    }
    if (req.method === 'POST') {
      const b = jsonBody(req);
      res.status(201).json(await mintUserKey(store, uid, String(b?.name || ''), b?.perMin));
      return;
    }
    if (req.method === 'DELETE') {
      const id = String(req.query?.id || '');
      if (!id) {
        res.status(400).json({ error: { message: 'Query ?id required.', type: 'validation', code: 'validation' } });
        return;
      }
      await store.revokeKey(uid, id);
      res.status(200).json({ revoked: true });
      return;
    }
    res.setHeader('Allow', 'GET, POST, DELETE');
    res.status(405).json({ error: { message: 'GET/POST/DELETE only', type: 'validation', code: 'validation' } });
  } catch (e) {
    sendError(res, e);
  }
}

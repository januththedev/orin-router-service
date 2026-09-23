/**
 * User providers: add many APIs, list them, test them, delete them.
 * Owner auth (Orin session/MCP). Secrets accepted, never returned.
 */
import { addProvider, publicProviders, testProvider } from '../src/service.js';
import { ctx, jsonBody, owner, sendError } from './_ctx.js';

export const config = { maxDuration: 60 };

export default async function handler(req: any, res: any): Promise<void> {
  try {
    const { uid, store } = await owner(req);
    if (req.method === 'GET') {
      res.status(200).json({ providers: publicProviders(await store.getProviders(uid)) });
      return;
    }
    if (req.method === 'POST') {
      const b = jsonBody(req);
      if (b?.action === 'test') {
        const id = String(b.id || '');
        if (!id) {
          res.status(400).json({ error: { message: 'Field "id" required.', type: 'validation', code: 'validation' } });
          return;
        }
        res.status(200).json(await testProvider(ctx(), uid, id, typeof b.model === 'string' ? b.model : undefined));
        return;
      }
      res.status(200).json({ ok: true, ...(await addProvider(store, uid, b ?? {})) });
      return;
    }
    if (req.method === 'DELETE') {
      const id = String(req.query?.id || '');
      if (!id) {
        res.status(400).json({ error: { message: 'Query ?id required.', type: 'validation', code: 'validation' } });
        return;
      }
      await store.deleteProvider(uid, id);
      res.status(200).json({ ok: true });
      return;
    }
    res.setHeader('Allow', 'GET, POST, DELETE');
    res.status(405).json({ error: { message: 'GET/POST/DELETE only', type: 'validation', code: 'validation' } });
  } catch (e) {
    sendError(res, e);
  }
}

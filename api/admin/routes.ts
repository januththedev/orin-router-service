/** Admin: routes (aliases → ordered provider/model hops). X-Admin-Secret required. */
import { ctx, jsonBody, requireAdmin, sendError } from '../_ctx.js';

export const config = { maxDuration: 30 };

export default async function handler(req: any, res: any): Promise<void> {
  try {
    requireAdmin(req);
    const { store } = ctx();
    if (req.method === 'GET') {
      res.status(200).json({ routes: await store.getRoutes() });
      return;
    }
    if (req.method === 'POST') {
      const b = jsonBody(req);
      const { id, hops = [], enabled = true } = b ?? {};
      if (!id || typeof id !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(id)) {
        res.status(400).json({ error: { message: 'Field "id" ([a-z0-9_-], ≤64) required.', type: 'validation', code: 'validation' } });
        return;
      }
      if (!Array.isArray(hops) || !hops.length || hops.length > 20) {
        res.status(400).json({ error: { message: 'Field "hops" needs 1–20 {provider, model} entries.', type: 'validation', code: 'validation' } });
        return;
      }
      for (const h of hops) {
        if (!h || typeof h.provider !== 'string' || typeof h.model !== 'string' || !h.provider || !h.model) {
          res.status(400).json({ error: { message: 'Every hop needs {provider, model} strings.', type: 'validation', code: 'validation' } });
          return;
        }
      }
      const providers = new Set((await store.getProviders()).filter((p) => p.enabled).map((p) => p.id));
      const unknown = hops.map((h: any) => h.provider).filter((p: string) => !providers.has(p));
      if (unknown.length) {
        res.status(400).json({ error: { message: `Unknown/disabled providers: ${[...new Set(unknown)].join(', ')}`, type: 'validation', code: 'validation' } });
        return;
      }
      await store.saveRoute({
        id, hops: hops.map((h: any) => ({ provider: h.provider, model: h.model })), enabled: enabled !== false,
      });
      res.status(200).json({ ok: true, id });
      return;
    }
    if (req.method === 'DELETE') {
      const id = String(req.query?.id || '');
      if (!id) {
        res.status(400).json({ error: { message: 'Query ?id required.', type: 'validation', code: 'validation' } });
        return;
      }
      await store.deleteRoute(id);
      res.status(200).json({ ok: true });
      return;
    }
    res.setHeader('Allow', 'GET, POST, DELETE');
    res.status(405).json({ error: { message: 'GET/POST/DELETE only', type: 'validation', code: 'validation' } });
  } catch (e) {
    sendError(res, e);
  }
}

/** Admin: providers. X-Admin-Secret required. apiKeys accepted, never returned. */
import { validateBaseUrl } from '../../src/validate.js';
import { ctx, jsonBody, requireAdmin, sendError } from '../_ctx.js';

export const config = { maxDuration: 30 };

const TYPES = new Set(['openrouter', 'groq', 'custom']);

export default async function handler(req: any, res: any): Promise<void> {
  try {
    requireAdmin(req);
    const { store } = ctx();
    if (req.method === 'GET') {
      const all = await store.getProviders();
      // Strip secrets — the admin list shows shape, never credentials.
      res.status(200).json({
        providers: all.map((p) => ({
          id: p.id, type: p.type, baseUrl: p.baseUrl,
          models: p.models, enabled: p.enabled, hasKey: p.apiKey.length > 0,
        })),
      });
      return;
    }
    if (req.method === 'POST') {
      const b = jsonBody(req);
      const { id, type, baseUrl = '', apiKey = '', models = [], enabled = true, timeoutMs } = b ?? {};
      if (!id || typeof id !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(id)) {
        res.status(400).json({ error: { message: 'Field "id" ([a-z0-9_-], ≤64) required.', type: 'validation', code: 'validation' } });
        return;
      }
      if (!TYPES.has(type)) {
        res.status(400).json({ error: { message: 'Field "type" must be openrouter|groq|custom.', type: 'validation', code: 'validation' } });
        return;
      }
      if (!apiKey || typeof apiKey !== 'string') {
        res.status(400).json({ error: { message: 'Field "apiKey" required.', type: 'validation', code: 'validation' } });
        return;
      }
      const cleanUrl = type === 'custom' ? validateBaseUrl(String(baseUrl || '')) : String(baseUrl || '');
      await store.saveProvider({
        id, type, baseUrl: cleanUrl, apiKey,
        models: Array.isArray(models) ? models.map(String).slice(0, 200) : [],
        enabled: enabled !== false,
        timeoutMs: Number(timeoutMs) > 0 ? Number(timeoutMs) : undefined,
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
      await store.deleteProvider(id);
      res.status(200).json({ ok: true });
      return;
    }
    res.setHeader('Allow', 'GET, POST, DELETE');
    res.status(405).json({ error: { message: 'GET/POST/DELETE only', type: 'validation', code: 'validation' } });
  } catch (e) {
    sendError(res, e);
  }
}

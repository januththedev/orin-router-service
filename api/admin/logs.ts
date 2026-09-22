/** Admin: request logs. X-Admin-Secret required. Prefixes only, never secrets. */
import { ctx, requireAdmin, sendError } from '../_ctx.js';

export const config = { maxDuration: 30 };

export default async function handler(req: any, res: any): Promise<void> {
  try {
    requireAdmin(req);
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      res.status(405).json({ error: { message: 'GET only', type: 'validation', code: 'validation' } });
      return;
    }
    const { store } = ctx();
    const q = req.query ?? {};
    res.status(200).json({
      logs: await store.queryLogs({
        limit: Number(q.limit) || 50,
        status: typeof q.status === 'string' && q.status ? q.status : undefined,
        provider: typeof q.provider === 'string' && q.provider ? q.provider : undefined,
      }),
    });
  } catch (e) {
    sendError(res, e);
  }
}

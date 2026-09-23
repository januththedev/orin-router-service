/** User request logs (own traffic only). */
import { owner, sendError } from './_ctx.js';

export const config = { maxDuration: 30 };

export default async function handler(req: any, res: any): Promise<void> {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      res.status(405).json({ error: { message: 'GET only', type: 'validation', code: 'validation' } });
      return;
    }
    const { uid, store } = await owner(req);
    const q = req.query ?? {};
    res.status(200).json({
      logs: await store.queryLogs(uid, {
        limit: Number(q.limit) || 50,
        status: typeof q.status === 'string' ? q.status : undefined,
        provider: typeof q.provider === 'string' ? q.provider : undefined,
      }),
    });
  } catch (e) {
    sendError(res, e);
  }
}

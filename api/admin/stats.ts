/** Admin: usage stats. X-Admin-Secret required. */
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
    res.status(200).json(await ctx().store.stats());
  } catch (e) {
    sendError(res, e);
  }
}

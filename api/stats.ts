/** User usage aggregates (own traffic only). */
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
    res.status(200).json(await store.stats(uid));
  } catch (e) {
    sendError(res, e);
  }
}

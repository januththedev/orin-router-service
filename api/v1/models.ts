/** GET /v1/models — the caller's own models (gateway key auth). */
import { authenticate, listModels } from '../../src/service.js';
import { ctx, sendError } from '../_ctx.js';

export const config = { maxDuration: 10 };

export default async function handler(req: any, res: any): Promise<void> {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: { message: 'GET only', type: 'validation', code: 'validation' } });
    return;
  }
  try {
    const { store } = ctx();
    const key = await authenticate(req.headers?.authorization ?? null, store);
    res.status(200).json(await listModels(store, key.userUid));
  } catch (e) {
    sendError(res, e);
  }
}

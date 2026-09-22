/** GET /v1/models — route aliases as models (public, no auth). */
import { listModels } from '../../src/service.js';
import { ctx, sendError } from '../_ctx.js';

export const config = { maxDuration: 10 };

export default async function handler(req: any, res: any): Promise<void> {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: { message: 'GET only', type: 'validation', code: 'validation' } });
    return;
  }
  try {
    res.status(200).json(await listModels(ctx().store));
  } catch (e) {
    sendError(res, e);
  }
}

/** POST /v1/chat/completions — OpenAI-compatible, streaming optional. */
import { chatCompletions, chatCompletionsStream, SSE_DONE } from '../../../src/service.js';
import { ctx, jsonBody, sendError } from '../../_ctx.js';

export const config = { maxDuration: 120 };

export default async function handler(req: any, res: any): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: { message: 'POST only', type: 'validation', code: 'validation' } });
    return;
  }
  const { store } = ctx();
  const body = jsonBody(req);
  try {
    if (body?.stream === true) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      let sentAnything = false;
      try {
        await chatCompletionsStream(
          { store },
          {
            authHeader: (req.headers?.authorization as string) ?? null,
            rawBody: body,
            onSse: (line) => { sentAnything = true; res.write(line); },
          },
        );
      } catch (e: any) {
        // Headers already streaming: report in-band, never double-send JSON.
        if (sentAnything) {
          res.write(`data: ${JSON.stringify({ error: { message: e?.message || 'Router failed.', type: e?.code || 'internal', code: e?.code || 'internal' } })}\n\n`);
          res.write(SSE_DONE);
          res.end();
          return;
        }
        throw e;
      }
      res.end();
      return;
    }
    const out = await chatCompletions(
      { store },
      { authHeader: (req.headers?.authorization as string) ?? null, rawBody: body },
    );
    res.status(200).json(out);
  } catch (e) {
    if (!res.headersSent) sendError(res, e);
    else res.end();
  }
}

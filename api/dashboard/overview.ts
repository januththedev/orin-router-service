import { ctx, jsonBody, noStore, requestId, sendError } from "../_ctx.js";
import { executeChat, listModels } from "../../src/service.js";
import { validateChatBody } from "../../src/validate.js";
import { RouterError } from "../../src/errors.js";

export const config = { maxDuration: 60 };

export default async function handler(req: any, res: any) {
  const id = requestId(req);
  noStore(res);
  try {
    if (req.method !== "POST") throw new RouterError("ORIN_VALIDATION_FAILED", "POST only.");
    const principal = await ctx().auth.verify(req, undefined, "router:manage");
    const body = jsonBody(req) as Record<string, unknown>;
    const action = String(body.action || "models");
    if (action === "models") return res.status(200).json(await listModels(ctx().service.catalog));
    if (action === "attempts") {
      const request = String(body.requestId || "");
      if (!/^[A-Za-z0-9._:-]{8,160}$/.test(request)) throw new RouterError("ORIN_VALIDATION_FAILED", "A valid requestId is required.");
      return res.status(200).json({ attempts: await ctx().service.store.listAttempts(request) });
    }
    if (action === "playground") {
      const prompt = String(body.prompt || "").trim();
      if (!prompt || prompt.length > 12_000) throw new RouterError("ORIN_VALIDATION_FAILED", "Playground prompt is required and must be under 12,000 characters.");
      const chatBody = validateChatBody({ model: String(body.model || "orin-balanced"), messages: [{ role: "user", content: prompt }] });
      return res.status(200).json(await executeChat(ctx().service, principal, chatBody));
    }
    throw new RouterError("ORIN_VALIDATION_FAILED", "Unknown dashboard action.");
  } catch (error) {
    sendError(res, error, id);
  }
}

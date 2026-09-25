import { ctx, jsonBody, noStore, requestId, sendError } from "../_ctx.js";
import { RouterError } from "../../src/errors.js";

export const config = { maxDuration: 15 };

export default async function handler(req: any, res: any) {
  const id = requestId(req);
  noStore(res);
  try {
    if (req.method !== "POST") throw new RouterError("ORIN_VALIDATION_FAILED", "POST only.");
    const principal = await ctx().auth.verify(req, undefined, "router:manage");
    const body = jsonBody(req) as Record<string, unknown>;
    const action = String(body.action || "");
    if (action === "list") return res.status(200).json({ keys: await ctx().gatewayKeys.list(principal.accountId) });
    if (action === "create") return res.status(201).json(await ctx().gatewayKeys.create(principal.accountId, String(body.label || "default")));
    if (action === "revoke") {
      await ctx().gatewayKeys.revoke(principal.accountId, String(body.id || ""));
      return res.status(200).json({ ok: true });
    }
    throw new RouterError("ORIN_VALIDATION_FAILED", "Unknown gateway-key action.");
  } catch (error) {
    sendError(res, error, id);
  }
}

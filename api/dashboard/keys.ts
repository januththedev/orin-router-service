import { ctx, jsonBody, noStore, requestId, sendError } from "../_ctx.js";
import { RouterError } from "../../src/errors.js";
import { BYOK_PREFERENCE, isKnownProviderOrigin } from "../../src/provider-registry.js";

export const config = { maxDuration: 15 };

export default async function handler(req: any, res: any) {
  const id = requestId(req);
  noStore(res);
  try {
    if (req.method !== "POST") throw new RouterError("ORIN_VALIDATION_FAILED", "POST only.");
    const runtime = ctx();
    const principal = await runtime.auth.verify(req, undefined, "router:manage");
    const body = jsonBody(req) as Record<string, unknown>;
    const action = String(body.action || "");
    // The runtime owns the keyring, so a key created here is the same key the
    // upstream resolver reads for this account's traffic.
    const keys = runtime.providerKeys;
    if (action === "list") return res.status(200).json({ keys: await keys.list(principal.accountId), usable_providers: BYOK_PREFERENCE });
    if (action === "create") {
      const created = await keys.create(principal.accountId, String(body.provider || ""), String(body.label || "default"), String(body.secret || ""));
      return res.status(201).json({ ...created, routes_traffic: isKnownProviderOrigin(String(body.provider || "")) });
    }
    if (action === "reveal_once") {
      const secret = await keys.revealOnce(principal.accountId, String(body.id || ""));
      return res.status(200).json({ secret });
    }
    if (action === "revoke") return res.status(200).json({ record: await keys.revoke(principal.accountId, String(body.id || "")) });
    if (action === "rotate") return res.status(201).json(await keys.rotate(principal.accountId, String(body.id || ""), String(body.secret || "")));
    throw new RouterError("ORIN_VALIDATION_FAILED", "Unknown provider-key action.");
  } catch (error) {
    sendError(res, error, id);
  }
}

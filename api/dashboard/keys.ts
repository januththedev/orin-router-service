import { ctx, jsonBody, noStore, requestId, sendError } from "../_ctx.js";
import { MemoryProviderKeyStore, NeonProviderKeyStore, ProviderKeyManager } from "../../src/provider-keys.js";
import { RouterError } from "../../src/errors.js";

export const config = { maxDuration: 15 };
const memoryStores = new Map<string, MemoryProviderKeyStore>();

function manager(): ProviderKeyManager {
  const runtime = ctx();
  const store = runtime.config.providerMode === "fake"
    ? (memoryStores.get(runtime.config.databaseUrl) ?? (() => { const value = new MemoryProviderKeyStore(); memoryStores.set(runtime.config.databaseUrl, value); return value; })())
    : new NeonProviderKeyStore(runtime.config.databaseUrl);
  return new ProviderKeyManager(store, runtime.config.providerKekCurrent);
}

export default async function handler(req: any, res: any) {
  const id = requestId(req);
  noStore(res);
  try {
    if (req.method !== "POST") throw new RouterError("ORIN_VALIDATION_FAILED", "POST only.");
    const principal = await ctx().auth.verify(req, undefined, "router:manage");
    const body = jsonBody(req) as Record<string, unknown>;
    const action = String(body.action || "");
    const keys = manager();
    if (action === "list") return res.status(200).json({ keys: await keys.list(principal.accountId) });
    if (action === "create") {
      const created = await keys.create(principal.accountId, String(body.provider || ""), String(body.label || "default"), String(body.secret || ""));
      return res.status(201).json(created);
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

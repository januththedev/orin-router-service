import { timingSafeEqual } from "node:crypto";
import { refreshCatalog } from "../../../src/catalog.js";
import { ctx, requestId, sendError } from "../../_ctx.js";
export const config = { maxDuration: 30 };
function authorized(header: unknown, secret: string): boolean { const token = String(header ?? "").replace(/^Bearer\s+/i, ""); const a = Buffer.from(token); const b = Buffer.from(secret); return a.length === b.length && timingSafeEqual(a, b); }
export default async function handler(req: any, res: any): Promise<void> { const id = requestId(req); try { if (req.method !== "POST" || !authorized(req.headers?.authorization, ctx().config.cronSecret)) throw new Error("cron authentication required"); const snapshot = await refreshCatalog(ctx().config.catalogSourceUrl); ctx().service.catalog.set(snapshot); res.status(200).json({ request_id: id, provider: snapshot.provider, status: snapshot.status, fetched_at: snapshot.fetchedAt }); } catch (error) { sendError(res, error, id); } }

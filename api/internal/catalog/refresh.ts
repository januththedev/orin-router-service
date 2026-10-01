import { timingSafeEqual } from "node:crypto";
import { refreshCatalog, CATALOG_SOURCES } from "../../../src/catalog.js";
import { ctx, requestId, sendError } from "../../_ctx.js";
export const config = { maxDuration: 30 };
function authorized(header: unknown, secret: string): boolean { const token = String(header ?? "").replace(/^Bearer\s+/i, ""); const a = Buffer.from(token); const b = Buffer.from(secret); return a.length === b.length && timingSafeEqual(a, b); }
// ORIN_ROUTER_CATALOG_SOURCE_URL is an explicit override that narrows the refresh
// to a single source. Left unset -- the default -- the refresh fans out to every
// configured source, which is how OpenCode's no-cost ids reach the pool at all.
export default async function handler(req: any, res: any): Promise<void> { const id = requestId(req); try { if (req.method !== "POST" || !authorized(req.headers?.authorization, ctx().config.cronSecret)) throw new Error("cron authentication required"); const override = process.env.ORIN_ROUTER_CATALOG_SOURCE_URL; const snapshot = await refreshCatalog(override ? override : CATALOG_SOURCES); ctx().service.catalog.set(snapshot); res.status(200).json({ request_id: id, provider: snapshot.provider, status: snapshot.status, fetched_at: snapshot.fetchedAt, models: snapshot.models.length }); } catch (error) { sendError(res, error, id); } }

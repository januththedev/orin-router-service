import { listModels } from "../../src/service.js";
import { ctx, requestId, sendError } from "../_ctx.js";
export const config = { maxDuration: 10 };
export default async function handler(req: any, res: any): Promise<void> { const id = requestId(req); try { if (req.method !== "GET") { res.setHeader("Allow", "GET"); throw new Error("GET required"); } await ctx().auth.verify(req); res.status(200).json(await listModels()); } catch (error) { sendError(res, error, id); } }

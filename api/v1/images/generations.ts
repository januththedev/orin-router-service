import { executeImage } from "../../../src/service.js";
import { validateImageBody } from "../../../src/validate.js";
import { ctx, jsonBody, requestId, sendError } from "../../_ctx.js";
export const config = { maxDuration: 60 };
export default async function handler(req: any, res: any): Promise<void> { const id = requestId(req); try { if (req.method !== "POST") { res.setHeader("Allow", "POST"); throw new Error("POST required"); } const runtime = ctx(); const principal = await runtime.auth.verify(req); const body = validateImageBody(jsonBody(req)); res.status(200).json(await executeImage(runtime.service, principal, body, id, req.signal)); } catch (error) { sendError(res, error, id); } }

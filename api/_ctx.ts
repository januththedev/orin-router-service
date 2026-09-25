import { randomUUID } from "node:crypto";
import { RouterError } from "../src/errors.js";
import { runtimeFromEnv, type Runtime } from "../src/runtime.js";
let runtime: Runtime | null = null;
export function ctx(): Runtime { return runtime ??= runtimeFromEnv(); }
export function requestId(req: any): string { return String(req.headers?.["x-request-id"] ?? randomUUID()); }
export function jsonBody(req: any): unknown { if (req.body && typeof req.body === "object") return req.body; if (typeof req.body === "string" && req.body) { try { return JSON.parse(req.body); } catch { throw new RouterError("ORIN_VALIDATION_FAILED", "Request body must be valid JSON."); } } return {}; }
export function sendError(res: any, error: unknown, id: string): void { const value = error instanceof RouterError ? error : new RouterError("ORIN_INTERNAL", "Router failed."); res.status(value.status).json(value.toResponse(id)); }
export function noStore(res: any): void { res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff"); }

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { runtimeFromEnv, type Runtime } from "../src/runtime.js";
import { useRuntime } from "../api/_ctx.js";

import chatCompletions from "../api/v1/chat/completions.js";
import imageGenerations from "../api/v1/images/generations.js";
import models from "../api/v1/models.js";
import dashboardKeys from "../api/dashboard/keys.js";
import dashboardGatewayKeys from "../api/dashboard/gateway-keys.js";
import dashboardOverview from "../api/dashboard/overview.js";

type Handler = (req: any, res: any) => Promise<void> | void;

const MAX_BODY_BYTES = 1_000_000;

/**
 * Routes for the standalone (non-Vercel) deployment. Paths match the Vercel
 * rewrites in vercel.json so the same handler code serves both topologies.
 */
const ROUTES: ReadonlyArray<{ method: string; path: string; handler: Handler }> = [
  { method: "POST", path: "/v1/chat/completions", handler: chatCompletions },
  { method: "POST", path: "/v1/images/generations", handler: imageGenerations },
  { method: "GET", path: "/v1/models", handler: models },
  { method: "POST", path: "/api/dashboard/keys", handler: dashboardKeys },
  { method: "POST", path: "/api/dashboard/gateway-keys", handler: dashboardGatewayKeys },
  { method: "POST", path: "/api/dashboard/overview", handler: dashboardOverview },
];

/**
 * Adapts a Node `ServerResponse` to the small Vercel-style surface the handlers
 * use: `status().json()` plus the native response methods.
 */
class ResponseShim {
  readonly raw: ServerResponse;
  constructor(raw: ServerResponse) {
    this.raw = raw;
  }
  get headersSent() { return this.raw.headersSent; }
  status(code: number) { this.raw.statusCode = code; return this; }
  setHeader(name: string, value: string | number | readonly string[]) { this.raw.setHeader(name, value as any); return this; }
  getHeader(name: string) { return this.raw.getHeader(name); }
  removeHeader(name: string) { this.raw.removeHeader(name); return this; }
  writeHead(status: number, headers?: Record<string, string>) { this.raw.writeHead(status, headers); return this; }
  write(chunk: string) { this.raw.write(chunk); return true; }
  end(chunk?: string) { this.raw.end(chunk); return this; }
  json(value: unknown) {
    if (!this.raw.headersSent) this.raw.setHeader("Content-Type", "application/json; charset=utf-8");
    this.raw.end(JSON.stringify(value));
    return this;
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  return JSON.parse(text);
}

export function createRouterServer(runtime: Runtime = runtimeFromEnv()) {
  useRuntime(runtime);
  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://internal");
      const path = url.pathname.replace(/\/+$/, "") || "/";

      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");

      if (path === "/health") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ status: "ok", mode: runtime.config.providerMode, time: new Date().toISOString() }));
        return;
      }

      const route = ROUTES.find((entry) => entry.path === path);
      if (!route) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: { code: "ORIN_NOT_FOUND", message: "Unknown route." } }));
        return;
      }
      if (route.method !== req.method) {
        res.statusCode = 405;
        res.setHeader("Allow", route.method);
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: { code: "ORIN_VALIDATION_FAILED", message: `${route.method} required.` } }));
        return;
      }

      try {
        const body = await readBody(req);
        const shim = new ResponseShim(res);
        await route.handler({ method: req.method, url: req.url, headers: req.headers, body, query: Object.fromEntries(url.searchParams), signal: req.signal }, shim);
        if (!res.writableEnded) res.end();
      } catch (error) {
        if (res.writableEnded) return;
        const tooLarge = error instanceof Error && /too large/i.test(error.message);
        if (!tooLarge) console.error(`[orin-router] ${req.method} ${path} failed:`, error);
        const code = tooLarge ? 413 : 400;
        res.statusCode = code;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: { code: code === 413 ? "ORIN_VALIDATION_FAILED" : "ORIN_INVALID_JSON", message: "Request body could not be read." } }));
      }
    })();
  });
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("server/index.ts") || process.argv[1]?.replace(/\\/g, "/").endsWith("server/index.js");
if (isMain) {
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? "127.0.0.1";
  const runtime = runtimeFromEnv();
  createRouterServer(runtime).listen(port, host, () => {
    console.log(`orin-router listening on http://${host}:${port} (${runtime.config.providerMode} mode)`);
  });
}

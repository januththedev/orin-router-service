import { jwtVerify } from "jose";
import { RouterError } from "./errors.js";
import type { ServicePrincipal } from "./types.js";
import type { RouterConfig } from "./config.js";

export interface CoreIntrospector { introspect(token: string, signal?: AbortSignal): Promise<{ active: boolean; account_id: string; scopes: string[]; usage_reservation_id?: string }>; }
function bearer(value: unknown): string | null { const match = /^Bearer\s+(.+)$/i.exec(String(value ?? "").trim()); return match?.[1] ?? null; }
export class ServiceAuthenticator {
  readonly #config: RouterConfig;
  readonly #introspector: CoreIntrospector;
  constructor(config: RouterConfig, introspector: CoreIntrospector) { this.#config = config; this.#introspector = introspector; }
  async verify(req: any, signal?: AbortSignal): Promise<ServicePrincipal> {
    const token = bearer(req.headers?.authorization);
    if (!token) throw new RouterError("ORIN_AUTHENTICATION_REQUIRED", "A Core service assertion is required.");
    if (this.#config.providerMode === "fake" && req.headers?.["x-orin-preview-service"] === "1") return { accountId: "preview-account", scopes: ["router:invoke"], subject: "preview-core", tokenId: "preview-token", expiresAt: new Date(Date.now() + 60_000), usageReservationId: "preview-usage" };
    let payload: Record<string, unknown>;
    try {
      const key = new TextEncoder().encode(this.#config.serviceSigningKey);
      const verified = await jwtVerify(token, key, { issuer: "orin-core", audience: "orin-router", algorithms: ["HS256"] });
      payload = verified.payload as Record<string, unknown>;
    } catch { throw new RouterError("ORIN_AUTHENTICATION_REQUIRED", "The service assertion is invalid."); }
    const scopes = String(payload.scope ?? "").split(/\s+/).filter(Boolean);
    if (payload.typ !== "service" || !scopes.includes("router:invoke") || typeof payload.account_id !== "string" || typeof payload.usage_reservation_id !== "string") throw new RouterError("ORIN_AUTHORIZATION_DENIED", "The service assertion lacks Router permission.");
    const introspection = await this.#introspector.introspect(token, signal).catch(() => { throw new RouterError("ORIN_AUTHENTICATION_REQUIRED", "Core authorization state is unavailable.", true); });
    if (!introspection.active) throw new RouterError("ORIN_AUTHENTICATION_REQUIRED", "The service assertion is inactive.");
    return { accountId: introspection.account_id, scopes: introspection.scopes, subject: String(payload.sub), tokenId: String(payload.jti), expiresAt: new Date(Number(payload.exp) * 1000), usageReservationId: introspection.usage_reservation_id ?? String(payload.usage_reservation_id) };
  }
}
export function createCoreIntrospector(config: RouterConfig): CoreIntrospector { return { async introspect(token, signal) { const response = await fetch(config.coreIntrospectionUrl, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.coreClientSecret}`, "x-orin-client-id": config.coreClientId }, body: JSON.stringify({ token }), signal }); if (!response.ok) return { active: false, account_id: "", scopes: [] }; return await response.json() as { active: boolean; account_id: string; scopes: string[]; usage_reservation_id?: string }; } }; }

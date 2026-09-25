import { jwtVerify } from "jose";
import { RouterError } from "./errors.js";
import type { ServicePrincipal } from "./types.js";
import type { RouterConfig } from "./config.js";
import type { GatewayKeyManager } from "./gateway-keys.js";

export interface CoreCredentialVerifier { verifyServiceCredential(token: string, signal?: AbortSignal): Promise<{ active: boolean; account_id: string; scopes: string[]; usage_reservation_id?: string }>; }
const CORE_INTROSPECTION_URL = "https://orinai.org/api/auth/introspect";
function assertTrustedCoreEndpoint(rawUrl: string, providerMode: "fake" | "live"): URL { const url = new URL(rawUrl); if (url.username || url.password || url.port) throw new Error("Core introspection URL is not trusted"); if (providerMode === "live" && (url.protocol !== "https:" || !["orinai.org", "core.orinai.org", "api.orinai.org"].includes(url.hostname) || url.pathname !== "/api/auth/introspect")) throw new Error("Core introspection URL is not trusted"); return url; }
export class ServiceAuthenticator {
  readonly #config: RouterConfig;
  readonly #verifier: CoreCredentialVerifier;
  readonly #gatewayKeys: GatewayKeyManager | null;
  constructor(config: RouterConfig, verifier: CoreCredentialVerifier, gatewayKeys: GatewayKeyManager | null = null) { this.#config = config; this.#verifier = verifier; this.#gatewayKeys = gatewayKeys; }
  async verify(req: any, signal?: AbortSignal, requiredScope = "router:invoke"): Promise<ServicePrincipal> {
    const rawAuthorization = req.headers?.authorization;
    const token = typeof rawAuthorization === "string" && rawAuthorization.length <= 4096 ? /^Bearer\s+([A-Za-z0-9._~-]+)$/i.exec(rawAuthorization.trim())?.[1] ?? null : null;
    if (!token) throw new RouterError("ORIN_AUTHENTICATION_REQUIRED", "A Core service assertion or Orin gateway key is required.");
    if (token.startsWith("orin_")) {
      if (requiredScope !== "router:invoke" || !this.#gatewayKeys) throw new RouterError("ORIN_AUTHORIZATION_DENIED", "Gateway keys cannot access Router management.");
      const key = await this.#gatewayKeys.verify(token);
      if (!key) throw new RouterError("ORIN_AUTHENTICATION_REQUIRED", "The Orin gateway key is invalid or revoked.");
      return { accountId: key.accountId, scopes: ["router:invoke"], subject: `gateway:${key.id}`, tokenId: `gateway:${key.id}`, expiresAt: key.expiresAt ? new Date(key.expiresAt) : new Date(Date.now() + 86_400_000), usageReservationId: `gateway:${key.id}` };
    }
    if (this.#config.providerMode === "fake" && req.headers?.["x-orin-preview-service"] === "1") return { accountId: "preview-account", scopes: ["router:invoke", "router:manage"], subject: "preview-core", tokenId: "preview-token", expiresAt: new Date(Date.now() + 60_000), usageReservationId: "preview-usage" };
    let payload: Record<string, unknown>;
    try {
      const key = new TextEncoder().encode(this.#config.serviceSigningKey);
      const verified = await jwtVerify(token, key, { issuer: "orin-core", audience: "orin-router", algorithms: ["HS256"] });
      payload = verified.payload as Record<string, unknown>;
    } catch { throw new RouterError("ORIN_AUTHENTICATION_REQUIRED", "The service assertion is invalid."); }
    const scopes = String(payload.scope ?? "").split(/\s+/).filter(Boolean);
    if (payload.typ !== "service" || !scopes.includes(requiredScope) || typeof payload.account_id !== "string" || typeof payload.usage_reservation_id !== "string") throw new RouterError("ORIN_AUTHORIZATION_DENIED", "The service assertion lacks Router permission.");
    const introspection = await this.#verifier.verifyServiceCredential(token, signal).catch(() => { throw new RouterError("ORIN_AUTHENTICATION_REQUIRED", "Core authorization state is unavailable.", true); });
    if (!introspection.active) throw new RouterError("ORIN_AUTHENTICATION_REQUIRED", "The service assertion is inactive.");
    if (!introspection.scopes.includes(requiredScope)) throw new RouterError("ORIN_AUTHORIZATION_DENIED", "The service credential is not active for this Router scope.");
    return { accountId: introspection.account_id, scopes: introspection.scopes, subject: String(payload.sub), tokenId: String(payload.jti), expiresAt: new Date(Number(payload.exp) * 1000), usageReservationId: introspection.usage_reservation_id ?? String(payload.usage_reservation_id) };
  }
}
export function createCoreCredentialVerifier(config: RouterConfig): CoreCredentialVerifier { const endpoint = config.providerMode === "live" ? new URL(CORE_INTROSPECTION_URL) : assertTrustedCoreEndpoint(config.coreIntrospectionUrl, config.providerMode); return { async verifyServiceCredential(token, signal) { const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.coreClientSecret}`, "x-orin-client-id": config.coreClientId }, body: JSON.stringify({ token }), signal }); if (!response.ok) return { active: false, account_id: "", scopes: [] }; return await response.json() as { active: boolean; account_id: string; scopes: string[]; usage_reservation_id?: string }; } }; }

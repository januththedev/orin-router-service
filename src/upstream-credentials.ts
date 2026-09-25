import { RouterError } from "./errors.js";
import { createProviderAdapter, createProviderAdapterForOrigin, BYOK_PREFERENCE } from "./provider-registry.js";
import type { ProviderAdapter, ServicePrincipal } from "./types.js";
import type { ProviderKeyManager } from "./provider-keys.js";

export type UpstreamSource = "fake" | "account-byok" | "platform";

export interface ResolvedUpstream {
  adapter: ProviderAdapter;
  source: UpstreamSource;
  provider: string;
  providerKeyId: string | null;
}

export interface UpstreamResolverDeps {
  mode: "fake" | "live";
  platformKey: string | undefined;
  providerKeys: ProviderKeyManager | null;
  fetchImpl?: typeof fetch;
}

/**
 * Resolves which upstream credential a request should use.
 *
 * An account's own BYOK key always wins over the shared platform key, so
 * Orin can host a router for users who bring their own provider credentials
 * without ever spending the platform's money on their behalf. The free-only
 * model policy is enforced before this resolver runs, in validation and catalog
 * eligibility, so a BYOK key can never be used to reach a paid model.
 */
export class UpstreamResolver {
  private readonly deps: UpstreamResolverDeps;

  constructor(deps: UpstreamResolverDeps) {
    this.deps = deps;
  }

  async resolve(principal: ServicePrincipal): Promise<ResolvedUpstream> {
    if (this.deps.mode === "fake") {
      return { adapter: createProviderAdapter("fake", undefined), source: "fake", provider: "fake", providerKeyId: null };
    }
    if (this.deps.providerKeys) {
      for (const provider of BYOK_PREFERENCE) {
        const found = await this.deps.providerKeys.useForUpstream(principal.accountId, provider);
        if (found) {
          return {
            adapter: createProviderAdapterForOrigin(provider, found.secret, this.deps.fetchImpl),
            source: "account-byok",
            provider,
            providerKeyId: found.id,
          };
        }
      }
    }
    if (!this.deps.platformKey) {
      throw new RouterError("ORIN_PROVIDER_ERROR", "No upstream credential is available for this account.", true);
    }
    return { adapter: createProviderAdapter("live", this.deps.platformKey, this.deps.fetchImpl), source: "platform", provider: "openrouter", providerKeyId: null };
  }
}

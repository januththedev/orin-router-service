import { RouterError } from "./errors.js";
import { createProviderAdapter, createProviderAdapterForOrigin, isKnownProviderOrigin, PROVIDER_ORIGINS, BYOK_PREFERENCE } from "./provider-registry.js";
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

  /**
   * Resolves the credential for one specific provider.
   *
   * Returns null when the account has no usable credential for that provider, so
   * the caller can fail over to the next candidate instead of aborting the whole
   * request. That distinction matters because a candidate names the provider
   * that serves it: a `:free` model only exists on OpenRouter and a `-free`
   * model only on OpenCode, so sending one to the other's origin just 404s.
   *
   * The shared platform key is used only for origins that accept it, which today
   * means OpenRouter alone. Every other origin is BYOK-only.
   */
  async resolveForProvider(principal: ServicePrincipal, provider: string): Promise<ResolvedUpstream | null> {
    if (this.deps.mode === "fake") {
      return { adapter: createProviderAdapter("fake", undefined), source: "fake", provider: "fake", providerKeyId: null };
    }
    if (!isKnownProviderOrigin(provider)) return null;
    const origin = PROVIDER_ORIGINS[provider];
    if (this.deps.providerKeys) {
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
    if (origin.acceptsPlatformKey && this.deps.platformKey) {
      return {
        adapter: createProviderAdapterForOrigin(provider, this.deps.platformKey, this.deps.fetchImpl),
        source: "platform",
        provider,
        providerKeyId: null,
      };
    }
    return null;
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

import { randomUUID } from "node:crypto";
import { loadConfig, type RouterConfig } from "./config.js";
import { CatalogStore, fakeCatalog } from "./catalog.js";
import { createDistributedState } from "./redis-state.js";
import { createStore } from "./store.js";
import { createCoreCredentialVerifier, ServiceAuthenticator } from "./service-auth.js";
import { GatewayKeyManager, MemoryGatewayKeyStore, NeonGatewayKeyStore } from "./gateway-keys.js";
import { MemoryProviderKeyStore, NeonProviderKeyStore, ProviderKeyManager } from "./provider-keys.js";
import { UpstreamResolver } from "./upstream-credentials.js";
import type { RouterServiceContext } from "./service.js";

export interface Runtime {
  config: RouterConfig;
  service: RouterServiceContext;
  auth: ServiceAuthenticator;
  gatewayKeys: GatewayKeyManager;
  providerKeys: ProviderKeyManager;
  requestId(): string;
}

export function createRuntime(config: RouterConfig, env: Record<string, string | undefined> = process.env): Runtime {
  const catalog = new CatalogStore(config.providerMode === "fake" ? fakeCatalog() : null);

  // One account-scoped BYOK keyring per runtime instance, shared by the dashboard
  // API and the upstream resolver so a key created in the dashboard is
  // immediately usable for that account's traffic.
  const providerKeys = new ProviderKeyManager(
    config.providerMode === "fake" ? new MemoryProviderKeyStore() : new NeonProviderKeyStore(config.databaseUrl),
    config.providerKekCurrent,
  );

  const upstream = new UpstreamResolver({
    mode: config.providerMode,
    platformKey: env.ORIN_PROVIDER_API_KEY,
    providerKeys,
  });

  const service: RouterServiceContext = {
    store: createStore(config.providerMode, config.databaseUrl),
    state: createDistributedState(config.providerMode, config.redisUrl, config.redisToken, config.redisHashKey),
    catalog,
    upstream,
    accountLimit: Number(env.ORIN_ROUTER_ACCOUNT_RPM ?? 60),
  };

  const gatewayKeys = new GatewayKeyManager(
    config.providerMode === "fake" ? new MemoryGatewayKeyStore() : new NeonGatewayKeyStore(config.databaseUrl),
  );

  return {
    config,
    service,
    auth: new ServiceAuthenticator(config, createCoreCredentialVerifier(config), gatewayKeys),
    gatewayKeys,
    providerKeys,
    requestId: () => randomUUID(),
  };
}

export function runtimeFromEnv(env = process.env): Runtime { return createRuntime(loadConfig(env), env); }

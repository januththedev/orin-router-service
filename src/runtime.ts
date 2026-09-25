import { randomUUID } from "node:crypto";
import { loadConfig, type RouterConfig } from "./config.js";
import { CatalogStore, fakeCatalog } from "./catalog.js";
import { createDistributedState } from "./redis-state.js";
import { createStore } from "./store.js";
import { createProviderAdapter } from "./provider-registry.js";
import { createCoreIntrospector, ServiceAuthenticator } from "./service-auth.js";
import type { RouterServiceContext } from "./service.js";
export interface Runtime { config: RouterConfig; service: RouterServiceContext; auth: ServiceAuthenticator; requestId(): string; }
export function createRuntime(config: RouterConfig): Runtime { const catalog = new CatalogStore(config.providerMode === "fake" ? fakeCatalog() : null); const service: RouterServiceContext = { store: createStore(config.providerMode, config.databaseUrl), state: createDistributedState(config.providerMode, config.redisUrl, config.redisToken, config.redisHashKey), catalog, adapter: createProviderAdapter(config.providerMode, process.env.ORIN_PROVIDER_API_KEY), accountLimit: Number(process.env.ORIN_ROUTER_ACCOUNT_RPM ?? 60) }; return { config, service, auth: new ServiceAuthenticator(config, createCoreIntrospector(config)), requestId: () => randomUUID() }; }
export function runtimeFromEnv(env = process.env): Runtime { return createRuntime(loadConfig(env)); }

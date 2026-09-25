export interface RouterConfig {
  databaseUrl: string;
  serviceSigningKey: string;
  serviceKeyId: string;
  coreIntrospectionUrl: string;
  coreClientId: string;
  coreClientSecret: string;
  redisUrl: string;
  redisToken: string;
  redisHashKey: string;
  providerMode: "fake" | "live";
  catalogSourceUrl: string;
  providerKekCurrent: string;
  providerKekPrevious?: string;
  cronSecret: string;
}
function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
export function loadConfig(env: Record<string, string | undefined> = process.env): RouterConfig {
  const providerMode = env.ORIN_PROVIDER_MODE ?? "fake";
  if (providerMode !== "fake" && providerMode !== "live") throw new Error("ORIN_PROVIDER_MODE must be fake or live");
  return {
    databaseUrl: required(env, "DATABASE_URL"),
    serviceSigningKey: required(env, "ORIN_ROUTER_SERVICE_SIGNING_KEY"),
    serviceKeyId: required(env, "ORIN_ROUTER_SERVICE_KEY_ID"),
    coreIntrospectionUrl: required(env, "ORIN_CORE_INTROSPECTION_URL"),
    coreClientId: required(env, "ORIN_CORE_CLIENT_ID"),
    coreClientSecret: required(env, "ORIN_CORE_CLIENT_SECRET"),
    redisUrl: required(env, "UPSTASH_REDIS_REST_URL"),
    redisToken: required(env, "UPSTASH_REDIS_REST_TOKEN"),
    redisHashKey: required(env, "ORIN_ROUTER_REDIS_HASH_KEY"),
    providerMode,
    catalogSourceUrl: env.ORIN_ROUTER_CATALOG_SOURCE_URL ?? "https://openrouter.ai/api/v1/models",
    providerKekCurrent: required(env, "ORIN_PROVIDER_KEK_CURRENT"),
    providerKekPrevious: env.ORIN_PROVIDER_KEK_PREVIOUS,
    cronSecret: required(env, "CRON_SECRET"),
  };
}

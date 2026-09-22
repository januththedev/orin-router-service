/** Environment + seed. Secrets stay server-side; never import in browser code. */

export interface RouterConfig {
  databaseUrl: string;
  adminSecret: string;
  masterKey: string;
  cooldownMs: number;
  seed: { providers?: any[]; routes?: any[] } | null;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): RouterConfig {
  const databaseUrl = env.DATABASE_URL || env.NEON_DATABASE_URL || '';
  if (!databaseUrl) throw new Error('DATABASE_URL not configured');
  const adminSecret = env.ORIN_ROUTER_ADMIN || '';
  if (!adminSecret) throw new Error('ORIN_ROUTER_ADMIN not configured');
  const masterKey = env.ROUTER_MASTER_KEY || '';
  if (masterKey.length < 32) throw new Error('ROUTER_MASTER_KEY not configured (min 32 chars)');
  let seed: RouterConfig['seed'] = null;
  if (env.ROUTER_SEED_JSON) {
    try { seed = JSON.parse(env.ROUTER_SEED_JSON); } catch { seed = null; }
  }
  return {
    databaseUrl, adminSecret, masterKey,
    cooldownMs: Number(env.ROUTER_COOLDOWN_MS) || 60_000,
    seed,
  };
}

/** Insert seed providers/routes when tables are empty (first boot). */
export async function ensureSeed(store: {
  getProviders(): Promise<{ id: string }[]>;
  getRoutes(): Promise<{ id: string }[]>;
  saveProvider(p: any): Promise<void>;
  saveRoute(r: any): Promise<void>;
}, seed: RouterConfig['seed']): Promise<{ providers: number; routes: number }> {
  if (!seed) return { providers: 0, routes: 0 };
  const [haveP, haveR] = await Promise.all([store.getProviders(), store.getRoutes()]);
  let providers = 0, routes = 0;
  if (!haveP.length && Array.isArray(seed.providers)) {
    for (const p of seed.providers) {
      if (p?.id && p?.type && p?.apiKey && p?.baseUrl !== undefined) {
        await store.saveProvider({
          id: String(p.id), type: p.type, baseUrl: String(p.baseUrl || ''),
          apiKey: String(p.apiKey), models: Array.isArray(p.models) ? p.models.map(String) : [],
          enabled: p.enabled !== false, timeoutMs: Number(p.timeoutMs) || undefined,
        });
        providers++;
      }
    }
  }
  if (!haveR.length && Array.isArray(seed.routes)) {
    for (const r of seed.routes) {
      if (r?.id && Array.isArray(r.hops) && r.hops.length) {
        await store.saveRoute({
          id: String(r.id),
          hops: r.hops.filter((h: any) => h?.provider && h?.model).map((h: any) => ({ provider: String(h.provider), model: String(h.model) })),
          enabled: r.enabled !== false,
        });
        routes++;
      }
    }
  }
  return { providers, routes };
}

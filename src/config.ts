/** Environment. Secrets stay server-side; never import in browser code. */

export interface RouterConfig {
  databaseUrl: string;
  masterKey: string;
  /** Orin session signing key (HS256) — MUST match the Orin core TOKEN_ENCRYPTION_KEY. */
  tokenKey: string;
  cooldownMs: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): RouterConfig {
  const databaseUrl = env.DATABASE_URL || env.NEON_DATABASE_URL || '';
  if (!databaseUrl) throw new Error('DATABASE_URL not configured');
  const masterKey = env.ROUTER_MASTER_KEY || '';
  if (masterKey.length < 32) throw new Error('ROUTER_MASTER_KEY not configured (min 32 chars)');
  const tokenKey = env.TOKEN_ENCRYPTION_KEY || '';
  if (tokenKey.length < 32) throw new Error('TOKEN_ENCRYPTION_KEY not configured (must match Orin core)');
  return {
    databaseUrl, masterKey, tokenKey,
    cooldownMs: Number(env.ROUTER_COOLDOWN_MS) || 60_000,
  };
}

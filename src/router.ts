/**
 * Routing core: priority order, failover, health cooldowns, latency EMA.
 * No provider-specific code here — hops are (provider, model) pairs and the
 * adapters do the talking. Pure logic + injected health store = unit-testable.
 */
import { OrinError } from './errors.js';
import type { ProviderCall, ProviderAdapter, ProviderResult } from './providers.js';
import type { RouteDef } from './types.js';

export interface Attempt {
  provider: string;
  model: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export interface RouteOutcome extends ProviderResult {
  provider: string;
  attempts: Attempt[];
}

/** Per-instance health: cooldowns + latency EMAs. Fresh per serverless call by default. */
export class RouterHealth {
  private cooledUntil = new Map<string, number>();
  private emaMs = new Map<string, number>();
  private now: () => number;
  constructor(now?: () => number) {
    this.now = now ?? (() => Date.now());
  }

  private key(provider: string, model: string): string {
    return `${provider}::${model}`;
  }

  isCool(provider: string, model: string): boolean {
    return (this.cooledUntil.get(this.key(provider, model)) ?? 0) > this.now();
  }

  cool(provider: string, model: string, ms: number): void {
    this.cooledUntil.set(this.key(provider, model), this.now() + ms);
  }

  recordLatency(provider: string, model: string, ms: number): void {
    const k = this.key(provider, model);
    const prev = this.emaMs.get(k);
    this.emaMs.set(k, prev === undefined ? ms : prev * 0.7 + ms * 0.3);
  }

  latency(provider: string, model: string): number | undefined {
    return this.emaMs.get(this.key(provider, model));
  }
}

export interface RouteDeps {
  adapters: Map<string, ProviderAdapter>;
  health?: RouterHealth;
  cooldownMs?: number;
  onAttempt?: (a: Attempt) => void;
  now?: () => number;
}

/**
 * Try each hop in route order. First success wins.
 * - 429/5xx/timeout/network → cool this hop, next hop.
 * - 401/403 → this provider's credentials are bad: skip its other hops too.
 * - 400/404 → model-level problem: next hop immediately.
 */
export async function routeChat(
  route: RouteDef,
  call: Omit<ProviderCall, 'model'>,
  deps: RouteDeps,
): Promise<RouteOutcome> {
  if (!route.enabled) throw new OrinError('route_unavailable', `Route ${route.id} is disabled.`);
  if (!route.hops.length) throw new OrinError('route_unavailable', `Route ${route.id} has no hops.`);
  const health = deps.health ?? new RouterHealth(deps.now);
  const cooldownMs = deps.cooldownMs ?? 60_000;
  const deadProviders = new Set<string>();
  const attempts: Attempt[] = [];
  let lastErr: OrinError | null = null;

  const note = (a: Attempt) => {
    attempts.push(a);
    try { deps.onAttempt?.(a); } catch { /* hooks never break routing */ }
  };

  for (const hop of route.hops) {
    const adapter = deps.adapters.get(hop.provider);
    if (!adapter) {
      note({ provider: hop.provider, model: hop.model, ok: false, latencyMs: 0, error: 'unknown provider' });
      continue;
    }
    if (deadProviders.has(hop.provider) || health.isCool(hop.provider, hop.model)) continue;
    const t0 = (deps.now ?? Date.now)();
    try {
      const r = await adapter.chat({ ...call, model: hop.model });
      const dt = (deps.now ?? Date.now)() - t0;
      health.recordLatency(hop.provider, hop.model, dt);
      note({ provider: hop.provider, model: hop.model, ok: true, latencyMs: dt });
      return { text: r.text, model: r.model, provider: hop.provider, attempts };
    } catch (e: any) {
      const dt = (deps.now ?? Date.now)() - t0;
      const err = e instanceof OrinError ? e : new OrinError('provider', String(e?.message || e));
      lastErr = err;
      // dead-key (401/403): this provider's credentials are bad — skip its
      // remaining hops for the rest of the request. Everything else cools
      // just this hop (transient) or moves on (model-level 400/404).
      if (err.action === 'dead-key') deadProviders.add(hop.provider);
      else health.cool(hop.provider, hop.model, cooldownMs);
      note({ provider: hop.provider, model: hop.model, ok: false, latencyMs: dt, error: err.message });
    }
  }
  throw lastErr ?? new OrinError('route_unavailable', `Route ${route.id} has no healthy hops.`);
}

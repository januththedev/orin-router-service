/**
 * Service orchestration: auth → validate → fan out → respond → log.
 * Multi-tenant: a gateway key serves exactly one user's providers.
 * No manual routes — candidates are synthesized per request from the user's
 * enabled providers (exact model match, or wildcard when a provider lists
 * no models), in the order the providers were added. First success wins.
 * Pure against injected ctx — fully testable without HTTP or a database.
 */
import crypto from 'node:crypto';
import { OrinError } from './errors.js';
import { bearerToken, hashSecret, mintKey } from './keys.js';
import { customAdapter, groqAdapter, openRouterAdapter, type ProviderAdapter } from './providers.js';
import { RouterHealth, routeChat } from './router.js';
import { RateLimit } from './ratelimit.js';
import type { RouterStore } from './store.js';
import type { ApiKeyRecord, ChatRequestBody, ProviderDef, RouteDef, UsageLog } from './types.js';
import { validateBaseUrl, validateChatBody } from './validate.js';

export interface ServiceCtx {
  store: RouterStore;
  health?: RouterHealth;
  limits?: RateLimit;
  cooldownMs?: number;
  logErrors?: (e: unknown) => void;
  /** Injected adapters (tests / dry-run). Defaults to building from provider rows. */
  adapters?: Map<string, ProviderAdapter>;
}

export const PROVIDER_TYPES = new Set(['openrouter', 'groq', 'custom']);

function adaptersFor(providers: ProviderDef[]): Map<string, ProviderAdapter> {
  const m = new Map<string, ProviderAdapter>();
  for (const p of providers) {
    if (!p.enabled) continue;
    if (p.type === 'openrouter') m.set(p.id, openRouterAdapter(p.apiKey, { timeoutMs: p.timeoutMs }));
    else if (p.type === 'groq') m.set(p.id, groqAdapter(p.apiKey, { timeoutMs: p.timeoutMs }));
    else m.set(p.id, customAdapter(p.id, p.baseUrl, p.apiKey, { timeoutMs: p.timeoutMs }));
  }
  return m;
}

export async function authenticate(authHeader: string | null | undefined, store: RouterStore): Promise<ApiKeyRecord> {
  const secret = bearerToken(authHeader);
  if (!secret) throw new OrinError('authentication', 'Missing Bearer API key.');
  const rec = await store.findKeyByHash(hashSecret(secret));
  if (!rec) throw new OrinError('authentication', 'Invalid API key.');
  if (!rec.enabled) throw new OrinError('authorization', 'API key is disabled.');
  return rec;
}

/** Union of a user's configured models (wildcard providers serve any model but list none). */
export async function listModels(store: RouterStore, userUid: string): Promise<{ object: string; data: { id: string; object: string; owned_by: string }[] }> {
  const providers = (await store.getProviders(userUid)).filter((p) => p.enabled);
  const ids = [...new Set(providers.flatMap((p) => p.models ?? []))].sort();
  return { object: 'list', data: ids.map((id) => ({ id, object: 'model', owned_by: 'orin-router' })) };
}

/** Candidate providers for a requested model, in added order. */
export function candidates(providers: ProviderDef[], requested: string): ProviderDef[] {
  return providers.filter(
    (p) => p.enabled && ((p.models ?? []).length === 0 || (p.models ?? []).includes(requested)),
  );
}

function synthRoute(requested: string, cands: ProviderDef[]): RouteDef {
  return {
    id: requested,
    hops: cands.map((p) => ({ provider: p.id, model: requested })),
    enabled: true,
  };
}

function availableHint(providers: ProviderDef[]): string {
  const ids = [...new Set(providers.filter((p) => p.enabled).flatMap((p) => p.models ?? []))].sort();
  return ids.length ? ` Available: ${ids.slice(0, 20).join(', ')}.` : ' No models configured yet — add a provider first.';
}

function completionObject(model: string, text: string): Record<string, unknown> {
  return {
    id: 'chatcmpl-orin-' + crypto.randomUUID().slice(0, 8),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

export function sseChunk(model: string, text: string): string {
  return `data: ${JSON.stringify({ id: 'chatcmpl-orin', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`;
}

export const SSE_DONE = 'data: [DONE]\n\n';

export interface ChatOpts {
  authHeader: string | null | undefined;
  rawBody: unknown;
  requestId?: string;
  stream?: boolean;
  onSse?: (line: string) => void;
  signal?: AbortSignal;
}

async function safeLog(ctx: ServiceCtx, e: UsageLog): Promise<void> {
  try { await ctx.store.log(e); } catch (err) { try { ctx.logErrors?.(err); } catch { /* never break responses */ } }
}

/** Non-streaming chat completion. Throws OrinError (with .status) on failure. */
export async function chatCompletions(ctx: ServiceCtx, opts: ChatOpts): Promise<Record<string, unknown>> {
  const requestId = opts.requestId ?? crypto.randomUUID();
  const key = await authenticate(opts.authHeader, ctx.store);
  const body: ChatRequestBody = validateChatBody(opts.rawBody);
  if (body.stream) throw new OrinError('validation', 'Streaming needs the SSE endpoint variant ( Accept: text/event-stream ).');
  if (key.perMin && !(ctx.limits ?? new RateLimit()).allow(key.id, key.perMin)) {
    throw new OrinError('rate_limit', 'API key rate limit exceeded.');
  }

  const t0 = Date.now();
  const promptChars = body.messages.map((m) => m.content.length).reduce((a, b) => a + b, 0);
  try {
    const providers = await ctx.store.getProviders(key.userUid);
    const cands = candidates(providers, body.model);
    if (!cands.length) throw new OrinError('validation', `Unknown model '${body.model}'.${availableHint(providers)}`);
    const outcome = await routeChat(synthRoute(body.model, cands), {
      messages: body.messages,
      temperature: body.temperature,
      maxTokens: body.max_tokens,
      signal: opts.signal,
    }, {
      adapters: ctx.adapters ?? adaptersFor(providers),
      health: ctx.health,
      cooldownMs: ctx.cooldownMs,
    });
    void safeLog(ctx, {
      requestId, userUid: key.userUid, keyPrefix: key.prefix, requested: body.model, provider: outcome.provider,
      model: outcome.model, status: 'ok', latencyMs: Date.now() - t0,
      promptChars, completionChars: outcome.text.length, at: Date.now(),
    });
    return completionObject(body.model, outcome.text);
  } catch (e: any) {
    const err = e instanceof OrinError ? e : new OrinError('internal', 'Router failed.');
    void safeLog(ctx, {
      requestId, userUid: key.userUid, keyPrefix: key.prefix, requested: body.model, status: 'error',
      latencyMs: Date.now() - t0, error: `${err.code}: ${err.message}`.slice(0, 300),
      promptChars, at: Date.now(),
    });
    throw err;
  }
}

/**
 * Streaming chat completion. Writes SSE lines via onSse (including [DONE]),
 * then logs. Mid-stream provider death sends an SSE error payload and closes —
 * partial content already sent cannot be recalled (documented behavior).
 */
export async function chatCompletionsStream(ctx: ServiceCtx, opts: ChatOpts): Promise<void> {
  const requestId = opts.requestId ?? crypto.randomUUID();
  const emit = opts.onSse ?? (() => undefined);
  const key = await authenticate(opts.authHeader, ctx.store);
  const body: ChatRequestBody = validateChatBody(opts.rawBody);
  if (key.perMin && !(ctx.limits ?? new RateLimit()).allow(key.id, key.perMin)) {
    throw new OrinError('rate_limit', 'API key rate limit exceeded.');
  }

  const t0 = Date.now();
  const promptChars = body.messages.map((m) => m.content.length).reduce((a, b) => a + b, 0);
  try {
    const providers = await ctx.store.getProviders(key.userUid);
    const cands = candidates(providers, body.model);
    if (!cands.length) throw new OrinError('validation', `Unknown model '${body.model}'.${availableHint(providers)}`);
    const hops = synthRoute(body.model, cands).hops;
    const adapters = ctx.adapters ?? adaptersFor(providers);
    const health = ctx.health ?? new RouterHealth();
    const dead = new Set<string>();
    let lastErr: OrinError | null = null;
    let done = false;

    for (const hop of hops) {
      const adapter = adapters.get(hop.provider);
      if (!adapter || dead.has(hop.provider) || health.isCool(hop.provider, hop.model)) continue;
      let text = '';
      try {
        const r = await adapter.chatStream({
          messages: body.messages, model: hop.model,
          temperature: body.temperature, maxTokens: body.max_tokens, signal: opts.signal,
        }, (chunk) => emit(sseChunk(body.model, chunk)));
        text = r.text;
        health.recordLatency(hop.provider, hop.model, Date.now() - t0);
        emit(SSE_DONE);
        done = true;
        void safeLog(ctx, {
          requestId, userUid: key.userUid, keyPrefix: key.prefix, requested: body.model, provider: hop.provider,
          model: r.model, status: 'ok', latencyMs: Date.now() - t0,
          promptChars, completionChars: text.length, at: Date.now(),
        });
        return;
      } catch (e: any) {
        const err = e instanceof OrinError ? e : new OrinError('provider', String(e?.message || e));
        lastErr = err;
        if (err.action === 'dead-key') dead.add(hop.provider);
        else health.cool(hop.provider, hop.model, ctx.cooldownMs ?? 60_000);
      }
    }
    const err = lastErr ?? new OrinError('route_unavailable', `No healthy provider for '${body.model}'.`);
    emit(`data: ${JSON.stringify({ error: err.toResponse().error })}\n\n`);
    emit(SSE_DONE);
    void safeLog(ctx, {
      requestId, userUid: key.userUid, keyPrefix: key.prefix, requested: body.model, status: 'error',
      latencyMs: Date.now() - t0, error: `${err.code}: ${err.message}`.slice(0, 300),
      promptChars, at: Date.now(),
    });
    if (!done) throw err;
  } catch (e: any) {
    const err = e instanceof OrinError ? e : new OrinError('internal', 'Router failed.');
    if (err.code === 'authentication' || err.code === 'authorization' || err.code === 'validation' || err.code === 'rate_limit') throw err;
    throw err;
  }
}

// ── User management (dashboard /api/*) ──────────────────────────────

export interface ProviderInput {
  id: string;
  type: string;
  baseUrl?: string;
  apiKey: string;
  models?: string[];
  enabled?: boolean;
  timeoutMs?: number;
}

export async function addProvider(store: RouterStore, userUid: string, input: ProviderInput): Promise<{ id: string }> {
  const id = String(input.id || '');
  if (!/^[a-z0-9_-]{1,64}$/.test(id)) throw new OrinError('validation', 'Field "id" ([a-z0-9_-], ≤64) required.');
  if (!PROVIDER_TYPES.has(input.type)) throw new OrinError('validation', 'Field "type" must be openrouter|groq|custom.');
  if (!input.apiKey || typeof input.apiKey !== 'string') throw new OrinError('validation', 'Field "apiKey" required.');
  const cleanUrl = input.type === 'custom' ? validateBaseUrl(String(input.baseUrl || '')) : String(input.baseUrl || '');
  await store.saveProvider({
    userUid, id, type: input.type as ProviderDef['type'], baseUrl: cleanUrl, apiKey: input.apiKey,
    models: Array.isArray(input.models) ? input.models.map(String).slice(0, 200) : [],
    enabled: input.enabled !== false,
    timeoutMs: Number(input.timeoutMs) > 0 ? Number(input.timeoutMs) : undefined,
  });
  return { id };
}

export function publicProviders(providers: ProviderDef[]): Omit<ProviderDef, 'apiKey' | 'userUid'>[] {
  return providers.map((p) => ({
    id: p.id, type: p.type, baseUrl: p.baseUrl,
    models: p.models, enabled: p.enabled, timeoutMs: p.timeoutMs,
  }));
}

/** Live test: one real call through the provider. Logged like any request. */
export async function testProvider(
  ctx: ServiceCtx, userUid: string, id: string, model?: string,
): Promise<{ ok: boolean; text?: string; provider?: string; model?: string; latencyMs: number; error?: string }> {
  const providers = await ctx.store.getProviders(userUid);
  const p = providers.find((x) => x.id === id && x.enabled);
  if (!p) throw new OrinError('validation', `Unknown provider '${id}'.`);
  const useModel = model || (p.models ?? [])[0] || 'test';
  const adapter = (ctx.adapters ?? adaptersFor(providers)).get(p.id);
  if (!adapter) throw new OrinError('internal', 'No adapter for provider.');
  const t0 = Date.now();
  try {
    const r = await adapter.chat({ messages: [{ role: 'user', content: 'Reply with exactly: ok' }], model: useModel });
    const latencyMs = Date.now() - t0;
    void safeLog(ctx, {
      requestId: crypto.randomUUID(), userUid, keyPrefix: '(dashboard)', requested: `(test) ${useModel}`,
      provider: p.id, model: r.model, status: 'ok', latencyMs,
      promptChars: 22, completionChars: r.text.length, at: Date.now(),
    });
    return { ok: true, text: r.text.slice(0, 500), provider: p.id, model: r.model, latencyMs };
  } catch (e: any) {
    const err = e instanceof OrinError ? e : new OrinError('provider', String(e?.message || e));
    const latencyMs = Date.now() - t0;
    void safeLog(ctx, {
      requestId: crypto.randomUUID(), userUid, keyPrefix: '(dashboard)', requested: `(test) ${useModel}`,
      provider: p.id, status: 'error', latencyMs,
      error: `${err.code}: ${err.message}`.slice(0, 300), promptChars: 22, at: Date.now(),
    });
    return { ok: false, latencyMs, error: `${err.code}: ${err.message}`.slice(0, 300) };
  }
}

export async function mintUserKey(
  store: RouterStore, userUid: string, name: string, perMin?: number,
): Promise<{ key: string; id: string; prefix: string }> {
  if (!name || typeof name !== 'string' || name.length > 80) throw new OrinError('validation', 'Field "name" (1..80 chars) required.');
  const m = mintKey();
  const rec: ApiKeyRecord = {
    id: 'key_' + crypto.randomUUID().slice(0, 12), userUid,
    prefix: m.prefix, hash: m.hash, name,
    perMin: Number(perMin) > 0 ? Math.floor(Number(perMin)) : 0,
    enabled: true, createdAt: Date.now(),
  };
  await store.createKey(rec);
  return { key: m.secret, id: rec.id, prefix: rec.prefix };
}

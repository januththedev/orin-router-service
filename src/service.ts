/**
 * Service orchestration: auth → validate → route → respond → log.
 * Pure against injected ctx — fully testable without HTTP or a database.
 */
import crypto from 'node:crypto';
import { OrinError } from './errors.js';
import { bearerToken, hashSecret } from './keys.js';
import { customAdapter, groqAdapter, openRouterAdapter, type ProviderAdapter } from './providers.js';
import { RouterHealth, routeChat } from './router.js';
import { RateLimit } from './ratelimit.js';
import type { RouterStore } from './store.js';
import type { ApiKeyRecord, ChatRequestBody, ProviderDef, UsageLog } from './types.js';
import { validateChatBody } from './validate.js';

export interface ServiceCtx {
  store: RouterStore;
  health?: RouterHealth;
  limits?: RateLimit;
  cooldownMs?: number;
  logErrors?: (e: unknown) => void;
  /** Injected adapters (tests / dry-run). Defaults to building from provider rows. */
  adapters?: Map<string, ProviderAdapter>;
}

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

export async function listModels(store: RouterStore): Promise<{ object: string; data: { id: string; object: string; owned_by: string }[] }> {
  const routes = (await store.getRoutes()).filter((r) => r.enabled && r.hops.length > 0);
  return { object: 'list', data: routes.map((r) => ({ id: r.id, object: 'model', owned_by: 'orin-router' })) };
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
    const [providers, routes] = await Promise.all([ctx.store.getProviders(), ctx.store.getRoutes()]);
    const route = routes.find((r) => r.id === body.model && r.enabled);
    if (!route) throw new OrinError('validation', `Unknown model/route '${body.model}'. See GET /v1/models.`);
    const outcome = await routeChat(route, {
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
      requestId, keyPrefix: key.prefix, route: route.id, provider: outcome.provider,
      model: outcome.model, status: 'ok', latencyMs: Date.now() - t0,
      promptChars, completionChars: outcome.text.length, at: Date.now(),
    });
    return completionObject(body.model, outcome.text);
  } catch (e: any) {
    const err = e instanceof OrinError ? e : new OrinError('internal', 'Router failed.');
    void safeLog(ctx, {
      requestId, keyPrefix: key.prefix, route: body.model, status: 'error',
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
    const [providers, routes] = await Promise.all([ctx.store.getProviders(), ctx.store.getRoutes()]);
    const route = routes.find((r) => r.id === body.model && r.enabled);
    if (!route) throw new OrinError('validation', `Unknown model/route '${body.model}'. See GET /v1/models.`);
    const adapters = ctx.adapters ?? adaptersFor(providers);
    const health = ctx.health ?? new RouterHealth();
    const dead = new Set<string>();
    let lastErr: OrinError | null = null;
    let done = false;

    for (const hop of route.hops) {
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
          requestId, keyPrefix: key.prefix, route: route.id, provider: hop.provider,
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
    const err = lastErr ?? new OrinError('route_unavailable', `Route ${route.id} has no healthy hops.`);
    emit(`data: ${JSON.stringify({ error: err.toResponse().error })}\n\n`);
    emit(SSE_DONE);
    void safeLog(ctx, {
      requestId, keyPrefix: key.prefix, route: route.id, status: 'error',
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

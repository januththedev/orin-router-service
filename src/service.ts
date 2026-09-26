import { randomUUID } from "node:crypto";
import { RouterError, classifyUpstream } from "./errors.js";
import { listFreeModels, requireCandidates } from "./catalog.js";
import type { CatalogStore } from "./catalog.js";
import { MODEL_ALIASES, type ProviderAttemptFact, type ServicePrincipal, type ChatRequestBody, type ImageRequestBody, type RoutableModel, type DistributedState, type RouterStore } from "./types.js";
import { StreamSession } from "./stream-session.js";
import type { StreamWriter } from "./stream-session.js";
import type { UpstreamResolver } from "./upstream-credentials.js";

export interface RouterServiceContext { store: RouterStore; state: DistributedState; catalog: CatalogStore; upstream: UpstreamResolver; accountLimit: number; }

function attemptBase(principal: ServicePrincipal, requestId: string, alias: RoutableModel, attemptNo: number) { return { requestId, usageReservationId: principal.usageReservationId, accountId: principal.accountId, alias, attemptNo }; }
function publicCompletion(model: RoutableModel, text: string, requestId: string) { return { id: `chatcmpl-${randomUUID().slice(0, 8)}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, request_id: requestId }; }

/**
 * Advertises the four Orin aliases plus every free model currently eligible in
 * the catalog, so a client can either stay on an alias or pin an exact model.
 */
export async function listModels(catalog: CatalogStore | null = null) {
  const aliases = MODEL_ALIASES.map((id) => ({ id, object: "model", owned_by: "orin" }));
  const free = (catalog ? listFreeModels(catalog.getFresh(), "text") : []).map((entry) => ({
    id: entry.modelId,
    object: "model",
    owned_by: entry.provider,
    context_length: entry.contextLimit,
    pricing: { prompt: String(entry.prices.prompt ?? 0), completion: String(entry.prices.completion ?? 0) },
  }));
  return { object: "list", data: [...aliases, ...free] };
}

export async function executeChat(ctx: RouterServiceContext, principal: ServicePrincipal, body: ChatRequestBody, requestId: string = randomUUID(), signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (!(await ctx.state.consumeRequest(`${principal.accountId}:chat`, ctx.accountLimit, 60_000))) throw new RouterError("ORIN_RATE_LIMITED", "Router request limit exceeded.", true, requestId);
  const { adapter } = await ctx.upstream.resolve(principal);
  const candidates = requireCandidates(ctx.catalog.getFresh(), body.model, "text").slice(0, 3);
  let last: RouterError | null = null;
  for (const candidate of candidates) {
    const key = { provider: candidate.provider, model: candidate.modelId };
    if (!(await ctx.state.isEligible(key))) continue;
    const attemptNo = candidates.indexOf(candidate) + 1;
    const started = Date.now();
    await ctx.store.beginAttempt({ ...attemptBase(principal, requestId, body.model, attemptNo), provider: candidate.provider, model: candidate.modelId });
    try {
      const result = await adapter.chat(body, candidate.modelId, signal);
      const fact: ProviderAttemptFact = { ...attemptBase(principal, requestId, body.model, attemptNo), provider: candidate.provider, model: candidate.modelId, status: "succeeded", latencyMs: Date.now() - started, units: result.units, estimatedCostMicros: 0, errorCode: null };
      await ctx.store.finishAttempt(fact);
      await ctx.state.recordSuccess(key, fact.latencyMs);
      return publicCompletion(body.model, result.text, requestId);
    } catch (error) {
      const upstream = error instanceof RouterError ? error : new RouterError("ORIN_PROVIDER_ERROR", "Provider request failed.", true);
      last = upstream;
      await ctx.store.finishAttempt({ ...attemptBase(principal, requestId, body.model, attemptNo), provider: candidate.provider, model: candidate.modelId, status: "failed", latencyMs: Date.now() - started, units: 0, estimatedCostMicros: null, errorCode: upstream.code });
      await ctx.state.recordFailure(key, 500);
      if (upstream.code === "ORIN_PROVIDER_EXHAUSTED") break;
    }
  }
  throw last ?? new RouterError("ORIN_PROVIDER_EXHAUSTED", "No eligible provider is currently available.", true, requestId);
}

export async function executeChatStream(ctx: RouterServiceContext, principal: ServicePrincipal, body: ChatRequestBody, writer: StreamWriter, requestId: string = randomUUID(), signal?: AbortSignal): Promise<void> {
  if (!(await ctx.state.consumeRequest(`${principal.accountId}:chat-stream`, ctx.accountLimit, 60_000))) throw new RouterError("ORIN_RATE_LIMITED", "Router request limit exceeded.", true, requestId);
  const { adapter } = await ctx.upstream.resolve(principal);
  const candidates = requireCandidates(ctx.catalog.getFresh(), body.model, "text").slice(0, 3);
  let last: RouterError | null = null;
  for (const candidate of candidates) {
    const key = { provider: candidate.provider, model: candidate.modelId };
    if (!(await ctx.state.isEligible(key))) continue;
    const attemptNo = candidates.indexOf(candidate) + 1;
    const started = Date.now();
    await ctx.store.beginAttempt({ ...attemptBase(principal, requestId, body.model, attemptNo), provider: candidate.provider, model: candidate.modelId });
    const session = new StreamSession(writer, () => writer.event("event: start\ndata: {}\n\n"));
    try {
      let text = "";
      const result = await adapter.stream(body, candidate.modelId, (chunk) => {
        text += chunk;
        session.emit({ object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] });
      }, signal);
      await ctx.store.finishAttempt({ ...attemptBase(principal, requestId, body.model, attemptNo), provider: candidate.provider, model: candidate.modelId, status: "succeeded", latencyMs: Date.now() - started, units: result.units, estimatedCostMicros: 0, errorCode: null });
      await ctx.state.recordSuccess(key, Date.now() - started);
      session.finish({ object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      return;
    } catch (error) {
      const upstream = error instanceof RouterError ? error : new RouterError("ORIN_STREAM_INTERRUPTED", "The provider stream ended unexpectedly.", true);
      last = upstream;
      await ctx.store.finishAttempt({ ...attemptBase(principal, requestId, body.model, attemptNo), provider: candidate.provider, model: candidate.modelId, status: "failed", latencyMs: Date.now() - started, units: 0, estimatedCostMicros: null, errorCode: upstream.code });
      await ctx.state.recordFailure(key, 500);
      if (session.committed) { session.fail(upstream, requestId); return; }
    }
  }
  if (last) throw last;
  throw new RouterError("ORIN_PROVIDER_EXHAUSTED", "No eligible provider is currently available.", true, requestId);
}

export async function executeImage(ctx: RouterServiceContext, principal: ServicePrincipal, body: ImageRequestBody, requestId: string = randomUUID(), signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (!(await ctx.state.consumeRequest(`${principal.accountId}:image`, ctx.accountLimit, 60_000))) throw new RouterError("ORIN_RATE_LIMITED", "Router request limit exceeded.", true, requestId);
  const { adapter } = await ctx.upstream.resolve(principal);
  const candidates = requireCandidates(ctx.catalog.getFresh(), body.model, "image_generation").slice(0, 3);
  let last: RouterError | null = null;
  for (const candidate of candidates) {
    const key = { provider: candidate.provider, model: candidate.modelId };
    if (!(await ctx.state.isEligible(key))) continue;
    const attemptNo = candidates.indexOf(candidate) + 1;
    const started = Date.now();
    await ctx.store.beginAttempt({ ...attemptBase(principal, requestId, body.model, attemptNo), provider: candidate.provider, model: candidate.modelId });
    try {
      const result = await adapter.image(body, candidate.modelId, signal);
      await ctx.store.finishAttempt({ ...attemptBase(principal, requestId, body.model, attemptNo), provider: candidate.provider, model: candidate.modelId, status: "succeeded", latencyMs: Date.now() - started, units: result.units, estimatedCostMicros: 0, errorCode: null });
      return { created: Math.floor(Date.now() / 1000), data: [{ b64_json: result.data }], model: body.model, request_id: requestId };
    } catch (error) {
      const upstream = error instanceof RouterError ? error : new RouterError("ORIN_PROVIDER_ERROR", "Image provider request failed.", true);
      last = upstream;
      await ctx.store.finishAttempt({ ...attemptBase(principal, requestId, body.model, attemptNo), provider: candidate.provider, model: candidate.modelId, status: "failed", latencyMs: Date.now() - started, units: 0, estimatedCostMicros: null, errorCode: upstream.code });
    }
  }
  throw last ?? new RouterError("ORIN_PROVIDER_EXHAUSTED", "No eligible image provider is currently available.", true, requestId);
}

export { classifyUpstream };

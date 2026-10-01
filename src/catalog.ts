import { createHash } from "node:crypto";
import { RouterError } from "./errors.js";
import { filterFreeModels, isFreeModelId } from "./free-models.js";
import type { CatalogModel, CatalogSnapshot, ModelAlias } from "./types.js";

const CATALOG_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const nowIso = () => new Date().toISOString();

export class CatalogStore {
  private snapshot: CatalogSnapshot | null = null;
  constructor(initial?: CatalogSnapshot | null) { this.snapshot = initial ?? null; }
  getFresh(now = new Date()): CatalogSnapshot | null {
    if (!this.snapshot) return null;
    const age = now.getTime() - Date.parse(this.snapshot.fetchedAt);
    return age >= 0 && age <= CATALOG_MAX_AGE_MS && this.snapshot.status === "success" ? this.snapshot : null;
  }
  set(snapshot: CatalogSnapshot): void { this.snapshot = snapshot; }
}

export function fakeCatalog(): CatalogSnapshot {
  const model: CatalogModel = {
    provider: "fake",
    modelId: "fake/free-text:free",
    fetchedAt: nowIso(),
    sourceStatus: "success",
    capabilities: ["text", "streaming", "image_generation"],
    contextLimit: 8192,
    prices: { prompt: 0, completion: 0, image: 0 },
  };
  return { provider: "fake", fetchedAt: model.fetchedAt, status: "success", sourceVersion: "fake", sourceResponseHash: "0".repeat(64), models: [model] };
}

/**
 * Two independent gates: the model id must carry the free marker of the provider
 * that serves it, and the catalog must price it at zero. A model that passes
 * both is safe to answer a user with.
 *
 * The marker is provider-scoped on purpose. OpenRouter writes `:free` and
 * OpenCode writes `-free`, so a single global suffix would either reject every
 * OpenCode model or, worse, accept an OpenCode id as an OpenRouter one and send
 * it to the wrong origin.
 */
export function isEligible(model: CatalogModel, capability: "text" | "image_generation", now = new Date()): boolean {
  const age = now.getTime() - Date.parse(model.fetchedAt);
  if (model.sourceStatus !== "success" || age < 0 || age > CATALOG_MAX_AGE_MS) return false;
  if (!model.capabilities.includes(capability)) return false;
  if (!isFreeModelId(model.modelId, model.provider)) return false;
  return capability === "text"
    ? model.prices.prompt === 0 && model.prices.completion === 0
    : model.prices.image === 0;
}

export function candidatesFor(
  snapshot: CatalogSnapshot | null,
  model: ModelAlias | string,
  capability: "text" | "image_generation",
  now = new Date(),
): CatalogModel[] {
  if (!snapshot) return [];
  const eligible = snapshot.models.filter((entry) => isEligible(entry, capability, now));
  const pinned = isFreeModelId(model) ? eligible.filter((entry) => entry.modelId === model) : eligible;
  return pinned.sort((a, b) => a.modelId.localeCompare(b.modelId));
}

export interface CatalogSource {
  provider: string;
  url: string;
}

export const CATALOG_SOURCES: readonly CatalogSource[] = Object.freeze([
  { provider: "openrouter", url: "https://openrouter.ai/api/v1/models" },
  // OpenCode serves its model list without a credential. It is a second source
  // of genuinely no-cost ids, not a way around the free-tier gate: see
  // `opencodeFreeTierTerms` for why this origin stays BYOK-only.
  { provider: "opencode", url: "https://opencode.ai/zen/v1/models" },
]);

async function fetchSource(source: CatalogSource, fetchImpl: typeof fetch): Promise<{ models: CatalogModel[]; raw: string } | null> {
  const response = await fetchImpl(source.url, { headers: { accept: "application/json" } });
  if (!response.ok) return null;
  const raw = await response.text();
  const parsed = JSON.parse(raw) as { data?: Array<Record<string, unknown>> };
  const provider = source.provider;
  // Zen publishes no prices, so its no-cost models are established by the `-free`
  // marker plus the published pricing table. Recording 0 is what lets the shared
  // `isEligible` zero-price gate treat both sources identically.
  const priced = provider === "opencode";
  const mapped = (parsed.data ?? []).map((item) => ({
    provider,
    modelId: String(item.id ?? ""),
    fetchedAt: nowIso(),
    sourceStatus: "success" as const,
    capabilities: ["text", "streaming"],
    contextLimit: Number(item.context_length ?? 0),
    prices: priced
      ? { prompt: 0, completion: 0, image: null }
      : {
          prompt: Number((item.pricing as Record<string, unknown> | undefined)?.prompt ?? NaN),
          completion: Number((item.pricing as Record<string, unknown> | undefined)?.completion ?? NaN),
          image: null,
        },
  }));
  return { models: filterFreeModels(mapped), raw };
}

/**
 * Builds one snapshot from every configured source.
 *
 * A source that fails is dropped rather than failing the whole refresh: one
 * provider being unreachable should not empty the pool. A refresh where every
 * source failed is a failure, so the router fails closed instead of pretending
 * it has no models for a reason other than "none exist".
 */
export async function refreshCatalog(
  urlOrSources: string | readonly CatalogSource[] = CATALOG_SOURCES,
  fetchImpl: typeof fetch = fetch,
): Promise<CatalogSnapshot> {
  const sources: readonly CatalogSource[] = typeof urlOrSources === "string" ? [{ provider: "openrouter", url: urlOrSources }] : urlOrSources;
  const models: CatalogModel[] = [];
  const parts: string[] = [];
  for (const source of sources) {
    try {
      const result = await fetchSource(source, fetchImpl);
      if (!result) continue;
      models.push(...result.models);
      parts.push(`${source.provider}:${createHash("sha256").update(result.raw).digest("hex")}`);
    } catch {
      // A source that throws is treated exactly like one that returns non-2xx.
    }
  }
  if (!parts.length) {
    return { provider: "catalog", fetchedAt: nowIso(), status: "failure", sourceVersion: "unknown", sourceResponseHash: "0".repeat(64), models: [], errorCode: "ORIN_CATALOG_UNAVAILABLE" };
  }
  return {
    provider: "catalog",
    fetchedAt: nowIso(),
    status: "success",
    sourceVersion: sources.map((source) => source.provider).join("+"),
    sourceResponseHash: createHash("sha256").update(parts.join("|")).digest("hex"),
    models,
  };
}

export function requireCandidates(
  snapshot: CatalogSnapshot | null,
  model: ModelAlias | string,
  capability: "text" | "image_generation",
): CatalogModel[] {
  const candidates = candidatesFor(snapshot, model, capability);
  if (!candidates.length) throw new RouterError("ORIN_PROVIDER_EXHAUSTED", "No eligible free model is currently available.", true);
  return candidates;
}

/** The free model ids a client may pin, for `GET /v1/models`. */
export function listFreeModels(
  snapshot: CatalogSnapshot | null,
  capability: "text" | "image_generation" = "text",
  now = new Date(),
): CatalogModel[] {
  if (!snapshot) return [];
  return snapshot.models.filter((entry) => isEligible(entry, capability, now)).sort((a, b) => a.modelId.localeCompare(b.modelId));
}

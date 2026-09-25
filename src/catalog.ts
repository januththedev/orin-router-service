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
 * Two independent gates: the model id must carry OpenRouter's `:free` marker,
 * and the catalog must price it at zero. A model that passes both is safe to
 * answer a user with.
 */
export function isEligible(model: CatalogModel, capability: "text" | "image_generation", now = new Date()): boolean {
  const age = now.getTime() - Date.parse(model.fetchedAt);
  if (model.sourceStatus !== "success" || age < 0 || age > CATALOG_MAX_AGE_MS) return false;
  if (!model.capabilities.includes(capability)) return false;
  if (!isFreeModelId(model.modelId)) return false;
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

export async function refreshCatalog(url: string, fetchImpl: typeof fetch = fetch): Promise<CatalogSnapshot> {
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    return { provider: "openrouter", fetchedAt: nowIso(), status: "failure", sourceVersion: "unknown", sourceResponseHash: "0".repeat(64), models: [], errorCode: "ORIN_CATALOG_UNAVAILABLE" };
  }
  const raw = await response.text();
  const parsed = JSON.parse(raw) as { data?: Array<Record<string, unknown>> };
  const mapped = (parsed.data ?? []).map((item) => ({
    provider: "openrouter",
    modelId: String(item.id ?? ""),
    fetchedAt: nowIso(),
    sourceStatus: "success" as const,
    capabilities: ["text", "streaming"],
    contextLimit: Number(item.context_length ?? 0),
    prices: {
      prompt: Number((item.pricing as Record<string, unknown> | undefined)?.prompt ?? NaN),
      completion: Number((item.pricing as Record<string, unknown> | undefined)?.completion ?? NaN),
      image: null,
    },
  }));
  // Keep only the no-cost tier at ingest, so nothing downstream can route to a paid model.
  return {
    provider: "openrouter",
    fetchedAt: nowIso(),
    status: "success",
    sourceVersion: "openrouter",
    sourceResponseHash: createHash("sha256").update(raw).digest("hex"),
    models: filterFreeModels(mapped),
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

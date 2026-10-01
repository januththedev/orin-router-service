import { RouterError } from "./errors.js";
import { MODEL_ALIASES, type ModelAlias } from "./types.js";
import { PROVIDER_ORIGINS } from "./provider-registry.js";

/**
 * Orin's standing product policy: user-facing traffic is answered only by
 * no-cost models. Each provider marks those in its own id namespace, so the
 * marker is read from the provider rather than hardcoded to one convention:
 * OpenRouter appends `:free`, OpenCode Zen appends `-free`. The suffix is the
 * first gate; zero pricing in `catalog.isEligible` is the second, independent
 * one. A suffix alone never authorises a model -- `requireCandidates` still has
 * to find that exact id in the catalog, so an invented `-free` id resolves to
 * "no eligible model" rather than reaching a provider.
 */
export const FREE_MODEL_SUFFIX = ":free";

const FREE_ID_BODY = /^[\w.\-/]+$/;

function hasFreeSuffix(modelId: string, suffix: string): boolean {
  if (modelId.length <= suffix.length || modelId.length > 200) return false;
  if (!modelId.endsWith(suffix)) return false;
  const body = modelId.slice(0, -suffix.length);
  return FREE_ID_BODY.test(body) && !body.includes(":");
}

/** The suffix set a model id may legally end with, scoped to one provider. */
export function freeSuffixFor(provider: string): string {
  return PROVIDER_ORIGINS[provider]?.freeSuffix ?? FREE_MODEL_SUFFIX;
}

/**
 * True when `modelId` carries a no-cost marker. Pass `provider` to scope the
 * check to that provider's own convention; omit it to accept any known
 * provider's marker, which is what the client-facing pin gate wants.
 */
export function isFreeModelId(modelId: unknown, provider?: string): modelId is string {
  if (typeof modelId !== "string") return false;
  if (provider !== undefined) return hasFreeSuffix(modelId, freeSuffixFor(provider));
  return Object.values(PROVIDER_ORIGINS).some((origin) => hasFreeSuffix(modelId, origin.freeSuffix));
}

export function isModelAlias(value: unknown): value is ModelAlias {
  return typeof value === "string" && (MODEL_ALIASES as readonly string[]).includes(value);
}

/** A request may name either an Orin alias or a concrete free model id. */
export function isRoutableModelId(value: unknown): value is ModelAlias | string {
  return isModelAlias(value) || isFreeModelId(value);
}

export function assertRoutableModelId(value: unknown): ModelAlias | string {
  if (isModelAlias(value)) return value;
  if (isFreeModelId(value)) return value;
  throw new RouterError(
    "ORIN_MODEL_NOT_FOUND",
    "Orin routes only free models. Use an Orin alias or a provider-marked free model id.",
  );
}

/** Catalog ingest keeps only the ids whose marker matches the provider that serves them. */
export function filterFreeModels<T extends { modelId: string; provider?: string }>(models: readonly T[]): T[] {
  return models.filter((model) => isFreeModelId(model.modelId, model.provider));
}

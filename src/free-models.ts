import { RouterError } from "./errors.js";
import { MODEL_ALIASES, type ModelAlias } from "./types.js";

/**
 * Orin's standing product policy: user-facing traffic is answered only by
 * OpenRouter's no-cost tier. OpenRouter marks that tier with a `:free` model-id
 * suffix, so the suffix is the authoritative signal and zero pricing is treated
 * as a second, independent gate in `isEligible`.
 */
export const FREE_MODEL_SUFFIX = ":free";

const FREE_ID_BODY = /^[\w.\-/]+$/;

export function isFreeModelId(modelId: unknown): modelId is string {
  if (typeof modelId !== "string") return false;
  if (modelId.length <= FREE_MODEL_SUFFIX.length || modelId.length > 200) return false;
  if (!modelId.endsWith(FREE_MODEL_SUFFIX)) return false;
  const body = modelId.slice(0, -FREE_MODEL_SUFFIX.length);
  return FREE_ID_BODY.test(body) && !body.includes(":");
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
    "Orin routes only free OpenRouter models. Use an Orin alias or a `:free` model id.",
  );
}

export function filterFreeModels<T extends { modelId: string }>(models: readonly T[]): T[] {
  return models.filter((model) => isFreeModelId(model.modelId));
}

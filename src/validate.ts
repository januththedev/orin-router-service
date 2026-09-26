import { RouterError } from "./errors.js";
import { assertRoutableModelId } from "./free-models.js";
import type { ChatMessage, ChatRequestBody, ImageRequestBody } from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }

export function validateChatBody(body: unknown): ChatRequestBody {
  if (!isPlainObject(body)) throw new RouterError("ORIN_VALIDATION_FAILED", "Request body must be a JSON object.");
  const allowed = new Set(["model", "messages", "stream", "temperature", "max_tokens"]);
  for (const key of Object.keys(body)) if (!allowed.has(key)) throw new RouterError("ORIN_VALIDATION_FAILED", `Unknown field ${key}.`);
  const model = assertRoutableModelId(body.model);
  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 200) throw new RouterError("ORIN_VALIDATION_FAILED", "messages must contain 1–200 items.");
  const messages: ChatMessage[] = body.messages.map((item: unknown, index: number) => {
    if (!isPlainObject(item) || !["system", "user", "assistant"].includes(String(item.role)) || typeof item.content !== "string" || item.content.length > 100_000) throw new RouterError("ORIN_VALIDATION_FAILED", `Message ${index} is invalid or too large.`);
    return { role: item.role as ChatMessage["role"], content: item.content };
  });
  if (body.stream !== undefined && typeof body.stream !== "boolean") throw new RouterError("ORIN_VALIDATION_FAILED", "stream must be boolean.");
  if (body.temperature !== undefined && (typeof body.temperature !== "number" || !Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2)) throw new RouterError("ORIN_VALIDATION_FAILED", "temperature must be between 0 and 2.");
  const maxTokens = body.max_tokens;
  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || (maxTokens as number) < 1 || (maxTokens as number) > 100_000)) throw new RouterError("ORIN_VALIDATION_FAILED", "max_tokens must be an integer from 1 to 100000.");
  return { model, messages, stream: body.stream === true, temperature: body.temperature as number | undefined, max_tokens: maxTokens as number | undefined };
}

export function validateImageBody(body: unknown): ImageRequestBody {
  if (!isPlainObject(body)) throw new RouterError("ORIN_VALIDATION_FAILED", "Request body must be a JSON object.");
  const allowed = new Set(["model", "prompt", "n", "size", "response_format"]);
  for (const key of Object.keys(body)) if (!allowed.has(key)) throw new RouterError("ORIN_VALIDATION_FAILED", `Unknown field ${key}.`);
  const model = assertRoutableModelId(body.model);
  if (typeof body.prompt !== "string" || body.prompt.length < 1 || body.prompt.length > 4000) throw new RouterError("ORIN_VALIDATION_FAILED", "prompt must contain 1–4000 characters.");
  if (body.n !== 1 || body.response_format !== "b64_json") throw new RouterError("ORIN_VALIDATION_FAILED", "Only n=1 and response_format=b64_json are supported.");
  if (body.size !== undefined && !["512x512", "768x768", "1024x1024"].includes(String(body.size))) throw new RouterError("ORIN_VALIDATION_FAILED", "Unsupported image size.");
  return { model, prompt: body.prompt, n: 1, size: body.size as ImageRequestBody["size"], response_format: "b64_json" };
}

export { isPlainObject };

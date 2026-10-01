import { RouterError } from "./errors.js";
import type { ChatRequestBody, ImageRequestBody, ProviderAdapter } from "./types.js";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

/**
 * Fixed upstream origins. A BYOK base URL is never accepted from the client, so
 * the Router cannot be turned into an SSRF proxy by anything stored on an
 * account. Adding a provider means adding an entry here, nothing else.
 */
export interface ProviderOrigin {
  id: string;
  baseUrl: string;
  chatPath: string;
  imagePath: string | null;
  attribution: boolean;
  /**
   * How this provider marks a no-cost model in its own id. OpenRouter uses a
   * `:free` suffix; OpenCode Zen uses `-free`. The marker is per-provider
   * because it is read off the provider's id namespace, not chosen by us.
   */
  freeSuffix: string;
  /**
   * Whether the shared platform key may be used for this origin. Only the
   * provider the platform key actually belongs to may be reached that way; any
   * other origin requires the account's own BYOK credential. See
   * `upstream-credentials.ts`.
   */
  acceptsPlatformKey: boolean;
}

export const PROVIDER_ORIGINS: Readonly<Record<string, ProviderOrigin>> = Object.freeze({
  openrouter: { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1", chatPath: "/chat/completions", imagePath: "/images/generations", attribution: true, freeSuffix: ":free", acceptsPlatformKey: true },
  deepseek: { id: "deepseek", baseUrl: "https://api.deepseek.com", chatPath: "/chat/completions", imagePath: null, attribution: false, freeSuffix: ":free", acceptsPlatformKey: false },
  groq: { id: "groq", baseUrl: "https://api.groq.com/openai/v1", chatPath: "/chat/completions", imagePath: null, attribution: false, freeSuffix: ":free", acceptsPlatformKey: false },
  openai: { id: "openai", baseUrl: "https://api.openai.com/v1", chatPath: "/chat/completions", imagePath: "/images/generations", attribution: false, freeSuffix: ":free", acceptsPlatformKey: false },
  // OpenCode Zen is OpenAI-compatible, but it is BYOK-only: see the note on
  // `opencodeFreeTierTerms` before adding any shared key here.
  opencode: { id: "opencode", baseUrl: "https://opencode.ai/zen/v1", chatPath: "/chat/completions", imagePath: null, attribution: false, freeSuffix: "-free", acceptsPlatformKey: false },
});

/**
 * Why OpenCode Zen is BYOK-only.
 *
 * OpenCode's Terms of Use (https://opencode.ai/legal/terms-of-service, effective
 * 2026-08-15) state, verbatim:
 *
 *   "You will only use the Services for your own internal use, and not on
 *    behalf of or for the benefit of any third party, and only in a manner that
 *    complies with all laws that apply to you."
 *
 * Routing the no-cost tier for our own users is "on behalf of" third parties, so
 * a shared Orin key against the free models is prohibited by that sentence. Two
 * further facts, both measured against the live API rather than the docs:
 *
 *   - 9 of the 11 free model ids answer HTTP 403 `FreeTierError`: "OpenCode's
 *     free tier can only be used from within OpenCode". Spoofing
 *     `x-opencode-client`, `x-opencode-session` and `User-Agent` does not defeat
 *     the gate. Only `space-bunny-free` answered HTTP 200 with no credential.
 *   - On an unpaid account OpenCode may use Content "to further develop and
 *     improve our Services", so relaying a user's prompts would feed a training
 *     pipeline the user never agreed to.
 *
 * Requiring the account's own key keeps the request the user's own internal use,
 * which is what the terms permit. Do not add a platform key for this origin.
 */
export const opencodeFreeTierTerms = Object.freeze({
  provider: "opencode",
  byokOnly: true,
  termsUrl: "https://opencode.ai/legal/terms-of-service",
  /** Exact controlling sentence, quoted so a future edit cannot paraphrase it. */
  internalUseOnlyClause:
    "You will only use the Services for your own internal use, and not on behalf of or for the benefit of any third party, and only in a manner that complies with all laws that apply to you.",
});


/** Preference order when an account holds more than one usable BYOK key. */
export const BYOK_PREFERENCE: readonly string[] = Object.keys(PROVIDER_ORIGINS);

export function isKnownProviderOrigin(provider: string): provider is keyof typeof PROVIDER_ORIGINS {
  return Object.prototype.hasOwnProperty.call(PROVIDER_ORIGINS, provider);
}

class FakeAdapter implements ProviderAdapter {
  readonly id = "fake";
  async chat(request: ChatRequestBody) { return { text: `fake:${request.messages.at(-1)?.content ?? ""}`, model: "fake/free-text:free", units: 1 }; }
  async stream(request: ChatRequestBody, _model: string, onText: (text: string) => void) { const text = `fake:${request.messages.at(-1)?.content ?? ""}`; onText(text); return { text, model: "fake/free-text:free", units: 1 }; }
  async image(_request: ImageRequestBody) { return { data: PNG_1X1, model: "fake/free-text:free", units: 1 }; }
}

class OpenAiCompatibleAdapter implements ProviderAdapter {
  readonly id: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly origin: ProviderOrigin;
  constructor(origin: ProviderOrigin, apiKey: string, fetchImpl: typeof fetch = fetch) {
    this.origin = origin;
    this.id = origin.id;
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }
  private headers() {
    const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` };
    if (this.origin.attribution) { headers["http-referer"] = "https://orinai.org"; headers["x-title"] = "Orin Router"; }
    return headers;
  }
  private async post(path: string, payload: Record<string, unknown>) {
    const response = await this.fetchImpl(`${this.origin.baseUrl}${path}`, { method: "POST", headers: this.headers(), body: JSON.stringify(payload) });
    if (!response.ok) throw new RouterError("ORIN_PROVIDER_ERROR", `Provider failed (HTTP ${response.status}).`, response.status >= 500 || response.status === 429);
    return await response.json() as any;
  }
  async chat(request: ChatRequestBody, model: string) {
    const body = await this.post(this.origin.chatPath, { model, messages: request.messages, temperature: request.temperature, max_tokens: request.max_tokens });
    return { text: body?.choices?.[0]?.message?.content ?? "", model, units: 1 };
  }
  async stream(request: ChatRequestBody, model: string, onText: (text: string) => void) {
    const result = await this.chat(request, model);
    onText(result.text);
    return result;
  }
  async image(request: ImageRequestBody, model: string) {
    if (!this.origin.imagePath) throw new RouterError("ORIN_PROVIDER_ERROR", `The ${this.id} provider does not serve image generation.`);
    const body = await this.post(this.origin.imagePath, { model, prompt: request.prompt, n: 1, size: request.size, response_format: "b64_json" });
    return { data: body?.data?.[0]?.b64_json ?? "", model, units: 1 };
  }
}

export function createProviderAdapter(mode: "fake" | "live", apiKey: string | undefined, fetchImpl: typeof fetch = fetch): ProviderAdapter {
  if (mode === "fake") return new FakeAdapter();
  if (!apiKey) throw new Error("ORIN_PROVIDER_API_KEY is required in live mode");
  return new OpenAiCompatibleAdapter(PROVIDER_ORIGINS.openrouter, apiKey, fetchImpl);
}

export function createProviderAdapterForOrigin(provider: string, apiKey: string, fetchImpl: typeof fetch = fetch): ProviderAdapter {
  if (!isKnownProviderOrigin(provider)) throw new RouterError("ORIN_VALIDATION_FAILED", "Unsupported provider.");
  return new OpenAiCompatibleAdapter(PROVIDER_ORIGINS[provider], apiKey, fetchImpl);
}

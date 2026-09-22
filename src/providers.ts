/**
 * Provider adapters. One interface, one file-shaped concern per provider:
 * request normalization here, response normalization here, nothing else.
 * Routing core never contains provider-specific code.
 */
import { OrinError, classifyUpstream } from './errors.js';
import type { ChatMessage } from './types.js';

export interface ProviderCall {
  messages: ChatMessage[];
  model: string;
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
}

export interface ProviderResult {
  text: string;
  /** Provider-side model id that answered (may differ from requested). */
  model: string;
}

export interface ProviderAdapter {
  readonly id: string;
  chat(call: ProviderCall): Promise<ProviderResult>;
  chatStream(call: ProviderCall, onChunk: (text: string) => void): Promise<ProviderResult>;
}

interface AdapterOpts {
  id: string;
  baseUrl: string;
  apiKey: string;
  extraHeaders?: Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}

function combineSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a) return b;
  if (!b) return a;
  const ctrl = new AbortController();
  const fire = () => ctrl.abort();
  if (a.aborted || b.aborted) fire();
  else {
    a.addEventListener('abort', fire, { once: true });
    b.addEventListener('abort', fire, { once: true });
  }
  return ctrl.signal;
}

function openAIBody(call: ProviderCall): Record<string, unknown> {
  return {
    model: call.model,
    messages: call.messages.map((m) => ({ role: m.role, content: m.content })),
    ...(typeof call.temperature === 'number' ? { temperature: call.temperature } : {}),
    ...(typeof call.maxTokens === 'number' ? { max_tokens: call.maxTokens } : {}),
  };
}

/** Parse an SSE stream, calling onChunk per delta. Throws classified errors. */
async function readSSE(
  res: Response,
  onChunk: (text: string) => void,
): Promise<{ text: string; model: string }> {
  const reader = res.body?.getReader();
  if (!reader) throw new OrinError('provider', 'Provider returned no stream body.');
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let model = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (data === '[DONE]') continue;
      let json: any = null;
      try { json = JSON.parse(data); } catch { continue; }
      const delta = json.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta) {
        text += delta;
        onChunk(delta);
      }
      if (!model && typeof json.model === 'string') model = json.model;
      if (json.error) {
        throw new OrinError('provider', `Provider stream error: ${String(json.error.message || json.error).slice(0, 200)}`);
      }
    }
  }
  return { text, model };
}

class OpenAICompatAdapter implements ProviderAdapter {
  readonly id: string;
  private baseUrl: string;
  private apiKey: string;
  private extraHeaders: Record<string, string>;
  private fetchImpl: typeof fetch;
  private timeoutMs: number;

  constructor(opts: AdapterOpts) {
    this.id = opts.id;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.extraHeaders = opts.extraHeaders ?? {};
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}`, ...this.extraHeaders };
  }

  async chat(call: ProviderCall): Promise<ProviderResult> {
    const t = withTimeout(this.timeoutMs);
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          signal: combineSignals(call.signal, t.signal),
          headers: this.headers(),
          body: JSON.stringify(openAIBody(call)),
        });
      } catch (e: any) {
        if (e?.name === 'AbortError') throw new OrinError('timeout', `Provider ${this.id} timed out.`);
        throw new OrinError('provider', `Provider ${this.id} unreachable: ${String(e?.message || e).slice(0, 160)}`);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw classifyUpstream(res.status, body).error;
      }
      const json: any = await res.json().catch(() => ({}));
      const text = (json.choices?.[0]?.message?.content || '').trim();
      if (!text) throw new OrinError('provider', `Provider ${this.id} returned an empty answer.`);
      return { text, model: json.model || call.model };
    } finally {
      t.done();
    }
  }

  async chatStream(call: ProviderCall, onChunk: (text: string) => void): Promise<ProviderResult> {
    const t = withTimeout(this.timeoutMs);
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          signal: combineSignals(call.signal, t.signal),
          headers: this.headers(),
          body: JSON.stringify({ ...openAIBody(call), stream: true }),
        });
      } catch (e: any) {
        if (e?.name === 'AbortError') throw new OrinError('timeout', `Provider ${this.id} timed out.`);
        throw new OrinError('provider', `Provider ${this.id} unreachable: ${String(e?.message || e).slice(0, 160)}`);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw classifyUpstream(res.status, body).error;
      }
      const out = await readSSE(res, onChunk);
      if (!out.text) throw new OrinError('provider', `Provider ${this.id} streamed an empty answer.`);
      return { text: out.text, model: out.model || call.model };
    } finally {
      t.done();
    }
  }
}

export function openRouterAdapter(apiKey: string, opts?: Partial<AdapterOpts> & { fetchImpl?: typeof fetch }): ProviderAdapter {
  return new OpenAICompatAdapter({
    id: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey,
    extraHeaders: { 'HTTP-Referer': 'https://orinai.org', 'X-Title': 'Orin Router' },
    ...opts,
  });
}

export function groqAdapter(apiKey: string, opts?: Partial<AdapterOpts> & { fetchImpl?: typeof fetch }): ProviderAdapter {
  return new OpenAICompatAdapter({ id: 'groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey, ...opts });
}

export function customAdapter(id: string, baseUrl: string, apiKey: string, opts?: Partial<AdapterOpts> & { fetchImpl?: typeof fetch }): ProviderAdapter {
  return new OpenAICompatAdapter({ id, baseUrl, apiKey, ...opts });
}

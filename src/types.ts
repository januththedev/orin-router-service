/** Shared domain types. UI/API layers import these — never duplicate them. */

export interface ProviderDef {
  /** Owner (Orin uid). Every provider belongs to exactly one user. */
  userUid: string;
  id: string;
  type: 'openrouter' | 'groq' | 'custom';
  /** Base URL, e.g. https://api.openai.com/v1 (no trailing slash). */
  baseUrl: string;
  /** Encrypted at rest (AES-GCM, ROUTER_MASTER_KEY). Plaintext only in memory. */
  apiKey: string;
  models: string[];
  enabled: boolean;
  timeoutMs?: number;
}

export interface RouteHop {
  provider: string;
  model: string;
}

export interface RouteDef {
  /**
   * INTERNAL ONLY: synthesized per request from a user's providers
   * ({id: requestedModel, hops: candidate providers}). Never stored, never
   * user-configured — the router fans out automatically.
   */
  id: string;
  hops: RouteHop[];
  enabled: boolean;
}

export interface ApiKeyRecord {
  id: string;
  /** Owner (Orin uid). A gateway key serves exactly one user's providers. */
  userUid: string;
  /** First 12 chars of the secret — safe to display and log. */
  prefix: string;
  /** sha256 hex of the full secret. Never returned by any endpoint. */
  hash: string;
  name: string;
  /** Requests per minute. 0/undefined = unlimited. */
  perMin?: number;
  enabled: boolean;
  createdAt: number;
}

export interface UsageLog {
  requestId: string;
  userUid: string;
  keyPrefix: string;
  /** Model id the caller requested. */
  requested: string;
  provider?: string;
  model?: string;
  status: 'ok' | 'error';
  latencyMs: number;
  error?: string;
  promptChars?: number;
  completionChars?: number;
  at: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequestBody {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

/** Predictable error taxonomy. Every failure maps to one of these. */

export type ErrorCode =
  | 'validation'
  | 'authentication'
  | 'authorization'
  | 'rate_limit'
  | 'timeout'
  | 'provider'
  | 'route_unavailable'
  | 'internal';

const STATUS: Record<ErrorCode, number> = {
  validation: 400,
  authentication: 401,
  authorization: 403,
  rate_limit: 429,
  timeout: 504,
  provider: 502,
  route_unavailable: 503,
  internal: 500,
};

export class OrinError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Router action hint set by adapters: retry (cool+next), dead-key (skip provider), hop (next model). */
  action?: 'retry' | 'dead-key' | 'hop';
  /** Safe for clients. Never put secrets here. */
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'OrinError';
    this.code = code;
    this.status = STATUS[code];
  }
  /** OpenAI-shaped error body. */
  toResponse(): { error: { message: string; type: string; code: string } } {
    return { error: { message: this.message, type: this.code, code: this.code } };
  }
}

/** Classify an upstream HTTP failure into router action + error. */
export function classifyUpstream(status: number, body: string): {
  action: 'retry' | 'dead-key' | 'hop' | 'fatal';
  error: OrinError;
} {
  const mk = (action: 'retry' | 'dead-key' | 'hop', code: ErrorCode, message: string): { action: 'retry' | 'dead-key' | 'hop' | 'fatal'; error: OrinError } => {
    const e = new OrinError(code, message);
    e.action = action;
    return { action, error: e };
  };
  if (status === 429) return mk('retry', 'rate_limit', 'Provider rate limited the request.');
  if (status >= 500) return mk('retry', 'provider', `Provider failed (HTTP ${status}).`);
  if (status === 401 || status === 403) return mk('dead-key', 'provider', 'Provider rejected credentials.');
  if (status === 400 || status === 404) return mk('hop', 'provider', `Provider rejected the request (HTTP ${status}): ${body.slice(0, 200)}`);
  return mk('hop', 'provider', `Provider error (HTTP ${status}).`);
}

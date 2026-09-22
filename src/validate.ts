/**
 * SSRF guard for custom provider base URLs. Blocks literal private IPs and
 * well-known internal names. Hostname-based private ranges (DNS rebinding)
 * cannot be checked without resolving — documented in README; custom
 * providers are admin-configured, never user-supplied.
 */
import { OrinError } from './errors.js';
import type { ChatMessage } from './types.js';

const BLOCKED_SUFFIX = ['.localhost', '.local', '.internal', '.lan', '.home', '.corp', '.invalid', '.test'];
const BLOCKED_EXACT = new Set(['localhost', 'metadata.google.internal']);

function isPrivateIPv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = p;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const low = ip.toLowerCase();
  if (low === '::1' || low === '::') return true;
  if (low.startsWith('fc') || low.startsWith('fd')) return true;
  if (low.startsWith('fe80')) return true;
  return false;
}

export function validateBaseUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new OrinError('validation', 'Provider base URL is not a valid URL.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new OrinError('validation', 'Provider base URL must be http(s).');
  }
  if (u.username || u.password) {
    throw new OrinError('validation', 'Provider base URL must not embed credentials.');
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) throw new OrinError('validation', 'Provider base URL needs a host.');
  if (BLOCKED_EXACT.has(host)) throw new OrinError('validation', 'Provider host is not allowed.');
  if (BLOCKED_SUFFIX.some((s) => host.endsWith(s))) {
    throw new OrinError('validation', 'Provider host is not allowed.');
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && isPrivateIPv4(host)) {
    throw new OrinError('validation', 'Provider host resolves to a private address.');
  }
  if (host.includes(':') && isPrivateIPv6(host)) {
    throw new OrinError('validation', 'Provider host resolves to a private address.');
  }
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

export function validateChatBody(body: any): { model: string; messages: ChatMessage[]; stream: boolean; temperature?: number; max_tokens?: number } {
  if (!body || typeof body !== 'object') throw new OrinError('validation', 'Request body must be JSON.');
  const { model, messages, stream, temperature, max_tokens } = body;
  if (typeof model !== 'string' || !model) throw new OrinError('validation', 'Field "model" (a route alias) is required.');
  if (!Array.isArray(messages) || !messages.length) throw new OrinError('validation', 'Field "messages" must be a non-empty array.');
  if (messages.length > 200) throw new OrinError('validation', 'Too many messages (max 200).');
  const clean: ChatMessage[] = messages.map((m: any, i: number) => {
    const role = m?.role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      throw new OrinError('validation', `Message ${i} has an invalid role.`);
    }
    const content = typeof m?.content === 'string' ? m.content : Array.isArray(m?.content)
      ? m.content.map((p: any) => (typeof p === 'string' ? p : p?.text || '')).join('\n')
      : '';
    if (content.length > 100_000) throw new OrinError('validation', `Message ${i} is too large.`);
    return { role, content };
  });
  if (temperature !== undefined && (typeof temperature !== 'number' || temperature < 0 || temperature > 2)) {
    throw new OrinError('validation', 'Field "temperature" must be 0–2.');
  }
  if (max_tokens !== undefined && (!Number.isInteger(max_tokens) || max_tokens < 1 || max_tokens > 100_000)) {
    throw new OrinError('validation', 'Field "max_tokens" must be 1–100000.');
  }
  return { model, messages: clean, stream: stream === true, temperature, max_tokens };
}

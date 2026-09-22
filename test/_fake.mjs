/** Shared fakes: in-memory store, mock adapters, mock fetch. */
import { RouterHealth } from '../src/router.ts';

export function fakeStore(seed = {}) {
  const providers = new Map(Object.entries(seed.providers ?? {}));
  const routes = new Map(Object.entries(seed.routes ?? {}));
  const keys = new Map();
  const logs = [];
  return {
    providers, routes, keys, logs,
    async getProviders() { return [...providers.values()]; },
    async saveProvider(p) { providers.set(p.id, p); },
    async deleteProvider(id) { providers.delete(id); },
    async getRoutes() { return [...routes.values()]; },
    async saveRoute(r) { routes.set(r.id, r); },
    async deleteRoute(id) { routes.delete(id); },
    async createKey(rec) {
      if ([...keys.values()].some((k) => k.hash === rec.hash)) throw new Error('duplicate');
      keys.set(rec.id, rec);
    },
    async listKeys() { return [...keys.values()].map(({ hash, ...r }) => r); },
    async findKeyByHash(hash) { return [...keys.values()].find((k) => k.hash === hash) ?? null; },
    async revokeKey(id) { const k = keys.get(id); if (k) k.enabled = false; },
    async log(e) { logs.push(e); },
    async queryLogs() { return logs; },
    async stats() { return { total: logs.length, ok: 0, errors: 0, avgLatencyMs: 0, byProvider: {} }; },
  };
}

export function keyRec(over = {}) {
  return {
    id: 'key_1', prefix: 'orin_abc', hash: 'h', name: 't',
    perMin: 0, enabled: true, createdAt: 1, ...over,
  };
}

/** Adapter driven by a script: { chat?: fn|result, chatStream?: fn }. */
export function scriptAdapter(id, script) {
  return {
    id,
    async chat(call) {
      if (typeof script.chat === 'function') return script.chat(call);
      if (script.chat instanceof Error) throw script.chat;
      return script.chat;
    },
    async chatStream(call, onChunk) {
      if (typeof script.chatStream === 'function') return script.chatStream(call, onChunk);
      if (script.chatStream instanceof Error) throw script.chatStream;
      return script.chatStream;
    },
  };
}

export function okAdapter(id, text = 'hello') {
  return scriptAdapter(id, { chat: { text, model: 'm' }, chatStream: { text, model: 'm' } });
}

export function freshHealth() {
  return new RouterHealth(() => 1_000_000);
}

/** node:test-friendly SSE reader for mocked streams. */
export function sseResponse(chunks) {
  const enc = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream({
    pull(c) {
      if (i < chunks.length) c.enqueue(enc.encode(chunks[i++]));
      else c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

export function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

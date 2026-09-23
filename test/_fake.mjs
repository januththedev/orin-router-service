/** Shared fakes: in-memory user-scoped store, mock adapters, mock fetch. */
import { RouterHealth } from '../src/router.ts';

export const UID = 'u1';

export function fakeStore(seed = {}) {
  const providers = new Map(); // `${userUid}:${id}`
  const keys = new Map();
  const logs = [];
  if (seed.providers) {
    for (const [id, p] of Object.entries(seed.providers)) providers.set(`${p.userUid ?? UID}:${id}`, { userUid: UID, id, ...p });
  }
  const pkey = (u, id) => `${u}:${id}`;
  return {
    providers, keys, logs,
    async getProviders(userUid) { return [...providers.values()].filter((p) => p.userUid === userUid); },
    async saveProvider(p) { providers.set(pkey(p.userUid, p.id), p); },
    async deleteProvider(userUid, id) { providers.delete(pkey(userUid, id)); },
    async createKey(rec) {
      if ([...keys.values()].some((k) => k.hash === rec.hash)) throw new Error('duplicate');
      keys.set(rec.id, rec);
    },
    async listKeys(userUid) {
      return [...keys.values()].filter((k) => k.userUid === userUid).map(({ hash, userUid: _u, ...r }) => r);
    },
    async findKeyByHash(hash) { return [...keys.values()].find((k) => k.hash === hash) ?? null; },
    async revokeKey(userUid, id) { const k = keys.get(id); if (k && k.userUid === userUid) k.enabled = false; },
    async log(e) { logs.push(e); },
    async queryLogs(userUid, opts = {}) {
      return logs.filter((l) => l.userUid === userUid
        && (!opts.status || l.status === opts.status)
        && (!opts.provider || l.provider === opts.provider)).slice(0, opts.limit ?? 50);
    },
    async stats(userUid) {
      const mine = logs.filter((l) => l.userUid === userUid);
      return { total: mine.length, ok: 0, errors: 0, avgLatencyMs: 0, byProvider: {} };
    },
  };
}

export function keyRec(over = {}) {
  return {
    id: 'key_1', userUid: UID, prefix: 'orin_abc', hash: 'h', name: 't',
    perMin: 0, enabled: true, createdAt: 1, ...over,
  };
}

export function provRec(id, over = {}) {
  return {
    userUid: UID, id, type: 'custom', baseUrl: 'https://x.test/v1',
    apiKey: 'k', models: [], enabled: true, ...over,
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

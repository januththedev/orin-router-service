/**
 * API contract: auth, validation, OpenAI shapes, streaming, rate limits.
 * Full paths with injected script adapters — no HTTP, no database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authenticate, chatCompletions, chatCompletionsStream,
  listModels, SSE_DONE, sseChunk,
} from '../src/service.ts';
import { hashSecret } from '../src/keys.ts';
import { OrinError } from '../src/errors.ts';
import { RateLimit } from '../src/ratelimit.ts';
import { fakeStore, keyRec, okAdapter, scriptAdapter } from './_fake.mjs';

const SECRET = 'orin_testsecret00000000000000000001';

async function seeded(adapters, routeHops = [{ provider: 'a', model: 'm' }], keyOver = {}) {
  const store = fakeStore();
  await store.createKey({ ...keyRec(), hash: hashSecret(SECRET), ...keyOver });
  await store.saveProvider({ id: 'a', type: 'custom', baseUrl: 'https://x.test/v1', apiKey: 'k', models: [], enabled: true });
  await store.saveProvider({ id: 'b', type: 'custom', baseUrl: 'https://y.test/v1', apiKey: 'k', models: [], enabled: true });
  await store.saveRoute({ id: 'smart', enabled: true, hops: routeHops });
  return { store, adapters: new Map(Object.entries(adapters)) };
}

const HELLO = { messages: [{ role: 'user', content: 'hi' }] };

test('models lists enabled routes only', async () => {
  const store = fakeStore({
    routes: {
      on: { id: 'on', enabled: true, hops: [{ provider: 'a', model: 'm' }] },
      off: { id: 'off', enabled: false, hops: [{ provider: 'a', model: 'm' }] },
      empty: { id: 'empty', enabled: true, hops: [] },
    },
  });
  const out = await listModels(store);
  assert.equal(out.object, 'list');
  assert.deepEqual(out.data.map((d) => d.id), ['on']);
  assert.equal(out.data[0].owned_by, 'orin-router');
});

test('missing/invalid/disabled keys are rejected with the right codes', async () => {
  const store = fakeStore();
  await store.createKey({ ...keyRec(), hash: hashSecret(SECRET) });
  const dis = { ...keyRec({ id: 'k2', prefix: 'orin_bad' }), hash: hashSecret('orin_disabled0000000000000000002') };
  dis.enabled = false;
  await store.createKey(dis);

  await assert.rejects(authenticate(null, store), (e) => e.status === 401);
  await assert.rejects(authenticate('Bearer nope', store), (e) => e.status === 401);
  await assert.rejects(authenticate('Bearer orin_disabled0000000000000000002', store), (e) => e.status === 403);
  const rec = await authenticate(`Bearer ${SECRET}`, store);
  assert.equal(rec.id, 'key_1');
});

test('malformed chat bodies are rejected before any provider is touched', async () => {
  const { store, adapters } = await seeded({ a: okAdapter('a') });
  let touched = 0;
  const counting = new Map([['a', scriptAdapter('a', { chat: async () => { touched++; return { text: 't', model: 'm' }; } })]]);
  for (const bad of [
    null, {}, { model: 'smart' }, { messages: [] },
    { model: 'smart', messages: [{ role: 'nope', content: 'x' }] },
    { model: 'smart', messages: 'hi' },
    { model: 'smart', messages: [{ role: 'user', content: 'x' }], temperature: 9 },
    { model: 'smart', messages: [{ role: 'user', content: 'x' }], max_tokens: -2 },
  ]) {
    await assert.rejects(
      chatCompletions({ store, adapters: counting }, { authHeader: `Bearer ${SECRET}`, rawBody: bad }),
      (e) => e.status === 400,
      JSON.stringify(bad),
    );
  }
  assert.equal(touched, 0);
  assert.equal(adapters.size, 1);
});

test('unknown route alias tells the client to check /v1/models', async () => {
  const { store, adapters } = await seeded({ a: okAdapter('a') });
  await assert.rejects(
    chatCompletions({ store, adapters }, { authHeader: `Bearer ${SECRET}`, rawBody: { model: 'nope', ...HELLO } }),
    (e) => e.status === 400 && /v1\/models/.test(e.message),
  );
});

test('chat returns OpenAI shape and logs once', async () => {
  const { store, adapters } = await seeded({ a: okAdapter('a', 'Answer!') });
  const out = await chatCompletions({ store, adapters }, {
    authHeader: `Bearer ${SECRET}`, rawBody: { model: 'smart', ...HELLO },
  });
  assert.equal(out.object, 'chat.completion');
  assert.equal(out.model, 'smart');
  assert.equal(out.choices[0].message.content, 'Answer!');
  assert.equal(out.choices[0].finish_reason, 'stop');
  assert.equal(store.logs.length, 1);
  assert.equal(store.logs[0].status, 'ok');
  assert.equal(store.logs[0].provider, 'a');
  assert.equal(store.logs[0].keyPrefix, 'orin_abc');
});

test('provider failure across all hops logs the error and throws', async () => {
  const { store, adapters } = await seeded({
    a: scriptAdapter('a', { chat: new OrinError('provider', 'down') }),
  });
  await assert.rejects(
    chatCompletions({ store, adapters }, { authHeader: `Bearer ${SECRET}`, rawBody: { model: 'smart', ...HELLO } }),
    /down/,
  );
  assert.equal(store.logs.length, 1);
  assert.equal(store.logs[0].status, 'error');
  assert.match(store.logs[0].error || '', /provider/);
});

test('per-key RPM gate trips at the limit', async () => {
  const { store, adapters } = await seeded({ a: okAdapter('a') }, [{ provider: 'a', model: 'm' }], { perMin: 1 });
  const limits = new RateLimit(() => 5000);
  await chatCompletions({ store, adapters, limits }, { authHeader: `Bearer ${SECRET}`, rawBody: { model: 'smart', ...HELLO } });
  await assert.rejects(
    chatCompletions({ store, adapters, limits }, { authHeader: `Bearer ${SECRET}`, rawBody: { model: 'smart', ...HELLO } }),
    (e) => e.status === 429,
  );
});

test('SSE chunk + DONE constants are well-formed', () => {
  const line = sseChunk('smart', 'hi');
  assert.match(line, /^data: /);
  assert.match(line, /"content":"hi"/);
  assert.equal(SSE_DONE, 'data: [DONE]\n\n');
});

test('streaming emits provider chunks then DONE', async () => {
  const { store } = await seeded({});
  const adapters = new Map([['a', scriptAdapter('a', {
    chatStream: async (_call, onChunk) => { onChunk('Hel'); onChunk('lo'); return { text: 'Hello', model: 'm' }; },
  })]]);
  const lines = [];
  await chatCompletionsStream({ store, adapters }, {
    authHeader: `Bearer ${SECRET}`,
    rawBody: { model: 'smart', ...HELLO },
    onSse: (l) => lines.push(l),
  });
  assert.ok(lines.length >= 3);
  assert.match(lines[0], /"content":"Hel"/);
  assert.equal(lines[lines.length - 1], SSE_DONE);
  assert.equal(store.logs.length, 1);
  assert.equal(store.logs[0].status, 'ok');
});

test('mid-stream provider death emits an error payload, closes cleanly, logs', async () => {
  const { store } = await seeded({});
  const adapters = new Map([['a', scriptAdapter('a', {
    chatStream: async (call, onChunk) => { onChunk('half'); throw new OrinError('provider', 'cut'); },
  })]]);
  const lines = [];
  await assert.rejects(
    chatCompletionsStream({ store, adapters }, {
      authHeader: `Bearer ${SECRET}`,
      rawBody: { model: 'smart', ...HELLO },
      onSse: (l) => lines.push(l),
    }),
    /cut/,
  );
  assert.match(lines[0], /"content":"half"/);
  assert.ok(lines.some((l) => /"error"/.test(l)));
  assert.equal(lines[lines.length - 1], SSE_DONE);
  assert.equal(store.logs[0].status, 'error');
});

test('streaming falls across hops when the first dies pre-stream', async () => {
  const err = new OrinError('provider', 'bad');
  err.action = 'retry';
  const { store } = await seeded({}, [{ provider: 'a', model: 'm' }, { provider: 'b', model: 'm' }]);
  const adapters = new Map([
    ['a', scriptAdapter('a', { chatStream: err })],
    ['b', scriptAdapter('b', { chatStream: async (_c, on) => { on('B!'); return { text: 'B!', model: 'm' }; } })],
  ]);
  const lines = [];
  await chatCompletionsStream({ store, adapters }, {
    authHeader: `Bearer ${SECRET}`,
    rawBody: { model: 'smart', ...HELLO },
    onSse: (l) => lines.push(l),
  });
  assert.ok(lines.some((l) => /"content":"B!"/.test(l)));
  assert.equal(store.logs[0].provider, 'b');
});

test('streaming rejects bad auth before emitting anything', async () => {
  const { store, adapters } = await seeded({ a: okAdapter('a') });
  const lines = [];
  await assert.rejects(
    chatCompletionsStream({ store, adapters }, {
      authHeader: 'Bearer wrong', rawBody: { model: 'smart', ...HELLO }, onSse: (l) => lines.push(l),
    }),
    (e) => e.status === 401,
  );
  assert.equal(lines.length, 0);
  assert.equal(store.logs.length, 0);
});

test('key hashes are never listed', async () => {
  const { store } = await seeded({});
  const got = await store.listKeys();
  assert.equal(got.length, 1);
  assert.equal(got[0].hash, undefined);
});

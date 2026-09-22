/**
 * Provider adapters against mocked fetch: classification, parsing,
 * streaming, timeouts. No network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { customAdapter, groqAdapter, openRouterAdapter } from '../src/providers.ts';
import { jsonResponse, sseResponse } from './_fake.mjs';

const CALL = { messages: [{ role: 'user', content: 'hi' }], model: 'm' };

function mockFetch(handler) {
  return async (url, init) => handler(url, init);
}

test('ok response parses text + model', async () => {
  const a = customAdapter('c', 'https://x.test/v1', 'k', {
    fetchImpl: mockFetch(async (url, init) => {
      assert.match(url, /\/chat\/completions$/);
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'm');
      assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
      assert.equal(init.headers.Authorization, 'Bearer k');
      return jsonResponse({ model: 'm-1', choices: [{ message: { content: '  Yo  ' } }] });
    }),
  });
  const r = await a.chat(CALL);
  assert.equal(r.text, 'Yo');
  assert.equal(r.model, 'm-1');
});

test('temperature/max_tokens pass through only when set', async () => {
  let seen;
  const a = customAdapter('c', 'https://x.test/v1', 'k', {
    fetchImpl: mockFetch(async (_u, init) => { seen = JSON.parse(init.body); return jsonResponse({ choices: [{ message: { content: 't' } }] }); }),
  });
  await a.chat({ ...CALL, temperature: 0.5, maxTokens: 10 });
  assert.equal(seen.temperature, 0.5);
  assert.equal(seen.max_tokens, 10);
  await a.chat(CALL);
  assert.equal('temperature' in seen, false);
  assert.equal('max_tokens' in seen, false);
});

test('429 → rate_limit, 500 → retryable provider, 401 → dead-key', async () => {
  const cases = [
    [429, 'rate_limit', 'retry'],
    [500, 'provider', 'retry'],
    [503, 'provider', 'retry'],
    [401, 'provider', 'dead-key'],
    [403, 'provider', 'dead-key'],
    [400, 'provider', 'hop'],
    [404, 'provider', 'hop'],
  ];
  for (const [status, code, action] of cases) {
    const a = customAdapter('c', 'https://x.test/v1', 'k', {
      fetchImpl: mockFetch(async () => new Response('nope', { status })),
    });
    await assert.rejects(a.chat(CALL), (e) => e.code === code && e.action === action, `HTTP ${status}`);
  }
});

test('network failure and timeout classify distinctly', async () => {
  const down = customAdapter('c', 'https://x.test/v1', 'k', {
    fetchImpl: mockFetch(async () => { throw new Error('socket hangup'); }),
  });
  await assert.rejects(down.chat(CALL), (e) => e.code === 'provider' && /unreachable/.test(e.message));

  const slow = customAdapter('c', 'https://x.test/v1', 'k', {
    fetchImpl: mockFetch(async (_u, init) => {
      await new Promise((_, rej) => init.signal?.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' }))));
    }),
    timeoutMs: 30,
  });
  await assert.rejects(slow.chat(CALL), (e) => e.code === 'timeout');
});

test('empty answer is an error, not an empty success', async () => {
  const a = customAdapter('c', 'https://x.test/v1', 'k', {
    fetchImpl: mockFetch(async () => jsonResponse({ choices: [{ message: { content: '   ' } }] })),
  });
  await assert.rejects(a.chat(CALL), /empty/);
});

test('SSE chunks assemble in order; [DONE] tolerated mid-stream', async () => {
  const got = [];
  const a = customAdapter('c', 'https://x.test/v1', 'k', {
    fetchImpl: mockFetch(async () => sseResponse([
      'data: {"model":"m-9","choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n',
    ])),
  });
  const r = await a.chatStream(CALL, (c) => got.push(c));
  assert.deepEqual(got, ['Hel', 'lo']);
  assert.equal(r.text, 'Hello');
  assert.equal(r.model, 'm-9');
});

test('SSE error payload throws; stream HTTP failure classifies', async () => {
  const bad = customAdapter('c', 'https://x.test/v1', 'k', {
    fetchImpl: mockFetch(async () => sseResponse(['data: {"error":{"message":"bad key"}}\n\n'])),
  });
  await assert.rejects(bad.chatStream(CALL, () => undefined), /bad key/);

  const http500 = customAdapter('c', 'https://x.test/v1', 'k', {
    fetchImpl: mockFetch(async () => new Response('err', { status: 500 })),
  });
  await assert.rejects(http500.chatStream(CALL, () => undefined), (e) => e.code === 'provider');
});

test('openrouter sends attribution headers; groq hits its endpoint', async () => {
  let or, g;
  const o = openRouterAdapter('k1', { fetchImpl: mockFetch(async (u, init) => { or = { u, h: init.headers }; return jsonResponse({ choices: [{ message: { content: 't' } }] }); }) });
  await o.chat(CALL);
  assert.match(or.u, /openrouter\.ai/);
  assert.equal(or.h['X-Title'], 'Orin Router');
  assert.ok(or.h['HTTP-Referer']);

  const gr = groqAdapter('k2', { fetchImpl: mockFetch(async (u) => { g = u; return jsonResponse({ choices: [{ message: { content: 't' } }] }); }) });
  await gr.chat(CALL);
  assert.match(g, /api\.groq\.com/);
});

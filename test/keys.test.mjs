/** Keys, validation, concurrency, idempotency. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bearerToken, hashSecret, mintKey, verifySecret } from '../src/keys.ts';
import { validateBaseUrl, validateChatBody } from '../src/validate.ts';
import { chatCompletions } from '../src/service.ts';
import { fakeStore, keyRec, okAdapter } from './_fake.mjs';

test('minted keys look right and verify round-trip', () => {
  const m = mintKey();
  assert.match(m.secret, /^orin_[0-9a-f]{64}$/);
  assert.equal(m.prefix, m.secret.slice(0, 12));
  assert.equal(m.hash, hashSecret(m.secret));
  assert.equal(verifySecret(m.secret, m.hash), true);
  assert.equal(verifySecret(m.secret + 'x', m.hash), false);
  assert.equal(verifySecret('', m.hash), false);
});

test('two mints never collide', () => {
  const a = new Set(Array.from({ length: 50 }, () => mintKey().secret));
  assert.equal(a.size, 50);
});

test('bearer parsing is strict', () => {
  assert.equal(bearerToken(null), null);
  assert.equal(bearerToken(''), null);
  assert.equal(bearerToken('Token abc'), null);
  assert.equal(bearerToken('Bearer abc123'), 'abc123');
  assert.equal(bearerToken('bearer abc123'), 'abc123');
});

test('SSRF guard blocks the nasty hosts, allows the real world', () => {
  for (const bad of [
    'http://localhost:8000/v1', 'http://127.0.0.1/v1', 'http://10.0.0.5/v1',
    'http://172.16.9.9/v1', 'http://192.168.1.1/v1', 'http://169.254.169.254/',
    'http://[::1]/v1', 'ftp://x.test/v1', 'not-a-url',
    'https://user:pass@x.test/v1', 'http://my.internal/v1', 'http://x.local/v1',
  ]) {
    assert.throws(() => validateBaseUrl(bad), /URL|host|address|credentials|valid/, bad);
  }
  assert.equal(validateBaseUrl('https://api.example.com/v1/'), 'https://api.example.com/v1');
  assert.equal(validateBaseUrl('http://8.8.8.8/v1'), 'http://8.8.8.8/v1');
});

test('chat body validation rejects garbage precisely', () => {
  assert.throws(() => validateChatBody(null), /JSON/);
  assert.throws(() => validateChatBody({}), /model/);
  assert.throws(() => validateChatBody({ model: 'm', messages: [] }), /non-empty/);
  assert.throws(() => validateChatBody({ model: 'm', messages: [{ role: 'x', content: '' }] }), /role/);
  const big = 'x'.repeat(100_001);
  assert.throws(() => validateChatBody({ model: 'm', messages: [{ role: 'user', content: big }] }), /too large/);
  const ok = validateChatBody({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true });
  assert.equal(ok.stream, true);
});

test('concurrent chats do not corrupt each other or double-log', async () => {
  const store = fakeStore();
  const { hashSecret: hs } = await import('../src/keys.ts');
  await store.createKey({ ...keyRec(), hash: hs('s') });
  await store.saveProvider({ id: 'a', type: 'custom', baseUrl: 'https://x/v1', apiKey: 'k', models: [], enabled: true });
  await store.saveRoute({ id: 'smart', enabled: true, hops: [{ provider: 'a', model: 'm' }] });
  const adapters = new Map([['a', okAdapter('a', 'R')]]);
  const bodies = Array.from({ length: 10 }, (_, i) => ({ model: 'smart', messages: [{ role: 'user', content: `q${i}` }] }));
  const outs = await Promise.all(bodies.map((b) =>
    chatCompletions({ store, adapters }, { authHeader: 'Bearer s', rawBody: b }),
  ));
  assert.equal(outs.length, 10);
  assert.ok(outs.every((o) => o.choices[0].message.content === 'R'));
  assert.equal(store.logs.length, 10);
  assert.equal(new Set(store.logs.map((l) => l.requestId)).size, 10);
});

test('duplicate key hashes are rejected (idempotent creation)', async () => {
  const store = fakeStore();
  const rec = { ...keyRec(), hash: 'same' };
  await store.createKey(rec);
  await assert.rejects(store.createKey({ ...keyRec({ id: 'k2' }), hash: 'same' }), /duplicate/);
  const list = await store.listKeys();
  assert.equal(list.length, 1);
  assert.equal(list[0].hash, undefined);
});

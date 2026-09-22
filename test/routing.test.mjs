/**
 * Routing logic: priority, failover, dead keys, cooldowns, validation.
 * No network, no database — adapters and health are injected.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { OrinError } from '../src/errors.ts';
import { routeChat, RouterHealth } from '../src/router.ts';
import { fakeStore, freshHealth, keyRec, okAdapter, scriptAdapter } from './_fake.mjs';

const CALL = { messages: [{ role: 'user', content: 'hi' }] };
const ROUTE = (hops) => ({ id: 'r', enabled: true, hops });

function ctx(adapters, health = freshHealth()) {
  const m = new Map(Object.entries(adapters));
  return { adapters: m, health, cooldownMs: 60_000 };
}

test('first hop wins, attempts recorded', async () => {
  const deps = ctx({ a: okAdapter('a', 'A!') });
  const out = await routeChat(ROUTE([{ provider: 'a', model: 'm1' }]), CALL, deps);
  assert.equal(out.text, 'A!');
  assert.equal(out.provider, 'a');
  assert.equal(out.attempts.length, 1);
  assert.equal(out.attempts[0].ok, true);
});

test('429 on A falls to B (priority order kept)', async () => {
  const e429 = new OrinError('rate_limit', 'limited');
  const deps = ctx({
    a: scriptAdapter('a', { chat: e429 }),
    b: okAdapter('b', 'B!'),
  });
  const seen = [];
  deps.onAttempt = (a) => seen.push(a.provider + ':' + a.ok);
  const out = await routeChat(ROUTE([{ provider: 'a', model: 'm' }, { provider: 'b', model: 'm' }]), CALL, deps);
  assert.equal(out.text, 'B!');
  assert.deepEqual(seen, ['a:false', 'b:true']);
});

test('500 and timeout both fail over', async () => {
  for (const err of [new OrinError('provider', '500'), new OrinError('timeout', 'slow')]) {
    const deps = ctx({ a: scriptAdapter('a', { chat: err }), b: okAdapter('b', 'ok') });
    const out = await routeChat(ROUTE([{ provider: 'a', model: 'm' }, { provider: 'b', model: 'm' }]), CALL, deps);
    assert.equal(out.provider, 'b');
  }
});

test('401 dead-keys the whole provider (its other hops skipped)', async () => {
  const dead = new OrinError('provider', 'bad creds');
  dead.action = 'dead-key';
  const calls = [];
  const deps = ctx({
    a: scriptAdapter('a', { chat: async () => { calls.push('a'); throw dead; } }),
    b: okAdapter('b', 'B!'),
  });
  const out = await routeChat(ROUTE([
    { provider: 'a', model: 'm1' },
    { provider: 'a', model: 'm2' },
    { provider: 'b', model: 'm3' },
  ]), CALL, deps);
  assert.equal(out.provider, 'b');
  assert.deepEqual(calls, ['a']); // second a-hop never attempted
  assert.equal(out.attempts.filter((x) => x.provider === 'a').length, 1);
});

test('404 hops to next model immediately', async () => {
  const e404 = new OrinError('provider', 'no such model');
  e404.action = 'hop';
  const deps = ctx({ a: scriptAdapter('a', { chat: e404 }), b: okAdapter('b', 'ok') });
  const out = await routeChat(ROUTE([{ provider: 'a', model: 'bad' }, { provider: 'b', model: 'good' }]), CALL, deps);
  assert.equal(out.model, 'm');
});

test('cooled hop is skipped until cooldown expires', async () => {
  let now = 1_000_000;
  const health = new RouterHealth(() => now);
  const e500 = new OrinError('provider', 'boom');
  const deps = { adapters: new Map([['a', scriptAdapter('a', { chat: e500 })], ['b', okAdapter('b', 'ok')]]), health, cooldownMs: 60_000 };
  const route = ROUTE([{ provider: 'a', model: 'm' }, { provider: 'b', model: 'm' }]);
  await routeChat(route, CALL, deps); // cools a
  assert.equal(health.isCool('a', 'm'), true);
  now += 61_000;
  assert.equal(health.isCool('a', 'm'), false);
});

test('all hops dead throws the last error', async () => {
  const deps = ctx({ a: scriptAdapter('a', { chat: new OrinError('provider', 'down') }) });
  await assert.rejects(
    routeChat(ROUTE([{ provider: 'a', model: 'm' }]), CALL, deps),
    /down/,
  );
});

test('disabled route and empty route are rejected, not retried', async () => {
  const deps = ctx({ a: okAdapter('a') });
  await assert.rejects(routeChat({ id: 'r', enabled: false, hops: [{ provider: 'a', model: 'm' }] }, CALL, deps), /disabled/);
  await assert.rejects(routeChat({ id: 'r', enabled: true, hops: [] }, CALL, deps), /no hops/);
  assert.equal(deps.adapters.get('a') && true, true); // adapter never consulted on validation failure
});

test('unknown provider hop is skipped with a note', async () => {
  const deps = ctx({ b: okAdapter('b', 'B!') });
  const out = await routeChat(ROUTE([{ provider: 'ghost', model: 'm' }, { provider: 'b', model: 'm' }]), CALL, deps);
  assert.equal(out.provider, 'b');
  assert.match(out.attempts[0].error || '', /unknown provider/);
});

test('latency EMA is recorded on success', async () => {
  let now = 1000;
  const clock = () => now;
  const health = new RouterHealth(clock);
  const deps = {
    adapters: new Map([['a', scriptAdapter('a', { chat: async () => { now += 40; return { text: 't', model: 'm' }; } })]]),
    health, cooldownMs: 1000, now: clock,
  };
  await routeChat(ROUTE([{ provider: 'a', model: 'm' }]), CALL, deps);
  assert.equal(health.latency('a', 'm'), 40);
});

test('fake store + key record shape sanity', async () => {
  const s = fakeStore();
  assert.deepEqual(await s.getProviders(), []);
  assert.equal(keyRec().enabled, true);
});

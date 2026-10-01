import "./_hooks.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { executeChat } from "../src/service.js";
import { CatalogStore } from "../src/catalog.js";
import { UpstreamResolver } from "../src/upstream-credentials.js";
import { MemoryProviderKeyStore, ProviderKeyManager } from "../src/provider-keys.js";

/**
 * The request loop in service.ts had no coverage at all before this file, and
 * it is the code that decides which credential reaches which upstream. These
 * tests assert on the outgoing HTTP request -- the URL and the Authorization
 * header -- rather than on the resolver in isolation, because the bug this
 * guards against is a mismatch between the two: a candidate naming one
 * provider being sent to another provider's origin.
 */

const kek = Buffer.alloc(32, 7).toString("base64");

const principal = {
  accountId: "acct-1",
  scopes: ["router:invoke"],
  subject: "s",
  tokenId: "t",
  expiresAt: new Date(Date.now() + 60_000),
  usageReservationId: "u",
};

const openState = {
  isEligible: async () => true,
  recordSuccess: async () => {},
  recordFailure: async () => {},
  consumeRequest: async () => true,
};

const quietStore = {
  beginAttempt: async () => {},
  finishAttempt: async () => {},
  listAttempts: async () => [],
};

function ctxWith(models, { fetchImpl, platformKey = "platform-secret", providerKeys = new ProviderKeyManager(new MemoryProviderKeyStore(), kek) }) {
  const catalog = new CatalogStore({
    provider: "catalog",
    fetchedAt: new Date().toISOString(),
    status: "success",
    sourceVersion: "test",
    sourceResponseHash: "0".repeat(64),
    models,
  });
  return {
    store: quietStore,
    state: openState,
    catalog,
    upstream: new UpstreamResolver({ mode: "live", platformKey, providerKeys, fetchImpl }),
    accountLimit: 60,
  };
}

const entry = (provider, modelId) => ({
  provider,
  modelId,
  fetchedAt: new Date().toISOString(),
  sourceStatus: "success",
  capabilities: ["text", "streaming"],
  contextLimit: 1000,
  prices: { prompt: 0, completion: 0, image: null },
});

/** Records every upstream call and replies with a canned completion. */
function recorder() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

const chatBody = (model) => ({ model, messages: [{ role: "user", content: "hi" }], stream: false, max_tokens: 8 });

test("an opencode candidate is POSTed to Zen with that account's own key", async () => {
  const keys = new ProviderKeyManager(new MemoryProviderKeyStore(), kek);
  await keys.create(principal.accountId, "opencode", "test", "oc-account-key-0123456789");
  const { calls, fetchImpl } = recorder();
  const ctx = ctxWith([entry("opencode", "space-bunny-free")], { fetchImpl, providerKeys: keys });

  const out = await executeChat(ctx, principal, chatBody("space-bunny-free"));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://opencode.ai/zen/v1/chat/completions");
  assert.equal(calls[0].headers.authorization, "Bearer oc-account-key-0123456789");
  assert.equal(calls[0].body.model, "space-bunny-free");
  assert.equal(out.choices[0].message.content, "ok");
});

test("an openrouter candidate uses the shared platform key, not the OpenCode one", async () => {
  const keys = new ProviderKeyManager(new MemoryProviderKeyStore(), kek);
  await keys.create(principal.accountId, "opencode", "test", "oc-account-key-0123456789");
  const { calls, fetchImpl } = recorder();
  const ctx = ctxWith([entry("openrouter", "meta/llama-3.3-70b-instruct:free")], { fetchImpl, platformKey: "or-platform-key", providerKeys: keys });

  await executeChat(ctx, principal, chatBody("meta/llama-3.3-70b-instruct:free"));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
  // The OpenCode key exists on this account and must not leak to OpenRouter.
  assert.equal(calls[0].headers.authorization, "Bearer or-platform-key");
});

test("a candidate whose provider has no credential is skipped, not sent to the wrong host", async () => {
  // No OpenCode key on this account. The opencode candidate must be skipped
  // rather than falling back to the platform key against opencode.ai.
  const { calls, fetchImpl } = recorder();
  const ctx = ctxWith([entry("opencode", "space-bunny-free"), entry("openrouter", "meta/llama-3.3-70b-instruct:free")], { fetchImpl, platformKey: "or-platform-key" });

  await executeChat(ctx, principal, chatBody("orin-cheap"));

  assert.equal(calls.length, 1, "only the openrouter candidate should have been attempted");
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(calls[0].body.model, "meta/llama-3.3-70b-instruct:free");
});

test("a request with no usable credential anywhere fails closed", async () => {
  const { calls, fetchImpl } = recorder();
  const ctx = ctxWith([entry("opencode", "space-bunny-free")], { fetchImpl, platformKey: undefined });

  await assert.rejects(() => executeChat(ctx, principal, chatBody("space-bunny-free")), /ORIN_PROVIDER_EXHAUSTED|No opencode credential/);
  assert.equal(calls.length, 0, "nothing may be sent upstream without a credential");
});

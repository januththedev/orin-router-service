import "./_hooks.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { assertRoutableModelId, isFreeModelId, isModelAlias } from "../src/free-models.js";
import { candidatesFor, isEligible, refreshCatalog } from "../src/catalog.js";
import { validateChatBody } from "../src/validate.js";
import { BYOK_PREFERENCE, createProviderAdapterForOrigin, isKnownProviderOrigin } from "../src/provider-registry.js";
import { UpstreamResolver } from "../src/upstream-credentials.js";
import { MemoryProviderKeyStore, ProviderKeyManager } from "../src/provider-keys.js";

const kek = Buffer.alloc(32, 7).toString("base64");

const principal = {
  accountId: "acct-1",
  scopes: ["router:invoke"],
  subject: "s",
  tokenId: "t",
  expiresAt: new Date(Date.now() + 60_000),
  usageReservationId: "u",
};

test("only OpenRouter :free model ids are accepted as free", () => {
  assert.equal(isFreeModelId("deepseek/deepseek-r1-0528:free"), true);
  assert.equal(isFreeModelId("meta-llama/llama-3.3-70b-instruct:free"), true);
  assert.equal(isFreeModelId("openai/gpt-4o-mini"), false);
  assert.equal(isFreeModelId("openai/gpt-4o:extended"), false);
  assert.equal(isFreeModelId("vendor/model:free:free"), false);
  assert.equal(isFreeModelId(":free"), false);
  assert.equal(isFreeModelId("vendor/mo del:free"), false);
  assert.equal(isFreeModelId(`vendor/${"x".repeat(300)}:free`), false);
  assert.equal(isFreeModelId(undefined), false);
});

test("a request may name an Orin alias or a free model id, never a paid one", () => {
  assert.equal(isModelAlias("orin-cheap"), true);
  assert.equal(assertRoutableModelId("orin-thinking"), "orin-thinking");
  assert.equal(assertRoutableModelId("qwen/qwen-2.5-72b-instruct:free"), "qwen/qwen-2.5-72b-instruct:free");
  assert.throws(() => assertRoutableModelId("openai/gpt-4o"), /free/i);
  assert.throws(() => assertRoutableModelId("gpt-4o-mini"), /free/i);

  const base = { messages: [{ role: "user", content: "hi" }] };
  assert.equal(validateChatBody({ model: "orin-balanced", ...base }).model, "orin-balanced");
  assert.equal(validateChatBody({ model: "qwen/qwen-2.5-72b-instruct:free", ...base }).model, "qwen/qwen-2.5-72b-instruct:free");
  assert.throws(() => validateChatBody({ model: "anthropic/claude-3", ...base }));
});

test("catalog eligibility needs both the :free marker and zero price", () => {
  const at = new Date().toISOString();
  const free = { provider: "openrouter", modelId: "a/b:free", fetchedAt: at, sourceStatus: "success", capabilities: ["text"], contextLimit: 8192, prices: { prompt: 0, completion: 0, image: null } };
  const freeButPriced = { ...free, prices: { prompt: 0.0001, completion: 0, image: null } };
  const zeroButPaidTier = { ...free, modelId: "a/b" };
  assert.equal(isEligible(free, "text"), true);
  assert.equal(isEligible(freeButPriced, "text"), false);
  assert.equal(isEligible(zeroButPaidTier, "text"), false);
});

test("catalog refresh keeps only the free tier", async () => {
  const payload = {
    data: [
      { id: "vendor/free-one:free", context_length: 8192, pricing: { prompt: "0", completion: "0" } },
      { id: "vendor/paid-one", context_length: 8192, pricing: { prompt: "0.000003", completion: "0.000015" } },
      { id: "vendor/zero-no-suffix", context_length: 4096, pricing: { prompt: "0", completion: "0" } },
    ],
  };
  const fakeFetch = async () => new Response(JSON.stringify(payload), { status: 200 });
  const snapshot = await refreshCatalog("https://openrouter.ai/api/v1/models", fakeFetch);
  assert.deepEqual(snapshot.models.map((m) => m.modelId), ["vendor/free-one:free"]);
});

test("a free model id pins routing to exactly that model", () => {
  const at = new Date().toISOString();
  const model = (id) => ({ provider: "openrouter", modelId: id, fetchedAt: at, sourceStatus: "success", capabilities: ["text"], contextLimit: 8192, prices: { prompt: 0, completion: 0, image: null } });
  const snapshot = { provider: "openrouter", fetchedAt: at, status: "success", sourceVersion: "t", sourceResponseHash: "0".repeat(64), models: [model("a/one:free"), model("b/two:free")] };
  assert.deepEqual(candidatesFor(snapshot, "a/one:free", "text").map((m) => m.modelId), ["a/one:free"]);
  assert.deepEqual(candidatesFor(snapshot, "orin-cheap", "text").map((m) => m.modelId), ["a/one:free", "b/two:free"]);
  assert.deepEqual(candidatesFor(snapshot, "missing/nope:free", "text"), []);
});

test("provider origins are fixed and unknown providers are refused", () => {
  assert.equal(isKnownProviderOrigin("openrouter"), true);
  assert.equal(isKnownProviderOrigin("deepseek"), true);
  assert.equal(isKnownProviderOrigin("evil"), false);
  assert.throws(() => createProviderAdapterForOrigin("evil", "k"), /Unsupported provider/);
  const adapter = createProviderAdapterForOrigin("groq", "k");
  assert.equal(adapter.id, "groq");
  assert.ok(BYOK_PREFERENCE.includes("openrouter"));
});

test("an account BYOK key is used for upstream and never marked revealed", async () => {
  const keys = new ProviderKeyManager(new MemoryProviderKeyStore(), kek);
  await keys.create("acct-1", "openrouter", "personal", "sk-or-v1-abcdefghijklmnop");
  const list = await keys.list("acct-1");
  assert.equal(list[0].lastRevealedAt, null);

  const used = await keys.useForUpstream("acct-1", "openrouter");
  assert.equal(used.secret, "sk-or-v1-abcdefghijklmnop");
  assert.equal((await keys.list("acct-1"))[0].lastRevealedAt, null, "upstream use must not consume the one-time reveal");

  assert.equal(await keys.useForUpstream("acct-2", "openrouter"), null, "keys must not cross accounts");
  assert.equal(await keys.useForUpstream("acct-1", "groq"), null);
});

test("BYOK wins over the platform key, and preference order is honoured", async () => {
  const keys = new ProviderKeyManager(new MemoryProviderKeyStore(), kek);
  const resolver = new UpstreamResolver({ mode: "live", platformKey: "platform-secret", providerKeys: keys });

  // No BYOK yet: the shared platform key serves the request.
  const shared = await resolver.resolve(principal);
  assert.equal(shared.source, "platform");
  assert.equal(shared.provider, "openrouter");

  // A later key on a lower-preference provider still wins over the platform key.
  await keys.create("acct-1", "deepseek", "personal", "sk-deepseek-0000000000");
  const byok = await resolver.resolve(principal);
  assert.equal(byok.source, "account-byok");
  assert.equal(byok.provider, "deepseek");
  assert.equal(byok.adapter.id, "deepseek");

  // The highest-preference provider present is the one selected.
  await keys.create("acct-1", "openrouter", "router", "sk-openrouter-000000000");
  const preferred = await resolver.resolve(principal);
  assert.equal(preferred.provider, "openrouter");
});

test("a revoked BYOK key falls back to the platform key", async () => {
  const keys = new ProviderKeyManager(new MemoryProviderKeyStore(), kek);
  const created = await keys.create("acct-1", "openrouter", "personal", "sk-openrouter-000000000");
  await keys.revoke("acct-1", created.record.id);
  const resolver = new UpstreamResolver({ mode: "live", platformKey: "platform-secret", providerKeys: keys });
  const resolved = await resolver.resolve(principal);
  assert.equal(resolved.source, "platform");
});

test("an account with no usable credential fails closed instead of using nobody's key", async () => {
  const keys = new ProviderKeyManager(new MemoryProviderKeyStore(), kek);
  const resolver = new UpstreamResolver({ mode: "live", platformKey: undefined, providerKeys: keys });
  await assert.rejects(() => resolver.resolve(principal), /No upstream credential/);
});

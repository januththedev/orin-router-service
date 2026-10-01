import "./_hooks.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { isFreeModelId, isRoutableModelId, assertRoutableModelId } from "../src/free-models.js";
import { candidatesFor, isEligible, refreshCatalog, CATALOG_SOURCES } from "../src/catalog.js";
import { BYOK_PREFERENCE, PROVIDER_ORIGINS, isKnownProviderOrigin, opencodeFreeTierTerms } from "../src/provider-registry.js";
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

function manager() {
  return new ProviderKeyManager(new MemoryProviderKeyStore(), kek);
}

async function withKey(provider, secret) {
  const keys = manager();
  await keys.create(principal.accountId, provider, "test", secret);
  return keys;
}

const catModel = (provider, modelId, prices = { prompt: 0, completion: 0, image: null }) => ({
  provider,
  modelId,
  fetchedAt: new Date().toISOString(),
  sourceStatus: "success",
  capabilities: ["text", "streaming"],
  contextLimit: 1000,
  prices,
});

const snapshotOf = (models) => ({ provider: "catalog", fetchedAt: new Date().toISOString(), status: "success", sourceVersion: "test", sourceResponseHash: "0".repeat(64), models });

// --- the free marker is per-provider -------------------------------------------------

test("each provider's free marker is read from that provider, not globally", () => {
  // OpenRouter writes `:free`, OpenCode writes `-free`.
  assert.equal(isFreeModelId("meta-llama/llama-3.3-70b-instruct:free", "openrouter"), true);
  assert.equal(isFreeModelId("meta-llama/llama-3.3-70b-instruct:free", "opencode"), false);
  assert.equal(isFreeModelId("space-bunny-free", "opencode"), true);
  assert.equal(isFreeModelId("space-bunny-free", "openrouter"), false);
  // A paid id carries no marker under either provider.
  assert.equal(isFreeModelId("gpt-5.5", "opencode"), false);
  assert.equal(isFreeModelId("openai/gpt-4o", "openrouter"), false);
  // An unknown provider falls back to the OpenRouter convention rather than
  // silently accepting everything.
  assert.equal(isFreeModelId("space-bunny-free", "nope"), false);
});

test("an unscoped free check accepts either provider's marker", () => {
  assert.equal(isFreeModelId("space-bunny-free"), true);
  assert.equal(isFreeModelId("qwen/qwen-2.5-72b-instruct:free"), true);
  assert.equal(isFreeModelId("gpt-5.5"), false);
  assert.equal(isRoutableModelId("space-bunny-free"), true);
  assert.equal(assertRoutableModelId("space-bunny-free"), "space-bunny-free");
});

test("an OpenCode id is not eligible as an OpenRouter model and vice versa", () => {
  // This is the bug the second gate exists to prevent: without the provider
  // scope, `-free` would look free everywhere and the id would be POSTed to
  // the wrong origin.
  assert.equal(isEligible(catModel("openrouter", "space-bunny-free"), "text"), false);
  assert.equal(isEligible(catModel("opencode", "meta/llama:free"), "text"), false);
  assert.equal(isEligible(catModel("opencode", "space-bunny-free"), "text"), true);
  assert.equal(isEligible(catModel("openrouter", "meta/llama:free"), "text"), true);
});

// --- a marker alone never authorises a model ----------------------------------------

test("an invented -free id resolves to no candidate instead of reaching a provider", () => {
  const snapshot = snapshotOf([catModel("opencode", "space-bunny-free")]);
  assert.deepEqual(candidatesFor(snapshot, "space-bunny-free", "text").map((m) => m.modelId), ["space-bunny-free"]);
  // Passes the shape check, is absent from the catalog, so it is not routable.
  assert.deepEqual(candidatesFor(snapshot, "totally-made-up-free", "text"), []);
  // A real OpenCode id cannot be borrowed to select an OpenRouter-only pool.
  assert.deepEqual(candidatesFor(snapshotOf([catModel("openrouter", "meta/llama:free")]), "space-bunny-free", "text"), []);
});

// --- credentials are bound to the provider that serves the candidate -----------------

test("a BYOK key is used only for its own provider, and failover continues", async () => {
  const keys = await withKey("opencode", "oc-test-secret-0123456789");
  const resolver = new UpstreamResolver({ mode: "live", platformKey: "platform-secret", providerKeys: keys });

  const opencode = await resolver.resolveForProvider(principal, "opencode");
  assert.equal(opencode.source, "account-byok");
  assert.equal(opencode.provider, "opencode");
  assert.equal(opencode.providerKeyId !== null, true);

  // No DeepSeek key on this account, and the platform key must not stand in.
  assert.equal(await resolver.resolveForProvider(principal, "deepseek"), null);
  // OpenRouter still falls back to the shared platform key.
  const shared = await resolver.resolveForProvider(principal, "openrouter");
  assert.equal(shared.source, "platform");
  assert.equal(shared.provider, "openrouter");
});

test("the platform key is never used for OpenCode", async () => {
  const resolver = new UpstreamResolver({ mode: "live", platformKey: "platform-secret", providerKeys: manager() });
  // No BYOK key anywhere and a platform key present: opencode must still refuse,
  // because Orin holds no OpenCode credential and the free tier is not ours to
  // broker. OpenCode is therefore unusable until the account brings its own key.
  assert.equal(await resolver.resolveForProvider(principal, "opencode"), null);
  assert.equal((await resolver.resolveForProvider(principal, "openrouter"))?.source, "platform");
});

test("an unknown provider resolves to nothing rather than to a default origin", async () => {
  const resolver = new UpstreamResolver({ mode: "live", platformKey: "platform-secret", providerKeys: manager() });
  assert.equal(await resolver.resolveForProvider(principal, "evil.example"), null);
});

test("the existing preference-order resolve() contract is unchanged", async () => {
  const keys = manager();
  const resolver = new UpstreamResolver({ mode: "live", platformKey: "platform-secret", providerKeys: keys });
  assert.equal((await resolver.resolve(principal)).source, "platform");
  assert.ok(BYOK_PREFERENCE.includes("openrouter"));
  await keys.create(principal.accountId, "opencode", "test", "oc-test-secret-0123456789");
  const byok = await resolver.resolve(principal);
  assert.equal(byok.source, "account-byok");
  assert.equal(byok.provider, "opencode");
});

// --- the origin itself ----------------------------------------------------------------

test("the OpenCode origin is OpenAI-compatible, text-only, and BYOK-only", () => {
  const origin = PROVIDER_ORIGINS.opencode;
  assert.equal(origin.baseUrl, "https://opencode.ai/zen/v1");
  assert.equal(origin.chatPath, "/chat/completions");
  assert.equal(origin.imagePath, null, "Zen serves no image endpoint");
  assert.equal(origin.acceptsPlatformKey, false, "the free tier may not be brokered");
  assert.equal(origin.freeSuffix, "-free");
  assert.equal(isKnownProviderOrigin("opencode"), true);
  // No BYOK path in a model id, so an OpenCode id cannot be steered elsewhere.
  assert.equal(opencodeFreeTierTerms.byokOnly, true);
  assert.match(opencodeFreeTierTerms.internalUseOnlyClause, /own internal use/);
  assert.match(opencodeFreeTierTerms.internalUseOnlyClause, /not on behalf of or for the benefit of any third party/);
});

// --- catalog refresh fans out -----------------------------------------------------------

function stubJson(map) {
  return async (url) => {
    const body = map[url];
    if (body === undefined) return { ok: false, status: 503 };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
}

test("a multi-source refresh keeps OpenCode free models and drops its paid ones", async () => {
  const or = "https://openrouter.ai/api/v1/models";
  const oc = "https://opencode.ai/zen/v1/models";
  const fetchImpl = stubJson({
    [or]: { data: [{ id: "meta/llama-3.3-70b-instruct:free", context_length: 128000, pricing: { prompt: "0", completion: "0" } }, { id: "openai/gpt-4o", pricing: { prompt: "2.5", completion: "10" } }] },
    [oc]: { data: [{ id: "space-bunny-free", context_length: 1048576 }, { id: "gpt-5.5", context_length: 400000 }] },
  });
  const snapshot = await refreshCatalog(CATALOG_SOURCES, fetchImpl);
  assert.equal(snapshot.status, "success");
  assert.equal(snapshot.sourceVersion, "openrouter+opencode");
  const ids = snapshot.models.map((m) => m.modelId).sort();
  assert.deepEqual(ids, ["meta/llama-3.3-70b-instruct:free", "space-bunny-free"]);
  // Each entry keeps the provider that actually serves it, which is what binds
  // the credential later.
  assert.equal(snapshot.models.find((m) => m.modelId === "space-bunny-free")?.provider, "opencode");
  assert.equal(snapshot.models.find((m) => m.modelId.startsWith("meta/"))?.provider, "openrouter");
  // Zen publishes no prices; the marker plus the published table establishes them.
  assert.equal(snapshot.models.find((m) => m.modelId === "space-bunny-free")?.prices.prompt, 0);
});

test("one unreachable source does not empty the pool, and all-down fails closed", async () => {
  const or = "https://openrouter.ai/api/v1/models";
  const oc = "https://opencode.ai/zen/v1/models";
  const partial = await refreshCatalog(CATALOG_SOURCES, stubJson({ [or]: { data: [{ id: "meta/llama:free", pricing: { prompt: "0", completion: "0" } }] } }));
  assert.equal(partial.status, "success");
  assert.deepEqual(partial.models.map((m) => m.modelId), ["meta/llama:free"]);

  const down = await refreshCatalog(CATALOG_SOURCES, async () => { throw new Error("network down"); });
  assert.equal(down.status, "failure");
  assert.equal(down.models.length, 0);
  assert.equal(down.errorCode, "ORIN_CATALOG_UNAVAILABLE");
});

test("the explicit single-source override still narrows the refresh to one provider", async () => {
  const or = "https://openrouter.ai/api/v1/models";
  const snapshot = await refreshCatalog(or, stubJson({ [or]: { data: [{ id: "meta/llama:free", pricing: { prompt: "0", completion: "0" } }, { id: "space-bunny-free" }] } }));
  // A `-free` id arriving from the OpenRouter source is not OpenRouter's marker,
  // so it is dropped rather than mislabelled.
  assert.deepEqual(snapshot.models.map((m) => m.modelId), ["meta/llama:free"]);
  assert.equal(snapshot.sourceVersion, "openrouter");
});

import "./_hooks.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRuntime } from "../src/runtime.js";
import { listModels } from "../src/service.js";

const config = { databaseUrl: "fake", serviceSigningKey: "x", serviceKeyId: "x", coreIntrospectionUrl: "http://127.0.0.1", coreClientId: "x", coreClientSecret: "x", redisUrl: "fake", redisToken: "x", redisHashKey: "x", providerMode: "fake", catalogSourceUrl: "fake", providerKekCurrent: "x", cronSecret: "x" };

test("fake preview executes chat and image without a live adapter", async () => {
  const runtime = createRuntime(config, {});
  const principal = { accountId: "preview-account", scopes: ["router:invoke"], subject: "preview", tokenId: "preview", expiresAt: new Date(Date.now() + 60_000), usageReservationId: "usage" };
  const { adapter, source } = await runtime.service.upstream.resolve(principal);
  assert.equal(source, "fake");
  const result = await adapter.chat({ model: "orin-balanced", messages: [{ role: "user", content: "hello" }], stream: false }, "fake/free-text:free");
  assert.equal(result.text, "fake:hello");
  const image = await adapter.image({ model: "orin-cheap", prompt: "p", n: 1, response_format: "b64_json" }, "fake/free-text:free");
  assert.equal(image.data.length > 0, true);
  const models = await listModels();
  assert.equal(models.data.length, 4);
  assert.equal(principal.accountId, "preview-account");
});

test("model list advertises the free catalog alongside the aliases", async () => {
  const runtime = createRuntime(config, {});
  const models = await listModels(runtime.service.catalog);
  const ids = models.data.map((m) => m.id);
  assert.deepEqual(ids.slice(0, 4), ["orin-cheap", "orin-balanced", "orin-thinking", "orin-coding"]);
  assert.ok(ids.includes("fake/free-text:free"), "fake free model should be advertised");
  for (const id of ids.slice(4)) assert.ok(id.endsWith(":free"), `advertised model ${id} must be free`);
});

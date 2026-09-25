import "./_hooks.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRuntime } from "../src/runtime.js";

const config = { databaseUrl: "fake", serviceSigningKey: "x", serviceKeyId: "x", coreIntrospectionUrl: "http://127.0.0.1", coreClientId: "x", coreClientSecret: "x", redisUrl: "fake", redisToken: "x", redisHashKey: "x", providerMode: "fake", catalogSourceUrl: "fake", providerKekCurrent: "x", cronSecret: "x" };
test("fake preview executes chat and image without a live adapter", async () => {
  const runtime = createRuntime(config);
  const principal = { accountId: "preview-account", scopes: ["router:invoke"], subject: "preview", tokenId: "preview", expiresAt: new Date(Date.now() + 60_000), usageReservationId: "usage" };
  const result = await runtime.service.adapter.chat({ model: "orin-balanced", messages: [{ role: "user", content: "hello" }], stream: false }, "free-text");
  assert.equal(result.text, "fake:hello");
  const models = await import("../src/service.js").then(({ listModels }) => listModels());
  assert.equal(models.data.length, 4);
  assert.equal(principal.accountId, "preview-account");
});

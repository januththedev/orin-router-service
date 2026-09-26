import "./_hooks.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRouterServer } from "../server/index.js";
import { createRuntime } from "../src/runtime.js";

const config = {
  databaseUrl: "fake", serviceSigningKey: "x", serviceKeyId: "x",
  coreIntrospectionUrl: "http://127.0.0.1", coreClientId: "x", coreClientSecret: "x",
  redisUrl: "fake", redisToken: "x", redisHashKey: "x",
  providerMode: "fake", catalogSourceUrl: "fake", providerKekCurrent: "x", cronSecret: "x",
};

async function withServer(fn) {
  const server = createRouterServer(createRuntime(config, {}));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("the standalone server exposes health and the same route table as Vercel", async () => {
  await withServer(async (base) => {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, "ok");

    // An unknown path is 404 and a known path with the wrong verb is 405.
    const missing = await fetch(`${base}/v1/nope`);
    assert.equal(missing.status, 404);

    const wrongVerb = await fetch(`${base}/v1/models`, { method: "POST" });
    assert.equal(wrongVerb.status, 405);
    assert.equal(wrongVerb.headers.get("allow"), "GET");
  });
});

test("the standalone server enforces authentication on inference routes", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/v1/models`, { method: "GET" });
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error.code, "ORIN_AUTHENTICATION_REQUIRED");
  });
});

test("the standalone server rejects an oversized or malformed body", async () => {
  await withServer(async (base) => {
    const malformed = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, "ORIN_INVALID_JSON");
  });
});

test("the preview path completes a real chat turn over the standalone server", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-orin-preview-service": "1", authorization: "Bearer preview" },
      body: JSON.stringify({ model: "orin-balanced", messages: [{ role: "user", content: "ping" }] }),
    });
    const text = await response.text();
    assert.equal(response.status, 200, `unexpected response: ${text}`);
    const body = JSON.parse(text);
    assert.equal(body.object, "chat.completion");
    assert.equal(body.choices[0].message.content, "fake:ping");
  });
});

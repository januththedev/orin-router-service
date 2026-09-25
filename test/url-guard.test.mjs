import "./_hooks.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { validateOutboundUrl } from "@orin/security";

const policy = { profile: "cloud", allowlist: [{ origin: "https://openrouter.ai", pathPrefixes: ["/api/v1"] }], maxRedirects: 2, connectTimeoutMs: 1000, totalTimeoutMs: 1000, maxResponseBytes: 1000, allowedContentTypes: ["application/json"] };
test("provider registry blocks non-allowlisted and private destinations", async () => {
  await assert.rejects(() => validateOutboundUrl("https://evil.example/api/v1", policy, { resolveAll: async () => [{ address: "8.8.8.8", family: 4 }] }));
  await assert.rejects(() => validateOutboundUrl("https://openrouter.ai/api/v1", policy, { resolveAll: async () => [{ address: "127.0.0.1", family: 4 }] }));
});

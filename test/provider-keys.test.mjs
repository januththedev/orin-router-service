import "./_hooks.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryProviderKeyStore, ProviderKeyManager } from "../src/provider-keys.js";

const kek = Buffer.alloc(32, 7).toString("base64");
const secret = "provider-secret-value-123456";

test("provider keys are encrypted, fingerprinted, and reveal-once", async () => {
  const store = new MemoryProviderKeyStore();
  const manager = new ProviderKeyManager(store, kek);
  const created = await manager.create("acct_123", "openai", "production", secret);
  assert.equal(created.record.fingerprint.length, 16);
  assert.equal(created.record.status, "active");
  assert.equal((await manager.list("acct_123"))[0].encrypted, undefined);
  assert.equal(await manager.revealOnce("acct_123", created.record.id), secret);
  assert.equal(await manager.revealOnce("acct_123", created.record.id), null);
  assert.equal(JSON.stringify(await manager.list("acct_123")).includes(secret), false);
});

test("rotation revokes the old key and enforces account/provider boundaries", async () => {
  const manager = new ProviderKeyManager(new MemoryProviderKeyStore(), kek);
  const first = await manager.create("acct_123", "groq", "default", secret);
  assert.equal(await manager.revealOnce("acct_other", first.record.id), null);
  const rotated = await manager.rotate("acct_123", first.record.id, "new-provider-secret-123456");
  assert.equal(rotated.record.provider, "groq");
  assert.equal((await manager.list("acct_123")).filter((row) => row.status === "revoked").length, 1);
  await assert.rejects(() => manager.create("acct_123", "unknown", "x", secret), /Unsupported provider/);
});

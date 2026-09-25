import "./_hooks.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { GatewayKeyManager, MemoryGatewayKeyStore } from "../src/gateway-keys.js";

test("gateway keys are one-time displayed, hashed, and revocable", async () => {
  const manager = new GatewayKeyManager(new MemoryGatewayKeyStore());
  const created = await manager.create("acct_123", "laptop");
  assert.match(created.secret, /^orin_[A-Za-z0-9_-]{43}$/);
  assert.equal((await manager.list("acct_123"))[0].fingerprint.length, 16);
  assert.equal(JSON.stringify(await manager.list("acct_123")).includes(created.secret), false);
  assert.equal((await manager.verify(created.secret))?.accountId, "acct_123");
  await manager.revoke("acct_123", created.record.id);
  assert.equal(await manager.verify(created.secret), null);
});

test("gateway keys are scoped to the creating account", async () => {
  const manager = new GatewayKeyManager(new MemoryGatewayKeyStore());
  const created = await manager.create("acct_123", "other");
  assert.deepEqual(await manager.list("acct_other"), []);
  await assert.rejects(() => manager.revoke("acct_other", created.record.id));
});

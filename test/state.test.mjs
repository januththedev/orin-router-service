import "./_hooks.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryState } from "../src/redis-state.js";

test("memory state is explicit fake state and enforces limits", async () => {
  const state = new MemoryState(() => 0);
  assert.equal(await state.consumeRequest("a", 2, 60_000), true);
  assert.equal(await state.consumeRequest("a", 2, 60_000), true);
  assert.equal(await state.consumeRequest("a", 2, 60_000), false);
  await state.recordFailure({ provider: "fake", model: "free-text" }, 500);
  assert.equal(await state.isEligible({ provider: "fake", model: "free-text" }), true);
});

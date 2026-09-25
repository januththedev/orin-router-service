import "./_hooks.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { MODEL_ALIASES } from "../src/types.js";
import { listModels } from "../src/service.js";

test("contract exposes exactly four public aliases", async () => {
  assert.deepEqual(MODEL_ALIASES, ["orin-cheap", "orin-balanced", "orin-thinking", "orin-coding"]);
  const response = await listModels();
  assert.deepEqual(response.data.map((item) => item.id), [...MODEL_ALIASES]);
});
test("legacy user-key and wildcard modules are not part of the public surface", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../src/service.ts", import.meta.url), "utf8"));
  assert.doesNotMatch(source, /mintUserKey|addProvider|customAdapter|userUid/);
});

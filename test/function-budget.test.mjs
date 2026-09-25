import "./_hooks.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Vercel function topology is exactly five", async () => {
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(config.functions).sort(), ["api/internal/attempts/[requestId].ts", "api/internal/catalog/refresh.ts", "api/v1/chat/completions.ts", "api/v1/images/generations.ts", "api/v1/models.ts"]);
  assert.equal(config.crons, undefined, "catalog refresh uses an external scheduler, not Vercel cron");
});

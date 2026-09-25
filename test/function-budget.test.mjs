import "./_hooks.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Vercel function topology includes the bounded dashboard surface", async () => {
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(config.functions).sort(), ["api/dashboard/gateway-keys.ts", "api/dashboard/keys.ts", "api/dashboard/overview.ts", "api/internal/attempts/[requestId].ts", "api/internal/catalog/refresh.ts", "api/v1/chat/completions.ts", "api/v1/images/generations.ts", "api/v1/models.ts"]);
  assert.equal(config.crons, undefined, "catalog refresh uses an external scheduler, not Vercel cron");
});

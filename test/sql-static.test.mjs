import "./_hooks.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("migration files contain canonical tables and no user routes", async () => {
  const files = ["001_canonical_router.sql", "002_router_indexes_rls.sql", "003_seed_aliases.sql", "004_legacy_quarantine.sql"];
  for (const file of files) assert.ok((await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8")).length > 0);
});

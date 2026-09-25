import "./_hooks.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("static Router surfaces contain no credential storage or deferred dashboard claims", async () => {
  for (const file of ["../index.html", "../docs/api.html", "../docs/introduction.html", "../README.md"]) {
    const text = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(text, /localStorage|orin_mcp_|wildcard providers|raw model id.*accepted/i, file);
    assert.match(text, /orin-balanced|service assertion/i, file);
  }
});

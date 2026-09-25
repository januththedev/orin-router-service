import "./_hooks.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { validateChatBody, validateImageBody } from "../src/validate.js";
import { RouterError } from "../src/errors.js";

test("chat validation accepts only canonical aliases and text roles", () => {
  const body = validateChatBody({ model: "orin-balanced", messages: [{ role: "user", content: "hello" }] });
  assert.equal(body.model, "orin-balanced");
  assert.throws(() => validateChatBody({ model: "openrouter/free", messages: [{ role: "user", content: "x" }] }), RouterError);
  assert.throws(() => validateChatBody({ model: "orin-balanced", messages: [{ role: "tool", content: "x" }] }), RouterError);
  assert.throws(() => validateChatBody({ model: "orin-balanced", messages: [{ role: "user", content: "x" }], tools: [] }), RouterError);
});
test("image validation is bounded", () => {
  assert.equal(validateImageBody({ model: "orin-balanced", prompt: "draw", n: 1, response_format: "b64_json" }).n, 1);
  assert.throws(() => validateImageBody({ model: "orin-balanced", prompt: "draw", n: 2, response_format: "b64_json" }), RouterError);
});

import "./_hooks.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { ServiceAuthenticator } from "../src/service-auth.js";
import { RouterError } from "../src/errors.js";

const config = { providerMode: "fake", serviceSigningKey: "x", coreIntrospectionUrl: "http://127.0.0.1", coreClientId: "x", coreClientSecret: "x" };
const introspector = { introspect: async () => ({ active: true, account_id: "acct_test", scopes: ["router:invoke"], usage_reservation_id: "usage_test" }) };
test("fake preview accepts only explicit preview service header", async () => {
  const auth = new ServiceAuthenticator(config, introspector);
  const principal = await auth.verify({ headers: { authorization: "Bearer fake", "x-orin-preview-service": "1" } });
  assert.equal(principal.accountId, "preview-account");
  await assert.rejects(() => auth.verify({ headers: { authorization: "Bearer fake" } }), RouterError);
});
test("missing bearer is rejected", async () => {
  const auth = new ServiceAuthenticator(config, introspector);
  await assert.rejects(() => auth.verify({ headers: {} }), (error) => error.code === "ORIN_AUTHENTICATION_REQUIRED");
});

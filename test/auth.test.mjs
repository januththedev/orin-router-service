import "./_hooks.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { ServiceAuthenticator, createCoreCredentialVerifier } from "../src/service-auth.js";
import { RouterError } from "../src/errors.js";

const config = { providerMode: "fake", serviceSigningKey: "x", coreIntrospectionUrl: "http://127.0.0.1", coreClientId: "x", coreClientSecret: "x" };
const introspector = { verifyServiceCredential: async () => ({ active: true, account_id: "acct_test", scopes: ["router:invoke"], usage_reservation_id: "usage_test" }) };
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

test("the introspection destination is pinned per mode, not taken from config", () => {
  const base = { serviceSigningKey: "x", coreClientId: "x", coreClientSecret: "x" };
  // Fake mode is the local development loopback and nothing else.
  assert.doesNotThrow(() => createCoreCredentialVerifier({ ...base, providerMode: "fake", coreIntrospectionUrl: "http://127.0.0.1:8080/api/auth/introspect" }));
  for (const url of [
    "https://evil.example/api/auth/introspect",
    "http://169.254.169.254/latest/meta-data/",
    "https://orinai.org.evil.example/api/auth/introspect",
    "file:///etc/passwd",
  ]) {
    assert.throws(() => createCoreCredentialVerifier({ ...base, providerMode: "fake", coreIntrospectionUrl: url }), /not trusted|loopback/i, `fake mode must refuse ${url}`);
  }
  // Live mode never reads the configured value at all: the destination is the
  // pinned apex, so a hostile setting cannot redirect introspection.
  for (const url of ["https://evil.example/x", "http://127.0.0.1:8080/api/auth/introspect", "https://orinai.org.evil.example/api/auth/introspect"]) {
    assert.doesNotThrow(() => createCoreCredentialVerifier({ ...base, providerMode: "live", coreIntrospectionUrl: url }), `live mode ignores ${url}`);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { FirebaseAuthVerifier } from "../src/firebase-auth.js";

function token(payload: Record<string, unknown>): string {
  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${enc({ alg: "RS256", kid: "test" })}.${enc(payload)}.signature`;
}

const now = Math.floor(Date.now() / 1000);
const projectId = "mcp-runtime-test";
const allowedUid = "owner-uid";
const goodToken = token({
  aud: projectId,
  iss: `https://securetoken.google.com/${projectId}`,
  sub: allowedUid,
  exp: now + 3600,
  iat: now - 10,
  auth_time: now - 20
});

function okLookup(uid = allowedUid, validSince = String(now - 100)): typeof fetch {
  return (async () => new Response(JSON.stringify({ users: [{ localId: uid, validSince, disabled: false }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  })) as typeof fetch;
}

function verifier(fetchImpl: typeof fetch): FirebaseAuthVerifier {
  return new FirebaseAuthVerifier({
    projectId,
    webApiKey: "public-web-api-key",
    allowedUids: [allowedUid],
    lookupTimeoutMs: 2_000
  }, fetchImpl);
}

test("Firebase Auth accepts a backend-validated token for the allowed uid", async () => {
  const result = await verifier(okLookup()).authorize(`Bearer ${goodToken}`);
  assert.deepEqual(result, { allowed: true, principal: { uid: allowedUid } });
});

test("Firebase Auth rejects missing, wrong-project, revoked, and non-allowlisted identities", async () => {
  assert.equal((await verifier(okLookup()).authorize(undefined)).status, 401);

  const wrongProject = token({
    aud: "other-project",
    iss: "https://securetoken.google.com/other-project",
    sub: allowedUid,
    exp: now + 3600,
    iat: now - 10,
    auth_time: now - 20
  });
  assert.equal((await verifier(okLookup()).authorize(`Bearer ${wrongProject}`)).status, 401);

  assert.equal((await verifier(okLookup(allowedUid, String(now))).authorize(`Bearer ${goodToken}`)).status, 401);

  const otherUid = "other-uid";
  const otherToken = token({
    aud: projectId,
    iss: `https://securetoken.google.com/${projectId}`,
    sub: otherUid,
    exp: now + 3600,
    iat: now - 10,
    auth_time: now - 20
  });
  const forbidden = await verifier(okLookup(otherUid)).authorize(`Bearer ${otherToken}`);
  assert.deepEqual(forbidden, { allowed: false, status: 403, code: "principal_not_allowed" });
});

test("Firebase Auth fails closed with 503 when the Auth backend is unavailable", async () => {
  const backendDown = (async () => new Response("unavailable", { status: 503 })) as typeof fetch;
  assert.deepEqual(
    await verifier(backendDown).authorize(`Bearer ${goodToken}`),
    { allowed: false, status: 503, code: "auth_unavailable" }
  );
});

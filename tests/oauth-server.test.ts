import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { OAuthError } from "@modelcontextprotocol/server";
import { FirebaseAuthVerifier } from "../src/firebase-auth.js";
import { CinemaOAuthServer } from "../src/oauth-server.js";
import type {
  CinemaOAuthStore,
  IssuedOAuthTokens,
  OAuthAuthorizationCodeRecord,
  OAuthAuthorizationRequestRecord,
  OAuthTokenRecord
} from "../src/oauth-store.js";

const base = "https://cinema.example";
const resource = `${base}/mcp`;
const clientId = "https://chatgpt.com/oauth/test/client.json";
const redirectUri = "https://chatgpt.com/connector/oauth/test";
const ownerUid = "owner-uid";
const projectId = "mcp-runtime-test";

function firebaseToken(uid = ownerUid): string {
  const now = Math.floor(Date.now() / 1000);
  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${enc({ alg: "RS256", kid: "test" })}.${enc({
    aud: projectId,
    iss: `https://securetoken.google.com/${projectId}`,
    sub: uid,
    exp: now + 3600,
    iat: now - 10,
    auth_time: now - 20
  })}.signature`;
}

function firebaseVerifier(): FirebaseAuthVerifier {
  const now = Math.floor(Date.now() / 1000);
  const fetchImpl = (async () => new Response(JSON.stringify({
    users: [{ localId: ownerUid, validSince: String(now - 100), disabled: false }]
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  return new FirebaseAuthVerifier({
    projectId,
    webApiKey: "public-web-api-key",
    allowedUids: [ownerUid],
    lookupTimeoutMs: 2_000
  }, fetchImpl);
}

class MemoryOAuthStore implements CinemaOAuthStore {
  private sequence = 0;
  readonly requests = new Map<string, OAuthAuthorizationRequestRecord>();
  readonly codes = new Map<string, OAuthAuthorizationCodeRecord>();
  readonly access = new Map<string, OAuthTokenRecord>();
  readonly refresh = new Map<string, OAuthTokenRecord>();

  private secret(kind: string): string {
    this.sequence += 1;
    return `${kind}-${String(this.sequence).padStart(3, "0")}-${"x".repeat(43)}`;
  }

  async createAuthorizationRequest(record: OAuthAuthorizationRequestRecord): Promise<string> {
    const value = this.secret("request");
    this.requests.set(value, structuredClone(record));
    return value;
  }

  async getAuthorizationRequest(handle: string): Promise<OAuthAuthorizationRequestRecord | undefined> {
    const value = this.requests.get(handle);
    return value && value.expiresAt > Date.now() ? structuredClone(value) : undefined;
  }

  async consumeAuthorizationRequest(handle: string): Promise<OAuthAuthorizationRequestRecord | undefined> {
    const value = await this.getAuthorizationRequest(handle);
    this.requests.delete(handle);
    return value;
  }

  async createAuthorizationCode(record: OAuthAuthorizationCodeRecord): Promise<string> {
    const value = this.secret("code");
    this.codes.set(value, structuredClone(record));
    return value;
  }

  async consumeAuthorizationCode(code: string): Promise<OAuthAuthorizationCodeRecord | undefined> {
    const value = this.codes.get(code);
    this.codes.delete(code);
    return value && value.expiresAt > Date.now() ? structuredClone(value) : undefined;
  }

  async issueTokenPair(input: {
    uid: string;
    clientId: string;
    scopes: string[];
    resource: string;
    accessExpiresAt: number;
    refreshExpiresAt: number;
  }): Promise<IssuedOAuthTokens> {
    const accessToken = this.secret("access");
    const refreshToken = this.secret("refresh");
    const access: OAuthTokenRecord = {
      uid: input.uid,
      clientId: input.clientId,
      scopes: [...input.scopes],
      resource: input.resource,
      expiresAt: input.accessExpiresAt
    };
    const refresh: OAuthTokenRecord = {
      uid: input.uid,
      clientId: input.clientId,
      scopes: [...input.scopes],
      resource: input.resource,
      expiresAt: input.refreshExpiresAt
    };
    this.access.set(accessToken, access);
    this.refresh.set(refreshToken, refresh);
    return { accessToken, refreshToken, access, refresh };
  }

  async consumeRefreshToken(token: string): Promise<OAuthTokenRecord | undefined> {
    const value = this.refresh.get(token);
    this.refresh.delete(token);
    return value && value.expiresAt > Date.now() ? structuredClone(value) : undefined;
  }

  async getAccessToken(token: string): Promise<OAuthTokenRecord | undefined> {
    const value = this.access.get(token);
    return value && value.expiresAt > Date.now() ? structuredClone(value) : undefined;
  }

  async revokeToken(token: string): Promise<void> {
    this.access.delete(token);
    this.refresh.delete(token);
  }

  async close(): Promise<void> {}
}

function clientMetadataFetch(overrides: Record<string, unknown> = {}): typeof fetch {
  return (async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    assert.equal(url, clientId);
    return new Response(JSON.stringify({
      client_id: clientId,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...overrides
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function server(store = new MemoryOAuthStore(), metadataFetch = clientMetadataFetch()) {
  return {
    store,
    oauth: new CinemaOAuthServer({
      publicBaseUrl: base,
      firebaseWebApiKey: "public-web-api-key",
      allowedFirebaseUids: [ownerUid],
      allowedClientHosts: ["chatgpt.com"],
      authorizationRequestTtlMs: 600_000,
      authorizationCodeTtlMs: 120_000,
      accessTokenTtlMs: 3_600_000,
      refreshTokenTtlMs: 30 * 86_400_000,
      clientMetadataTimeoutMs: 2_000
    }, store, firebaseVerifier(), metadataFetch)
  };
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

function authorizeUrl(verifier: string): string {
  const url = new URL(`${base}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", "state-123");
  url.searchParams.set("code_challenge", pkceChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", resource);
  url.searchParams.set("scope", "mcp:tools offline_access");
  return url.href;
}

test("OAuth metadata is ChatGPT-preflight compatible and does not advertise offline_access on the resource", async () => {
  const { oauth } = server();
  const prm = await oauth.handle(new Request(`${base}/.well-known/oauth-protected-resource/mcp`));
  assert.equal(prm.status, 200);
  const resourceMetadata = await prm.json() as Record<string, unknown>;
  assert.equal(resourceMetadata.resource, resource);
  assert.deepEqual(resourceMetadata.authorization_servers, [base]);
  assert.deepEqual(resourceMetadata.scopes_supported, ["mcp:tools"]);

  const as = await oauth.handle(new Request(`${base}/.well-known/oauth-authorization-server`));
  assert.equal(as.status, 200);
  const metadata = await as.json() as Record<string, unknown>;
  assert.equal(metadata.issuer, base);
  assert.equal(metadata.authorization_endpoint, `${base}/authorize`);
  assert.equal(metadata.token_endpoint, `${base}/token`);
  assert.equal(metadata.client_id_metadata_document_supported, true);
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ["none"]);
  assert.deepEqual(metadata.grant_types_supported, ["authorization_code", "refresh_token"]);
  assert.deepEqual(metadata.scopes_supported, ["mcp:tools", "offline_access"]);
});

test("authorization validates CIMD host, resource and exact redirect URI", async () => {
  const verifier = "v".repeat(64);
  const { oauth } = server();
  const good = await oauth.handle(new Request(authorizeUrl(verifier), { redirect: "manual" }));
  assert.equal(good.status, 303);
  assert.match(good.headers.get("location") ?? "", /^https:\/\/cinema\.example\/authorize\/session\//);

  const wrongResource = new URL(authorizeUrl(verifier));
  wrongResource.searchParams.set("resource", "https://evil.example/mcp");
  assert.equal((await oauth.handle(new Request(wrongResource))).status, 400);

  const wrongClient = new URL(authorizeUrl(verifier));
  wrongClient.searchParams.set("client_id", "https://evil.example/client.json");
  assert.equal((await oauth.handle(new Request(wrongClient))).status, 400);

  const unlistedSubdomain = new URL(authorizeUrl(verifier));
  unlistedSubdomain.searchParams.set("client_id", "https://oauth.chatgpt.com/client.json");
  assert.equal((await oauth.handle(new Request(unlistedSubdomain))).status, 400);

  const wrongRedirect = server(new MemoryOAuthStore(), clientMetadataFetch({ redirect_uris: ["https://chatgpt.com/other"] }));
  assert.equal((await wrongRedirect.oauth.handle(new Request(authorizeUrl(verifier)))).status, 400);
});

test("authorization session keeps credentials out of the Cinema server form boundary", async () => {
  const verifier = "v".repeat(64);
  const { oauth } = server();
  const authorize = await oauth.handle(new Request(authorizeUrl(verifier)));
  const location = authorize.headers.get("location");
  assert.ok(location);
  const page = await oauth.handle(new Request(location));
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /accounts:signInWithPassword/);
  assert.match(html, /not submitted to the Cinema MCP server/);
  assert.doesNotMatch(html, /ksawada127|mcp-runtime-test@gmail/i);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.equal(page.headers.get("x-frame-options"), "DENY");
});

test("authorization code is PKCE-bound and one-shot; refresh rotates and revocation invalidates access", async () => {
  const verifier = "v".repeat(64);
  const { oauth } = server();
  const authorize = await oauth.handle(new Request(authorizeUrl(verifier)));
  const sessionUrl = authorize.headers.get("location");
  assert.ok(sessionUrl);
  const handle = decodeURIComponent(new URL(sessionUrl).pathname.split("/").at(-1) ?? "");

  const complete = await oauth.handle(new Request(`${base}/authorize/complete`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ handle, idToken: firebaseToken() })
  }));
  assert.equal(complete.status, 200);
  const redirectTo = (await complete.json() as { redirectTo: string }).redirectTo;
  const code = new URL(redirectTo).searchParams.get("code");
  assert.ok(code);
  assert.equal(new URL(redirectTo).searchParams.get("state"), "state-123");

  const tokenForm = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    client_id: clientId,
    resource
  });
  const tokenResponse = await oauth.handle(new Request(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokenForm
  }));
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json() as { access_token: string; refresh_token: string; scope: string };
  assert.ok(tokens.access_token);
  assert.ok(tokens.refresh_token);
  assert.equal(tokens.scope, "mcp:tools offline_access");

  const authInfo = await oauth.accessTokenVerifier.verifyAccessToken(tokens.access_token);
  assert.equal(authInfo.clientId, clientId);
  assert.equal(authInfo.resource?.href, resource);
  assert.deepEqual(authInfo.extra, { uid: ownerUid });

  const secondCodeUse = await oauth.handle(new Request(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokenForm
  }));
  assert.equal(secondCodeUse.status, 400);
  assert.equal((await secondCodeUse.json() as { error: string }).error, "invalid_grant");

  const refreshForm = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: clientId,
    resource
  });
  const refreshed = await oauth.handle(new Request(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: refreshForm
  }));
  assert.equal(refreshed.status, 200);
  const rotated = await refreshed.json() as { access_token: string; refresh_token: string };
  assert.notEqual(rotated.refresh_token, tokens.refresh_token);

  const replayRefresh = await oauth.handle(new Request(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: refreshForm
  }));
  assert.equal(replayRefresh.status, 400);
  assert.equal((await replayRefresh.json() as { error: string }).error, "invalid_grant");

  await oauth.handle(new Request(`${base}/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: rotated.access_token })
  }));
  await assert.rejects(
    () => oauth.accessTokenVerifier.verifyAccessToken(rotated.access_token),
    (error: unknown) => error instanceof OAuthError
  );
});

test("wrong PKCE verifier consumes the authorization code and fails closed", async () => {
  const verifier = "v".repeat(64);
  const { oauth } = server();
  const authorize = await oauth.handle(new Request(authorizeUrl(verifier)));
  const sessionUrl = authorize.headers.get("location");
  assert.ok(sessionUrl);
  const handle = decodeURIComponent(new URL(sessionUrl).pathname.split("/").at(-1) ?? "");
  const complete = await oauth.handle(new Request(`${base}/authorize/complete`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ handle, idToken: firebaseToken() })
  }));
  const code = new URL((await complete.json() as { redirectTo: string }).redirectTo).searchParams.get("code");
  assert.ok(code);

  const bad = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: "w".repeat(64),
    redirect_uri: redirectUri,
    client_id: clientId,
    resource
  });
  const first = await oauth.handle(new Request(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: bad
  }));
  assert.equal(first.status, 400);
  const retry = new URLSearchParams(bad);
  retry.set("code_verifier", verifier);
  const second = await oauth.handle(new Request(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: retry
  }));
  assert.equal(second.status, 400);
});

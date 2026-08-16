import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  OAuthError,
  OAuthErrorCode,
  getOAuthProtectedResourceMetadataUrl,
  oauthMetadataResponse,
  type AuthInfo,
  type OAuthMetadata,
  type OAuthTokenVerifier
} from "@modelcontextprotocol/server";
import type { FirebaseAuthVerifier } from "./firebase-auth.js";
import type {
  CinemaOAuthStore,
  OAuthAuthorizationCodeRecord,
  OAuthAuthorizationRequestRecord,
  OAuthTokenRecord
} from "./oauth-store.js";

const RESOURCE_SCOPE = "mcp:tools";
const OFFLINE_SCOPE = "offline_access";
const SUPPORTED_SCOPES = new Set([RESOURCE_SCOPE, OFFLINE_SCOPE]);
const MAX_CLIENT_METADATA_BYTES = 64 * 1024;

export interface CinemaOAuthConfig {
  publicBaseUrl: string;
  firebaseWebApiKey: string;
  allowedFirebaseUids: string[];
  allowedClientHosts: string[];
  authorizationRequestTtlMs: number;
  authorizationCodeTtlMs: number;
  accessTokenTtlMs: number;
  refreshTokenTtlMs: number;
  clientMetadataTimeoutMs: number;
}

interface ClientMetadataDocument {
  client_id?: unknown;
  redirect_uris?: unknown;
  token_endpoint_auth_method?: unknown;
  token_endpoint_auth_methods_supported?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
}

interface ValidatedClientMetadata {
  clientId: string;
  redirectUris: string[];
  tokenAuthMethods: string[];
  grantTypes: string[];
  responseTypes: string[];
}

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  const output = new Headers(headers);
  output.set("content-type", "application/json; charset=utf-8");
  output.set("cache-control", "no-store");
  output.set("pragma", "no-cache");
  return Response.json(body, { status, headers: output });
}

function oauthError(error: string, status = 400, description?: string): Response {
  return jsonResponse({ error, ...(description ? { error_description: description } : {}) }, status);
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("MCP OAuth public base URL must be an HTTPS origin");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("MCP OAuth public base URL must not include a path");
  }
  return url.origin;
}

function hostAllowed(hostname: string, allowed: string[]): boolean {
  const host = hostname.toLowerCase();
  return allowed.some((entry) => host === entry.trim().toLowerCase());
}

function safeClientIdUrl(raw: string, allowedHosts: string[]): URL | undefined {
  if (!raw || raw.length > 2048) return undefined;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.port && url.port !== "443") ||
      !hostAllowed(url.hostname, allowedHosts)
    ) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function safeRedirectUri(raw: string): boolean {
  if (!raw || raw.length > 4096) return false;
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    const host = url.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
  return [...new Set(value as string[])];
}

function parseScopes(raw: string | null): string[] | undefined {
  const scopes = raw?.trim() ? [...new Set(raw.trim().split(/\s+/))] : [RESOURCE_SCOPE];
  if (!scopes.includes(RESOURCE_SCOPE)) return undefined;
  if (scopes.some((scope) => !SUPPORTED_SCOPES.has(scope))) return undefined;
  return scopes;
}

function validPkceChallenge(value: string): boolean {
  return /^[A-Za-z0-9_-]{43,128}$/.test(value);
}

function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

function authorizationErrorRedirect(redirectUri: string, state: string, error: string): Response {
  const callback = new URL(redirectUri);
  callback.searchParams.set("error", error);
  callback.searchParams.set("state", state);
  return Response.redirect(callback, 302);
}

function securityHeaders(nonce: string): Headers {
  return new Headers({
    "cache-control": "no-store",
    "pragma": "no-cache",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "content-security-policy": [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "connect-src https://identitytoolkit.googleapis.com",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'"
    ].join("; ")
  });
}

function authorizationPage(handle: string, firebaseWebApiKey: string): Response {
  const nonce = randomBytes(18).toString("base64url");
  const handleJson = JSON.stringify(handle);
  const apiKeyJson = JSON.stringify(firebaseWebApiKey);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize Japan Cinema MCP</title>
<style nonce="${nonce}">
:root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText}.card{width:min(420px,calc(100vw - 32px));box-sizing:border-box;border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:18px;padding:24px}.card h1{font-size:22px;margin:0 0 8px}.card p{line-height:1.45;margin:0 0 20px;opacity:.75}label{display:block;font-size:14px;margin:14px 0 6px}input{width:100%;box-sizing:border-box;padding:12px;border:1px solid color-mix(in srgb,CanvasText 25%,transparent);border-radius:10px;background:Canvas;color:CanvasText;font:inherit}button{width:100%;margin-top:18px;padding:12px;border:0;border-radius:999px;background:CanvasText;color:Canvas;font:600 16px inherit;cursor:pointer}button[disabled]{opacity:.45;cursor:default}.error{min-height:1.3em;color:#c62828;margin-top:12px;font-size:14px}.note{font-size:12px;margin-top:18px;opacity:.62}</style>
</head>
<body>
<main class="card">
<h1>Authorize Japan Cinema MCP</h1>
<p>Sign in with the existing MCP Runtime test account. New account creation is disabled.</p>
<label for="email">Email</label><input id="email" type="email" autocomplete="username" inputmode="email" required>
<label for="password">Password</label><input id="password" type="password" autocomplete="current-password" required>
<button id="submit" type="button">Authorize</button>
<div id="error" class="error" role="alert"></div>
<div class="note">Your password is sent directly from this browser to Firebase Authentication. It is not submitted to the Cinema MCP server.</div>
</main>
<script nonce="${nonce}">
const handle=${handleJson};const apiKey=${apiKeyJson};const button=document.getElementById('submit');const error=document.getElementById('error');
button.addEventListener('click',async()=>{error.textContent='';button.disabled=true;const email=document.getElementById('email').value.trim();const password=document.getElementById('password').value;try{const auth=await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key='+encodeURIComponent(apiKey),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password,returnSecureToken:true}),credentials:'omit',referrerPolicy:'no-referrer'});document.getElementById('password').value='';if(!auth.ok){error.textContent='Sign-in failed.';return;}const payload=await auth.json();if(!payload.idToken){error.textContent='Sign-in failed.';return;}const complete=await fetch('/authorize/complete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({handle,idToken:payload.idToken}),credentials:'omit',referrerPolicy:'no-referrer'});const result=await complete.json().catch(()=>({}));if(!complete.ok||!result.redirectTo){error.textContent='Authorization could not be completed.';return;}location.replace(result.redirectTo);}catch{error.textContent='Authorization service is unavailable.';}finally{button.disabled=false;}});
</script>
</body>
</html>`;
  const headers = securityHeaders(nonce);
  headers.set("content-type", "text/html; charset=utf-8");
  return new Response(html, { status: 200, headers });
}

export class CinemaOAuthAccessTokenVerifier implements OAuthTokenVerifier {
  private readonly allowedUids: Set<string>;

  constructor(
    private readonly store: CinemaOAuthStore,
    private readonly resourceUrl: string,
    allowedFirebaseUids: string[]
  ) {
    this.allowedUids = new Set(allowedFirebaseUids);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = await this.store.getAccessToken(token);
    if (
      !record ||
      !this.allowedUids.has(record.uid) ||
      record.resource !== this.resourceUrl ||
      !record.scopes.includes(RESOURCE_SCOPE)
    ) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, "Unknown, expired, or unauthorized access token");
    }
    return {
      token,
      clientId: record.clientId,
      scopes: [...record.scopes],
      expiresAt: Math.floor(record.expiresAt / 1000),
      resource: new URL(record.resource),
      extra: { uid: record.uid }
    };
  }
}

export class CinemaOAuthServer {
  readonly publicBaseUrl: string;
  readonly resourceUrl: string;
  readonly resourceMetadataUrl: string;
  readonly accessTokenVerifier: CinemaOAuthAccessTokenVerifier;
  readonly oauthMetadata: OAuthMetadata;
  private readonly allowedUids: Set<string>;
  private readonly clientCache = new Map<string, { expiresAt: number; metadata: ValidatedClientMetadata }>();

  constructor(
    private readonly config: CinemaOAuthConfig,
    private readonly store: CinemaOAuthStore,
    private readonly firebaseVerifier: FirebaseAuthVerifier,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.publicBaseUrl = normalizeOrigin(config.publicBaseUrl);
    this.resourceUrl = `${this.publicBaseUrl}/mcp`;
    this.resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(this.resourceUrl));
    this.allowedUids = new Set(config.allowedFirebaseUids);
    this.accessTokenVerifier = new CinemaOAuthAccessTokenVerifier(store, this.resourceUrl, config.allowedFirebaseUids);
    this.oauthMetadata = {
      issuer: this.publicBaseUrl,
      authorization_endpoint: `${this.publicBaseUrl}/authorize`,
      token_endpoint: `${this.publicBaseUrl}/token`,
      revocation_endpoint: `${this.publicBaseUrl}/revoke`,
      client_id_metadata_document_supported: true,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      response_types_supported: ["code"],
      scopes_supported: [RESOURCE_SCOPE, OFFLINE_SCOPE]
    };
  }

  isPath(pathname: string): boolean {
    return pathname === "/.well-known/oauth-authorization-server" ||
      pathname === "/.well-known/oauth-protected-resource" ||
      pathname === "/.well-known/oauth-protected-resource/mcp" ||
      pathname === "/authorize" ||
      pathname.startsWith("/authorize/session/") ||
      pathname === "/authorize/complete" ||
      pathname === "/token" ||
      pathname === "/revoke";
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const metadata = oauthMetadataResponse(request, {
      oauthMetadata: this.oauthMetadata,
      resourceServerUrl: new URL(this.resourceUrl),
      scopesSupported: [RESOURCE_SCOPE],
      resourceName: "Japan Cinema MCP"
    });
    if (metadata) return metadata;
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return jsonResponse({
        resource: this.resourceUrl,
        authorization_servers: [this.publicBaseUrl],
        scopes_supported: [RESOURCE_SCOPE],
        resource_name: "Japan Cinema MCP"
      });
    }
    if (url.pathname === "/authorize") return this.handleAuthorize(request);
    if (url.pathname.startsWith("/authorize/session/")) return this.handleAuthorizationSession(request);
    if (url.pathname === "/authorize/complete") return this.handleAuthorizationComplete(request);
    if (url.pathname === "/token") return this.handleToken(request);
    if (url.pathname === "/revoke") return this.handleRevoke(request);
    return oauthError("invalid_request", 404);
  }

  private async handleAuthorize(request: Request): Promise<Response> {
    if (request.method !== "GET") return oauthError("invalid_request", 405);
    const url = new URL(request.url);
    const clientId = url.searchParams.get("client_id") ?? "";
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    const state = url.searchParams.get("state") ?? "";
    const resource = url.searchParams.get("resource") ?? "";
    const challenge = url.searchParams.get("code_challenge") ?? "";
    if (
      url.searchParams.get("response_type") !== "code" ||
      url.searchParams.get("code_challenge_method") !== "S256" ||
      !state || state.length > 2048 ||
      !validPkceChallenge(challenge) ||
      resource !== this.resourceUrl
    ) return oauthError("invalid_request", 400);

    const clientUrl = safeClientIdUrl(clientId, this.config.allowedClientHosts);
    if (!clientUrl || !safeRedirectUri(redirectUri)) return oauthError("invalid_client", 400);

    let client: ValidatedClientMetadata;
    try {
      client = await this.fetchClientMetadata(clientUrl.href);
    } catch {
      return oauthError("invalid_client", 400);
    }
    if (!client.redirectUris.includes(redirectUri)) return oauthError("invalid_client", 400);
    if (!client.tokenAuthMethods.includes("none")) {
      return authorizationErrorRedirect(redirectUri, state, "unauthorized_client");
    }
    if (client.grantTypes.length > 0 && !client.grantTypes.includes("authorization_code")) {
      return authorizationErrorRedirect(redirectUri, state, "unauthorized_client");
    }
    if (client.responseTypes.length > 0 && !client.responseTypes.includes("code")) {
      return authorizationErrorRedirect(redirectUri, state, "unsupported_response_type");
    }

    const scopes = parseScopes(url.searchParams.get("scope"));
    if (!scopes) return authorizationErrorRedirect(redirectUri, state, "invalid_scope");

    const record: OAuthAuthorizationRequestRecord = {
      clientId: client.clientId,
      redirectUri,
      state,
      codeChallenge: challenge,
      scopes,
      resource: this.resourceUrl,
      expiresAt: Date.now() + this.config.authorizationRequestTtlMs
    };
    const handle = await this.store.createAuthorizationRequest(record);
    return Response.redirect(`${this.publicBaseUrl}/authorize/session/${encodeURIComponent(handle)}`, 303);
  }

  private async handleAuthorizationSession(request: Request): Promise<Response> {
    if (request.method !== "GET") return oauthError("invalid_request", 405);
    const url = new URL(request.url);
    const handle = decodeURIComponent(url.pathname.slice("/authorize/session/".length));
    if (!handle || !(await this.store.getAuthorizationRequest(handle))) {
      return new Response("Authorization request expired. Return to the MCP client and try again.", {
        status: 410,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
      });
    }
    return authorizationPage(handle, this.config.firebaseWebApiKey);
  }

  private async handleAuthorizationComplete(request: Request): Promise<Response> {
    if (request.method !== "POST") return oauthError("invalid_request", 405);
    if (request.headers.get("origin") !== this.publicBaseUrl) return oauthError("invalid_request", 403);
    let input: { handle?: unknown; idToken?: unknown };
    try {
      input = await request.json() as { handle?: unknown; idToken?: unknown };
    } catch {
      return oauthError("invalid_request", 400);
    }
    if (typeof input.handle !== "string" || typeof input.idToken !== "string") {
      return oauthError("invalid_request", 400);
    }

    const decision = await this.firebaseVerifier.verifyIdToken(input.idToken);
    if (!decision.allowed) {
      return oauthError(decision.code, decision.status === 503 ? 503 : 401);
    }
    const pending = await this.store.consumeAuthorizationRequest(input.handle);
    if (!pending) return oauthError("invalid_request", 410);

    const codeRecord: OAuthAuthorizationCodeRecord = {
      uid: decision.principal.uid,
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      scopes: [...pending.scopes],
      resource: pending.resource,
      expiresAt: Date.now() + this.config.authorizationCodeTtlMs
    };
    const code = await this.store.createAuthorizationCode(codeRecord);
    const callback = new URL(pending.redirectUri);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", pending.state);
    return jsonResponse({ redirectTo: callback.href });
  }

  private async handleToken(request: Request): Promise<Response> {
    if (request.method !== "POST") return oauthError("invalid_request", 405);
    if (request.headers.get("authorization")) return oauthError("invalid_client", 401);
    const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("application/x-www-form-urlencoded")) return oauthError("invalid_request", 400);

    const form = new URLSearchParams(await request.text());
    const grantType = form.get("grant_type");
    if (grantType === "authorization_code") return this.exchangeAuthorizationCode(form);
    if (grantType === "refresh_token") return this.exchangeRefreshToken(form);
    return oauthError("unsupported_grant_type", 400);
  }

  private async exchangeAuthorizationCode(form: URLSearchParams): Promise<Response> {
    const code = form.get("code") ?? "";
    const verifier = form.get("code_verifier") ?? "";
    const redirectUri = form.get("redirect_uri") ?? "";
    const clientId = form.get("client_id") ?? "";
    const resource = form.get("resource") ?? "";
    if (!code || !verifier || !redirectUri || !clientId || resource !== this.resourceUrl) {
      return oauthError("invalid_grant", 400);
    }
    const record = await this.store.consumeAuthorizationCode(code);
    if (
      !record ||
      record.clientId !== clientId ||
      record.redirectUri !== redirectUri ||
      record.resource !== resource ||
      !equalSecret(pkceS256(verifier), record.codeChallenge) ||
      !this.allowedUids.has(record.uid)
    ) return oauthError("invalid_grant", 400);
    return this.issueTokens(record);
  }

  private async exchangeRefreshToken(form: URLSearchParams): Promise<Response> {
    const refreshToken = form.get("refresh_token") ?? "";
    const clientId = form.get("client_id") ?? "";
    const resource = form.get("resource") ?? "";
    if (!refreshToken || !clientId || resource !== this.resourceUrl) return oauthError("invalid_grant", 400);
    const record = await this.store.consumeRefreshToken(refreshToken);
    if (
      !record ||
      record.clientId !== clientId ||
      record.resource !== resource ||
      !this.allowedUids.has(record.uid)
    ) return oauthError("invalid_grant", 400);

    const requested = form.get("scope")?.trim();
    let scopes = [...record.scopes];
    if (requested) {
      const subset = [...new Set(requested.split(/\s+/))];
      if (subset.some((scope) => !record.scopes.includes(scope)) || !subset.includes(RESOURCE_SCOPE)) {
        return oauthError("invalid_scope", 400);
      }
      scopes = subset;
    }
    return this.issueTokens({ ...record, scopes });
  }

  private async issueTokens(record: Pick<OAuthTokenRecord, "uid" | "clientId" | "scopes" | "resource">): Promise<Response> {
    const now = Date.now();
    const issued = await this.store.issueTokenPair({
      uid: record.uid,
      clientId: record.clientId,
      scopes: [...record.scopes],
      resource: record.resource,
      accessExpiresAt: now + this.config.accessTokenTtlMs,
      refreshExpiresAt: now + this.config.refreshTokenTtlMs
    });
    return jsonResponse({
      access_token: issued.accessToken,
      refresh_token: issued.refreshToken,
      token_type: "Bearer",
      expires_in: Math.floor(this.config.accessTokenTtlMs / 1000),
      scope: record.scopes.join(" ")
    });
  }

  private async handleRevoke(request: Request): Promise<Response> {
    if (request.method !== "POST") return oauthError("invalid_request", 405);
    const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("application/x-www-form-urlencoded")) return oauthError("invalid_request", 400);
    const form = new URLSearchParams(await request.text());
    const token = form.get("token") ?? "";
    if (token) await this.store.revokeToken(token);
    return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
  }

  private async fetchClientMetadata(clientId: string): Promise<ValidatedClientMetadata> {
    const cached = this.clientCache.get(clientId);
    if (cached && cached.expiresAt > Date.now()) return cached.metadata;

    const clientUrl = safeClientIdUrl(clientId, this.config.allowedClientHosts);
    if (!clientUrl) throw new Error("invalid client metadata URL");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.clientMetadataTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(clientUrl, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new Error("client metadata fetch failed");
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_CLIENT_METADATA_BYTES) {
      throw new Error("client metadata too large");
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_CLIENT_METADATA_BYTES) throw new Error("client metadata too large");
    let raw: ClientMetadataDocument;
    try {
      raw = JSON.parse(text) as ClientMetadataDocument;
    } catch {
      throw new Error("invalid client metadata JSON");
    }
    if (raw.client_id !== clientId) throw new Error("client metadata client_id mismatch");
    const redirectUris = stringArray(raw.redirect_uris);
    if (!redirectUris || redirectUris.length === 0 || redirectUris.some((uri) => !safeRedirectUri(uri))) {
      throw new Error("invalid client redirect URIs");
    }
    const supportedMethods = stringArray(raw.token_endpoint_auth_methods_supported);
    const singleMethod = typeof raw.token_endpoint_auth_method === "string" ? raw.token_endpoint_auth_method : undefined;
    const tokenAuthMethods = supportedMethods?.length ? supportedMethods : singleMethod ? [singleMethod] : [];
    const grantTypes = stringArray(raw.grant_types) ?? [];
    const responseTypes = stringArray(raw.response_types) ?? [];
    const metadata: ValidatedClientMetadata = {
      clientId,
      redirectUris,
      tokenAuthMethods,
      grantTypes,
      responseTypes
    };
    this.clientCache.set(clientId, { expiresAt: Date.now() + 5 * 60_000, metadata });
    return metadata;
  }

  async close(): Promise<void> {
    await this.store.close();
  }
}

export const cinemaOAuthResourceScope = RESOURCE_SCOPE;

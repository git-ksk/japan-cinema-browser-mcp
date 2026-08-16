# Cloud Run deployment

This document defines the bounded single-user remote runtime. Local stdio remains the default deployment model.

## Scope

The Cloud Run profile is intentionally narrow:

- single logical user / one allowlisted Firebase UID
- MCP OAuth 2.1 boundary for remote clients
- Firebase Authentication only for the Human authorization step
- headless dedicated Chromium
- read/navigation cinema workflows
- no external CDP attachment
- no purchase execution
- no remote Human Handoff
- no CAPTCHA, MFA, challenge, or anti-bot bypass
- no multi-user browser sharing

A cinema-site sign-in, consent, or access challenge fails closed. Use the local headed stdio runtime when manual cinema-site handoff is required.

## Runtime contract

Run the container with `node dist/index.js --http` and configure:

```text
CINEMA_REMOTE_MODE=true
CINEMA_HEADLESS=true
CINEMA_ENABLE_PURCHASE=false
MCP_HTTP_HOST=0.0.0.0
MCP_ALLOW_NONLOOPBACK=true
MCP_ALLOWED_HOSTS=<exact-service-hostname>
MCP_PUBLIC_BASE_URL=https://<exact-service-hostname>
MCP_OAUTH_ALLOWED_CLIENT_HOSTS=chatgpt.com
MCP_FIREBASE_PROJECT_ID=<firebase-project-id>
MCP_FIREBASE_WEB_API_KEY=<firebase-web-api-key>
MCP_ALLOWED_FIREBASE_UIDS=<single-owner-uid>
MCP_FIREBASE_LOOKUP_TIMEOUT_MS=5000
MCP_USAGE_REQUIRED=true
MCP_USAGE_FIRESTORE_PROJECT_ID=<gcp-project-id>
MCP_USAGE_DAILY_LIMIT=100
MCP_USAGE_LEASE_TTL_MS=300000
CINEMA_OPERATION_TIMEOUT_MS=60000
```

Optional OAuth lifetime controls default to:

```text
MCP_OAUTH_AUTHORIZATION_TTL_SECONDS=600
MCP_OAUTH_CODE_TTL_SECONDS=120
MCP_OAUTH_ACCESS_TTL_SECONDS=3600
MCP_OAUTH_REFRESH_TTL_DAYS=30
MCP_OAUTH_CLIENT_METADATA_TIMEOUT_MS=5000
```

Do not commit live project-specific configuration into this public repository. The Firebase Web API key identifies the Firebase project; it is not accepted as caller authorization by itself. OAuth access/refresh tokens, authorization codes, Firebase ID/refresh tokens, and passwords are credentials and must never be logged or committed.

## Remote authentication flow

The remote MCP endpoint is an OAuth Resource Server and the same origin exposes the bounded Authorization Server needed by supported MCP clients:

```text
MCP client
  -> Protected Resource Metadata
  -> Authorization Server metadata
  -> CIMD client metadata validation
  -> /authorize with PKCE S256 + exact resource
  -> Human enters existing Firebase email/password in browser
  -> browser sends password directly to Firebase Authentication
  -> browser sends only the resulting Firebase ID Token to /authorize/complete
  -> Cinema verifies Firebase UID against the single-owner allowlist
  -> one-shot authorization code
  -> /token issues resource-bound OAuth access + rotating refresh token
  -> /mcp validates scope/resource/expiry and restores the Firebase UID principal
```

The Cinema server never receives the Firebase password. It receives a short-lived Firebase ID Token only at authorization completion and does not persist it.

CIMD client identifiers are accepted only from the explicitly configured HTTPS host allowlist. The fetched metadata must contain the exact `client_id`, and the requested `redirect_uri` must exactly match one of the metadata document's registered redirect URIs. Redirect following is disabled for the metadata fetch.

Dynamic Client Registration is not exposed by this profile. The advertised public-client token endpoint authentication method is `none`, with PKCE S256 mandatory for authorization-code exchange.

OAuth control-plane records use Firestore. Random authorization-request handles, codes, access tokens, and refresh tokens are never stored raw: their SHA-256 values are used as document identities. Authorization requests/codes are one-shot, refresh tokens rotate on use, and expired records are removed best-effort.

## Endpoints

- `GET /health` — passive unauthenticated liveness; does not start Chromium
- `GET /.well-known/oauth-protected-resource/mcp` — Protected Resource Metadata
- `GET /.well-known/oauth-authorization-server` — Authorization Server Metadata
- `GET /authorize` — starts OAuth authorization after CIMD/resource/PKCE validation
- `POST /authorize/complete` — consumes a verified Firebase identity and creates a one-shot authorization code
- `POST /token` — authorization-code or refresh-token exchange
- `POST /revoke` — token revocation
- `GET /ready` — OAuth-authenticated browser readiness
- `POST /mcp` — OAuth-authenticated Streamable HTTP MCP endpoint

`/mcp` and `/ready` require the `mcp:tools` scope. `offline_access` is advertised by the Authorization Server for refresh-capable sessions but is not advertised by the Protected Resource Metadata as a resource scope.

Cloud Run reserves some paths ending in `z`; the deployment therefore uses `/health` and `/ready`, not `healthz` / `readyz`.

## MCP usage control

Remote browser tools use vendored `mcp-usage-control` v0.4.0 with the Firestore adapter.

Lifecycle:

```text
OAuth access token
  -> recover allowlisted Firebase UID principal
  -> derive opaque principal binding
  -> reserve 1 unit
  -> mark liable
  -> execute browser operation
  -> settle completed/error
```

The default budget is 100 metered browser operations per UTC day for each allowed Firebase UID. Budget and reservation updates are Firestore transactions. Identifiers are hashed by the usage adapter before becoming document IDs; raw credentials and cinema page content are not usage metadata.

Static OAuth metadata, token-control requests, and passive liveness are not counted as browser operations.

## Free-tier-oriented deployment profile

The recommended low-traffic profile is:

```text
region: us-central1
billing: request-based / CPU throttling enabled
startup CPU boost: disabled
CPU: 1
memory: 2 GiB
concurrency: 1
min instances: 0
max instances: 1
request timeout: 240 seconds
browser operation timeout: 60 seconds per explicit provider target
find_showtimes aggregate timeout: 185 seconds for three targets
daily metered browser operations: 100
```

`2 GiB` is intentional. Live Cloud Run validation on 2026-08-16 observed Chromium crossing the previous 1 GiB limit (1047 MiB used), which terminated the browser process during provider reads. Do not reduce memory without measuring browser reliability under the three-provider workflow.

The longer HTTP request envelope does **not** make provider reads unbounded. `CINEMA_OPERATION_TIMEOUT_MS` remains the per-provider semantic budget. `find_showtimes` runs at most three explicit targets sequentially, isolates a timed-out target, and gives each target its full bounded provider budget before the aggregate envelope can fire. With the recommended 60-second provider budget, three targets are bounded to 185 seconds of browser work. The 240-second HTTP timeout leaves room for cold Chromium startup plus OAuth/usage-control work so a structured partial result can reach the MCP client instead of being cut off by transport cancellation.

`MCP_USAGE_LEASE_TTL_MS=300000` intentionally exceeds the maximum recommended browser-work envelope. Usage admission and `markLiable()` still happen before browser work; post-liability settlement is best-effort accounting and cannot erase the charged reservation if a lease expires.

The daily usage budget is an application guardrail, not a billing hard cap. Cloud Run health/startup work, OAuth metadata/token traffic, image storage, build minutes, and authenticated unmetered control calls remain separate. Keep billing alerts enabled and inspect actual usage.

Keep only the actively deployed container image where practical. Chromium makes the image materially larger than an API-only service.

## Identity boundary

Firebase Authentication remains the source of Human identity. During `/authorize`, the browser authenticates directly with Firebase; Cinema validates the resulting ID Token through the Firebase Auth backend, re-checks project/issuer/subject/time claims and the user's `validSince` boundary, and allows only the configured owner UID.

After OAuth exchange, the Resource Server accepts only Cinema-issued OAuth access tokens. The token record remains bound to the originating Firebase UID, OAuth client ID, exact MCP resource, scope set, and expiration. The UID is then used to derive the same logical principal used by MCPUsage and handoff ownership.

This is **not** multi-user browser isolation. Adding more allowed UIDs without principal-specific browser/profile/runtime isolation is prohibited. A future multi-user deployment must isolate browser/profile state per authenticated principal before expanding the allowlist.

## Chromium sandbox

The container installs `chromium-sandbox` and keeps Chromium sandboxing enabled by default. If a verified Cloud Run runtime incompatibility prevents startup, `CINEMA_ALLOW_UNSANDBOXED_CHROMIUM=true` exists as an explicit compatibility fallback. Do not enable it pre-emptively.

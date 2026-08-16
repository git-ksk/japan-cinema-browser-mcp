# Cloud Run deployment

This document defines the bounded single-user remote runtime. Local stdio remains the default deployment model.

## Scope

The Cloud Run profile is intentionally narrow:

- single logical user / one allowlisted Firebase UID
- headless dedicated Chromium
- read/navigation cinema workflows
- no external CDP attachment
- no purchase execution
- no remote Human Handoff
- no CAPTCHA, MFA, challenge, or anti-bot bypass
- no multi-user browser sharing

A sign-in, consent, or access challenge fails closed. Use the local headed stdio runtime when manual handoff is required.

## Runtime contract

Run the container with `node dist/index.js --http` and configure:

```text
CINEMA_REMOTE_MODE=true
CINEMA_HEADLESS=true
CINEMA_ENABLE_PURCHASE=false
MCP_HTTP_HOST=0.0.0.0
MCP_ALLOW_NONLOOPBACK=true
MCP_ALLOWED_HOSTS=<exact-service-hostname>
MCP_FIREBASE_PROJECT_ID=<firebase-project-id>
MCP_FIREBASE_WEB_API_KEY=<firebase-web-api-key>
MCP_ALLOWED_FIREBASE_UIDS=<single-owner-uid>
MCP_FIREBASE_LOOKUP_TIMEOUT_MS=5000
MCP_USAGE_REQUIRED=true
MCP_USAGE_FIRESTORE_PROJECT_ID=<gcp-project-id>
MCP_USAGE_DAILY_LIMIT=100
MCP_USAGE_LEASE_TTL_MS=60000
CINEMA_OPERATION_TIMEOUT_MS=30000
```

The Firebase Web API key identifies the Firebase project and is not accepted as caller authorization by itself. Do not commit live project-specific configuration into this public repository. Firebase ID Tokens and refresh tokens are credentials and must not be logged or committed. Remote mode requires an explicit Firebase project, Web API key, and non-empty allowed UID list.

Endpoints:

- `GET /health` — passive unauthenticated liveness; does not start Chromium
- `GET /ready` — Firebase ID Token-authenticated browser readiness
- `POST /mcp` — Firebase ID Token-authenticated Streamable HTTP MCP endpoint

Cloud Run reserves some paths ending in `z`; the deployment therefore uses `/health` and `/ready`, not `healthz` / `readyz`.

## MCP usage control

Remote browser tools use vendored `mcp-usage-control` v0.4.0 with the Firestore adapter.

Lifecycle:

```text
Firebase-authenticated UID
  -> derive opaque principal binding
  -> reserve 1 unit
  -> mark liable
  -> execute browser operation
  -> settle completed/error
```

The default budget is 100 metered browser operations per UTC day for each allowed Firebase UID. Budget and reservation updates are Firestore transactions. Identifiers are hashed by the usage adapter before becoming document IDs; raw credentials and cinema page content are not usage metadata.

Static metadata and passive liveness are not counted as browser operations.

## Free-tier-oriented deployment profile

The recommended low-traffic profile is:

```text
region: us-central1
billing: request-based / CPU throttling enabled
startup CPU boost: disabled
CPU: 1
memory: 1 GiB
concurrency: 1
min instances: 0
max instances: 1
request timeout: 60 seconds
browser operation timeout: 30 seconds
daily metered browser operations: 100
```

`1 GiB` is intentional: Chromium needs more working room than a typical API-only Node process. Do not reduce memory merely to make the nominal configuration smaller without measuring browser reliability.

The daily usage budget is an application guardrail, not a billing hard cap. Cloud Run health/startup work, image storage, build minutes, and authenticated unmetered control calls remain separate. Keep billing alerts enabled and inspect actual usage.

Keep only the actively deployed container image where practical. Chromium makes the image materially larger than an API-only service.

## Identity boundary

The Phase 3 deployment validates Firebase ID Tokens through the Firebase Auth backend, re-checks project/issuer/subject/time claims and the user's `validSince` revocation boundary, then binds the Firebase UID to the MCP principal. The Cloud Run profile still allowlists one owner UID because one process owns one browser/profile.

This is **not** multi-user browser isolation. Adding more allowed UIDs without principal-specific browser/profile/runtime isolation is prohibited. A future multi-user deployment must isolate browser/profile state per authenticated principal before expanding the allowlist.

## Chromium sandbox

The container installs `chromium-sandbox` and keeps Chromium sandboxing enabled by default. If a verified Cloud Run runtime incompatibility prevents startup, `CINEMA_ALLOW_UNSANDBOXED_CHROMIUM=true` exists as an explicit compatibility fallback. Do not enable it pre-emptively.

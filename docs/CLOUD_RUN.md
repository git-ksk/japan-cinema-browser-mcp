# Cloud Run deployment

This document defines the bounded single-user remote runtime. Local stdio remains the default deployment model.

## Scope

The Cloud Run profile is intentionally narrow:

- single logical user / one bearer credential
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
MCP_BEARER_TOKEN=<secret-manager-injected-value>
MCP_USAGE_REQUIRED=true
MCP_USAGE_FIRESTORE_PROJECT_ID=<gcp-project-id>
MCP_USAGE_DAILY_LIMIT=100
MCP_USAGE_LEASE_TTL_MS=60000
CINEMA_OPERATION_TIMEOUT_MS=30000
```

Do not commit `MCP_BEARER_TOKEN`. The server requires a non-whitespace bearer value of at least 32 characters before non-loopback or remote mode can start.

Endpoints:

- `GET /health` — passive unauthenticated liveness; does not start Chromium
- `GET /ready` — bearer-authenticated browser readiness
- `POST /mcp` — bearer-authenticated Streamable HTTP MCP endpoint

Cloud Run reserves some paths ending in `z`; the deployment therefore uses `/health` and `/ready`, not `healthz` / `readyz`.

## MCP usage control

Remote browser tools use vendored `mcp-usage-control` v0.4.0 with the Firestore adapter.

Lifecycle:

```text
authenticated principal
  -> reserve 1 unit
  -> mark liable
  -> execute browser operation
  -> settle completed/error
```

The default budget is 100 metered browser operations per UTC day for the single bearer principal. Budget and reservation updates are Firestore transactions. Identifiers are hashed by the usage adapter before becoming document IDs; raw credentials and cinema page content are not usage metadata.

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

The Phase 3 deployment uses one high-entropy application bearer as its logical principal. It is **not** a multi-user identity system.

Future Firebase Auth or another end-user identity provider must replace the static principal with an authenticated stable non-secret subject and must add principal-specific browser/profile isolation before multi-user hosting is enabled.

## Chromium sandbox

The container installs `chromium-sandbox` and keeps Chromium sandboxing enabled by default. If a verified Cloud Run runtime incompatibility prevents startup, `CINEMA_ALLOW_UNSANDBOXED_CHROMIUM=true` exists as an explicit compatibility fallback. Do not enable it pre-emptively.

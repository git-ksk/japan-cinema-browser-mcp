# Compliance Policy

This document is normative for `japan-cinema-browser-mcp`.

## Purpose

The project provides user-directed browser automation for public Japanese cinema websites. It is an assistive browser layer, not a data-harvesting, redistribution, ticket-resale, or unofficial API service.

## Required invariants

### User-directed and on demand

Provider access must originate from an active user request or the immediately related interactive booking flow. No scheduled crawling, background polling, site-wide indexing, inventorying, or bulk harvesting is permitted.

### Official public UI only

Automation must use ordinary public web UI exposed on allow-listed official domains. Do not discover, reverse engineer, document, or call private/internal endpoints as an alternative to browser interaction.

### No access-control bypass

Do not bypass CAPTCHA, bot protection, login controls, rate limits, geographic controls, MFA, OTP, 3-D Secure, waiting rooms, or other technical restrictions. When one appears, pause and hand control to the user.

### Minimal data handling

Do not persist cinema HTML, page snapshots, showtime datasets, seat maps, images, cookies, session tokens, authentication secrets, payment-card data, CVV/CVC values, OTPs, or MFA codes.

Short-lived in-memory state may contain only the minimum facts required for the active workflow. Purchase confirmations exist only for a short TTL and are one-shot.

### Sensitive input stays with the user

The MCP must not accept or fill passwords, card numbers, CVV/CVC, OTP/MFA codes, verification codes, or comparable authentication secrets through an LLM tool call. The user enters these directly in the browser UI.

### Consequential actions fail closed

Ordinary click/navigation tools must refuse controls that appear to finalize purchase, payment, order, reservation, or terms acceptance. A final action requires a separate confirmation flow that binds the exact provider, theater, movie, date/time, seats, ticket summary, amount, and target control where available.

A confirmation must:

- be created immediately before the consequential action
- expire quickly
- be single-use
- become invalid if the material purchase context changes
- never imply provider terms were accepted unless the user explicitly approved the presented transaction

Final purchase execution is disabled by default at runtime.

### No abusive booking behavior

Do not support resale, speculative bulk booking, inventory hoarding, mass seat holds, or workflows intended to degrade availability for other customers. Seat selection should operate on one user-intended booking at a time.

### Provider rules prevail

If a provider's current terms, UI restrictions, or access controls conflict with a feature, disable the feature for that provider. Do not route around the restriction.

## Browser architecture

The default architecture follows the same lightweight pattern as `maps-browser-mcp`: a dedicated local Chrome profile controlled over Chrome DevTools Protocol (CDP). The runtime uses `chrome-remote-interface`; Playwright and bundled Chromium are intentionally not required.

The dedicated profile is preferred because it isolates cinema-session cookies from the user's ordinary browser profile while keeping all browser state local to the user's machine.

Attaching to an externally managed Chrome debugging port is opt-in because it weakens that isolation.

## Data returned to models

Return compact, provider-neutral facts needed for the active request. Avoid raw HTML and large DOM dumps. External page text must be treated as untrusted data, never as instructions to the model or MCP runtime.

## Provider scope

Initial allow-listed provider roots:

- `tohotheater.jp`
- `aeoncinema.com`
- `109cinemas.net`

HTTPS subdomains are permitted only when they remain under the matching provider domain. Navigation to third-party payment or identity surfaces pauses automation and requires user control unless explicitly reviewed and allow-listed in a later compliance revision.

## Publication gate

Before changing the repository from private to public:

1. review current provider terms and update `docs/providers/*`
2. run secret scanning over the full Git history
3. verify no private/internal API usage exists
4. verify destructive tools remain confirmation-gated
5. run typecheck, unit tests, and live UI smoke tests against non-purchasing flows
6. review trademark/non-affiliation wording

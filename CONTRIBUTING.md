# Contributing

Thanks for helping improve `japan-cinema-browser-mcp`.

This project intentionally keeps a narrow safety boundary: it automates reviewed public cinema browser UI through Chrome + direct CDP, and it fails closed when a provider surface or workflow is not explicitly reviewed.

## Before opening a change

- Search existing issues and pull requests first.
- Use a public issue for normal bugs, documentation, and feature requests.
- Do **not** post vulnerabilities, credentials, cookies, session tokens, payment details, private browsing data, or screenshots containing sensitive information in a public issue. Use GitHub Private Vulnerability Reporting instead; see `.github/SECURITY.md`.
- Provider terms, site policy, and UI behavior can change independently of this repository. Do not describe provider compatibility as legal approval or endorsement.

## Development setup

Requirements:

- Node.js 20 or newer
- npm
- Chrome or Chromium for provider live-smoke testing

Install from the lockfile:

```bash
npm ci --ignore-scripts
```

Run the required local checks:

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

The normal test suite must not require live provider access.

## Safety invariants

Changes must preserve these boundaries unless a separate, explicit security review changes the documented capability:

- Chrome + direct CDP; do not add network interception as a shortcut.
- Rendered public UI only; do not discover or call private/internal APIs or hidden JSON endpoints.
- Do not guess provider slugs, private routes, or query values when the public UI does not provide them.
- Do not bypass CAPTCHA, access challenges, MFA, OTP, 3-D Secure, waiting rooms, or other human/security controls.
- Treat provider page text and external place labels as untrusted data, never as instructions.
- Keep provider-specific reviewed DOM knowledge inside the provider adapter rather than widening a generic parser.
- Disabled provider capabilities must not be recovered through generic fuzzy navigation, click, or fill fallbacks.
- `seatMap`, `seatSelection`, `checkoutPreparation`, and `purchaseSubmission` are currently disabled for every provider.
- Preserve one-shot/TTL purchase confirmation and the no-auto-replay rule for ambiguous purchase outcomes.
- Preserve Execution Handoff owner/requestState binding and resource-epoch fencing. Human completion must never become approval for a different action.
- Keep semantic mutation and transaction/payment handoff at `never_replay`; do not change them to automatic replay.
- Keep the pre-release `mcp-execution-handoff` dependency pinned to an immutable commit until a release decision is made.
- Do not add credential, Cookie, localStorage, sessionStorage, Authorization-header, or payment-data dump paths.

Local process configuration such as `CINEMA_CHROME_EXECUTABLE`, `CINEMA_CHROME_PROFILE_DIR`, and explicit external-CDP opt-in is trusted operator configuration. It must never be populated from MCP tool arguments, provider pages, or other untrusted external input.

## Provider changes

For TOHO, AEON, or 109 changes:

1. Reproduce against the rendered public UI.
2. Add or update a regression test before widening the implementation.
3. Prefer an explicit reviewed positive allow-list over a growing deny-list.
4. Preserve navigation-after-identity verification and fail-closed behavior.
5. Do not add speculative fallback selectors merely to make a live smoke pass.
6. Update `docs/PROVIDERS.md` and the relevant `docs/providers/*.md` when the reviewed surface or assumptions change.

Live smoke tests are intentionally manual and non-purchasing:

```bash
npm run smoke:toho
npm run smoke:aeon
npm run smoke:109
```

Run only the provider smoke tests relevant to the change unless a wider regression check is warranted. Do not put purchase, seat-hold, login, or high-frequency provider traffic into CI.

## Pull requests

`main` is protected. Changes go through pull requests and are squash-merged after required checks pass.

Keep pull requests focused. The PR body should state:

- what changed and why;
- which safety boundary or provider surface is affected;
- tests run locally;
- whether a live provider smoke was run, and why;
- documentation updated;
- any remaining uncertainty or provider-policy risk.

A green CI result proves repository tests/builds passed; it does not prove provider terms permit every possible use, nor does it replace provider-specific live review.

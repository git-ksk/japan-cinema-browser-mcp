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
- `seatMap` is currently enabled for TOHO / AEON / 109. `seatSelection`, `checkoutPreparation`, and `purchaseSubmission` remain disabled for every provider unless a separate provider-specific review changes them.
- Preserve one-shot/TTL purchase confirmation and the no-auto-replay rule for ambiguous purchase outcomes.
- Preserve Execution Handoff owner/requestState binding and resource-epoch fencing. Human completion must never become approval for a different action.
- Keep semantic mutation and transaction/payment handoff at `never_replay`; do not change them to automatic replay.
- Keep purchaser PII/contact fields, credentials, consent, and payment surfaces Human-only unless a separate explicit security/compliance review changes that documented boundary.
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

## Versioning, releases, and milestones

This repository uses Semantic Versioning as the compatibility model, with an explicit project policy for the `0.x` initial-development period.

### Public compatibility contract

Version compatibility is evaluated against the repository's documented public surface, including:

- MCP tool names and documented availability;
- tool input schemas;
- tool output schemas and documented field semantics;
- documented error codes and error semantics;
- documented provider capability states;
- supported remote authentication/discovery interfaces;
- documented operator-facing configuration and runtime requirements for supported deployment modes.

Internal selectors, implementation structure, logging detail, tests, and non-contractual diagnostics are not public API by themselves. A change to an internal detail is still compatibility-relevant if it changes one of the documented behaviors above.

### Version selection during `0.x`

During initial development, this project deliberately applies stricter release rules than SemVer requires for `0.x`:

- **patch (`0.x.Y`)** — backward-compatible bug fixes, security fixes, performance improvements, and reliability improvements that do not change the public compatibility contract;
- **minor (`0.X.0`)** — new tools, capabilities, provider functionality, supported deployment behavior, or any breaking change to the public compatibility contract;
- documentation, tests, CI, and internal refactors alone normally do not require a release.

A security fix is not automatically a patch: if the safe fix requires a breaking public-contract change during `0.x`, it requires a minor bump. After `1.0.0`, normal SemVer rules apply: backward-compatible fixes are patch, backward-compatible features are minor, and breaking public-contract changes are major.

The next version is chosen from the **entire cumulative diff from the previous release tag to the release candidate**, not from the type of the final PR. The highest required bump in that cumulative diff wins. For example, a feature followed by several bug fixes still produces a minor release.

### Deployments and releases are separate

A production deployment from `main` does not by itself create a package or GitHub release. `main` may be deployed for validation or operational fixes while `package.json`, tags, and the latest GitHub Release remain at the previous released version.

Version bumps, release-note finalization, tags, and GitHub Releases are release activities and should be performed together through an explicit release change. Ordinary feature and bug-fix PRs must not opportunistically bump the package version.

If an older supported release needs a security or critical fix while `main` already contains a higher-level change, use a dedicated release/backport branch rather than mis-versioning the cumulative `main` diff.

### Release notes and publication

GitHub Releases are the canonical release-note history for this repository. A separate `CHANGELOG.md` is not required while the project remains small enough for GitHub Releases to provide a clear chronological record; introduce one only when maintaining a second changelog adds concrete value.

Each release note should summarize user-visible capabilities, compatibility or safety-relevant changes, and the current transaction-capability boundary. Source releases do **not** imply npm publication. npm publication remains a separate explicit decision and must not be performed merely because a Git tag or GitHub Release is created.

### GitHub Milestones and Roadmap

`docs/ROADMAP.md` describes long-term product phases and capability direction. GitHub Milestones, when used, represent a concrete **target release version** such as `v0.2.0`.

Prefer one active next-release milestone when there is enough release scope to benefit from grouping. Issues intended for that release should be assigned to it; unrelated future work stays in the Roadmap/backlog. A Roadmap phase does not automatically imply a release version, and a release milestone does not replace the Roadmap.

GitHub Projects are optional workflow visualization and are not required for the repository's Issue → PR → required checks → squash merge process.
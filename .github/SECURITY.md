# Security Policy

## Supported versions

Security fixes are currently made on the latest `main` branch. There is no separate long-term-support release line yet.

## Reporting a vulnerability

Please do not publish exploit details, credentials, private browsing data, or other sensitive material in a public issue.

For vulnerabilities in this repository, use GitHub Private Vulnerability Reporting. From the repository's **Security** tab, choose **Advisories** and **Report a vulnerability**. Do not use a public issue for vulnerability details.

If GitHub's private reporting UI is temporarily unavailable, contact the maintainer through the GitHub account associated with this repository and ask for a private reporting channel before sending sensitive details. A public issue may be used only to request contact, without vulnerability details.

A useful report includes the affected commit/version, the impacted MCP tool or provider flow, reproduction steps, expected versus observed behavior, and whether the issue can cross the documented browser, provider, capability, secret, or purchase-confirmation boundaries.

## Security boundaries

The project intentionally uses rendered public cinema web UI through Chrome + direct CDP. It does not rely on private/internal APIs, hidden JSON endpoints, network interception, Cookie/token dumps, or CAPTCHA/challenge bypasses.

Provider capabilities are fail-closed. Seat map, seat selection, checkout preparation, and purchase submission are currently disabled for all providers. Generic navigation is limited to reviewed public read surfaces; generic click/fill must not bypass disabled provider capabilities. Final purchase, if enabled in a future reviewed implementation, remains behind the separate one-shot, short-TTL confirmation flow. Human-only browser state uses Execution Handoff with exclusive Agent/Human authority, exact invocation/request-state binding, resource-epoch fencing, and consumer-defined replay policy. Human completion is not transaction approval, and any new Human intervention invalidates prepared purchase confirmation state.

See `docs/SECURITY.md`, `COMPLIANCE.md`, and `docs/PROVIDERS.md` for the detailed threat model and provider-specific review boundaries.

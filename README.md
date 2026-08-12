# japan-cinema-browser-mcp

Browser-first MCP server for interacting with Japanese cinema websites on behalf of the user.

Initial providers:

- TOHO Cinemas
- AEON Cinema
- 109 Cinemas

## Positioning

This project is **not** a cinema-data aggregation service. It automates the same public web UI a user can operate in their own browser, on demand.

Core rules:

- browser UI first; do not reverse engineer or call private/internal APIs
- only official cinema domains are navigable
- no scheduled crawling or cinema-wide aggregation
- no persistent storage of showtimes, seat maps, HTML, images, cookies, or payment data
- authentication, CAPTCHA, MFA, and 3-D Secure stay under user control
- checkout-changing actions fail closed
- final purchase actions are disabled by default and require an explicit one-shot confirmation gate when enabled
- provider terms and access restrictions take precedence over this project
- keep the runtime lightweight: reuse one Chrome session and return compact structured facts instead of raw DOM/HTML

See [COMPLIANCE.md](./COMPLIANCE.md) for the normative policy.

## Architecture

The browser layer follows the same lightweight pattern as `maps-browser-mcp`:

```text
MCP client
   |
   | stdio
   v
japan-cinema-browser-mcp
   |
   | Chrome DevTools Protocol (CDP)
   v
Dedicated local Google Chrome
   |
   +-- TOHO Cinemas
   +-- AEON Cinema
   +-- 109 Cinemas
```

There is no Playwright dependency and no bundled Chromium download. Browser control uses `chrome-remote-interface` directly against installed Chrome/Chromium.

## Status

Early private MVP. The current implementation provides:

- a reusable local Chrome/CDP session
- reviewed official-domain navigation
- bounded visible-page reading
- provider-neutral showtime candidate extraction
- visible control interaction with ambiguity checks
- sensitive-field refusal
- a short-lived, URL-bound, one-shot purchase confirmation gate

Provider-specific semantic booking adapters are the next layer and will be added only after each current public UI is validated.

## Requirements

- Node.js 20+
- npm
- Google Chrome installed on the Mac

```bash
npm install
npm run build
npm start
```

The server uses stdio and logs only to stderr.

## Browser modes

### Default: dedicated Chrome profile

No browser configuration is needed. The MCP finds installed Chrome, starts it once, and reuses a dedicated persistent profile at:

```text
~/.japan-cinema-browser-mcp/chrome-profile
```

This keeps cinema login/session state local and isolated from the user's normal Chrome profile.

### Optional: attach to an existing local CDP port

This is opt-in because it weakens profile isolation:

```bash
CINEMA_ALLOW_EXTERNAL_CDP=true \
CINEMA_CDP_PORT=9222 \
npm start
```

The MCP only connects to loopback CDP (`127.0.0.1`).

### Final purchase execution

Disabled by default:

```bash
CINEMA_ENABLE_PURCHASE=true npm start
```

Enabling this flag does **not** bypass the confirmation gate. The exact provider/page and transaction summary must first be bound by `prepare_purchase_confirmation`; the token expires quickly and can be used only once.

## Tools

- `list_cinema_providers` — provider definitions and official roots
- `browser_status` — current Chrome/CDP session and provider surface
- `open_cinema_provider` — open an official provider root
- `navigate_cinema_official` — navigate only within reviewed official domains
- `read_cinema_page` — bounded visible-text snapshot; no raw HTML persistence
- `extract_showtime_candidates` — visible HH:MM candidates plus short context
- `click_cinema_control` — click one unique visible link/button; final actions are blocked
- `fill_cinema_field` — fill one non-sensitive field; auth/payment secrets are blocked
- `prepare_purchase_confirmation` — bind current URL and material transaction summary
- `confirm_purchase_action` — consequential one-shot final action, disabled by default
- `close_browser_session` — close MCP-owned Chrome; externally managed Chrome is left running

## Safety model

The runtime fails closed:

1. **Domain guard** — only HTTPS pages under `tohotheater.jp`, `aeoncinema.com`, and `109cinemas.net` are automatable.
2. **Visible-UI guard** — operations target ordinary visible controls; no private/internal API path exists in the architecture.
3. **Sensitive-data guard** — password, card number, CVV/CVC, OTP/MFA, verification-code and similar fields are rejected.
4. **Challenge guard** — visible CAPTCHA/challenge surfaces stop automation for human handling.
5. **Purchase guard** — normal click tools cannot click final purchase/payment/booking controls.
6. **State guard** — purchase confirmation is bound to the exact current URL; navigation invalidates it.

If a target is missing, ambiguous, sensitive, changed, or outside the reviewed surface, the server returns an error instead of guessing.

## Performance model

- only three runtime dependencies: MCP server SDK, `chrome-remote-interface`, and Zod
- one long-lived Chrome/controller per MCP process
- no browser launch per tool call
- no browser binary bundled or downloaded by the package
- system Google Chrome reused locally
- bounded visible-text reads instead of DOM/HTML dumps
- compact provider-neutral JSON
- no background polling, crawling, or indexing
- provider-specific semantic selectors will replace generic scanning on validated flows

## Compliance

See:

- [COMPLIANCE.md](./COMPLIANCE.md)
- [docs/PROVIDERS.md](./docs/PROVIDERS.md)

Before public release, current provider terms, live UI behavior, full Git history, secrets, destructive-action gates, and non-affiliation wording must be reviewed again.

## Development

```bash
npm run typecheck
npm test
npm run build
```

## Non-affiliation

This project is not affiliated with, endorsed by, or sponsored by TOHO Cinemas, AEON Cinema, 109 Cinemas, or their parent companies. Provider names are used only to identify interoperability targets.

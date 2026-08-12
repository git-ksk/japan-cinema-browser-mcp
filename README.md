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

See [COMPLIANCE.md](./COMPLIANCE.md) for the normative policy.

## Status

Early private MVP. The current implementation provides a constrained local browser session, official-domain navigation, page reading, visible control interaction, basic showtime extraction, and a purchase confirmation state machine. Provider-specific booking adapters are intentionally added only after their current public UI has been validated.

## Requirements

- Node.js 20+
- npm
- Chromium installed through Playwright

```bash
npm install
npx playwright install chromium
npm run build
```

## Run

```bash
npm start
```

The server uses stdio and logs only to stderr.

By default it launches a headed local Chromium profile under `.runtime/browser-profile`. The user can log in normally in that browser window. To connect to an already-running Chromium instance instead, set:

```bash
CINEMA_BROWSER_CDP_URL=http://127.0.0.1:9222 npm start
```

Final purchase actions remain disabled unless explicitly enabled:

```bash
CINEMA_ENABLE_PURCHASE=true npm start
```

Enabling that flag does **not** bypass the one-shot confirmation gate.

## Tools

- `list_cinema_providers` — provider capabilities and official roots
- `open_cinema_provider` — open the official provider site
- `navigate_cinema_official` — navigate only inside an allowed official domain
- `read_cinema_page` — return a bounded visible-text snapshot; nothing is persisted
- `extract_showtime_candidates` — extract likely HH:MM showtime candidates from the current page
- `click_cinema_control` — click a visible link/button; final-purchase-looking controls are blocked
- `fill_cinema_field` — fill a non-sensitive field by label/placeholder
- `prepare_purchase_confirmation` — bind provider/theater/movie/time/seats/amount into a short-lived confirmation
- `confirm_purchase_action` — one-shot gate for a final click; disabled by default
- `browser_status` — current browser/session status
- `close_browser_session` — close the local browser session

## Safety model

The server has three layers:

1. **Domain guard** — only TOHO, AEON, and 109 official root domains and their HTTPS subdomains are accepted.
2. **Sensitive-data guard** — password, card number, CVV/CVC, OTP, MFA, and verification-code fields are rejected by `fill_cinema_field`; users enter those directly in the browser.
3. **Purchase guard** — controls whose visible text looks like a final purchase/payment action cannot be clicked by the ordinary click tool. The separate confirmation tool uses a short TTL, binds the purchase summary, and is one-shot.

If the page is ambiguous or an expected control cannot be identified, the server returns an error rather than guessing.

## Development

```bash
npm run typecheck
npm test
```

## Non-affiliation

This project is not affiliated with, endorsed by, or sponsored by TOHO Cinemas, AEON Cinema, 109 Cinemas, or their parent companies. Provider names are used only to identify interoperability targets.

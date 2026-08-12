# Provider Review Matrix

Last reviewed for initial private MVP: 2026-08-12.

This file records implementation scope, not legal advice. Provider terms and UI behavior must be re-checked before enabling purchase flows or making the repository public.

| Provider | Official root | Current automated scope | Purchase status |
|---|---|---|---|
| TOHO Cinemas | `https://www.tohotheater.jp/` | On-demand public UI navigation/read only | Disabled pending live flow validation |
| AEON Cinema | `https://www.aeoncinema.com/` | On-demand public UI navigation/read only | Disabled pending live flow validation |
| 109 Cinemas | `https://109cinemas.net/` | On-demand public UI navigation/read only | Disabled pending live flow validation |

## Common implementation rules

- Browser UI only; no private/internal endpoint discovery or direct calls.
- Do not persist showtimes, seat maps, HTML, images, cookies, or payment data.
- No scheduled crawling or provider-wide aggregation.
- CAPTCHA, MFA, OTP, 3-D Secure, waiting rooms, and third-party payment/identity surfaces require human control.
- Generic click tools must not execute final purchase/payment/booking controls.
- Provider-specific selectors must be scoped to visible public UI and fail closed when the expected structure changes.

## Validation checklist per provider

Before moving a provider from generic navigation to provider-specific booking automation:

1. confirm current official navigation and booking domains
2. review current terms/site policy relevant to automated browser use
3. identify public UI states without inspecting or depending on private APIs
4. implement semantic selectors for theater/date/movie/showtime/seat steps
5. test that changed or ambiguous UI produces `UI_STATE_CHANGED` instead of guessing
6. verify login and payment secrets remain user-entered
7. verify access challenges trigger human handoff
8. verify purchase preparation and final submission are separate actions
9. verify final confirmation binds the current URL and material transaction summary
10. document any provider-specific limitation here before release

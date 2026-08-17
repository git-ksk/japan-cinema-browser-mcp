# Phase 4 Checkout Preparation / Human Handoff Discovery

Review date: 2026-08-17

Tracking: #48

This document records the safety boundary for Phase 4 before any provider enables seat selection or checkout preparation. Discovery is limited to official public information, rendered official UI, and the repository's existing reviewed behavior. It does not authorize private/internal APIs, network interception, hidden endpoint discovery, guessed routes, challenge bypass, credential automation, payment handling, or final purchase.

## Decision

Phase 4 does not enable a transaction capability during Discovery.

| Provider | seatMap | seatSelection | checkoutPreparation | purchaseSubmission | Phase 4 status |
|---|---:|---:|---:|---:|---|
| TOHO | true | false | false | false | conditional first vertical slice |
| AEON | true | false | false | false | hold/release semantics need provider review |
| 109 | true | false | false | false | explicit 10-minute hold; mutation review required |

`seatSelection` is a semantic mutation. It must remain `never_replay` and cannot be recovered through generic click/fill or Human Handoff.

## Seat-selection / hold boundary

### TOHO

Official public guidance separates seat selection from ticket type, purchaser information, payment, and final review. TOHO also documents that a purchase must be completed within 15 minutes after the desired seat is decided. Phase 3 proved that entering the seat map itself does not create a selected seat.

What remains unresolved is the exact mutation trigger: seat activation, seat decision/confirmation, or a later transition. The exact release behavior also needs a bounded provider review. Therefore Phase 4 does not click a live seat during Discovery and keeps `seatSelection=false`.

TOHO remains the conditional first vertical slice because it already has the strongest seat identity/freshness implementation, a reviewed guest continuation, and the clearest documented checkout stage order.

Post-Discovery Gate 0 update (2026-08-17): one bounded exact ordinary-seat activation was performed after two stable read-only observations and an exact rendered pointer hit-test. The seat changed locally from `seat_1.gif` / `空席(選択可)` to `seat_3.gif` / `選択中`, while an independent fresh profile still observed the same seat as available and the full pre-click seat-state fingerprint was unchanged. Therefore individual seat activation is not the cross-session/server-side hold trigger. A later B1 preflight corrected one earlier assumption: TOHO's rendered public instructions include an intermediate `確認する` seat-decision step before the legal-consent continuation. The direct seat-image activation used for Gate 0 does not prove that this seat-decision step was completed; in isolated live validation the selected image state appeared while the exact `確認する` control remained non-interactive and the selected-seat summary did not advance. TOHO's documented 15-minute timeout starts after the desired seat is "decided", so `確認する` is now treated as the candidate material hold boundary until separately proven. `利用規約に同意して次へ` remains Human-only and is not reached automatically. No capability is enabled.
 Additional B1/Gate 0b setup validation stayed on the same showtime/seat and did not click `確認する` or any consent control. The default isolated `756x469` viewport exposed TOHO's horizontal-orientation blocker after seat-image selection, while a temporary desktop `1280x813` rendered viewport removed that environment concern but still left the exact `確認する` element non-interactive. The adapter therefore treats both unsupported checkout layout and the intermediate seat-confirmation step as fail-closed conditions instead of retrying seat activation.

### AEON

The official e-seat instructions show that a selected seat can be clicked again to deselect and that ticket selection/payment/review follow seat selection. Existing repository code also has a reviewed guest transition to the Smart Theater seat surface.

Visible deselection is not proof that there is no server-side hold. Public evidence reviewed for Discovery does not establish the hold trigger, timeout, or release semantics. AEON therefore remains blocked at `seatSelection=false` until an individual provider review proves that boundary.

### 109

109's official purchase instructions explicitly describe a 10-minute seat hold. Phase 3 separately observed that seat-map entry starts a 10-minute purchase-session timer while the rendered selected-seat count remains zero and fresh-session inventory does not change.

This separates seat-map entry from seat hold but also establishes that selecting a seat is a server-side reversible/expiring mutation. `seatSelection=false` therefore remains correct until the exact activation/release behavior is reviewed.

Post-Discovery read-only revalidation (2026-08-17): the current rendered seat page now formats the zero-selection summary as `選択座席：0／8席` (full-width colon). The adapter previously required the older no-colon form and correctly failed closed before returning a seat map. The read-only parser now accepts only the same reviewed label with an optional ASCII/full-width colon; it does not weaken the zero-selected-seat requirement.

After that narrow parser update, two independent fresh temporary Chrome profiles opened the same exact public showtime (109シネマズ港北 / 2026-08-18 / `オークストリートの異変[字幕]` / 11:15 / Screen 5). Both rendered the reviewed 10-minute release notice, `選択座席：0／8席`, 94 seats / available 83 / unavailable 11 / selected 0 / universal 2, and identical context/layout/state SHA-256 fingerprints. No seat was activated and no `次へ`, guest/member continuation, ticket type, consent, purchaser PII, payment, or purchase control was used. This reconfirms that seat-map entry creates the timed session context but does not itself create a seat hold or cross-session availability change. It does **not** authorize seat mutation: `seatSelection=false`, `checkoutPreparation=false`, and `purchaseSubmission=false` remain unchanged pending the separate exact activation/release review in #52.

## Checkout stage matrix

| Stage | TOHO | AEON | 109 |
|---|---|---|---|
| schedule/showtime | read-only | read-only | read-only |
| seat-map entry | read-only | reviewed stateful navigation then read-only seat surface | timed session context; no hold observed by entry alone |
| seat selection | possible hold; exact trigger unresolved | visual toggle; server hold unresolved | explicit 10-minute hold |
| ticket type | checkout mutation candidate | checkout mutation candidate | checkout mutation candidate; voucher/PIN flows Human-only |
| member / guest | guest path exists; login Human-only | reviewed guest path exists; login Human-only | guest path documented; login Human-only |
| purchaser/contact info | Human-only for initial Phase 4 | Human-only for initial Phase 4 | Human-only for initial Phase 4 |
| consent | Human-only | Human-only | Human-only |
| payment | Human-only | Human-only | Human-only |
| checkout summary | rendered facts may be normalized | rendered facts may be normalized | rendered facts may be normalized |
| final purchase | Phase 5 only | Phase 5 only | Phase 5 only |

## Human Handoff boundary

The following remain Human-only:

- password / passcode;
- OTP / MFA / verification code / 3-D Secure;
- CAPTCHA / access challenge / waiting room;
- payment card/credential or wallet approval;
- member credential or PIN-like secret;
- voucher/coupon/MovieTicket identifiers when they participate in authentication/PIN semantics;
- legal or terms consent;
- purchaser name, phone, email, and birth date in the initial Phase 4 design.

The last group is intentionally stricter than the existing secret deny-list. Phase 4 should not create a new PII ingress, logging, or result path just because a field is not a credential.

Existing Execution Handoff invariants remain authoritative: exact owner/requestState binding, resource-epoch fencing, official provider/context revalidation after Human action, invalidation of prepared purchase confirmation, and no automatic replay for semantic mutation or transaction.

## Ticket normalization proposal

Provider labels and restrictions remain authoritative. A provider-neutral representation may expose:

```ts
interface CinemaTicketType {
  providerTicketTypeId?: string;
  label: string;
  price?: number;
  currency: "JPY";
  category?: "standard" | "child" | "student" | "senior" | "member" | "accessibility" | "special" | "other";
  eligibilityText?: string;
  restrictionText?: string;
  minQuantity?: number;
  maxQuantity?: number;
  providerData?: Record<string, string>;
}
```

Rules:

- read label, price, restrictions, and quantity constraints from the current rendered UI;
- preserve the provider label even when a normalized category is available;
- never infer age, student, disability, senior, or member eligibility;
- stop for Human action when a discount path requires credential/identity/PIN semantics;
- validate ticket quantity against the exact selected seat set and provider constraints.

## Checkout summary proposal

A prepared summary must be re-read from the current provider UI. Caller input expresses intent and must never become transaction truth by itself.

Minimum facts when rendered:

- provider;
- theater;
- movie;
- date;
- start time;
- screen;
- exact seats;
- ticket types and quantities;
- subtotal;
- fees;
- total;
- currency;
- current provider-visible stage/context;
- observation time/context fingerprint.

Missing provider facts remain missing; the core must not invent fees, totals, eligibility, or seat state.

## `prepare_checkout` responsibility

The intended contract is:

1. bind the exact user-intended showtime, seats, and ticket choices;
2. re-read showtime and seat freshness before any mutation;
3. delegate only to provider-specific reviewed mutation primitives;
4. select exactly the intended seat set once, with no speculative substitute or automatic retry;
5. verify the rendered selected/held state after mutation;
6. normalize ticket choices without deciding eligibility;
7. take only an explicitly reviewed guest path;
8. stop at Human-only identity/contact/consent/payment/challenge surfaces;
9. after Human intervention, require a fresh semantic action and revalidate provider/showtime/seat/hold state;
10. return a provider-rendered pre-purchase summary when safely reachable;
11. never submit the final purchase/payment action.

No provider-independent rollback is promised. A release/deselect action can be automated only after its provider semantics are separately reviewed. Otherwise the runtime fails closed and relies on the provider's documented expiry behavior.

## Implementation split

- #49 — provider-neutral `prepare_checkout` contract/core; must be mergeable with all transaction capabilities still false.
- #50 — TOHO conditional first vertical slice. Gate 0 must prove exact seat hold/release semantics before any capability flip.
- #51 — AEON hold/release discovery and provider adapter; deferred independently of TOHO.
- #52 — 109 explicit 10-minute hold review and provider adapter; deferred independently of TOHO.

Provider parity is not a Phase 4 requirement.

## Release milestone direction

`v0.4.0 — Checkout Preparation` is the candidate next release because `prepare_checkout` and any provider checkout capability are public-surface additions under the repository's `0.x` versioning policy.

The candidate release scope should initially contain the generic core and TOHO first slice only. AEON/109 belong in that milestone only after their independent safety reviews make the scope concrete. A milestone must not be treated as permission to enable a provider capability before its review gate passes.

No version bump, tag, GitHub Release, npm publication, or production deployment is part of Discovery.

## Official public references reviewed

- TOHO vit usage: https://www.tohotheater.jp/vit/vit_buy.html
- TOHO vit guest availability: https://www.tohotheater.jp/vit/index.html
- TOHO FAQ: https://help.tohotheater.jp/category/show/469?site_domain=default
- AEON e-seat instructions: https://www.aeoncinema.com/service/onlineticket/instructions/?tab=tab3
- 109 ticket purchase instructions: https://109cinemas.net/tickets/howto/

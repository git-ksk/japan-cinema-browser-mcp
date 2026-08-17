# Phase 3 Seat Intelligence Discovery

Discovery date: 2026-08-17

Parent issue: #30

Milestone: `v0.3.0 — Seat Intelligence`

## Purpose

Phase 3 must understand a rendered seat map without creating unnecessary seat holds. This Discovery compares TOHO Cinemas, AEON Cinema, and 109 Cinemas before enabling any seat capability.

The investigation remained inside the existing safety boundary:

- public rendered official UI and official public documentation only
- no private/internal API discovery or calls
- no network interception
- no guessed hidden routes, provider slugs, or query values
- no CAPTCHA/challenge bypass
- no login, checkout, payment, or purchase
- no seat click
- no intentional hold creation
- `seatMap`, `seatSelection`, `checkoutPreparation`, and `purchaseSubmission` remained disabled for every provider

Representative current schedule surfaces were read through the existing provider adapters for TOHO Cinemas Lalaport Yokohama, AEON Cinema Kohoku New Town, and 109 Cinemas Kohoku. During the initial comparison, the purchase/seat controls themselves were not activated. A bounded follow-up validation then entered seat-map surfaces without clicking any seat, as recorded below.

## Provider comparison

| Provider | Seat-map entry | Hold / mutation boundary | Read-only seat semantics | Geometry | Auth / challenge | Discovery result |
|---|---|---|---|---|---|---|
| TOHO | Follow-up validation entered the live `座席指定` surface through the visible sellable showtime and visible non-member continuation. No seat was clicked. | No countdown was visible at entry, no selected-seat state was observed, and the official FAQ still places the documented 15-minute timeout after desired-seat decision. | Live legend exposes available, selected, and purchased/not-for-sale semantics. | Live seat-map surface is now reachable for semantic DOM review; extraction details belong to implementation #32. | Membership is optional; the reviewed path used the visible non-member continuation and no auth field. | **First provider gate passed** for read-only seat-map implementation. |
| AEON | Initial probe confusion around `about:blank` was resolved in #36: a pre-existing startup tab was unrelated, while the real blocker was the T360 Cookie overlay. Exact `全て拒否` → exact showtime `予約購入` → Watatheatre non-member → Smart Theater seat route reaches the live map without seat click. | #36 clean-profile validation showed entry with active/selected=0 and identical seat-state fingerprint in two sessions. Hold start/time remains undocumented, so any seat activation is still treated as mutating. | Live DOM exposes actual `seat-[ROW]-[NUMBER]` identities, `default` / `disabled`, premier/special and wheelchair classes. #43 normalizes only reviewed public classes and fails on `active`. | #43 reads rendered rect geometry; no screen orientation is inferred unless an explicit marker is geometrically proven. | Purchase without membership is supported; login fields are not automated. | **Read-only gate passed** in #36; runtime adapter implemented in #43 with provider-specific target adoption. |
| 109 | Follow-up validation entered the live seat-map surface by following one exact visible public showtime href; no route/query was synthesized and no seat was clicked. | Entry immediately starts a visible 10-minute purchase/session timer, but the page reports `選択座席 0／8席`. Two independent sessions showed identical per-seat state with 0 selected seats, strongly indicating entry alone does not hold seats or change availability. | Live DOM exposes row/seat identities plus available vs unavailable state; selected count remained zero. | Rendered rows expose stable seat identities suitable for semantic normalization. | Non-members can continue without joining. No challenge was observed. | **Read-only candidate after TOHO**; timed-session creation is acceptable only while seat selection remains zero. |

## Hold-boundary conclusion

Discovery does **not** authorize a seat click for any provider.

### TOHO

The strongest current evidence is TOHO's official FAQ: the purchase timeout begins after the user has decided the desired seat, and a temporarily held seat is released later. This places the documented hold boundary at or after seat decision rather than at ordinary schedule browsing.

The bounded follow-up validation passed the implementation safety gate: the visible public non-member path reached `座席指定` with no visible countdown and no selected seat. The implementation criterion is **no seat hold, material reservation mutation, or availability impact caused by read-only entry**, not literal absence of all server-side session state. #32 has now implemented and tested the reviewed read-only adapter, so TOHO alone exposes `seatMap=true`; seat selection remains disabled.

### AEON

The official instructions clearly separate showtime selection, seat selection, ticket type, payment, and final purchase. They also state that seat availability is continuously updated and an uncompleted reservation can result in seats becoming available again. They do not specify when a temporary hold starts or how long it lasts.

The exact hold start/time remains undocumented, but #36 demonstrated in two independent clean profiles that normal rendered entry to the Smart Theater seat page produces active/selected=0 and a stable seat-state fingerprint without a material availability impact. #43 therefore implements only read-only target adoption and seat extraction; any `active` seat, stale transaction state, wrong context, or unexpected route fails closed. `seatMap=true`, while `seatSelection=false` and AEON recommendation remains disabled because screen orientation is not proven.

### 109

Live validation clarified the boundary: the 10-minute timer is already visible immediately after seat-map entry, while the page explicitly reports `選択座席 0／8席`. A second independent browser session for the same showtime exposed the same 223 seat identities and the same 11 unavailable seats, with zero selected seats and a zero-difference per-seat state fingerprint.

This is strong evidence that 109 creates a timed purchase/session context on entry but does **not** create a seat hold or availability mutation until a seat is selected. Treat any seat activation as mutating. A future read-only adapter may enter the map while preserving zero selected seats; see #35.

## Domain model direction

Do not model `special` as an availability state. A D-BOX, Gold Class, Executive, Pair, wheelchair, or other special seat can independently be available or unavailable.

The first shared contract should therefore separate state from attributes:

```ts
type CinemaSeatState =
  | "available"
  | "unavailable"
  | "selected"
  | "unknown";

type CinemaSeatUnavailableReason =
  | "sold"
  | "blocked"
  | "not_for_sale"
  | "unknown";

interface CinemaSeat {
  id: string;
  row?: string;
  number?: string;
  state: CinemaSeatState;
  unavailableReason?: CinemaSeatUnavailableReason;
  attributes: string[];
  rowIndex?: number;
  x?: number;
  y?: number;
  groupId?: string;
}

interface CinemaSeatMap {
  provider: "toho" | "aeon" | "109";
  theaterId: string;
  screen?: string;
  showtimeIdentity: string;
  seats: CinemaSeat[];
  screenEdge?: "top" | "bottom" | "left" | "right";
  observedAt: string;
  sourceUrl: string;
}
```

The final names may change during implementation. The invariants are more important:

- do not invent `occupied`, `blocked`, or `not_for_sale` distinctions unless the rendered UI distinguishes them
- preserve provider-visible seat identity
- preserve special-seat attributes independently from availability
- carry provenance and observation time
- make unknown state explicit rather than treating it as available

## Provider-independent recommendation feasibility

The following can be provider-independent once a provider adapter supplies normalized layout facts:

- adjacent N-seat grouping: same row, consecutive layout neighbors, no explicit aisle/gap/group boundary between seats
- center preference: normalized horizontal distance from the observed center line
- rear preference: normalized row depth away from the screen edge
- rear-middle: combined center distance and rear-depth score
- aisle preference: adjacency to an observed aisle/gap boundary
- pair/group handling: preserve provider-declared logical groups rather than splitting them accidentally

Recommendation defaults to confirmed `available` seats. `unknown` is not a synonym for available. Special/accessibility seats remain independent attributes and are excluded from default recommendation unless the caller explicitly opts in.

## State stability / freshness

Seat availability is mutable external state. The read-only contract needs:

1. exact provider / theater / showtime / screen context identity
2. observation timestamp
3. a deterministic fingerprint or equivalent over seat identities and states
4. bounded re-read of the same reviewed seat-map context
5. fail-closed behavior if the context, layout identity, or availability state changes unexpectedly

A recommendation is advisory only. It must never select a seat as part of refreshing or validating state.

## v0.3.0 scope

First provider: **TOHO Cinemas**.

Implemented v0.3.0 seat-read scope:

- provider-neutral seat intelligence model
- TOHO / AEON / 109 `get_seat_availability`
- TOHO #32 / 109 #35 / AEON #43 reviewed read-only `seatMap=true`
- TOHO-only `recommend_seats` with exactly two bounded read-only observations
- row / seat normalization + rendered gap boundaries
- explicit SCREEN orientation proof from rendered public UI
- adjacent seat grouping
- center / rear / rear-middle / aisle scoring
- context / layout / state freshness fingerprints and fail-closed stale detection
- unit tests and isolated live smoke without seat click

Explicitly excluded from v0.3.0 first scope:

- `select_seats`
- `seatSelection=true`
- seat click / hold creation
- login automation
- checkout preparation
- payment / purchase
- AEON / 109 `recommend_seats` until provider-specific screen orientation is explicitly proven

## Follow-up issues

- #31 — provider-neutral seat intelligence model and recommendation core
- #32 — TOHO read-only seat availability adapter, including the non-mutating-entry gate
- #33 — seat freshness detection and `recommend_seats`
- #35 — 109 read-only seat availability with explicit timed-session semantics — implemented 2026-08-17
- #36 — AEON public seat-map entry / safety gate without hidden-route discovery — completed 2026-08-17
- #43 — AEON reviewed target adoption + read-only seat availability adapter — implemented 2026-08-17

A `select_seats` issue should only be created after a separate provider-specific mutation/hold review. Discovery did not pass that boundary.

## Official public references

TOHO Cinemas:

- https://www.tohotheater.jp/vit/vit_buy.html
- https://help.tohotheater.jp/faq/show/2049
- https://www.tohotheater.jp/theater/036/institution.html

AEON Cinema:

- https://www.aeoncinema.com/service/onlineticket/instructions/?tab=tab3
- https://www.aeoncinema.com/kohoku/facility/

109 Cinemas:

- https://109cinemas.net/tickets/howto/
- https://109cinemas.net/kohoku/establishment.html

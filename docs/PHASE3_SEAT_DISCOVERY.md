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

Representative current schedule surfaces were read through the existing provider adapters for TOHO Cinemas Lalaport Yokohama, AEON Cinema Kohoku New Town, and 109 Cinemas Kohoku. The purchase/seat controls themselves were not activated.

## Provider comparison

| Provider | Seat-map entry | Hold / mutation boundary | Read-only seat semantics | Geometry | Auth / challenge | Discovery result |
|---|---|---|---|---|---|---|
| TOHO | Official flow: choose a sellable showtime, then choose a seat. Live seat map was not entered automatically. | Official FAQ says the 15-minute purchase timeout begins after the desired seat is decided and temporarily held seats are later released. Exact seat-click vs later confirmation boundary is not stated. Seat-map display itself is not explicitly guaranteed mutation-free. | Official guide documents selected seats as red and sold seats as black. Wheelchair spaces can be selected in vit. | Facility page exposes screen capacity and wheelchair-space counts. Live row/seat DOM geometry still requires a separately reviewed non-mutating seat-map entry. | Membership is optional. No challenge was observed on the reviewed schedule surface; deeper purchase flow was not entered. | **Preferred first provider**, gated on proving seat-map entry itself is non-mutating. |
| AEON | Official flow: press `予約購入` for a showtime, then select seats. Live purchase seat map was not entered automatically. | Exact hold start/time is **unknown**. Official guidance says availability updates continuously and seats can become available again when another reservation is not completed. | Selected seats are documented as orange. Public facility pages identify wheelchair spaces and special seat types such as D-BOX / Gold Class. Wheelchair spaces at the reviewed static seat-map surface are not bookable through e席リザーブ. | Public facility UI exposes `座席図を見る`; the reviewed static seat-map page is primarily visual and does not provide live availability. Semantic live geometry remains unverified. | Purchase without membership is supported. No challenge was observed on the schedule/static facility surfaces; deeper purchase flow was not entered. | Defer until the hold boundary is clearer. |
| 109 | Official flow: choose a showtime, select seats, then continue. The guide also exposes a detailed-seat-map view. Live purchase seat map was not entered automatically. | Official guide states a seat hold lasts 10 minutes, in the flow after seat selection. Exact seat-click vs `次へ` start point is not stated. | Public facility UI distinguishes standard, Executive, Pair, and wheelchair seats. Dynamic availability-state semantics still need a reviewed live seat-map read. | Public facility UI exposes seat maps by theater and seat-type counts. The purchase guide warns the detailed layout may differ from actual placement. Semantic live geometry remains unverified. | Non-members can continue without joining. No challenge was observed on reviewed schedule/facility surfaces; deeper purchase flow was not entered. | Second candidate after TOHO; dynamic state semantics are less explicit. |

## Hold-boundary conclusion

Discovery does **not** authorize a seat click for any provider.

### TOHO

The strongest current evidence is TOHO's official FAQ: the purchase timeout begins after the user has decided the desired seat, and a temporarily held seat is released later. This places the documented hold boundary at or after seat decision rather than at ordinary schedule browsing.

This is enough to make TOHO the best first candidate, but not enough to assert that entering every current seat-map surface has zero server-side mutation. The TOHO implementation issue therefore has a mandatory pre-enable gate: if read-only seat-map entry cannot be established as non-mutating from the live public flow, `seatMap` stays disabled.

### AEON

The official instructions clearly separate showtime selection, seat selection, ticket type, payment, and final purchase. They also state that seat availability is continuously updated and an uncompleted reservation can result in seats becoming available again. They do not specify when a temporary hold starts or how long it lasts.

Treat the hold boundary as unknown. `seatMap` remains disabled.

### 109

The official purchase guide states that the seat hold is 10 minutes and warns that a selected seat may become unavailable. This appears after the seat-selection step in the documented flow, but the exact transition that starts the timer is not stated.

Treat any seat selection as mutating. A future read-only entry review must not select a seat.

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

Recommendation must default to confirmed `available` seats. `unknown` is not a synonym for available.

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

Planned scope:

- provider-neutral seat intelligence model
- TOHO-only `get_seat_availability`
- TOHO-only `seatMap=true` **only after** non-mutating seat-map entry is separately verified
- `recommend_seats`
- row / seat normalization
- adjacent seat grouping
- center / rear / rear-middle / aisle scoring
- seat-state refresh / stale detection
- unit tests and fail-closed UI-change tests

Explicitly excluded from v0.3.0 first scope:

- `select_seats`
- `seatSelection=true`
- seat click / hold creation
- login automation
- checkout preparation
- payment / purchase
- AEON or 109 live seat-map implementation

## Follow-up issues

- #31 — provider-neutral seat intelligence model and recommendation core
- #32 — TOHO read-only seat availability adapter, including the non-mutating-entry gate
- #33 — seat freshness detection and `recommend_seats`

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

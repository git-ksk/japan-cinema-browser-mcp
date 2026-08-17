# Phase 4 TOHO Post-Consent Continuation Design

Status: design approved for implementation planning; provider post-consent behavior remains unproven.

Tracking: #50

## Goal

TOHOのpre-consent exact-seat selectionと、Humanがlegal consentを完了した後のcheckout continuationを安全に接続する。

中心原則は、**Human Handoff後にinterrupted semantic mutationをreplayしない**ことです。Human completionは元の`prepare_checkout`を自動再開する権限ではありません。Human操作後はcurrent rendered provider stateをpositiveに再検証し、callerのexact checkout intentへ再bindした**fresh semantic action**だけを許可します。

## Non-negotiable invariants

- `semantic_mutation` / `transaction` は `never_replay` のまま。
- Human completionをseat/ticket/payment/final purchase approvalとして扱わない。
- password / OTP / MFA / CAPTCHA answer / cookie / purchaser PII / payment credentialをrequestState、continuation binding、log、resultへ入れない。
- caller inputはintentでありtransaction truthではない。current rendered UIを再読する。
- alternate seat / speculative seat / automatic retryを行わない。
- 未review route、hidden endpoint、network interception、guessed URLをcontinuation proofに使わない。
- final purchase/payment submitはPhase 5まで到達不能。
- `purchaseSubmission=false` を維持する。

## Decision: same invocation is never resumed as a mutation

既存`mcp-execution-handoff`のprincipal + exact tool + canonical args + intervention id + resource epoch + resume strategy bindingはそのまま使います。ただしTOHO checkoutではHuman完了後に元のseat-selection taskをretryしません。

```text
prepare_checkout invocation A
  -> fresh seat reads
  -> exact local seat selection
  -> reviewed consent boundary
  -> explicit Human Handoff
  -> Human operates Chrome
  -> provider-specific verification
  -> invocation A terminates without replay

prepare_checkout invocation B (fresh semantic action)
  -> inspect current rendered stage
  -> re-bind current provider facts to the same exact intent
  -> only then continue with the reviewed next stage
```

invocation BはAのreplayではなく、現在のrendered stateから開始します。

## State machine

```text
INTENT_ACCEPTED
  -> SEAT_PREFLIGHT_STABLE
  -> EXACT_SEATS_SELECTED_LOCAL
  -> AWAITING_HUMAN_CONSENT
  -> VERIFYING_POST_CONSENT
       -> mismatch / unknown / unreviewed => BLOCKED
  -> POST_CONSENT_REBOUND
       -> hold/timer boundary unproven => BLOCKED until Gate 1
  -> TICKET_STAGE_REVIEWED
       -> restricted/eligibility ticket => HUMAN_ACTION_REQUIRED
  -> EXACT_TICKETS_SELECTED
  -> PURCHASER_INFORMATION => HUMAN_ACTION_REQUIRED
  -> PAYMENT => HUMAN_ACTION_REQUIRED / provider-specific review
  -> PRE_PURCHASE_SUMMARY_READ_ONLY
  -> PREPARED

FINAL PURCHASE: unreachable in Phase 4
```

Each Human-only boundary creates a new boundary-specific intervention. A previous intervention never authorizes a later stage.

## A. Explicit reviewed Human Handoff

### Problem

Current runtime starts Human Handoff when generic detection sees a natural `access_challenge`, `sign_in`, or consent surface. TOHOの`利用規約に同意して次へ`はprovider-reviewed boundaryとして明示的に停止したいので、generic detectorだけに依存しません。

### Proposed runtime action type

`CinemaBrowserRuntime`のhandoff action genericを`never`から、secretを含まないbounded actionへ変更します。

```ts
type CinemaHandoffAction =
  | {
      kind: "reviewed_checkout_boundary";
      provider: CinemaProviderId;
      boundary: "toho_terms_consent_next";
      continuationDigest: string;
    };
```

`boundary`はcaller supplied stringではなくprovider adapter内部のclosed setです。

### Runtime entry point

provider adapter専用のnarrow APIを追加します。

```ts
requireReviewedHumanIntervention({
  reason: "consent",
  action: {
    kind: "reviewed_checkout_boundary",
    provider: "toho",
    boundary: "toho_terms_consent_next",
    continuationDigest
  },
  resumePolicy: "never_replay",
  message
}): never
```

generic `start_handoff` MCP toolは作らず、generic click/fill policyも緩和しません。

### Human prompt

TOHO consent boundaryでは次を明示します。

- Chrome上のTOHO画面で利用規約をHuman自身が確認する。
- 同意する場合だけrendered `利用規約に同意して次へ` をHumanが操作する。
- seatを変更しない。
- credentials / OTP / PII / payment dataをMCPへ入力しない。
- final purchaseに進まない。
- 完了後にContinue、やめる場合はCancel。

## B. Ephemeral continuation binding

Humanがbrowserを操作できる間、provider contextが別bookingへ変わる可能性があります。MRTRのinvocation/epoch bindingに加えて、Cinema側に短命なmaterial bindingを保持します。

```ts
interface CheckoutContinuationBinding {
  version: 1;
  provider: CinemaProviderId;
  boundary: "toho_terms_consent_next";
  intentDigest: string;
  continuationDigest: string;
  theaterId: string;
  showtimeIdentity: string;
  selectedSeatIds: string[];
  preHumanFingerprints: { context: string; layout: string; state: string };
  sourceSurface: { host: string; pathname: string };
  browserTargetId: string;
  createdAt: number;
  expiresAt: number;
}
```

Storage rules:

- process memory only for first implementation。
- credential / PII / payment fact / opaque URL query / cookie / receipt / tokenを保存しない。
- one active checkout binding per dedicated browser runtime。
- browser reset / intervention cancel / context mismatch / timeoutで破棄。
- `continuationDigest`はcanonical material factsのSHA-256で、authority tokenとして扱わない。
- clientがdigestを返すことをauthorization条件にしない。authorizationはactive intervention ownership + rendered revalidationで決める。

TOHOのhold startはまだ未証明なので、binding TTLを「TOHOの15分hold」と表現しません。implementationのinternal safety TTLとprovider-visible expiryは別物です。

## C. Human completion verification

Current generic verificationのofficial domain + generic blocker absenceだけではcheckout continuationには弱いため、reviewed checkout interventionではprovider-specific positive postconditionを追加します。

Required common checks:

- intervention id / owner / epoch一致。
- pre-handoffと同じdedicated browser target。
- current top-level providerがTOHO。
- unreviewed external target/tabへ移っていない。
- current stateがpre-consent boundaryそのものではない。
- generic challenge / sign-in / consent blockerが残っていない。

TOHO positive postconditionはpost-consent live review後に実装します。最低でもunique stage markerと、original intentへmaterially re-bindできるrendered booking factsが必要です。official URLだけではcontinuity proofにしません。

## D. Fresh `prepare_checkout` continuation

Human verification後も元invocationをautomatic replayしません。current server invariantの`require_fresh_semantic_action`を維持します。

fresh `prepare_checkout`は最初にcurrent stageをclassifyします。

```text
seat page / no selected seats
  -> normal fresh preflight from zero

seat page / exact selected seats + active matching pre-consent binding
  -> do not re-click; verify boundary/continuation state only

reviewed post-consent stage + matching binding
  -> consume pre-consent binding, re-bind intent, continue reviewed next stage

selected seats but no valid binding
  -> fail closed

unreviewed checkout stage
  -> fail closed
```

pre-consent bindingはpost-consent positive revalidation成功時にone-shot consumeします。次のHuman-only stageへ進む場合は、その時点のcurrent rendered material factsから**新しいstage binding**を作り、古いbindingをpurchaser/payment stageまで使い回しません。

## E. Ticket stage contract

TOHO post-consent surfaceをreviewできた後のみ実装します。

Read first:

- rendered ticket label
- provider ticket type id（rendered DOMで明示的かつ安全に取れる場合のみ）
- displayed price
- displayed restriction / eligibility text
- displayed min/max quantity

Selection rules:

- callerのexact requested ticket choiceだけ。
- ticket quantity == selected seat count。
- labels/restrictionsはprovider textがauthoritative。
- age/student/senior/accessibility/member eligibilityを推測しない。
- restricted/eligibility-bearing/credential-bearing flowはHumanへ戻す。
- coupon / voucher / MovieTicket / member credential / PIN相当はHuman-only。
- speculative ticket choiceやdiscount optimizationをしない。

ordinary ticket selectionもsemantic mutationなので、exact-control review + tests + bounded live reviewの後だけ有効にします。

## F. Later Human boundaries

### Purchaser information

初期Phase 4ではname / phone / email / birth dateをMCP inputに追加しません。rendered purchaser-information stageへ到達したら`purchaser_information`でHuman Handoffします。

Humanが直接Chromeで入力後、agentはfresh actionでpositive postconditionを再検証します。入力値そのものをread/log/resultへ返しません。

### Payment

payment field / wallet approval / 3DS / OTPはHuman-onlyです。payment stageからpre-purchase summaryへ進む操作がauthorization/charge/holdを伴うかはprovider-specific reviewなしに自動化しません。

### Pre-purchase summary

安全に到達できた場合のみread-onlyでnormalizeします。

- theater / movie / date / time / screen
- exact seats
- exact tickets / quantities
- subtotal / fees / total（renderedされているfactだけ）
- currency / stage / observedAt

missing fee/amountを0として補わず、summaryは#49 material fingerprintへbindします。

## G. TOHO Provider Gate 1 — post-consent hold proof

implementation plumbingと分離したbounded live reviewです。

### Preconditions

- one theater / one showtime / one ordinary seat only。
- two stable read-only observations。
- exact seat pointer identity。
- pre-consent fresh profileでseat availableを確認。
- exact seat local selectionは1回だけ。
- agentはconsentをclickしない。

### Human action

Humanがtermsを確認し、同意する場合のみexact rendered `利用規約に同意して次へ`を1回操作します。

### Immediate read-only observations

Human completion直後にagentはmutationせず以下を確認します。

1. current rendered stage marker。
2. rendered hold/countdown/expiry表示の有無。
3. current booking factsのintent binding。
4. independent fresh profileでexact seat availability。

Decision:

- fresh profileでseat unavailableになり、同bookingにrendered timer/hold evidenceがある場合: consent transition at or before the arrived stageをmaterial hold boundaryとして記録。
- fresh profileでseat availableのまま: consent transition aloneをhold triggerと断定しない。次candidateを別subgateとしてreviewする。
- ambiguous/changed UI: stop。追加clickで探索しない。

### Release proof

server-side holdが観測された場合、最初のrelease proofでは**guessed cancel/back/deselectを試しません**。公開されているtimeoutによる自然解放を優先します。

- provider-rendered expiry/countdownがあれば記録。
- expiry後にindependent fresh profileでexact seatがavailableへ戻ることを確認。
- active release controlはlabel/semanticsを別途reviewできるまで使わない。

## H. Capability rollout

### `seatSelection`

current evidenceではfalse維持。trueへ変更するには少なくともexplicit reviewed Human Handoff integration、selected-state/current-stage recovery、no-replay fresh-action continuation testsが必要です。

### `checkoutPreparation`

false維持。さらにGate 1 post-consent positive stage review、exact ticket-stage contract、Human-only purchaser/payment stops、rendered summary validationまたはdocumented safe stopping pointが必要です。

### `purchaseSubmission`

Phase 4では常にfalse。

## I. Test matrix

Handoff plumbing:

- reviewed boundaryだけexplicit interventionを開始できる。
- caller supplied boundary名でhandoffを作れない。
- intervention actionにsecret/PII fieldが存在しない。
- owner / args / principal / epoch mismatchはfail closed。
- Human completion後にoriginal semantic mutation taskをretryしない。
- browser target changeはcontinuation invalidation。
- cancel/browser reset/TTLでbinding消去。

Fresh action continuation:

- exact matching post-consent bindingならseat click 0回でcontinue。
- selected seat + no binding => blocked。
- binding intent digest mismatch => blocked。
- showtime/material fact mismatch => blocked。
- unrelated inventory/context change => blocked。
- consumed bindingは再利用不可。

Ticket/final boundary:

- exact ordinary ticketだけを選択。
- eligibility-bearing ticketをHumanへ戻す。
- ticket quantity/seat count mismatch => blocked。
- caller-supplied priceをtransaction truthにしない。
- purchaser PII/payment fieldsはMCP schemaに存在しない。
- final purchase controlをPhase 4 adapterから到達不能にする。
- Human interventionでprepared purchase confirmationを必ず破棄する。

## J. Implementation status / order

A1/A2 implementation landed in the #50 continuation-plumbing slice without enabling any provider capability or registering `prepare_checkout`. A later B1 preflight found an earlier missing provider stage: TOHO's rendered public flow has a `確認する` seat-decision boundary before legal consent. A1/A2 remain valid plumbing, but the current provider adapter must stop at `確認する` until Gate 0b proves its hold semantics.

1. **A1 — explicit reviewed intervention plumbing** — implemented
   - typed `CinemaHandoffAction`
   - provider-reviewed handoff entry point
   - boundary-specific Human prompt
   - no capability change
2. **A2 — ephemeral continuation binding + fresh-action dispatch** — implemented at the binding/runtime primitive layer
   - target/provider/intent/material binding
   - one-shot consumption / invalidation
   - no seat replay
   - no capability change
3. **Gate 0b — TOHO rendered `確認する` seat-decision review** — next provider gate
   - establish the correct rendered interaction sequence without direct-seat shortcuts
   - prove whether `確認する` starts the documented 15-minute hold
   - prove selected/held identity and release semantics before allowing continuation
4. **B1 — TOHO post-consent Gate 1 live review** — blocked on Gate 0b
   - one Human consent transition
   - read-only stage/hold/fresh-profile observation
   - natural-expiry release proof if a hold is observed
5. **B2 — ticket stage adapter**
   - only after B1 establishes reviewed post-consent surface
   - exact ticket normalization/selection
6. **B3 — purchaser/payment handoff and summary boundary**
   - provider-specific positive postconditions
   - final purchase remains unreachable
7. capability decision only after tests + docs + bounded live evidence

## Out of scope

- automatic legal consent
- PII autofill
- credential/OTP/CAPTCHA transport
- payment autofill or automatic payment authorization
- final purchase
- AEON/109 parity
- guessed checkout URLs
- network/private API discovery
- version bump / tag / release / npm publish / production deploy

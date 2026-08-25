# Execution Handoff

この文書はJapan Cinemaがgeneric `git-ksk/mcp-execution-handoff` runtimeを利用する際の仕様です。

## 責務分離

upstreamが担当するのは再利用可能なcontrol-planeだけです。

- Agent/Human execution authorityの排他制御
- 単調増加するresource epoch
- resume policy
- generic execution-adapter contract
- principal + invocation + canonical args ownership binding
- MCP MRTR `input_required` requestState helper
- optional durable checkpoint / first-class Browser Handoff module

Japan Cinema側には次を残します。

- provider-reviewed checkout boundaryから明示的にHuman Handoffを開始する判断（Phase 4ではgeneric detectorとは別のnarrow entry pointを使う）
- 自然発生したaccess challenge/CAPTCHA、sign-in/authentication、consentの検出/classification
- official provider URL / capability allowlist
- current page / postcondition verification
- provider adapter behavior
- transaction / purchase-confirmation policy
- どのoperation classをreplay可能にするかの判断

通常のHuman interventionは引き続きdedicated local Chromeで直接完了できます。加えてPhase 4 TOHO Gate 0bだけは、upstreamのfirst-class `BrowserHandoffAdapter` を使うopt-in WebRTC経路を持ちます。Cinemaはintervention/principal、exact managed Chrome PID、明示input policyだけを渡し、WebRTC signaling/media/TURN、route ownership、exact-window/focus fencing、disconnect/reload generation recovery、revokeをHandoffへ委譲します。Cinema側でCDP screenshot/input takeoverを再実装しません。

Gate 0bのinput policyは `tap=true / scroll=true / text=false / key=false` です。座席決定の物理検証以外へこのsurfaceを一般化せず、credential/PII/payment dataの入力経路として使いません。Browser Handoffはheadedなowned Chrome processとvisible OS windowを必須とし、`CINEMA_HEADLESS=true` やexternal CDPとの併用はfail closedします。

## Intervention detection

browser-side detectionからhandoffへ返すのはbounded categoryだけです。

- `access_challenge`
- `sign_in`
- `consent`
- `seat_decision`（TOHO Gate 0bのreviewed Human-only boundaryのみ）

challenge answer、password、OTP/MFA、cookie、payment data、raw dialog/page contentをhandoff requestStateへ入れません。reviewed provider外へredirectしただけで自動的にtrustせず、Human対応が明示的に必要な場合だけhandoffとし、それ以外は通常URL policyでfail closedします。

このsubsystemはsolver/bypassではなくhandoff boundaryです。

## Second real adapterで実証したresume policy

CinemaではMapsより厳しいpolicy分離が必要です。

| 操作class | core resume policy | MCP strategy | Human完了後 |
| --- | --- | --- | --- |
| bounded pure read | `replay_safe` | `retry_original` | verification後にexact readのみretry可 |
| navigation/provider semantic flow | `revalidate` | `require_fresh_semantic_action` | automatic replayせずre-read/reissue |
| semantic mutation | `never_replay` | `require_fresh_semantic_action` | replay禁止 |
| transaction/payment action | `never_replay` | `require_fresh_semantic_action` | replay禁止、fresh intent/confirmation必須 |

consumerは常に厳しい方を採用し、Human completionだけを理由に `revalidate` / `never_replay` を `replay_safe` へ昇格させません。

## Transaction invariant

現在、TOHO / AEON / 109の3社でreview済みread-only `seatMap=true` です。3社共通で次のtransaction/mutation capabilityはfalseです。

```text
seatSelection=false
checkoutPreparation=false
purchaseSubmission=false
```

Execution Handoffはこれらのcapabilityを変更しません。各providerのseat-map entryはprovider-specific read-only adapterだけが扱い、seat clickは実行しません。

Human intervention開始時にprepared purchase confirmationを全破棄します。そのためlogin、consent、CAPTCHA/access challenge、その他manual stepをまたいで以前のconfirmationを再利用できません。

Human completionはpurchase approvalではありません。将来final purchaseを有効化する場合も、provider capability、runtime purchase flag、current provider/page verification、fresh one-shot material confirmation、final-control verificationをすべて別に満たす必要があります。ambiguous submission outcomeはautomatic retryしません。

Phase 4 TOHO checkout continuationでは、reviewed consent boundaryでexplicit interventionを作り、Human完了後も元のsemantic mutationをretryしません。A1/A2ではbounded `reviewed_checkout_boundary` action（provider/boundary/continuation digestのみ）とprocess-local one-shot bindingを実装済みです。bindingはexact browser target / provider / intent / showtime / selected seats / pre-Human fingerprintsへbindし、cancel、browser reset、TTL、owned context mismatchで破棄します。HumanがContinueだけ返してpre-consent controlが残っている場合はverificationでHumanへ戻します。fresh `prepare_checkout`がcurrent rendered stageをpositiveに再検証できるまでbindingはconsumeしません。詳細は [`PHASE4_TOHO_CONTINUATION_DESIGN.md`](./PHASE4_TOHO_CONTINUATION_DESIGN.md) を参照してください。

2026-08-17のB1 preflightでは、TOHOのcurrent rendered flowにlegal consentより前の `確認する` seat-decision stepがあることを再確認しました。Agent側の座席画像直接activationをそのstepと同一視せず、current adapterは通常automationでは引き続き`UNREVIEWED_INTERACTION`で停止します。Gate 0bではone exact seat intentにbindingしたHuman-only `seat_decision` interventionを作り、Handoff WebRTC surface上でpointer/scrollだけ許可します。physical sequenceは `exact seat選択 → 確認するを1回 → サイト自身の terms_check をHumanが明示的にON → Handoff Done` に固定し、`利用規約に同意して次へ` は押しません。Done後、Cinemaはread-onlyでexact seatが唯一の選択中seatであることと、review済み `terms_check` が1個だけ存在してcheckedであることを再検証します。Doneそのものはterms consent・seat hold成立・購入承認の証明ではなく、terms acknowledgementの証拠はprovider controlのchecked stateだけです。元のsemantic mutationは自動replayしません。物理Gate 0b acceptanceが完了するまで `seatSelection=false` / `checkoutPreparation=false` を維持します。

## Browser Handoff — TOHO Gate 0b

このremote surfaceは一般purpose browser takeoverではなく、#50 Gate 0bのbounded physical validation用です。

- `CINEMA_REMOTE_TAKEOVER=true` はloopback HTTP server + authenticated HTTPS gatewayを必須とする。
- Cloudflare Accessのexact email + Access JWTをnon-secret principal bindingへ変換し、locatorを別principalへ再利用させない。
- `CINEMA_WEBRTC_TAKEOVER_HOST_EXECUTABLE` はabsolute path必須。macOS/Linuxのみで、headed Chrome + server-owned child PIDが必要。
- Handoffへ渡すtargetはcurrent dedicated Chrome PIDだけ。Cinemaはwindow discovery、framebuffer、SDP/ICE/RTP、raw Human inputを扱わない。
- Gate 0b input policyはpointer/scrollのみ。text/keyはHandoff server policyで拒否する。
- Done/revoke後、Cinemaはcurrent provider/action binding、exact selected seat set、review済み `terms_check` のchecked stateをfresh read-only verificationし、失敗時はHumanへ戻すかfail closedする。`terms_check` はHumanだけが操作し、Cinemaはclick/change eventを発行しない。
- Cloud Run `CINEMA_REMOTE_MODE=true` はheadless必須なので、このheaded Browser Handoffとは意図的に両立しない。

## Invocation ownership

現在のstdio deploymentではlogical principal bindingとして `local-stdio` を使い、requestStateをさらにexact tool name、canonical args digest、intervention id、resource epoch、resume strategyへbindします。

intervention作成とowner claimの周囲でbrowser operationをserializeし、別invocationがunowned interventionをraceで奪えないようにします。fresh `awaiting_human` を過ぎたmissing/mismatched ownerはrebindできません。

将来remote multi-user化する場合、handoffをremote exposureする前に `local-stdio` をauthenticated non-secret principal bindingへ置換する必要があります。

## Verification

HumanがContinueを選んだ後:

1. Human authorityを `verifying` へ移しresource epochを進める。
2. current top-level pageがofficial provider domainへ戻っていることをCinema側で確認する。
3. access challenge / sign-in / consentが残っていないことを確認する。
4. verification失敗時はHumanへ戻すかfail closedする。
5. 成功しても返すのはresume decisionだけで、interrupted transactionを暗黙実行しない。

## Non-goals

- CAPTCHA/challenge solving / bypass
- anti-bot evasion、stealth/fingerprint spoofing、proxy rotation
- credential/OTP/MFA/payment dataのMCP transport
- 現在disabledのseat/checkout/purchase capability有効化
- Human completionをtransaction approvalとして扱うこと
- stateful/consequential actionのautomatic replay
- generic arbitrary-browser automation

## Testing

通常CIはdeterministic unit testだけを使用し、policy mapping、authority/epoch、exact requestState binding、owner/race exclusion、transaction confirmation invalidation、immutable upstream pin、provider capability invariantを検証します。

live smokeは低頻度read-only確認です。challengeを意図的に発生させず、自然発生した場合もbypassせず停止します。

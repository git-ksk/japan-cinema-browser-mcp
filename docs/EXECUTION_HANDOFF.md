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
- optional durable checkpoint / first-class Browser / Window Handoff module

Japan Cinema側には次を残します。

- provider-reviewed checkout boundaryから明示的にHuman Handoffを開始する判断（Phase 4ではgeneric detectorとは別のnarrow entry pointを使う）
- 自然発生したaccess challenge/CAPTCHA、sign-in/authentication、consentの検出/classification
- official provider URL / capability allowlist
- current page / postcondition verification
- provider adapter behavior
- transaction / purchase-confirmation policy
- どのoperation classをreplay可能にするかの判断

通常のHuman interventionは引き続きdedicated local Chromeで直接完了できます。2026-08-25のTOHO Gate 0b physical acceptanceはupstream `BrowserHandoffAdapter` のWebRTC経路で実施しました。現在のGate 1 physical acceptanceは、WebRTC/ICE/STUN/TURNを一切起動しないfirst-class `WindowWebSocketHandoffAdapter` のWSS-only経路へ切り替えています。Cinemaはintervention/principal、exact managed Chrome PID + macOS CGWindowID、明示input policyだけを渡し、WSS session/generation、exact-window capture/input、reconnect、fence/revokeをHandoffへ委譲します。Cinema側でCDP screenshot/input takeoverやWebSocket brokerを再実装しません。

Gate 0b / Gate 1のhistorical/bounded acceptance input policyは `tap=true / scroll=true / text=false / key=false` のままです。製品既定のFull Checkout HandoffだけはHumanがPII/paymentをbrowserへ直接入力する必要があるため `tap/scroll/text/key=true` を許可します。ただし入力内容はHandoff transportからCinemaのMCP state/log/resultへ戻しません。WSS-only Window Handoffはheadedなowned Chrome processとexactly one visible layer-0 macOS windowを必須とし、`CINEMA_HEADLESS=true` やexternal CDPとの併用はfail closedします。公開HTTPS/WSSは専用loopback listenerの前段に置くCloudflare Tunnel + Accessだけが提供します。

## Intervention detection

browser-side detectionからhandoffへ返すのはbounded categoryだけです。

- `access_challenge`
- `sign_in`
- `consent`
- `seat_decision`（TOHO Gate 0bのreviewed Human-only boundaryのみ）
- `checkout`（TOHO Full Checkout Handoff。全購入操作はHuman-owned）

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

Execution HandoffはAgentのtransaction capabilityを変更しません。TOHOでは別capability `humanCheckoutHandoff=true` により、read-only seat preflight後の操作権だけをHumanへ渡します。Agentのseat click / terms / PII / payment / final submitは実行しません。

Human intervention開始時にprepared purchase confirmationを全破棄します。そのためlogin、consent、CAPTCHA/access challenge、その他manual stepをまたいで以前のconfirmationを再利用できません。

Human completionはpurchase approvalではありません。将来final purchaseを有効化する場合も、provider capability、runtime purchase flag、current provider/page verification、fresh one-shot material confirmation、final-control verificationをすべて別に満たす必要があります。ambiguous submission outcomeはautomatic retryしません。

Phase 4 TOHO checkout continuationでは、reviewed consent boundaryでexplicit interventionを作り、Human完了後も元のsemantic mutationをretryしません。A1/A2ではbounded `reviewed_checkout_boundary` action（provider/boundary/continuation digestのみ）とprocess-local one-shot bindingを実装済みです。bindingはexact browser target / provider / intent / showtime / selected seats / pre-Human fingerprintsへbindし、cancel、browser reset、TTL、owned context mismatchで破棄します。HumanがContinueだけ返してpre-consent controlが残っている場合はverificationでHumanへ戻します。fresh `prepare_checkout`がcurrent rendered stageをpositiveに再検証できるまでbindingはconsumeしません。詳細は [`PHASE4_TOHO_CONTINUATION_DESIGN.md`](./PHASE4_TOHO_CONTINUATION_DESIGN.md) を参照してください。

2026-08-17のB1 preflightでは、TOHOのcurrent rendered flowにlegal consentより前の `確認する` seat-decision stepがあることを再確認しました。Agent側の座席画像直接activationをそのstepと同一視せず、current adapterは通常automationでは引き続き`UNREVIEWED_INTERACTION`で停止します。Gate 0bではone exact seat intentにbindingしたHuman-only `seat_decision` interventionを作り、当時はHandoff WebRTC surface上でpointer/scrollだけ許可してphysical acceptanceを完了しました。Gate 1では同じsemantic boundaryをWSS-only Window Handoffへ載せ替えます。physical sequenceは `exact seat選択 → 確認するを1回 → サイト自身の terms_check をHumanが明示的にON → Handoff Done` に固定し、`利用規約に同意して次へ` は押しません。Done後、Cinemaはread-onlyでTOHO自身の購入フォーム `bookSeatIntForm.seat_no` がexact seat 1件だけを保持し、rendered `#seatList2` も同じ1席を表示していること、さらにreview済み `terms_check` が1個だけ存在してcheckedであることを再検証します。seat画像の `alt=...選択中` は補助diagnosticに留め、visibility依存の成功条件にはしません。Doneそのものはterms consent・seat hold成立・購入承認の証明ではなく、terms acknowledgementの証拠はprovider controlのchecked stateだけです。元のsemantic mutationは自動replayしません。Gate 1のhold/timer/release semanticsと後続ticket boundaryがphysical reviewを通るまで `seatSelection=false` / `checkoutPreparation=false` を維持します。


## TOHO Full Checkout Handoff — v0.4 default

`start_checkout_handoff` はTOHOの既定購入導線です。Agentはexact showtime seat mapを2回readし、context/layout/stateが安定し、seatIds指定時はその席がavailable、未指定時は少なくとも1席availableの場合だけHandoffを開始します。その後は座席選択から実購入までHumanが操作します。Gate 0b / Gate 1 / B2 / B3の分割フローはphysical evidenceとoptional automation実装として残しますが、既定UXでは往復しません。

- input policy: `tap=true / scroll=true / text=true / key=true`
- exact managed Chrome PID + exactly-one macOS CGWindowIDへbinding
- authenticated short-lived WSS locator、intervention/principal/resource epochへbinding、cancel/resetでrevoke
- takeover TTL既定は30分、設定上限30分。TOHOの15分seat-hold windowより短いTTLでHuman checkoutが途中切断されないための値で、locatorは引き続きintervention-boundかつ即時revoke可能
- known in-progress routes（J01/J02/J2030/J2055）でDoneした場合は `HUMAN_ACTION_REQUIRED` として新generationへ戻す
- external payment/auth surfaceでDoneした場合もTOHO公式surfaceへ戻るまでsemantic verificationを完了しない
- Agentはfinal purchase controlを押さず、`purchaseSubmission=false` を維持する
- actual paid purchase後のexact success markerは未受入。paid physical acceptance完了まではpost-Handoff outcomeを `unverified_paid_acceptance_pending` とし、購入成功と断定しない

## Remote Window Handoff — TOHO Gate 1 WSS acceptance

このremote surfaceは一般purpose browser takeoverではなく、#50 Gate 1のbounded physical validation用です。Gate 0bのWebRTC acceptance evidenceは履歴として保持し、current runはWSS-onlyです。

- `CINEMA_REMOTE_TAKEOVER=true` はdedicated loopback takeover listener + authenticated HTTPS/WSS gatewayを必須とする。default local portは `48561`。
- Cloudflare Accessのexact email + Access JWTをnon-secret principal bindingへ変換し、locatorを別principalへ再利用させない。
- `CINEMA_TAKEOVER_HOST_EXECUTABLE` はabsolute path必須。current reviewed WSS pathはmacOSのみで、headed Chrome + server-owned child PIDが必要。helperはHandoff v0.4.1のreview済み `takeover-webrtc-host` binaryをWSS exact-window backendとして再利用する。
- CinemaはmacOS WindowServerをread-onlyで照合し、dedicated Chrome PIDが所有するvisible layer-0 windowがexactly oneの場合だけCGWindowIDを採用する。0件/複数件はfail closed。Handoffへはexact PID + CGWindowIDを渡し、framebuffer/raw Human inputはCinemaへ戻さない。WSS-onlyなのでSDP/ICE/STUN/TURNは存在しない。
- Gate 1 input policyはpointer/scrollのみ。text/keyはHandoff server policyで拒否する。
- HumanがDoneしてもWSS generationを完了扱いにしない。Cinemaがfresh semantic verificationを行い、Gate 0bではprovider-owned `bookSeatIntForm.seat_no` + rendered `#seatList2` + Human-checked `terms_check`、Gate 1ではsame-host immediate `TNPI2010J02.do` を確認した後だけHandoff `completeAfterVerification` を呼ぶ。verification失敗時はHumanへ戻すかfail closedし、Cinemaは`terms_check`やadvance controlへclick/change eventを発行しない。
- Cloud Run `CINEMA_REMOTE_MODE=true` はheadless必須なので、このheaded Window Handoffとは意図的に両立しない。

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

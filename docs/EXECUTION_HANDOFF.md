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
- optional durable checkpoint / browser-takeover module

Japan Cinema側には次を残します。

- 自然発生したaccess challenge/CAPTCHA、sign-in/authentication、consentの検出/classification
- official provider URL / capability allowlist
- current page / postcondition verification
- provider adapter behavior
- transaction / purchase-confirmation policy
- どのoperation classをreplay可能にするかの判断

Cinemaでは現時点でupstream browser-takeover transportを利用しません。Human interventionはdedicated local Chromeで直接完了します。

## Intervention detection

browser-side detectionからhandoffへ返すのはbounded categoryだけです。

- `access_challenge`
- `sign_in`
- `consent`

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

# コンプライアンス方針

この文書は `japan-cinema-browser-mcp` の実装・運用における正本です。

## 目的

本プロジェクトは、日本の映画館公式Webサイトをユーザー本人の要求に応じて操作するBrowser-first MCPです。

映画館データの収集・再配布、非公式API提供、転売支援、大量予約、アクセス制御回避を目的としません。

## 必須Invariant

### ユーザー要求時のみ動作する

providerへのアクセスは、ユーザーの現在の要求、またはその要求から直接続くinteractive booking flowに限ります。

禁止:

- scheduled crawling
- background polling
- site-wide indexing
- 全劇場/全上映のbulk harvesting
- provider inventoryの継続監視

### 公式公開Web UIのみ利用する

通常のブラウザで利用できる公開UIを操作します。

禁止:

- private/internal endpointの探索
- Webアプリ内部APIを解析して直接呼ぶ
- hidden JSON endpointへの依存
- network interceptionを使った非公開API発見

### Access Controlを回避しない

以下を突破・迂回しません。

- CAPTCHA
- anti-bot protection
- login control
- rate limit
- geographic restriction
- MFA / OTP
- 3-D Secure
- waiting room
- その他のtechnical restriction

表示された場合は自動操作を停止し、必要に応じてユーザーへ操作を返します。

### データを必要最小限にする

永続保存しないもの:

- cinema HTML
- full page snapshot
- showtime dataset
- seat map / seat availability history
- provider image
- Cookie
- session token
- password
- card number
- CVV/CVC
- OTP/MFA code
- payment credential

active workflowに必要な最小限の事実だけを短時間memory上で扱います。

purchase confirmationも短いTTLとone-shotを必須とします。

### 機密入力はユーザー自身が行う

MCP tool argumentとして以下を受け取りません。

- password / passcode
- card number
- CVV/CVC
- OTP
- MFA code
- verification code
- その他同等のauthentication/payment secret

必要な場合はユーザーがbrowser上で直接入力します。

### 重大操作はFail Closed

通常のgeneric navigationは、明示レビュー済みのpublic read surfaceだけをpositive allow-listで許可します。同一公式domain配下でも任意path/subdomainや未レビューrouteへは進みません。

通常のgeneric click/fillはprovider capability matrixをruntime boundaryとして扱い、seat map / seat selection / checkout preparation / purchase submissionに相当する操作をcapability無効時に拒否します。未知のscript-driven controlや未レビューfieldもfail closedし、無効capabilityをfuzzy automationへfallbackしません。

provider adapter内部のread-only操作はgeneric policyと分離し、rendered public UIから採用・検証したexplicit route/controlだけを利用します。購入・支払・注文・予約の最終確定に見えるcontrolはadapter内部でも通常clickしません。

最終購入を実装する場合は、別のconfirmation flowを通します。

confirmationでは可能な限り以下を固定します。

- provider
- 劇場
- 作品
- 日付
- 上映時刻
- 座席
- 券種
- 枚数
- 金額
- current browser URL/context
- 対象final control

confirmationは:

- 重大操作の直前に作る
- 短時間でexpire
- single-use
- material context変更で無効化
- userの明示承認なしに利用しない

Final purchase executionはruntime defaultで無効にします。

### Ambiguous Purchaseを再実行しない

最終submit後にtimeout/disconnect等で結果が確定できない場合は `PURCHASE_UNKNOWN` と扱います。

この状態では絶対に自動replay/retryしません。

ユーザーがprovider側で購入結果を確認するまで、新しいsubmitへ進みません。

### Abusive Bookingを支援しない

禁止:

- resale目的の自動購入
- speculative bulk booking
- mass seat hold
- inventory hoarding
- 他ユーザーのavailabilityを意図的に悪化させる操作

seat selectionは、1回のuser-intended bookingを対象にします。

### Provider側ルールを優先する

providerの現行規約、サイトポリシー、UI制約、アクセス制御と機能が衝突する場合、そのproviderのcapabilityを無効化します。

制約を別経路で迂回しません。

## Browser Architecture

標準構成は `maps-browser-mcp` と同じ軽量な方式を採用します。

- 専用local Chrome profile
- Chrome DevTools Protocol（CDP）
- `chrome-remote-interface`
- Playwrightなし
- bundled Chromiumなし

専用profileを優先する理由は、映画館sessionをユーザーの通常browser profileから分離しつつ、browser stateを端末内に保持できるためです。

external CDP attachはprofile isolationが弱くなるため明示opt-inです。

## Modelへ返すデータ

返すのはactive requestに必要なcompactなprovider-neutral factsだけです。

raw HTMLや大きなDOM dumpを返しません。

Web pageから得たtextはuntrusted external dataとして扱い、MCP/runtimeへの命令として解釈しません。

## 初期Provider Scope

allow-list対象:

- `tohotheater.jp`
- `aeoncinema.com`
- `109cinemas.net`

原則HTTPSのみです。

provider domain配下のsubdomain追加や、third-party payment/identity domainをautomation対象へ追加する場合は、実装前に個別レビューします。

## Public化Gate

PrivateからPublicへ変更する前に最低限以下を実施します。

1. providerの現行規約/サイトポリシー再確認
2. `docs/providers/*` のreview date更新
3. Git全履歴secret scan
4. Cookie/token/payment/auth data混入確認
5. private/internal API利用ゼロ確認
6. destructive/consequential toolのconfirmation gate確認
7. typecheck / unit test / build
8. non-purchasing live UI smoke test
9. `PURCHASE_UNKNOWN` / duplicate submission safety確認
10. trademark / non-affiliation表記確認
11. documentationと実装が一致していることを確認

最初のPublic releaseにfinal purchase capabilityは必須ではありません。

## Provider Review

現在のprovider状態は [`docs/PROVIDERS.md`](./docs/PROVIDERS.md) を参照します。

個別確認事項:

- [`docs/providers/TOHO.md`](./docs/providers/TOHO.md)
- [`docs/providers/AEON.md`](./docs/providers/AEON.md)
- [`docs/providers/109.md`](./docs/providers/109.md)

## 非公式プロジェクト

本プロジェクトはTOHOシネマズ、イオンシネマ、109シネマズおよび各運営会社と提携・後援・公認関係にありません。

provider名は相互運用対象を識別するためにのみ使用します。

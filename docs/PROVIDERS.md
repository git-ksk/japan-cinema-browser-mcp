# Provider対応方針・レビュー状況

初回Private MVPレビュー日: 2026-08-12  
TOHO Phase 1 read adapterレビュー日: 2026-08-13

この文書は実装上の対応範囲と確認状況を管理するためのものです。法的助言を目的としたものではありません。購入機能を有効化する前、およびPublic化前には、各providerの現行利用規約・サイトポリシー・実際のUIを再確認します。

## 現在の対応状況

| Provider | 公式root | 現在の自動化範囲 | 購入 |
|---|---|---|---|
| TOHOシネマズ | `https://www.tohotheater.jp/` | 公式domain内navigation / bounded read / 劇場・日付・作品・上映回semantic read | 無効。seat/checkout未レビュー |
| イオンシネマ | `https://www.aeoncinema.com/` | 公式domain内navigation / bounded read | 無効。live flow確認前 |
| 109シネマズ | `https://109cinemas.net/` | 公式domain内navigation / bounded read | 無効。live flow確認前 |

## 共通ルール

- 公式Web UIのみを自動操作対象にする
- private/internal endpointを探索・直接利用しない
- 上映情報、座席表、HTML、画像、Cookie、決済情報を永続保存しない
- 定期クロールやprovider-wide aggregationをしない
- CAPTCHA、MFA、OTP、3-D Secure、待機列、未レビューのthird-party payment/identity surfaceはHuman Handoff
- generic clickから最終購入/決済/予約確定を実行しない
- provider-specific selectorはvisible public UIに限定する
- UI構造が変わったら推測せずfail closed

## Capability Matrix

| Capability | TOHO | AEON | 109 |
|---|---:|---:|---:|
| 公式rootを開く | ✅ | ✅ | ✅ |
| Generic bounded read | ✅ | ✅ | ✅ |
| 劇場一覧/選択semantic | ✅ | 🟡 | 🟡 |
| 上映情報semantic | ✅ | 🟡 | 🟡 |
| 座席表read | ⬜ | ⬜ | ⬜ |
| 座席選択 | ⬜ | ⬜ | ⬜ |
| Checkout preparation | ⬜ | ⬜ | ⬜ |
| Final purchase | ⬜ | ⬜ | ⬜ |

`✅` はそのcapabilityについて実装済み、`🟡` は次に確認/実装する項目、`⬜` は未着手を表します。

TOHOの`✅`はread-only adapterの実装を表し、seat selectionやpurchase capabilityの解禁を意味しません。

## TOHO Phase 1 Read Adapter

2026-08-13時点で以下の公開導線を確認しています。

- 劇場一覧: `https://www.tohotheater.jp/theater/find.html`
- 各劇場の上映スケジュール: visible theater linkから `*.tohotheater.jp/net/schedule/.../TNPI2000J01.do` へ遷移

実装はChrome + CDPでrendered public DOMだけを読みます。network interceptionやprivate/internal API直接利用はありません。

MCP tools:

- `list_theaters` — 現在TOHOのみsemantic capability有効
- `get_showtimes` — 現在TOHOのみsemantic capability有効

`get_showtimes` は劇場・日付・作品・上映時刻をcompact structured factsへ正規化します。日付切替後はselected stateを再確認し、movie/showtime groupingやUI stateが曖昧なら部分結果を推測せずfail closedします。

TOHOの公開UIには、複数の劇場名が1つのschedule routeを共有するケースがあります。Phase 1 adapterはこれをaliasを持つschedule groupとして扱い、単純な「schedule ID = 1劇場名」前提には依存しません。

非購入live smokeは `npm run smoke:toho` として低頻度・明示実行用に分離し、通常CIには含めません。

## Provider Capabilityを上げる前のチェック

1. 現行の公式navigation/booking domainを確認
2. planned capabilityに関係する利用規約/サイトポリシーを確認
3. private APIに依存せず、visible UIだけで状態を認識できることを確認
4. theater/date/movie/showtime/seat等のsemantic selectorを実装
5. changed/ambiguous UIで `UI_STATE_CHANGED` 等にfail closedすることを確認
6. login/payment secretがユーザー入力のままであることを確認
7. CAPTCHA/MFA/3DS等で自動処理が停止することを確認
8. checkout preparationとfinal submissionが分離されていることを確認
9. final purchaseではbrowser contextとmaterial transaction summaryをconfirmationへbinding
10. provider固有の制約を個別documentへ記録

## Provider別文書

- [`providers/TOHO.md`](./providers/TOHO.md)
- [`providers/AEON.md`](./providers/AEON.md)
- [`providers/109.md`](./providers/109.md)

## Feature Parityについて

3社で同じ機能を同時に提供することは必須ではありません。

TOHOでshowtimesが有効でも、AEON/109はgeneric bounded readのまま維持できます。無効化されたcapabilityをgeneric fuzzy automationで黙って代替しません。

無理に同等機能へ揃えるより、providerごとに安全に使えるcapabilityだけを正確にadvertiseする方針です。

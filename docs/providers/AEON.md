# イオンシネマ Providerメモ

Provider ID: `aeon`

公式root: `https://www.aeoncinema.com/`

初回Private MVPレビュー日: 2026-08-12

## 現在のCapability

| Capability | 状態 | 備考 |
|---|---|---|
| 公式rootを開く | 有効 | domain allow-listあり |
| Generic bounded read | 有効 | page内容は永続保存しない |
| 劇場選択semantic | 未実装 | live UI確認が必要 |
| 上映情報semantic | 未実装 | live UI確認が必要 |
| Seat map read | 無効 | 未レビュー |
| Seat selection | 無効 | 未レビュー |
| Checkout preparation | 無効 | 未レビュー |
| Final purchase | 無効 | 別途厳格レビューが必要 |

## 実装境界

イオンシネマadapterは、通常ユーザーが利用する公開Web UIの操作支援に限定します。

やらないこと:

- private/internal APIを探索・直接利用する
- 定期的に劇場/上映情報を巡回する
- seat availabilityを履歴DB化する
- geographic/access challengeを回避する
- password/card/CVV/OTP/MFAをMCP引数へ渡す

## Read Adapter確認項目

1. 現在の劇場選択導線を確認
2. theater/date/movie/showtimeのsemantic境界を確認
3. 予約導線でdomain遷移がある場合は個別確認
4. 上映方式、字幕/吹替等のvisible labelを正規化
5. current source URLを結果へ付与
6. UI変更時はgeneric fuzzy操作へfallbackせずfail closed

## Seat Map確認項目

- seat mapへ入ることでholdが発生するか
- seat click時点とhold成立時点
- accessible/special seat等の扱い
- row/seat geometryの読み取り方法
- recommendationだけでholdを作らない設計が可能か

## Checkout / Purchase確認項目

Checkout preparation前:

- 会員/非会員フローを確認
- ログインや本人確認はHuman Handoff
- payment credentialはbrowser上でユーザー入力
- 未レビューthird-party domainではautomation停止

Final purchase前:

- 現行規約/サイトポリシーを再確認
- exact final button/transaction stateを確認
- confirmationにprovider/theater/movie/time/seats/ticket types/amount/current URLをbinding
- duplicate submission防止
- `PURCHASE_UNKNOWN`をterminal扱い

## 方針

イオンシネマ固有の制約がTOHO/109と異なる場合、共通化を優先して制約を弱めません。provider固有capabilityとして扱います。

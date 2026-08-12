# TOHOシネマズ Providerメモ

Provider ID: `toho`

公式root: `https://www.tohotheater.jp/`

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

TOHO adapterは、通常ユーザーが操作できる公開Web UIだけを対象にします。

やらないこと:

- private/internal endpointへ依存する
- 上映/座席inventoryを蓄積する
- access challengeを回避する
- 位置だけを頼りにfinal purchase controlを推測clickする
- password/card/OTP等をMCP引数で扱う

## Read Adapter確認項目

1. 現在の劇場選択導線を確認
2. visible UI上でstableな劇場識別方法を確認
3. 日付切り替え挙動を確認
4. 作品と上映回のgroupingを確認
5. IMAX等の上映方式、字幕/吹替表記を確認
6. 共通 `Showtime` schemaへ正規化
7. duplicate/ambiguous/missing stateでfail closed
8. 別domainへの遷移が必要な場合はallow-list変更前に個別レビュー

## Seat Map確認項目

- どの操作時点で座席仮押さえが発生するか
- available/unavailable等をvisible UIから識別できるか
- row/seat labelを正規化できるか
- 可能な限りseat click前にrecommendationを計算できるか
- seat state変更をどう検出するか

## Checkout / Purchase確認項目

Checkout automation前:

- login/auth/paymentのHuman-only境界を確認
- sensitive fieldはユーザー入力のままにする
- third-party surfaceへ遷移する場合は停止する
- transaction summaryを正規化する

Final purchase前:

- 現行規約/サイトポリシーを再確認
- exact final controlを確認
- duplicate submission防止
- `PURCHASE_UNKNOWN` handling
- timeout/disconnect後の自動replay禁止

## 方針

他providerとfeature parityを無理に揃えません。TOHOで安全に確認できたcapabilityだけを有効化します。

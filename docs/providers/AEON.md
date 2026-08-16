# イオンシネマ Providerメモ

Provider ID: `aeon`

公式root: `https://www.aeoncinema.com/`

初回Private MVPレビュー日: 2026-08-12  
Phase 1 read adapterレビュー日: 2026-08-13  
公式サイトポリシー再確認日: 2026-08-13

## 現在のCapability

| Capability | 状態 | 備考 |
|---|---|---|
| 公式rootを開く | 有効 | domain allow-listあり |
| Generic bounded read | 有効 | page内容は永続保存しない |
| 劇場選択semantic | 有効 | 公式「劇場を探す」UIのみ |
| 上映情報semantic | 有効 | rendered public schedule UIのみ |
| Seat map read | 無効 | 未レビュー |
| Seat selection | 無効 | 未レビュー |
| Checkout preparation | 無効 | 未レビュー |
| Final purchase | 無効 | `purchaseSubmission=false` をruntimeでも強制 |

## 公式サイトポリシー確認

2026-08-13にイオンシネマ公式サイトポリシーとe席リザーブ利用規約を再確認しました。

明示されている主な境界:

- 権利侵害をしない
- 当社の承認なく営利目的の行為またはその準備を行わない
- 本サイト/e席リザーブの運営を妨げない
- 劇場および運営会社の営業を妨げない
- その他不適切と判断される行為を行わない

この確認は法的判断ではありません。Phase 1ではリスクを広げないため、ユーザー要求時の低頻度な公式公開UI readに限定し、定期クロール、全国上映DB化、素材の再配布、private/internal endpoint利用、challenge回避、購入自動化を行いません。営利利用、materialなautomation surface変更、transaction capabilityの解禁前には再レビューします。

## Phase 1で確認した公開導線

- 劇場一覧: `https://www.aeoncinema.com/theater/`
- 上映スケジュール: `https://theater.aeoncinema.com/theaters/{slug}/`
- 日付指定: 上記public schedule pageの `?date=YYYYMMDD`

2026-08-13時点の公式公開UIで、劇場一覧、日付、作品名、上映時間range、screen表示、`予約購入` controlがrendered page上に存在することを確認しています。

Phase 1 adapterはこれらのrendered public factsだけを読みます。`schedule.json` 等のprivate/internal endpointを直接利用しません。network interceptionも行いません。

## Read Adapter

### `list_theaters`

公式「劇場を探す」ページのvisible theater controlsだけを対象にします。

- 都道府県見出し配下のvisible controlを抽出
- `IMAXレーザー`、`4DX`、`ULTIRA`、`Dolby Atmos` 等の施設labelを劇場名本体から分離
- explicitなpublic schedule URLがDOMに存在する場合だけ採用
- routeがDOMから確定できない場合はslugを推測せず、後続の公式UI選択経路を使う
- 劇場一覧がSPA/JS描画途中ならbounded pollingでreviewed semantic ready-stateを待つ
- 劇場件数がreviewed structureから大きく外れた場合はfail closed

### `get_showtimes`

1. `list_theaters` と同じsemanticで劇場を一意に解決
2. public schedule URLが確定済みなら直接その公開ページへ遷移
3. URLが確定していない場合は公式劇場選択controlをclickし、公式の「上映スケジュールを確認する」導線からschedule pageへ進む
4. requested dateは同じpublic schedule routeの `?date=YYYYMMDD` で表示
5. current hostname/path/date queryを再検証
6. SPAのrendered showtime stateが揃うまでbounded polling
7. rendered DOMから movie / start / end / screen / format / 字幕・吹替 / explicit availabilityだけをcompact structured factsへ変換

`予約購入` はcontextとして読めても、Phase 1 adapterからclickしません。

## Fail-Closed条件

以下では部分結果を推測して返しません。

- 劇場一覧heading/件数がreviewed structureと一致しない
- semantic ready-stateがbounded polling内に成立しない
- 劇場名が一意に解決できない
- schedule routeが `theater.aeoncinema.com/theaters/{slug}` から外れる
- requested date navigation後にpath/queryが一致しない
- schedule pageの劇場identityが一致しない
- 1つのDOM groupから複数の上映時間rangeが分離不能
- time rangeを一意なmovie titleへ結び付けられない
- showtimeが0件なのにexplicit empty stateもない

## Structured Facts

上映回ごとに必要なfactだけを返します。

- provider
- theater ID / name
- date
- movie
- start/end time
- format: IMAX / IMAX LASER / 4DX / MX4D / Dolby Atmos / THX / ULTIRA等
- subtitle / dubbed
- screen
- availability（明示表示がある場合のみ。通常は `unknown`）
- source URL

raw HTML、full DOM、Cookie、token、private API responseは返却・永続保存しません。

## テスト

Unit:

- 劇場label / facility suffix正規化
- explicit official public schedule URL validation / route非推測
- invalid calendar date拒否
- movie/showtime/screen/format/language正規化
- unresolved movie grouping fail closed
- ambiguous time group fail closed
- capability matrix / purchase disabled invariant

Manual non-purchase smoke:

```bash
npm run smoke:aeon
```

smokeは公式劇場一覧と上映ページを読むだけです。seat selection / checkout / purchaseは行いません。通常CIには含めません。2026-08-13の実ブラウザlive smokeはgreenを確認済みです。

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
- provider `purchaseSubmission` capabilityを明示的に有効化

## 方針

イオンシネマ固有の制約がTOHO/109と異なる場合、共通化を優先して制約を弱めません。provider固有capabilityとして扱います。

## Phase 3 Seat Intelligence Discovery — 2026-08-17

Phase 3 Discoveryでは、港北ニュータウンの現行schedule surfaceでmovie cardをvisible `上映時間を見る`から展開し、上映回ごとのexact `予約購入` buttonまで確認しました。追加validationでbuttonをactivateしましたが、isolated headless/headed Chromeのどちらでもnew targetが`about:blank`のまま残り、live purchase seat-mapには到達していません。

公式公開情報から確認できた点:

- `予約購入`後にseat selection stepがある
- 会員にならず購入するflowがある
- selected seatはオレンジ色に変化する
- seat availabilityは随時更新される
- 他ユーザーの予約が完了しなかった場合、seatが再度availableになる場合がある
- 港北ニュータウンの施設UIはscreen別の`座席図を見る`とseat-type/countを公開
- D-BOX / Gold Class等はavailabilityではなくseat attributeとして扱う必要がある
- reviewed static seat-mapでは車椅子spaceはe席リザーブ対象外と案内される

一方、holdがどの操作で開始し何分継続するかは公式公開説明から確定できず、live seat-mapにもまだ到達できていません。現在の未解決点はseat-map表示が危険という証拠ではなく、public `予約購入` buttonからのbrowser target/navigation handlingです（#36）。hidden route推測やnetwork interceptionへ逃げず、`seatMap=false / seatSelection=false`を維持します。

Discovery詳細: [`../PHASE3_SEAT_DISCOVERY.md`](../PHASE3_SEAT_DISCOVERY.md)

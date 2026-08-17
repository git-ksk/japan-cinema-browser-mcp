# Provider対応方針・レビュー状況

- 初回Private MVPレビュー日: 2026-08-12
- TOHO Phase 1 read adapterレビュー日: 2026-08-13
- AEON Phase 1 read adapterレビュー日: 2026-08-13
- 109 Phase 1 read adapterレビュー日: 2026-08-13
- Public safety hardening / live smoke再確認日: 2026-08-15
- TOHO Phase 3 read-only seat adapterレビュー日: 2026-08-17
- AEON Phase 3 read-only seat adapterレビュー日: 2026-08-17

この文書は実装上の対応範囲と確認状況を管理するためのものです。法的助言を目的としたものではありません。購入機能・seat/checkout capabilityを有効化する前、materialなautomation surface変更時、またはprovider規約/UI変更が疑われる場合は、各providerの現行利用規約・サイトポリシー・実際のUIを再確認します。Public repositoryであること自体はproviderの許諾や法的適合を意味しません。

## 現在の対応状況

| Provider | 公式root | 現在の自動化範囲 | 購入 |
|---|---|---|---|
| TOHOシネマズ | `https://www.tohotheater.jp/` | reviewed public read surface / bounded read / 劇場・日付・作品・上映回 + read-only座席表semantic read | 購入無効。seat selection / checkout未レビュー |
| イオンシネマ | `https://www.aeoncinema.com/` | reviewed public read surface / bounded read / 劇場・日付・作品・上映回 + read-only座席表semantic read | 購入無効。seat selection / checkout未レビュー |
| 109シネマズ | `https://109cinemas.net/` | reviewed public read surface / bounded read / 劇場・日付・作品・上映回 + read-only座席表semantic read | 購入無効。seat selection / checkout未レビュー |

## 共通ルール

- 公式Web UIのみを自動操作対象にする
- private/internal endpointを探索・直接利用しない
- 上映情報、座席表、HTML、画像、Cookie、決済情報を永続保存しない
- 定期クロールやprovider-wide aggregationをしない
- CAPTCHA、MFA、OTP、3-D Secure、待機列、未レビューのthird-party payment/identity surfaceはHuman Handoff
- generic navigationはreview済みpublic read surfaceだけをpositive allow-listし、同一domain内の任意path/subdomainへ広げない
- generic click/fillからseat/checkout/purchase capabilityを迂回しない
- generic clickから最終購入/決済/予約確定を実行しない
- provider-specific selectorはvisible public UIに限定する
- UI構造が変わったら推測せずfail closed
- provider capability matrixをruntime policy boundaryとして強制する

## Capability Matrix

| Capability | TOHO | AEON | 109 |
|---|---:|---:|---:|
| 公式rootを開く | ✅ | ✅ | ✅ |
| Generic bounded read | ✅ | ✅ | ✅ |
| 劇場一覧/選択semantic | ✅ | ✅ | ✅ |
| 上映情報semantic | ✅ | ✅ | ✅ |
| 座席表read | ✅ | ✅ | ✅ |
| 座席選択 | ⬜ | ⬜ | ⬜ |
| Checkout preparation | ⬜ | ⬜ | ⬜ |
| Final purchase | ⬜ | ⬜ | ⬜ |

`✅` はそのcapabilityについて実装済み、`⬜` は未着手を表します。

TOHO / AEON / 109の3社でreview済みread-only `seatMap=true` です。109はseat-map entryで10分session timerが開始しますがselected=0を必須検証します。AEONはactual seatに`active`が1件でもあればfail closedします。`seatSelection=false / checkoutPreparation=false / purchaseSubmission=false` は3社とも維持します。

## Phase 3 Seat Intelligence Discovery — 2026-08-17

TOHO / AEON / 109のseat-map / seat-hold境界を、seat clickなしで再レビューしました。詳細比較とv0.3.0 scopeは [`PHASE3_SEAT_DISCOVERY.md`](./PHASE3_SEAT_DISCOVERY.md) に記録しています。

- TOHO: live `座席指定` までseat clickなしで検証し、entry時selected=0 / visible timerなし。#32でread-only adapterを実装し `seatMap=true` へ昇格
- 109: live seat-map entryで10分session timer開始を確認する一方、`選択座席 0／8席`かつ独立session間のseat-state fingerprint一致を確認。#35でexact rendered public href + checkbox semantic adapterを実装し `seatMap=true`
- AEON: #36でpublic entry safety gateを確立し、#43でreview済みtarget adoption + actual seat DOM normalizationを実装。fresh profile 2本のlive smokeで同一showtimeが168 seats / available 151 / unavailable 17 / premium 18 / wheelchair 2 / active 0となることを確認し `seatMap=true`。screen orientationは明示markerを証明できないため推測せず、recommendationは未対応
- すべてのvalidation / smokeでseat clickは実施していない

`v0.3.0 — Seat Intelligence` では3社のread-only `get_seat_availability` を実装し、`recommend_seats` はscreen orientationをreviewできているTOHOだけで有効です。`select_seats` は含めません。

## TOHO Phase 1 Read Adapter

2026-08-13時点で以下の公開導線を確認しています。

- 劇場一覧: `https://www.tohotheater.jp/theater/find.html`
- 各劇場の上映スケジュール: visible theater linkから `*.tohotheater.jp/net/schedule/.../TNPI2000J01.do` へ遷移

実装はChrome + CDPでrendered public DOMだけを読みます。network interceptionやprivate/internal API直接利用はありません。

`get_showtimes` は劇場・日付・作品・上映時刻をcompact structured factsへ正規化します。日付切替後はselected stateを再確認し、movie/showtime groupingやUI stateが曖昧なら部分結果を推測せずfail closedします。

TOHOの公開UIには、複数の劇場名が1つのschedule routeを共有するケースがあります。Phase 1 adapterはこれをaliasを持つschedule groupとして扱い、単純な「schedule ID = 1劇場名」前提には依存しません。

非購入live smokeは `npm run smoke:toho` として低頻度・明示実行用に分離し、通常CIには含めません。2026-08-13の実ブラウザ確認では、TOHOシネマズ ららぽーと横浜（id `036`）でofficial redirect後もreviewed schedule pathnameとdate identityを維持し、showtimes > 0を確認しました。staticな「販売期間外」rowもrendered public UIから取得し、`unavailable` へ正規化しています。

## AEON Phase 1 Read Adapter

2026-08-13時点で以下の公開導線を確認しています。

- 劇場一覧: `https://www.aeoncinema.com/theater/`
- 各劇場の上映スケジュール: `https://theater.aeoncinema.com/theaters/{slug}/`
- 日付指定: public schedule pageの `?date=YYYYMMDD`

公式公開UI上で、劇場一覧、日付、作品名、上映時間range、screen表示、`予約購入` controlがrendered stateとして確認できるため、read-only adapterはこれらのvisible factsだけを対象にします。

重要な境界:

- `schedule.json` 等のprivate/internal endpointを直接利用しない
- routeがDOMから明示確定できない場合はslugを推測せず、公式劇場選択UIからschedule pageへ進む
- requested date navigation後にhostname/path/queryを再検証
- movie/time groupingが曖昧なら部分結果を返さずfail closed
- `予約購入` はread contextに含まれてもadapterからclickしない

非購入live smokeは `npm run smoke:aeon` として通常CIから分離します。2026-08-13の実ブラウザ確認はgreenで、rendered public UIだけを使うread-only境界を維持しました。

## 109 Phase 1 Read Adapter

2026-08-13時点で以下の公式公開導線・policyを確認しています。

- 劇場一覧: `https://109cinemas.net/` の「109シネマズの劇場」block
- 劇場ページ: rootのvisible linkから `https://109cinemas.net/{slug}/`
- schedule: 劇場ページの日付controlに明示された `https://109cinemas.net/{slug}/schedules/YYYYMMDD.html...`
- 109シネマズ公式サイトポリシー
- 東急レクリエーションの全般サイトポリシー
- チケット購入方法

通常館では `?theater_code=...` の例を確認していますが、プレミアム新宿ではquery形が異なります。adapterはquery仕様を推測・生成せず、rendered public UIのhrefをそのまま採用し、navigation後にhostname/path/query/date/theater identityを再検証します。

公開schedule pageから以下をcompact factへ正規化します。

- movie
- start/end time
- screen
- format
- 字幕/吹替
- explicit availability

`オンラインチケット購入` や上映回の購入導線はvisible read contextとして存在してもadapterからclickしません。

重要なfail-closed条件:

- theater block / schedule sectionがreviewed shapeから外れた
- explicit theater/date routeがofficial exact host/pathから外れた
- lookalike / credentials / non-default port
- wrong theater / wrong date / redirect
- visible date labelとhrefのdate mismatch
- ambiguous time grouping
- movie/screenを一意にbindingできない
- rowsなし + explicit empty stateなし

非購入live smokeは `npm run smoke:109` として通常CIから分離します。2026-08-13の初回実行は `unresolvedGroupCount=44` でfail closedし、現行公開UIの `article → header h2 → ul.timetable → li.theatre → time.start/time.end` 構造をreviewed provider-specific shapeとして反映後、再実行で44 showtimesを取得してgreenを確認しました。

詳細は [`providers/109.md`](./providers/109.md) を参照してください。

## MCP Tools

- `list_theaters` — TOHO / AEON / 109 semantic capability有効
- `get_showtimes` — TOHO / AEON / 109 semantic capability有効
- `get_seat_availability` — TOHOのみ。exact showtimeからread-only seat mapへ入り、seat identity/state/layoutを返す。seat clickなし

無効化されたseat/checkout/purchase capabilityをgeneric fuzzy automationへfallbackしません。Provider adapter内部のread-only navigation/clickはgeneric toolと分離し、rendered public UIから採用したexplicit route/controlと遷移後identityをprovider固有に再検証します。

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

3社のread-only Phase 1 capabilityは揃いましたが、内部UI・route・provider固有schemaまで同一という意味ではありません。

次は共通 `Theater` / `Showtime` schemaを明示し、そのcontractを通して `find_showtimes` を実装します。横断検索でもproviderごとのfail-closed境界を維持し、一社失敗を曖昧な部分結果として隠しません。

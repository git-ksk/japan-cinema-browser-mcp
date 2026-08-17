# TOHOシネマズ Providerメモ

Provider ID: `toho`

公式root: `https://www.tohotheater.jp/`

初回Private MVPレビュー日: 2026-08-12  
Phase 1 read adapterレビュー日: 2026-08-13  
Phase 3 seat adapterレビュー日: 2026-08-17  
Phase 4 checkout Discoveryレビュー日: 2026-08-17

## 現在のCapability

| Capability | 状態 | 備考 |
|---|---|---|
| 公式rootを開く | 有効 | domain allow-listあり |
| Generic bounded read | 有効 | page内容は永続保存しない |
| 劇場一覧/選択semantic | 有効 | 公式劇場一覧のvisible linkのみ |
| 上映情報semantic | 有効 | 劇場・日付・作品・上映回をrendered UIから抽出 |
| Seat map read | 有効 | #32 read-only adapter + #33 freshness/recommendation |
| Seat selection | 無効 | Phase 4 Gate 0でhold trigger / release semanticsを個別reviewするまでfalse |
| Checkout preparation | 無効 | #49 / #50。seat mutation gate通過前に有効化しない |
| Final purchase | 無効 | Phase 5で別途厳格レビューが必要 |

## Phase 1で確認した公式導線

劇場一覧:

```text
https://www.tohotheater.jp/theater/find.html
```

劇場の上映スケジュールは、劇場一覧のvisible linkから同じallow-list対象である `*.tohotheater.jp` 配下へ遷移します。

2026-08-13時点で確認した例:

```text
https://hlo.tohotheater.jp/net/schedule/036/TNPI2000J01.do
```

`036` はTOHOシネマズ ららぽーと横浜のschedule識別子としてvisible theater linkから取得します。

また、1つのschedule routeを複数の劇場名が共有する公開UIもあります。確認済みの例では、TOHOシネマズ 日比谷 / TOHOシネマズ シャンテが同じschedule groupとして表示されます。このためadapterはschedule IDを単一劇場名と決め打ちせず、同じrouteに結び付くvisible theater nameを`aliases`として保持します。

adapterはこの公開Web UIのrendered DOMだけを読みます。network interception、XHR/fetchの解析、hidden JSON endpoint、private/internal APIの直接利用は行いません。

## Read Adapter実装

### 劇場一覧

`list_theaters` では、公式劇場一覧画面上のvisible anchorを対象にします。

採用条件:

- HTTPS
- `tohotheater.jp` またはそのsubdomainに厳密一致
- visible theater link
- `/net/schedule/{3桁}/TNPI2000J01.do` 形式の公開schedule route
- `TOHOシネマズ ...` として読める劇場名

同じschedule ID / routeが設備別一覧などで重複していてもdeduplicateします。同じrouteに複数の劇場名が結び付く場合は、公開UIのgroupingとして`aliases`へまとめます。同一IDが異なるschedule routeを指すなど整合しない状態では `UI_STATE_CHANGED` で停止します。

劇場一覧の抽出数が極端に少ない場合も、UI変更とみなしてfail closedします。

### 日付

`get_showtimes` はvisible date controlから日付を正規化します。

- MCP inputは `YYYY-MM-DD`
- UI上の `M/D` 等はAsia/Tokyoの現在日付を基準に年を補完
- 年末年始のyear rolloverを考慮
- selected stateは `aria-current` / `aria-selected` / active/current/selected系のvisible stateから確認
- requested dateへ切り替えた後、同じ日付がselectedになったことを再読して確認
- selected stateが0件または複数など曖昧なら停止

公開されていない日付は推測せず、`dateAvailable=false` と現在visibleな `availableDates` を返します。

### 作品・上映回

上映スケジュール領域だけを対象に、visible showtime controlを短いsemantic snapshotへ変換します。

返却する主なfact:

- provider
- theater / theaterId
- date
- movie
- startTime / endTime（visible control上で確認できる場合）
- format（IMAX / IMAX LASER / MX4D / DOLBY CINEMA / SCREENX / TCX等。visible `SCREEN X` 表記もcanonical `SCREENX` へ正規化）
- subtitle / dub表示
- screen表示（明示されている場合）
- availability表示（明示されている場合のみ）
- sourceUrl

movie titleを1件に結び付けられない上映回が1つでもある場合、部分的に推測して返さず `UI_STATE_CHANGED` で全体を停止します。

raw HTML、DOM dump、showtime datasetをMCP resultへ返したり永続保存したりしません。

## Safety Boundary

Phase 1 adapterで有効化するのはread-only上映取得だけです。Phase 3で追加したseat surfaceもread-onlyです。

変更していないInvariant:

- domain allow-list
- sensitive field拒否
- generic clickのfinal purchase拒否
- CAPTCHA/anti-bot challengeで停止
- purchase confirmation TTL / one-shot / URL binding
- final purchaseのruntime default無効
- seat / checkout mutationのautomatic replay禁止

`get_showtimes` は日付タブのような可逆な表示切替のみ行います。Phase 3のseat adapterはseat DOMを読みますがseat activationを実行しません。

## テスト

Unit test:

- TOHO日付正規化
- 年末年始year rollover
- official domain / lookalike domain判定
- duplicate theater dedupe
- shared schedule routeのalias grouping
- theater list構造崩れのfail-closed

非購入live smoke:

```bash
npm run smoke:toho
```

smokeは低頻度・明示実行とし、CIの通常testには含めません。2026-08-13の実ブラウザ確認ではTOHOシネマズ ららぽーと横浜（id `036`）を使用し、official redirect後もreviewed schedule pathnameを維持、date identity一致、showtimes > 0を確認しました。staticな「販売期間外」rowもrendered public UIから取得し、availabilityを`unavailable`へ正規化できています。

確認対象:

1. 公式劇場一覧へ到達
2. ららぽーと横浜をvisible theater linkとして1件に解決
3. 上映スケジュール画面へ到達
4. selected dateとavailable datesをsemanticに読む
5. showtime resultがofficial `tohotheater.jp` source URLに紐づく
6. seat selection / purchaseを実行しない

CAPTCHA/anti-bot等が表示された環境では突破せずsmokeを失敗させます。

## Phase 3 Seat Intelligence Discovery — 2026-08-17

Phase 3 Discoveryでは、ららぽーと横浜の現行schedule surfaceを確認した後、追加のbounded validationでvisible showtimeとvisible non-member continuationを通り、live `座席指定` surfaceまで到達しました。座席自体は一切クリックしていません。

公式公開情報から確認できた境界:

- vitの購入手順は「作品と日時を選択」→「座席を選ぶ」の順
- selected seatは赤、販売済みseatは黒と明記
- 車椅子スペースもvitの座席選択画面から購入可能
- TOHO-ONE会員登録なしでも購入可能
- FAQでは「希望座席を決定してから15分以内」に購入完了しないとtimeout
- 仮押さえしたseatは一定時間後に再解放

このためTOHOをv0.3.0のfirst providerに選定しました。追加validationではseat-map entry時にvisible countdownもselected-seat stateもなく、read-only entryの安全ゲートを通過しました。ここでの基準は「全server-side stateがゼロ」ではなく、seat hold / material reservation mutation / availability impactを起こさないことです。#32でadapter / fail-closed test / isolated live smokeまで完了し、TOHO `seatMap=true` へ昇格しました。`seatSelection=false` は維持します。

v0.3.0 scope:

- read-only `get_seat_availability`
- `recommend_seats`
- row / seat normalization + rendered gap boundaries
- rendered SCREEN markerによるfront/rear orientation
- adjacent / center / rear / rear-middle / aisle scoring
- context / layout / stateの3 fingerprintによるstale detection

`select_seats` / seat click / hold生成は対象外です。

#32実装ではexact theater/date/movie/startTime/screenを1上映にbindingし、visible `販売中` controlからのみ進入します。会員促進面は観測済みJ03/J04 routeとexact `ログインせずに購入する` controlだけをprovider-specific intermediate allow-listで扱い、generic click policyは緩和していません。live seat DOMはprovider-visible `A-6` / `HC-1` 等のidentity、clickable `seatSelect(...)` attributeの**存在だけ**、non-clickable状態、rendered grid slotを読みます。`seatSelect(...)` 自体は実行しません。

#33ではrendered `#screen-defimg.screen-map` のofficial `screen.gif`とseat位置関係を検証できた場合だけ`screenEdge=top`を付与します。`recommend_seats`は同一seat mapを2回readし、context/layout/stateのSHA-256 fingerprintが全一致した時だけ2回目の状態をscoreします。special seatはdefault候補から除外し、明示opt-inが必要です。

Discovery詳細: [`../PHASE3_SEAT_DISCOVERY.md`](../PHASE3_SEAT_DISCOVERY.md)

## Phase 4 Checkout Preparation Discovery — 2026-08-17

Phase 4 Discoveryではseat clickを行わず、公式公開手順・FAQ・既存Phase 3実測からcheckout boundaryを再整理しました。全体のmatrixは [`../PHASE4_CHECKOUT_DISCOVERY.md`](../PHASE4_CHECKOUT_DISCOVERY.md)、trackingは#48、first-provider implementation gateは#50です。

### Checkout stage

公式公開情報から確認できる大枠は:

1. 作品 / 日時
2. 座席
3. チケット種別
4. 購入者情報
5. 支払い情報
6. 購入内容確認
7. 購入完了

TOHO-ONEへログインせず購入できるguest pathは既存review済みです。ただしmember authentication、購入者情報、payment、consent/final purchaseはPhase 4で自動化しません。

### Seat hold Gate 0

公式FAQの15分timeoutはhold/sessionがmaterialな時間制約を持つことを示しますが、Phase 4 Discoveryだけでは「seat DOMをactivateした瞬間」「seat決定control」「次stageへの遷移」のどこがexact hold startなのかを十分に証明できていません。

したがって:

- `seatSelection=false` を維持
- #50 Gate 0通過前にseat clickを実装しない
- eventual live validationは1 user-intended showtime / 1 exact seat setだけ
- pre-read + freshness確認後にのみ一度だけmutation候補を検証
- alternate seat probing / repeated click experimentation / bulk hold禁止
- selected/held setがrequested setと完全一致しなければfail closed
- release/deselectを自動化するのはprovider semanticsを別途証明できた場合だけ
- Human Handoff後にseat mutationをreplayしない

### Human-only boundary

初期Phase 4では以下をHumanへ戻します:

- password / member credential
- OTP / MFA / challenge
- purchaser name / phone / email / birth date
- legal/terms consent
- payment credential / wallet approval
- final purchase

これは単なるsecret deny-listではなく、新しいPII ingress / logging / result pathを作らないためのPhase 4 product boundaryです。

### TOHO first vertical slice decision

TOHOをconditional first providerとして維持します。理由はPhase 3のseat identity/freshness infrastructure、review済みguest continuation、公開されたcheckout stage/15分timeout情報が3社の中で最も揃っているためです。

ただしfirst providerという位置付けはcapability approvalではありません。Gate 0でhold/release semanticsを安全に証明できない場合、TOHOはblockedのままにし、`seatSelection` / `checkoutPreparation` をfalseで維持します。

## 今後

Phase 4:

- #49 provider-neutral `prepare_checkout` contract/core
- #50 TOHO Gate 0 + first adapter
- transaction truthはcaller inputでなくcurrent rendered UIから再取得
- ticket eligibilityをMCPが推測しない
- checkout preparationとPhase 5 final purchaseを分離

Final purchase前:

- 現行規約/サイトポリシーを再確認
- exact final controlを確認
- duplicate submission防止
- `PURCHASE_UNKNOWN` handling
- timeout/disconnect後の自動replay禁止

## 方針

TOHOはPhase 1 read-only上映取得とPhase 3 read-only seat intelligenceを有効化済みです。Phase 4ではseat selection / checkout preparationを別capabilityとして個別reviewし、Gate 0を通過した範囲だけ段階的に昇格させます。final purchaseはPhase 5まで無効のままです。
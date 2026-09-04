# TOHOシネマズ対応メモ

Provider ID: `toho`

公式サイト: `https://www.tohotheater.jp/`

初回Private MVPレビュー: 2026-08-12  
Phase 1 上映情報adapterレビュー: 2026-08-13  
Phase 3 座席表adapterレビュー: 2026-08-17  
Phase 4 チェックアウト調査: 2026-08-17

## 現在の対応状況

| 機能 | 状態 | 備考 |
|---|---|---|
| 公式サイトを開く | 有効 | 許可domainを限定 |
| 限定的な画面読み取り | 有効 | ページ内容は永続保存しない |
| 劇場一覧・劇場選択 | 有効 | 公式劇場一覧に表示されたlinkのみ |
| 上映情報取得 | 有効 | 劇場・日付・作品・上映回を表示中のUIから抽出 |
| 座席表の読み取り | 有効 | #32のread-only adapterと#33の鮮度確認・推薦 |
| 座席選択 | 無効 | `seatSelection=false`。Gate 1でのhold開始と自然releaseは実証済みだが、公開capability化はB3を含むPhase 4 closeout待ち |
| チェックアウト準備（Agent） | 無効 | `checkoutPreparation=false`。B2/B3 automationは研究・optional実装として保持 |
| Full checkout Human Handoff | 有効 | `humanCheckoutHandoff=true`。2回の安定read後、座席選択から購入完了までHumanが操作 |
| 最終購入（Agent submit） | 無効 | `purchaseSubmission=false`。実購入ボタンはHumanだけが操作 |

## Phase 1で確認した公式導線

### 劇場一覧

```text
https://www.tohotheater.jp/theater/find.html
```

劇場一覧に表示されたlinkから、同じ許可domainである `*.tohotheater.jp` 配下の上映スケジュールへ進みます。

2026-08-13に確認した例:

```text
https://hlo.tohotheater.jp/net/schedule/036/TNPI2000J01.do
```

`036` はTOHOシネマズ ららぽーと横浜のスケジュール識別子として、画面に表示された劇場linkから取得します。

1つのスケジュール経路を複数劇場名が共有する公開UIも確認しています。たとえばTOHOシネマズ 日比谷とTOHOシネマズ シャンテは同じスケジュールgroupとして表示されます。

そのためadapterはスケジュールIDを単一劇場名と決め打ちせず、同じ経路に結び付く表示上の劇場名を `aliases` として保持します。

このadapterが読むのは、ブラウザに表示された公開Web UIのDOMだけです。network interception、XHR/fetch解析、hidden JSON endpoint、private/internal APIの直接利用は行いません。

## 上映情報adapter

### 劇場一覧

`list_theaters` は公式劇場一覧画面で実際に表示されているanchorだけを対象にします。

採用条件:

- HTTPSであること
- `tohotheater.jp` またはそのsubdomainへ厳密一致すること
- 画面に表示されている劇場linkであること
- `/net/schedule/{3桁}/TNPI2000J01.do` 形式の公開スケジュール経路であること
- `TOHOシネマズ ...` として読める劇場名であること

同じID・経路が設備別一覧などで重複している場合は重複排除します。同じ経路に複数の劇場名が結び付く場合は `aliases` にまとめます。

同じIDが異なる経路を指すなど、公開UIの情報に矛盾がある場合は `UI_STATE_CHANGED` で停止します。劇場一覧の取得件数がレビュー済み範囲から大きく外れた場合も、UI変更と判断して安全停止します。

### 日付

`get_showtimes` は表示中の日付controlから日付を正規化します。

- MCP inputは `YYYY-MM-DD`
- 画面上の `M/D` 等はAsia/Tokyoの現在日付を基準に年を補う
- 年末年始の年またぎに対応する
- 選択状態は `aria-current` / `aria-selected` やactive/current/selected系の表示状態から確認する
- 日付を切り替えた後、要求した日付が実際に選択状態になったことを再読する
- 選択状態が0件または複数など曖昧なら停止する

公開されていない日付は推測せず、`dateAvailable=false` と現在表示されている `availableDates` を返します。

### 作品・上映回

上映スケジュール領域だけを対象に、表示中の上映controlを短い構造化情報へ変換します。

返却する主な項目:

- provider
- theater / theaterId
- date
- movie
- startTime / endTime
- format
- 字幕・吹替
- screen
- availability
- sourceUrl

formatは、画面に表示されたIMAX / IMAX LASER / MX4D / DOLBY CINEMA / SCREENX / TCXなどを正規化します。`SCREEN X` のような表示はcanonicalな `SCREENX` に変換します。

上映回を作品名へ一意に結び付けられないものが1件でもある場合、部分的に推測して返さず `UI_STATE_CHANGED` で全体を停止します。

raw HTML、DOM dump、上映データ一式をMCP結果へ返したり永続保存したりしません。

## 安全境界

Phase 1で有効にしたのは読み取り中心の上映情報取得です。Phase 3で追加した座席表も読み取り専用です。

維持している不変条件:

- 許可domainを限定する
- sensitive fieldへの操作を拒否する
- 汎用clickから最終購入へ進めない
- CAPTCHA / anti-bot challengeでは停止する
- purchase confirmationのTTL / one-shot / URL bindingを維持する
- 最終購入はruntime既定で無効
- 座席・checkoutの意味変更操作を自動再実行しない

`get_showtimes` が行う変更は、日付タブのような可逆な表示切替だけです。座席表adapterは座席DOMを読みますが、座席を選択する操作は行いません。

## テスト

単体テスト:

- TOHOの日付正規化
- 年末年始の年またぎ
- 公式domainとlookalike domainの判定
- 重複劇場の排除
- shared schedule routeのalias grouping
- 劇場一覧構造変更時の安全停止

非購入live smoke:

```bash
npm run smoke:toho
```

live smokeは低頻度で明示的に実行し、通常CIには含めません。

2026-08-13の実ブラウザ確認ではTOHOシネマズ ららぽーと横浜（id `036`）を使用し、公式redirect後もレビュー済みのpathnameを維持していること、日付identityが一致すること、上映回を1件以上取得できることを確認しました。

「販売期間外」の行も公開画面から取得し、availabilityを `unavailable` に正規化できています。

確認項目:

1. 公式劇場一覧へ到達する
2. ららぽーと横浜を表示中の劇場linkとして一意に解決する
3. 上映スケジュールへ到達する
4. 選択日付と利用可能日付を意味的に読む
5. 上映結果が公式 `tohotheater.jp` のsource URLに結び付く
6. 座席選択や購入を行わない

CAPTCHAやanti-bot画面が表示された場合は突破せず、smokeを失敗として終了します。

## Phase 3 座席情報調査 — 2026-08-17

ららぽーと横浜の現行スケジュールから、表示中の販売可能な上映回と非会員継続導線を使い、実際の `座席指定` 画面まで到達しました。初期調査では座席自体をクリックしていません。

公式公開情報から確認できたこと:

- vitの購入手順は「作品と日時を選択」→「座席を選ぶ」の順
- 選択中の座席は赤、販売済み座席は黒と明記されている
- 車いすスペースもvitの座席選択画面から購入できる
- TOHO-ONE会員登録なしでも購入できる
- FAQでは「希望座席を決定してから15分以内」に購入完了する必要がある
- 仮押さえした座席は一定時間後に再解放される

この根拠からTOHOをv0.3.0の最初の対象にしました。

座席表へ入った直後にはcountdownも選択済み座席もなく、**画面へ入るだけでは座席holdや他利用者への空席影響を起こさない**という読み取り専用の安全ゲートを通過しました。

#32でadapter、安全停止test、isolated live smokeまで完了し、TOHOは `seatMap=true` になっています。`seatSelection=false` は維持します。

v0.3.0で有効にした範囲:

- 読み取り専用の `get_seat_availability`
- `recommend_seats`
- 行・座席の正規化と表示上の隙間境界
- 画面上のSCREEN markerによる前後方向の判定
- 隣席・中央・後方・後方中央・通路寄りのscore
- context / layout / stateの3 fingerprintによる鮮度確認

`select_seats`、座席click、hold生成は対象外です。

#32ではtheater / date / movie / startTime / screenを1上映へ厳密に結び付け、表示中の `販売中` controlからだけ座席画面へ進みます。

会員促進画面は、観測済みのJ03/J04 routeと `ログインせずに購入する` controlだけをTOHO固有の中間許可対象として扱います。汎用clickの許可範囲は広げません。

座席DOMでは、`A-6` / `HC-1` 等の表示上のidentity、`seatSelect(...)` attributeの**存在**、非clickable状態、表示上のgrid slotを読みます。`seatSelect(...)` 自体は実行しません。

#33では `#screen-defimg.screen-map` の公式 `screen.gif` と座席位置の関係を画面上で確認できた場合だけ `screenEdge=top` を付与します。

`recommend_seats` は同じ座席表を2回読み、context / layout / stateのSHA-256 fingerprintがすべて一致した場合だけ2回目の状態をscoreします。special seatは既定候補から除外し、明示的なopt-inが必要です。

詳細: [`../PHASE3_SEAT_DISCOVERY.md`](../PHASE3_SEAT_DISCOVERY.md)

## Phase 4 チェックアウト調査 — 2026-08-17

Phase 4では、公式購入手順、FAQ、Phase 3の実測からcheckout境界を再整理しました。

全体整理: [`../PHASE4_CHECKOUT_DISCOVERY.md`](../PHASE4_CHECKOUT_DISCOVERY.md)  
追跡: #48  
TOHO実装ゲート: #50

### 公開手順上の段階

1. 作品・日時
2. 座席
3. チケット種別
4. 購入者情報
5. 支払い情報
6. 購入内容確認
7. 購入完了

TOHO-ONEへログインせず購入できるguest pathはレビュー済みです。ただし、会員認証、購入者情報、支払い、利用規約同意、最終購入はPhase 4で自動化しません。

### 座席hold Gate 0

#50では、fresh temporary profileと1上映・通常席1席だけを使った限定検証を行いました。

対象:

- TOHOシネマズ ららぽーと横浜
- 2026-08-18 21:50
- `隣人たち（字幕版）`
- Screen 4
- 通常席 `A-2`

確認した事実:

- 変更前に読み取り専用観測を2回行い、context / layout / state fingerprintが一致
- `#A-2` がviewport内の正確なpointer対象であることを再確認してから、座席activationを1回だけ実施
- 表示状態は `A-2 空席(選択可)` / `seat_1.gif` から `A-2 選択中` / `seat_3.gif` へ変化
- 直後に別fresh profileから同じ上映を読むと `A-2` は引き続き `available`
- pre-clickと別profileの座席状態fingerprintも一致

したがって、**個別座席を画面上で選択しただけでは、他sessionから見えるserver-side holdは開始しない**ことが確認できました。

その後のB1事前確認で、TOHO画面には座席選択後に `確認する` という別の座席決定段階があることが分かりました。

座席画像が `選択中` になっただけでは選択座席summaryが先へ進まず、`確認する` も操作可能になりませんでした。そのため、直接seat imageを選んだことをFAQ上の「希望座席を決定」と同一視しません。

`確認する` は当時15分hold開始点の有力候補としてGate 0bで別途レビューしました。physical Gate 0bではfresh sessionがavailableのままで、hold開始点ではないことを確認済みです。

Gate 0b受入前に適用していた安全規則は:

- `確認する` を自動操作しない
- Gate 0bでprovider自身の `terms_check` をONにする場合もHuman操作だけに限定し、Agentはcheckboxを自動操作しない
- `利用規約に同意して次へ` へ自動継続しない
- 別座席を試さない
- 推測によるretryをしない
- `seatSelection=false`
- `checkoutPreparation=false`

を維持します。

### 現行UIの追加確認

現行UIでは車いす席が必ずしも旧想定の `HC-*` IDではありません。

Screen 4では画面表示の `113席 + 2車いす席` と、ちょうど2つの `seat_4.gif`（`A-10`, `A-11`）が対応していました。別Screenでも同様の構造を確認したため、wheelchair属性はprovider-visibleな `seat_4.gif` と表示上の収容数を相互検証して付与します。

また、選択済み座席の検出は旧 `#seatList1` だけに依存せず、現行UIの `seat_3.gif` と `<seatId> 選択中` も確認します。読み取り専用adapterでは、1席でも選択済みなら安全停止します。

### #50内部実装の境界

- 指定された通常席だけを対象にする
- `elementFromPoint` が正確なseat ID / `IMG`へ一致してからpointerを送る
- 別座席・再試行・推測選択を行わない
- 複数座席でも、1席ごとにbaselineから期待状態を再構成し、自分が選択した座席以外に変化があれば次のclick前に停止する
- special / accessibility seatは初期sliceでは変更前に拒否する
- 正確な選択済みseat setを確認しても、`確認する` が未レビューなら `UNREVIEWED_INTERACTION` で停止する
- Gate 0b physical acceptanceではHumanだけがexact seat → `確認する` 1回 → review済み `terms_check` ONを行い、CinemaはDone後にprovider-owned `bookSeatIntForm.seat_no` + rendered `#seatList2` のexact-seat一致 + checkbox checkedをread-only検証する
- Gate 0bでは `利用規約に同意して次へ` / ticket / purchaser PII / payment / final purchaseを操作しない。Gate 1はHuman-onlyで同意後J02まで、B2はJ02内のreview済み券種だけを別のfresh semantic actionとして扱う
- Human Handoff後に座席変更を自動再実行しない

Gate 0b / Gate 1 / B2 / B3aのphysical evidenceは完了しており、hold開始・15分自然release、`一般 2,100円`のexact ticket mutation、guest continuation、J2030の購入者情報＋支払い方法同一surfaceまで確認済みです。これらは今後のoptional automation研究として保持します。製品の既定v0.4導線はより単純化し、J01のexact showtime seat mapを2回readして安定性を確認した後、`start_checkout_handoff` で座席選択から利用規約、券種、guest/login、PII、payment、最終購入までHumanへ一括handoffします。

同意後の継続処理は、同じ呼び出しを再開して座席操作を繰り返す方式ではありません。明示的なHuman Handoffの後に、**新しい意味操作**として現在の画面を再検証し、元の購入意図へ結び直します。

詳細: [`../PHASE4_TOHO_CONTINUATION_DESIGN.md`](../PHASE4_TOHO_CONTINUATION_DESIGN.md)


### v0.4.0既定導線 — Full Checkout Human Handoff

既定製品フローではGate 0b / Gate 1 / B2 / B3をユーザーとの複数往復にしません。

1. Agentがexact showtimeのseat mapを2回readする。
2. seatIdsを事前指定した場合はその席が両観測でavailableか確認する。未指定ならseat choiceをHumanへ残す。showtime/layout/state driftがあれば開始前に停止する。
3. `start_checkout_handoff` でsame managed Chrome / exact macOS WindowをHumanへ渡す。
4. Humanが座席選択、`確認する`、規約同意、券種、guest/login、購入者情報、支払い、最終確認、実購入を自分で操作する。
5. AgentはHuman操作をreplayせず、PII/credential/payment dataをMCP prompt/state/log/resultへ取り込まない。
6. known in-progress TOHO routeでDoneした場合は完了扱いにせずHumanへ戻す。外部決済・認証surface上のDoneもTOHO公式へ戻るまで受理しない。

実購入後のexact success route/markerは**有料のphysical acceptanceが必要**なため未確定です。それまではDone後のunknown later TOHO routeを購入成功とは断定せず `unverified_paid_acceptance_pending` として返します。`purchaseSubmission=false` は維持します。

### B2 券種段階

2026-09-05のread-only J02 reviewでは、1席A2に対してprovider ticket ID / label / priceを含むexact `SelectTicket.setTicket(...)` optionを確認しました。初期B2 adapterは次に限定します。

- physical acceptanceと同じ1席vertical slice
- Gate 1成功時のtarget / exact seat / checkout intent digest / J02 path / resource epoch proofをone-shot消費
- option listのprovider ID / label / rendered priceをstrict normalizeし、未知labelやdriftはfail closed
- `一般`は追加確認なしのunconditioned standard ticketとしてexact pointer selection候補にする
- 大学・専門、高校生、中学・小学、幼児、シニア、障がい者割引は資格を推測しない。まずexact provider ticket ID / label / rendered price / eligibility textを返して会話上でユーザー確認を要求し、そのexact factsへの `eligibilityAcknowledgement` がある場合だけ選択する。ticket eligibilityだけのためにbrowser Handoffは使わない
- 選択後はprovider Ajax settlementを待ち、3D/追加料金・キャンペーン・MovieTicket・決済限定・provider warningが出れば停止
- B2では `ログインせず次へ` を操作しない。B3aはB2成功後のtarget/seat/intent/resource epochへone-shot proofを作り、そのexact proofを消費してreview済みguest controlを1回だけ操作する
- B3a physical acceptanceではsame targetで `/net/ticket/036/TNPI2010J02.do` → `/net/ticket/036/TNPI2030J02.do` を確認
- J2030は `purchaseInfoInputForm` / POST / `/net/ticket/036/TNPI2055J02.do`。氏名・カナ・性別・年齢・電話・メールと支払い方法radioが同じHuman-only surfaceに存在する
- B3bのremote Handoffだけpointer/scroll/text/keyを許可し、入力値をMCP prompt/state/log/resultへ取り込まない。Gate 0b/Gate 1はtext/key禁止のまま
- B2/B3 automationだけでは `seatSelection` / `checkoutPreparation` / `purchaseSubmission` を変更しない。既定公開経路は別capabilityの `humanCheckoutHandoff`

2026-09-05のphysical acceptanceでは、caller明示の`一般` 1枚だけをexact pointerで選択し、provider ID `529-2100-0010-0`、rendered `一般 2,100円`、hidden/rendered total 2,100円、Ajax settlement=0、追加条件markerなしを確認しました。選択後は同じmodal anchorの表示が`券種を選択してください`から選択済み券種へ変わるため、PR #83でstage readだけをlabel非依存のexact `a[data-modal]` identityへ修正し、PR #84で選択summaryをexact `.ticket-item` 内のunique `.ticket-content` へbindしました。修正版は同じretained live J02で `一般 2,100円` / provider ID / total / Ajax settlement / 追加条件なしを再検証済みです。mutation直前の未選択label検証は維持し、B2完了だけをcapability approvalとは扱いません。

### 人間だけが扱う境界

初期Phase 4では次をHuman Handoffへ戻します。

- password / member credential
- OTP / MFA / challenge
- 購入者の氏名 / 電話番号 / メールアドレス / 生年月日
- 利用規約への同意
- payment credential / wallet approval
- 最終購入

これは単なるsecret deny-listではなく、新しいPII入力経路・ログ・結果経路を作らないためのPhase 4の製品境界です。

### TOHOを最初の候補としている理由

TOHOは、Phase 3の座席identity・鮮度確認基盤、レビュー済みguest continuation、公開されたcheckout手順・15分timeout情報が3社の中で最も揃っています。

Agent transaction capabilityは引き続きfalseです。一方でHuman-onlyのFull Checkout Handoffは、Agentが購入操作を行わない独立capabilityとしてTOHOで有効化します。実購入後の成功markerだけは有料physical acceptance待ちです。

## 今後

Phase 4:

- #49 — provider共通 `prepare_checkout` contract/core
- #50 — TOHO Gate 0b / Gate 1と最初のprovider adapter
- 取引上の真実はcaller inputではなく現在の画面から再取得する
- 券種資格をMCPが推測しない
- checkout preparationとPhase 5の最終購入を分離する

最終購入を検討する前には、現行規約・サイトポリシー、正確な最終control、重複送信防止、`PURCHASE_UNKNOWN`、timeout/disconnect後の再実行禁止を改めて確認します。

## 方針

TOHOではPhase 1の上映情報取得とPhase 3の読み取り専用座席情報を有効化済みです。

Phase 4の座席選択・チェックアウト準備は別機能として個別にレビューし、安全ゲートを通過した範囲だけ段階的に有効化します。最終購入はPhase 5まで無効のままです。
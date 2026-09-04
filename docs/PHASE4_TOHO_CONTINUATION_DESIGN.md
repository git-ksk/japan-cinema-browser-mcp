# Phase 4 TOHO 同意後継続処理の設計

状態: 実装計画として承認済み。ただし、TOHO側で同意後に何が起きるかはまだ実証できていない。

追跡Issue: #50

## 目的

TOHOの利用規約同意前に行う厳密な座席選択と、人間が利用規約への同意を完了した後のチェックアウト継続処理を、安全に接続する。

中心原則は、**Human Handoffで中断した意味のある変更操作を、そのまま再実行しないこと**です。人間が操作を完了したことは、元の `prepare_checkout` を自動再開してよいという許可ではありません。

人間の操作後は、現在ブラウザに表示されているTOHOの状態を改めて確認し、呼び出し元が指定した同じ購入意図へ結び直した**新しい意味操作**だけを許可します。

## 必ず守る不変条件

- `semantic_mutation` / `transaction` は `never_replay` のままにする。
- Human Handoff完了を、座席・券種・支払い・最終購入の承認として扱わない。
- password / OTP / MFA / CAPTCHA回答 / Cookie / 購入者PII / 決済credentialを `requestState`、継続バインディング、ログ、結果へ入れない。
- 呼び出し元の入力は「意図」であり、取引上の事実ではない。現在の画面を再読して確認する。
- 別の座席への代替、推測による座席選択、自動再試行を行わない。
- 未レビューの経路、hidden endpoint、network interception、推測URLを継続性の証明に使わない。
- 最終購入・支払い送信にはPhase 5まで到達できないようにする。
- `purchaseSubmission=false` を維持する。

## 決定: 同じ呼び出しを変更操作として再開しない

既存の `mcp-execution-handoff` が持つ principal、正確なtool名、canonical args、intervention id、resource epoch、resume strategyの結び付きはそのまま使います。

ただしTOHOのチェックアウトでは、人間の操作完了後に元の座席選択処理を再試行しません。

```text
prepare_checkout 呼び出しA
  -> 座席状態を新しく2回読む
  -> 指定された座席だけをローカル選択
  -> レビュー済みの同意境界へ到達
  -> 明示的に Human Handoff
  -> 人間がChromeを操作
  -> TOHO固有の再検証
  -> 呼び出しAは再実行せず終了

prepare_checkout 呼び出しB（新しい意味操作）
  -> 現在表示されている段階を確認
  -> 現在のTOHO画面の事実を同じ購入意図へ結び直す
  -> レビュー済みの次段階だけを継続
```

呼び出しBはAのリプレイではなく、**現在の画面状態から始める新しい操作**です。

## 状態遷移

```text
INTENT_ACCEPTED
  -> SEAT_PREFLIGHT_STABLE
  -> EXACT_SEATS_SELECTED_LOCAL
  -> AWAITING_HUMAN_CONSENT
  -> VERIFYING_POST_CONSENT
       -> 不一致 / 不明 / 未レビュー => BLOCKED
  -> POST_CONSENT_REBOUND
       -> hold/timer境界が未証明 => Gate 1までBLOCKED
  -> TICKET_STAGE_REVIEWED
       -> 資格・条件付き券種 => HUMAN_ACTION_REQUIRED
  -> EXACT_TICKETS_SELECTED
  -> PURCHASER_INFORMATION => HUMAN_ACTION_REQUIRED
  -> PAYMENT => HUMAN_ACTION_REQUIRED / TOHO固有レビュー
  -> PRE_PURCHASE_SUMMARY_READ_ONLY
  -> PREPARED

FINAL PURCHASE: Phase 4では到達不能
```

人間操作が必要な境界ごとに、新しい専用interventionを作ります。前のinterventionが後続段階の許可になることはありません。

## A. レビュー済み境界での明示的なHuman Handoff

### 課題

現在のランタイムは、一般検出で `access_challenge`、`sign_in`、同意画面などを検知するとHuman Handoffを開始します。

TOHOの `利用規約に同意して次へ` は、TOHO固有にレビューした停止境界として扱いたいため、一般検出だけには依存しません。

### ランタイム操作型

`CinemaBrowserRuntime` のhandoff actionを、secretを持たない限定操作として型付けします。

```ts
type CinemaHandoffAction =
  | {
      kind: "reviewed_checkout_boundary";
      provider: CinemaProviderId;
      boundary: "toho_terms_consent_next";
      continuationDigest: string;
    };
```

`boundary` は呼び出し元が自由に指定できる文字列ではなく、provider adapter内部の閉じた集合です。

### 専用エントリーポイント

provider adapterからだけ呼べる狭いAPIを使用します。

```ts
requireReviewedHumanIntervention({
  reason: "consent",
  action: {
    kind: "reviewed_checkout_boundary",
    provider: "toho",
    boundary: "toho_terms_consent_next",
    continuationDigest
  },
  resumePolicy: "never_replay",
  message
}): never
```

汎用 `start_handoff` MCP toolは追加せず、一般click/fillの許可範囲も広げません。

### 人間に表示する案内

TOHOの同意境界では、次を明示します。

- Chrome上のTOHO画面で利用規約を本人が確認する。
- 同意する場合だけ、表示されている `利用規約に同意して次へ` を本人が操作する。
- 座席を変更しない。
- credential / OTP / PII / payment dataをMCPへ入力しない。
- 最終購入へ進まない。
- 操作後はContinue、中止する場合はCancelを選ぶ。

## B. 短命な継続バインディング

Human Handoff中は、人間が別の上映や別の購入画面へ移動できるため、TOHO側の文脈が変わる可能性があります。

既存のintervention / epoch bindingに加えて、Cinema側でも購入上重要な事実を短時間だけメモリ上に保持します。

```ts
interface CheckoutContinuationBinding {
  version: 1;
  provider: CinemaProviderId;
  boundary: "toho_terms_consent_next";
  intentDigest: string;
  continuationDigest: string;
  theaterId: string;
  showtimeIdentity: string;
  selectedSeatIds: string[];
  preHumanFingerprints: { context: string; layout: string; state: string };
  sourceSurface: { host: string; pathname: string };
  browserTargetId: string;
  createdAt: number;
  expiresAt: number;
}
```

保存規則:

- 初期実装ではprocess memoryだけに保持する。
- credential / PII / payment fact / opaque URL query / Cookie / receipt / tokenは保存しない。
- 専用browser runtimeごとに有効なcheckout bindingは1件だけ。
- browser reset、intervention cancel、文脈不一致、timeoutで破棄する。
- `continuationDigest` は重要事実を正規化したSHA-256であり、権限tokenとして扱わない。
- クライアントがdigestを返したこと自体を認可条件にしない。認可はactive intervention ownershipと現在画面の再検証で決める。

Gate 1 physical acceptanceでTOHOのserver-side hold開始境界と自然releaseは実証済みですが、この内部TTLを「TOHOの15分hold」とは扱いません。実装内部の安全TTLと、TOHO画面に表示される15分期限は別のauthorityです。

## C. Human Handoff完了後の再検証

一般的な「公式domainにいる」「ブロッカーが消えた」だけでは、チェックアウト継続の証明として弱いため、レビュー済みのcheckout interventionではTOHO固有の肯定的条件を追加します。

最低限確認する共通条件:

- intervention id / owner / epochが一致する。
- Human Handoff前と同じ専用browser targetである。
- 現在のtop-level providerがTOHOである。
- 未レビューの外部target/tabへ移っていない。
- 現在の状態が、同意前の境界そのものではない。
- challenge / sign-in / consentなどの一般ブロッカーが残っていない。

TOHO固有の肯定条件は、同意後画面を実機レビューしてから実装します。少なくとも、一意な段階markerと、元の購入意図へ再結合できる表示上の購入事実が必要です。

**公式URLにいるという事実だけでは継続性の証明にしません。**

## D. 新しい `prepare_checkout` による継続

Human Handoff完了後も、元の呼び出しを自動リプレイしません。サーバ側の `require_fresh_semantic_action` 不変条件を維持します。

新しい `prepare_checkout` は、最初に現在の段階を分類します。

```text
座席ページ / 選択中の座席なし
  -> ゼロ状態から通常の新規preflight

座席ページ / 指定座席が選択済み + 有効な同意前bindingあり
  -> 再クリックしない。境界と継続状態だけ検証

レビュー済み同意後段階 + 一致するbindingあり
  -> 同意前bindingを消費し、購入意図へ再結合して次のレビュー済み段階へ進む

座席選択済みだが有効なbindingなし
  -> 安全停止

未レビューのcheckout段階
  -> 安全停止
```

同意前bindingは、同意後の肯定的な再検証に成功したとき1回だけ消費します。

次のHuman-only段階へ進む場合は、その時点で表示されている購入上重要な事実から**新しいstage binding**を作ります。古いbindingを購入者情報や支払い段階まで使い回しません。

## E. 券種段階の契約

TOHOの同意後画面を実際にレビューできた後にだけ実装します。

最初に読むもの:

- 表示されている券種名
- provider ticket type id（画面DOMに明示され、安全に読める場合だけ）
- 表示価格
- 表示されている条件・資格文言
- 表示されている最小・最大枚数

選択規則:

- 呼び出し元が明示した券種だけを選ぶ。
- 券種枚数と選択座席数を一致させる。
- 名称・制約はTOHO画面の表示を正とする。
- 年齢、学生、シニア、障害者、会員資格を推測しない。
- 資格確認・credential・条件付きの導線はHuman Handoffへ戻す。
- coupon / voucher / MovieTicket / member credential / PIN相当は人間のみが扱う。
- 推測による券種選択や割引最適化をしない。

通常券の選択も `semantic_mutation` です。対象controlの厳密なレビュー、test、限定live reviewを通してからのみ有効にします。

### 2026-09-05 J02 read-only review / B2初期slice

Gate 1 physical acceptance後の `TNPI2010J02.do` を追加操作なしでレビューし、1席 `A2` に対する券種段階を確認しました。

- seatごとにhidden `.select_ticket` / `ticket_type_name` があり、未選択値は `-0--`
- `券種を選択してください` はexact `data-modal=modal-target-00` のmodal trigger
- modal内の各券種はTOHO自身の `SelectTicket.setTicket(groupIndex, seatIndex, providerTicketTypeId, label, renderedPrice)` へbindされる
- このrunでは `一般`、大学・専門、高校生、中学・小学、幼児、シニア、障がい者割引2種のprovider ID / label / rendered priceをread-onlyで取得できた
- `一般`以外は名称そのものに資格条件が含まれるため、Cinemaはeligibilityを推測せず `ticket_eligibility` Human reviewへ戻す
- 券種選択後、TOHOはAjaxで追加料金/3D・キャンペーン/決済限定/MovieTicket等の追加条件を返し得る。B2はAjax settlement後にこれらを再読し、追加条件があればguest continuationへ進まず停止する
- `ログインせず次へ` はexact `gotoRej(4, '<site>', '', '')` と `TNPI2030J02.do` form actionをread-onlyで検証するだけで、B2ではクリックしない

初期implementationはphysical acceptanceと同じ1席vertical sliceに限定します。Gate 1成功時に得たtarget / seat / checkout intent digest / host/path / resource epochのproofをone-shotで消費してからだけ、review済み`一般`のexact modal trigger → exact ticket optionという2つのpointer mutationを許可します。proof不一致・既選択・価格/ID/label drift・Ajax状態不明・追加条件はすべてfail closedです。`prepare_checkout`公開やcapability変更はこの実装だけでは行いません。

## F. 後続のHuman-only境界

### 購入者情報

初期Phase 4では、氏名・電話番号・メールアドレス・生年月日をMCP inputへ追加しません。

購入者情報画面へ到達した場合は `purchaser_information` としてHuman Handoffします。

人間がChromeへ直接入力した後、agentは新しい操作として肯定条件を再検証します。入力値そのものを読み取り、ログ出力し、結果へ返すことはしません。

### 支払い

カード入力欄、wallet承認、3-D Secure、OTPは人間だけが扱います。

支払い画面から購入直前確認へ進む操作がauthorization / charge / holdを伴うかは、TOHO固有のレビューなしに自動化しません。

### 購入直前の確認内容

安全に到達できた場合だけ、読み取り専用で正規化します。

- 劇場
- 作品
- 日付・開始時刻・スクリーン
- 指定座席
- 券種と枚数
- 小計・手数料・合計（画面に表示されているものだけ）
- 通貨
- 現在の段階
- 観測時刻

表示されていない手数料や金額を0として補完しません。確認内容は#49のmaterial fingerprintへ結び付けます。

## G. TOHO Gate 1 — 同意後のhold境界確認

これは実装配線とは分離した、限定的なlive reviewです。

### 事前条件

- 劇場1件、上映1件、通常席1席だけを対象にする。
- 読み取り専用観測を2回行い、状態が安定していることを確認する。
- 座席pointer identityを厳密に確認する。
- 同意前に別fresh profileで対象座席が空席であることを確認する。
- 対象座席のローカル選択は1回だけ。
- agentは同意controlをクリックしない。

### 人間の操作

人間が利用規約を確認し、同意する場合だけ、表示されている `利用規約に同意して次へ` を1回操作します。

### 直後の読み取り専用確認

人間の操作直後、agentは追加変更を行わず次を確認します。

1. 現在の画面段階を示すmarker。
2. hold / countdown / expiry表示の有無。
3. 現在の購入事実が元の購入意図と一致するか。
4. 別のfresh profileから見た同じ座席の空席状態。

判定:

- 別profileで座席が利用不可になり、同じ購入画面にtimer / hold根拠が表示される場合、その同意遷移以前または遷移時点をmaterialなhold境界として記録する。
- 別profileで空席のままなら、同意遷移だけをhold開始点とは断定しない。次候補を別subgateでレビューする。
- UIが曖昧、または変更されている場合は停止する。追加clickで探索しない。

### 解放確認

server-side holdが観測された場合、最初の解放確認では**推測した取消・戻る・選択解除を使いません**。公開されているtimeoutによる自然解放を優先します。

- 画面にexpiry / countdownがあれば記録する。
- expiry後、別fresh profileで同じ座席が再び利用可能になることを確認する。
- 能動的な解放controlは、labelと意味を別途レビューするまで使わない。

## H. 対応機能を有効化する条件

### `seatSelection`

現在の根拠では `false` を維持します。

`true` にするには少なくとも、レビュー済みHuman Handoff連携、選択済み状態と現在段階の復元、再実行しない新規action継続のtestが必要です。

### `checkoutPreparation`

`false` を維持します。

さらに、Gate 1の同意後段階レビュー、厳密な券種段階contract、購入者情報・支払いでのHuman-only停止、表示された確認内容の検証または安全な停止地点の明文化が必要です。

### `purchaseSubmission`

Phase 4では常に `false` です。

## I. テスト項目

### Handoff配線

- レビュー済み境界だけが明示的interventionを開始できる。
- 呼び出し元が自由にboundary名を指定してhandoffを作れない。
- intervention actionにsecret / PII fieldが存在しない。
- owner / args / principal / epoch不一致では安全停止する。
- Human Handoff完了後に元の意味変更taskを再試行しない。
- browser target変更で継続bindingを無効化する。
- cancel / browser reset / TTLでbindingを消去する。

### 新しいactionによる継続

- 一致する同意後bindingがある場合、座席click 0回で継続する。
- 座席選択済み + bindingなし => blocked。
- intent digest不一致 => blocked。
- 上映または購入上重要な事実の不一致 => blocked。
- 無関係なinventory/context変更 => blocked。
- 消費済みbindingは再利用できない。

### 券種・最終購入境界

- 指定された通常券だけを選択する。
- 資格条件付き券種は人間へ戻す。
- 券種枚数と座席数が一致しなければblocked。
- caller supplied priceを取引上の真実にしない。
- 購入者PII / payment fieldをMCP schemaへ追加しない。
- Phase 4 adapterから最終購入controlへ到達できない。
- Human Handoffが入った時点でprepared purchase confirmationを必ず破棄する。

## J. 実装状況と順序

#50の継続処理基盤としてA1/A2は実装済みです。ただし、provider capabilityの有効化や `prepare_checkout` の公開登録は行っていません。

2026-08-25のphysical Gate 0b v6では、exact `A-2` に対してHumanが `確認する` を1回だけ実行し、provider自身の `terms_check` をONにした後、Cinemaのcanonical verifierが `bookSeatIntForm.seat_no` とrendered `#seatList2` のexact-seat一致を確認しました。直後の独立fresh sessionでも `A-2` は `available` のままでした。したがって、**`確認する` + terms checkboxまででは、別sessionから観測できるserver-side holdは発生しませんでした**。この結果だけから15分holdの開始点やrelease semanticsは断定しません。

2026-09-04のphysical Gate 1では、Human-only `利用規約に同意して次へ` 1回で `TNPI2010J02.do` へ到達し、直後の独立fresh profileでexact `A-2` が `available` から `unavailable` へ変わるserver-side holdを確認しました。J02は15分以内に購入が完了しなければ座席を自動解除すると表示し、能動的な戻る/取消/解除を使わない後続fresh profileでA-2が `available` に復帰したため自然releaseも確認済みです（exact解除秒は未計測）。Handoffはv0.4.1 `WindowWebSocketHandoffAdapter` WSS-onlyで、WebRTC/ICE/STUN/TURNは使いません。Gate 1成功時にはB2用のexact target / seat / intent / J02 path / resource epoch proofをone-shot生成し、別resource操作や再利用を拒否します。

1. **A1 — レビュー済み境界専用のintervention基盤** — ✅ 実装済み
   - 型付き `CinemaHandoffAction`
   - provider専用handoff entry point
   - 境界専用のHuman prompt
   - capability変更なし
2. **A2 — 短命な継続bindingと新規action dispatch** — ✅ 基盤実装済み
   - target / provider / intent / material binding
   - one-shot消費・無効化
   - 座席操作のリプレイなし
   - capability変更なし
3. **Gate 0b — TOHOの `確認する` 座席決定境界レビュー** — ✅ physical acceptance完了
   - exact seat → `確認する` 1回 → Human `terms_check` → Doneを検証済み
   - canonical selected-seat identityをTOHO自身のform + rendered summaryで確認
   - 直後fresh sessionではexact seatが引き続きavailableで、externally visible holdなし
   - このGate 0b単体ではholdを観測せず、後続Gate 1でhold開始点・自然releaseを別途実証。capabilityは引き続きfalse
4. **B1 — 同意後Gate 1 live review** — ✅ physical acceptance完了
   - Human `利用規約に同意して次へ` 1回でJ02へ到達
   - fresh profileでexact seat unavailable化を確認
   - J02の15分自動解除表示と、能動releaseなしのavailable復帰を確認
5. **B2 — 券種adapter** — ✅ implementation/test/physical mutation acceptance完了
   - J02の1席slot、provider ticket ID/label/price、guest continuationをstrict normalize
   - Gate 1 proofをtarget / seat / intent / path / resource epochへone-shot binding
   - caller明示のreview済み`一般` 1枚だけをexact pointerで実機選択済み。資格券はHuman review
   - provider ID `529-2100-0010-0`、`一般 2,100円`、total 2,100円、Ajax settlement=0、追加条件markerなしをpost-selectionで確認
   - 選択後にmodal anchorの表示labelが変わる実DOMをPR #83でstrict normalize対応。mutation直前のexact未選択label検証は維持
   - `ログインせず次へ`はB2ではクリックしない
6. **B3 — 購入者情報・支払いhandoffと確認画面境界**
   - provider固有の肯定条件を確認
   - 最終購入は引き続き到達不能
7. test・docs・限定live evidenceが揃ってからcapability変更を判断する

## 対象外

- 利用規約への自動同意
- PIIの自動入力
- credential / OTP / CAPTCHAの受け渡し
- 決済情報の自動入力・自動承認
- 最終購入
- AEON / 109との同時対応
- 推測したcheckout URL
- network interception / private API探索
- version bump / tag / GitHub Release / npm publish / production deploy
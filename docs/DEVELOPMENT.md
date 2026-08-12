# 開発ガイド

## 実装原則

### Browser layerは薄く保つ

navigation、bounded read、click、typing、state checkはCDP primitiveで実装し、provider固有の意味理解は上位adapterへ置きます。

Phase 1では `CinemaBrowserRuntime.evaluateSemanticState()` をprovider-neutral primitiveとして使い、TOHO/AEON固有のDOM knowledgeはそれぞれ `src/providers/toho/adapter.ts` / `src/providers/aeon/adapter.ts` に閉じ込めています。

### Model判断よりdeterministic code

URL判定、enum、正規表現、state machine、schema validationで決められることはコード側で強制します。

例:

- provider domain validation
- provider capability enforcement
- sensitive field判定
- consequential action判定
- confirmation expiry / one-shot
- candidate identity check
- TOHO schedule route / date / theater alias grouping
- AEON public schedule route / date query / theater identity

### Fail Closed

selector変更、duplicate label、想定外redirect、画面不一致、購入結果不明などはerrorとして扱います。推測して続行しません。

TOHO read adapterでは、上映回を作品に一意に結び付けられない場合やselected dateが曖昧な場合、部分的な上映結果を返しません。

AEON read adapterでは、劇場routeをDOMから明示できない場合にslugを推測しません。公式劇場選択UIを使い、reviewed schedule routeへ到達したことを検証します。1つのrendered groupから複数time rangeを安全に分離できない場合やmovie/time identityが曖昧な場合も部分結果を返しません。

### Steady-state Latencyを優先

通常フローでは次を再利用します。

- 1つのChrome process
- 1つの専用profile
- 可能な限り同じCDP connection/target

1 tool callごとのbrowser restartやfull-page scanは避けます。

### RuntimeをDB化しない

showtime、seat map、HTML、provider inventoryを永続保存しません。

## Source Layout

現在:

```text
src/
  index.ts
  server.ts
  config.ts
  providers.ts
  purchase-gate.ts
  browser/
    chrome-process.ts
    runtime.ts
  providers/
    toho/
      adapter.ts
    aeon/
      adapter.ts
```

provider実装が増えた後の候補:

```text
src/
  browser/
    chrome-process.ts
    runtime.ts
    visible-state.ts
  providers/
    contract.ts
    registry.ts
    toho/
      adapter.ts
      selectors.ts
    aeon/
      adapter.ts
      selectors.ts
    109/
      adapter.ts
      selectors.ts
  workflow/
    showtimes.ts
    seats.ts
    checkout.ts
  safety/
    purchase-gate.ts
    transaction-state.ts
  server.ts
  config.ts
  index.ts
```

Phase 1のためだけにregistry/contract/workflowを大規模refactorせず、必要になった時点で段階的に分離します。

## Provider Adapterのルール

adapterは以下を満たします。

- レビュー済み公式公開UIだけを操作
- cinema conceptを返し、CSS selectorを外部へ漏らさない
- 可能な限り狭いsemantic selectorを使う
- mutation前にexpected state/textを確認
- compact normalized objectを返す
- assumptionが崩れたらtyped state error
- granular capabilityを公開し、server側でruntime enforcementする

adapterでやらないこと:

- private/internal JSON endpoint直叩き
- network interceptionでhidden APIを探す
- production HTMLを保存して後処理する
- route/slugを不確かな属性から推測する
- final actionをfuzzy clickで代替する

## Selector Strategy

優先順:

1. semantic role + stable accessible name
2. provider側のstable attribute
3. scoped DOM structure + semantic assertion
4. strict uniqueness付きtext matching

absolute CSS pathや位置依存selectorはできるだけ避けます。

mutation selectorにはsemantic assertionを組み合わせます。

```text
candidateを読む
  ↓
expected labelを返す
  ↓
後続toolで同じlabelか確認
  ↓
一致した場合のみclick
```

TOHOの日付切替はclick後にselected dateをsemantic readerで再確認します。

AEONの劇場選択は、DOMにreviewed schedule URLが明示されていない場合だけvisible theater labelを一意にclickし、公式の「上映スケジュールを確認する」controlから `theater.aeoncinema.com/theaters/{slug}` へ到達したことを確認します。

## Visible State Budget

generic readのdefault上限は8,000文字です。

`CINEMA_MAX_READ_CHARS` で変更できますが、provider parserの都合だけでglobal上限を増やさず、provider-specific readerを改善します。

TOHO/AEON adapterはfull visible textをNode/modelへ返さず、ブラウザ内の `Runtime.evaluate` で劇場/date/movie/showtime等の必要factだけに絞ります。1上映回のcontextも上限付きです。

## Error Taxonomy

例:

- `BROWSER_UNAVAILABLE`
- `URL_NOT_ALLOWED`
- `UI_ELEMENT_NOT_FOUND`
- `UI_STATE_CHANGED`
- `HUMAN_ACTION_REQUIRED`
- `SENSITIVE_FIELD`
- `FINAL_ACTION_REQUIRES_CONFIRMATION`
- `UNSUPPORTED_CAPABILITY`
- `CONFIRMATION_EXPIRED`
- `CONFIRMATION_MISMATCH`
- `PURCHASE_UNKNOWN`

stack traceやbrowser secretをMCP resultへ出しません。

未実装providerのsemantic readへ `UNSUPPORTED_CAPABILITY` を返し、generic readerへ黙ってfallbackしません。

## Transaction State

購入系はtool履歴から推測せず、明示state machineで管理します。

```text
BROWSING
SHOWTIME_SELECTED
SEATS_REVIEWED
SEATS_SELECTED
CHECKOUT_PREPARED
AWAITING_USER_CONFIRMATION
USER_CONFIRMED
PURCHASE_SUBMITTED
PURCHASE_COMPLETE
PURCHASE_FAILED
PURCHASE_UNKNOWN
```

`PURCHASE_SUBMITTED`は絶対に自動replayしません。

TOHO/AEON Phase 1 read adapterはtransaction stateを進めません。上映情報を読むためのpage/date/theater UI navigation以外の購入系操作は行いません。

`CINEMA_ENABLE_PURCHASE=true` はprovider capabilityを上書きしません。`purchaseSubmission=false` のproviderはfinal submitへ進めません。

## テスト

### Unit Test

Chromeを起動せず確認できるpolicyを固定します。

- provider domain allow-list
- protocol/credential付きURL拒否
- provider capability enforcement
- sensitive field判定
- final purchase label判定
- confirmation TTL / one-shot
- transaction state transition
- TOHO日付/year rollover
- TOHO theater route/domain/alias grouping
- AEON theater label/facility normalization
- AEON explicit public route validation / route非推測
- AEON valid calendar date / public date URL
- AEON movie/time/screen/format/language normalization
- AEON ambiguous time group / unresolved movie fail-closed
- UI構造が崩れた場合のfail-closed

### Browser Runtime Test

可能な限りsynthetic local pageで確認します。

- bounded read
- duplicate/ambiguous control
- expected-label mismatch
- domain外redirect
- challenge detection

### Live Provider Smoke Test

live testは低頻度・非購入を原則とします。

適切な確認:

- provider rootが開く
- 劇場/上映画面へ到達できる
- bounded semantic showtime readが動く
- 想定外domainへescapeしない

CIで避けるもの:

- seat hold
- user account login
- 高頻度polling
- payment

TOHO/AEONには明示実行用のsmokeを用意します。

```bash
npm run smoke:toho
npm run smoke:aeon
```

通常の `npm test` / CIからは分離し、必要時だけ実ブラウザで実行します。challengeが出た場合は突破せず失敗扱いにします。

## Performance Review

機能追加時に確認します。

- runtime dependencyが増えるか
- Chrome再起動が増えるか
- full DOM scanが増えるか
- 必要nodeだけ抽出できないか
- 複数判定を1回の `Runtime.evaluate` にまとめられないか
- modelへ不要なtextを返していないか

**小さいstructured factsを1回で返す**ことを優先します。

TOHO/AEON Phase 1ではruntime dependencyを追加せず、既存の `chrome-remote-interface` と長寿命CDP sessionをそのまま利用します。

## Dependency追加ルール

runtime dependency追加時は次を説明できる状態にします。

- 何のcapabilityが増えるか
- 既存CDP/platform primitiveではなぜ不十分か
- install/runtime sizeへの影響
- security impact
- maintenance impact

## 主な環境変数

- `CINEMA_CHROME_EXECUTABLE`
- `CINEMA_CHROME_PROFILE_DIR`
- `CINEMA_ALLOW_EXTERNAL_CDP`
- `CINEMA_CDP_PORT`
- `CINEMA_HEADLESS`
- `CINEMA_MAX_READ_CHARS`
- `CINEMA_CONFIRMATION_TTL_SECONDS`
- `CINEMA_ENABLE_PURCHASE`

新しい設定を追加してもsafe defaultは崩しません。

TOHO/AEON Phase 1では新しい環境変数を追加していません。

## Provider CapabilityのDefinition of Done

「一度動いた」だけでは完了ではありません。

1. 現行公式UIの導線がdocument化されている
2. capabilityに必要なprovider/compliance reviewが記録されている
3. semantic selectorが実装されている
4. stale/ambiguous stateがfail closed
5. normal/failure caseのunit testがある
6. 非破壊live testを実施済み
7. capability matrix更新済み
8. documentationと実装が一致

purchase submissionの場合は `PURCHASE_UNKNOWN` とduplicate submission防止テストも必須です。

TOHO/AEON Phase 1は1〜5、7〜8まで実装し、実ブラウザlive smokeの実行確認を残タスクとして管理します。

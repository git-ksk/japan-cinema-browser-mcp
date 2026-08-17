# 開発ガイド

## 実装原則

### Browser layerは薄く保つ

navigation、bounded read、click、typing、state checkはCDP primitiveで実装し、provider固有の意味理解は上位adapterへ置きます。

Phase 1では `CinemaBrowserRuntime.evaluateSemanticState()` をprovider-neutral primitiveとして使い、TOHO / AEON / 109固有のDOM knowledgeはそれぞれ `src/providers/<provider>/adapter.ts` に閉じ込めています。

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
- 109 explicit theater/date route / exact path-query / theater-date identity

### Fail Closed

selector変更、duplicate label、想定外redirect、画面不一致、購入結果不明などはerrorとして扱います。推測して続行しません。

TOHO read adapterでは、上映回を作品に一意に結び付けられない場合やselected dateが曖昧な場合、部分的な上映結果を返しません。

AEON read adapterでは、劇場routeをDOMから明示できない場合にslugを推測しません。公式劇場選択UIを使い、reviewed schedule routeへ到達したことを検証します。1つのrendered groupから複数time rangeを安全に分離できない場合やmovie/time identityが曖昧な場合も部分結果を返しません。

109 read adapterでは、公式rootの劇場hrefと各劇場ページの日付hrefをsource of truthとし、slug/date/queryを生成しません。wrong theater/date/route、visible labelとhrefのdate mismatch、ambiguous time group、movie/screen binding不能では部分結果を返しません。

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
    109/
      adapter.ts
```

次のPhaseで必要になった時点の候補:

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
    aeon/
      adapter.ts
    109/
      adapter.ts
  workflow/
    showtimes.ts
  safety/
    purchase-gate.ts
    transaction-state.ts
  server.ts
  config.ts
  index.ts
```

Phase 1のためだけにregistry/contract/workflowを大規模refactorしませんでした。Phase 2では `src/cinema.ts` の共通schema、bounded `find_showtimes`、外部area resolver向け `resolve_theater_targets` を小さい独立境界として追加しています。外部place labelはuntrusted dataとして扱い、provider公式 `list_theaters` で一意に再解決できるまでshowtime targetとして採用しません。

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
- route/slug/queryを不確かな属性から推測する
- final actionをfuzzy clickで代替する
- purchase controlをread adapterからclickする

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
expected label / explicit routeを返す
  ↓
後続処理で同じidentity/contextか確認
  ↓
一致した場合のみ続行
```

TOHOの日付切替はclick後にselected dateをsemantic readerで再確認します。

AEONの劇場選択は、DOMにreviewed schedule URLが明示されていない場合だけvisible theater labelを一意にclickし、公式の「上映スケジュールを確認する」controlから `theater.aeoncinema.com/theaters/{slug}` へ到達したことを確認します。

109は劇場rootやschedule URLを生成せず、visible anchorの明示hrefだけを採用します。プレミアム新宿では通常館とquery形が異なるため、query key/valueをprovider-wide invariantとして仮定しません。

## Visible State Budget

generic readのdefault上限は8,000文字です。

`CINEMA_MAX_READ_CHARS` で変更できますが、provider parserの都合だけでglobal上限を増やさず、provider-specific readerを改善します。

3社adapterはfull visible textをNode/modelへ返さず、ブラウザ内の `Runtime.evaluate` で劇場/date/movie/showtime等の必要factだけに絞ります。1上映回のcontextも上限付きです。

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

Execution Handoffでは `HUMAN_ACTION_REQUIRED` とintervention metadataをMRTR `input_required` へ変換します。owner claimはbrowser operation queueと同じserialized turnで行い、exact invocation / args / logical principal / epochが一致しないrequestStateを拒否します。

Resume policyは `src/handoff-policy.ts` をsingle source of truthとします。pure read以外を安易に `replay_safe` へ変更しません。特にsemantic mutationとtransaction/payment actionは `never_replay`、MCP strategyは `require_fresh_semantic_action` を維持します。Human intervention開始時にpurchase confirmationをclearし、Human completionをapprovalへ変換しません。

無効provider capabilityへgeneric readerで黙ってfallbackしません。

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

3社Phase 1 read adapterはtransaction stateを進めません。上映情報を読むためのpage/date/theater UI navigation以外の購入系操作は行いません。

`CINEMA_ENABLE_PURCHASE=true` はprovider capabilityを上書きしません。`purchaseSubmission=false` のproviderはfinal submitへ進めません。

## テスト

### Unit Test

Chromeを起動せず確認できるpolicyを固定します。

共通:

- provider domain allow-list
- protocol/credential付きURL拒否
- non-default port拒否
- provider capability enforcement
- sensitive field判定
- final purchase label判定
- confirmation TTL / one-shot
- transaction state transition
- UI構造が崩れた場合のfail-closed

TOHO:

- 日付/year rollover
- theater route/domain/alias grouping
- movie/showtime/format/language/screen/availability
- ambiguous / unresolved grouping

AEON:

- theater label/facility normalization
- explicit public route validation / route非推測
- valid calendar date / public date URL
- movie/time/screen/format/language normalization
- ambiguous time group / unresolved movie fail-closed

109:

- theater name / slug normalization
- root theater block shape
- explicit theater route/domain validation
- lookalike / credentials / non-default port
- explicit schedule href validation
- normal theaterとpremium theaterのquery差を保持
- valid / invalid calendar date
- theater/date identity
- movie/showtime/screen/format/language/availability normalization
- wrong theater / wrong route / wrong date
- ambiguous time group / unresolved movie-screen fail-closed

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

明示実行用:

```bash
npm run smoke:toho
npm run smoke:aeon
npm run smoke:109
```

通常の `npm test` / CIからは分離し、必要時だけ実ブラウザで実行します。challengeが出た場合は突破せず失敗扱いにします。 Execution Handoffのlive検証目的でchallengeを意図的に発生させません。upstream v0.1.0 dependencyはsource release commit archiveへimmutable pinし、`npm ci --ignore-scripts` で再現できる状態を維持します。

## Public Repo CI / dependency policy

Public repositoryの標準GitHub-hosted runnerは通常CIに利用します。`main` pushでは従来どおりfull validationを行います。PRではchanged pathsを先に分類し、runtime/buildへ影響する変更だけ `npm ci --ignore-scripts`、typecheck、unit test、build、Node.js 20 / 22 compatibilityを実行します。Markdown/textだけのdocs-only PRではこれらの重いjobをskipします。live provider smokeは引き続き通常CIへ含めません。

Actions workflowでは:

- `GITHUB_TOKEN` はread-only
- GitHub-owned actionsだけを許可
- actionはfull commit SHAへpin
- Dependabotでnpm dependencyとGitHub Actionsを週次更新
- `package.json` / `package-lock.json` が変わるPRだけDependency Reviewを実行し、moderate以上の既知脆弱性を拒否
- CodeQL advanced setupは`security-and-quality` suiteでJS/TSとGitHub Actionsを解析し、Markdown/textだけのPRはanalysisを省略する
- `codeql-gate` は常に実行し、analysis対象PRではCodeQL job成功に加えてPR-scoped alertを確認し、Critical / High security alertまたはError quality alertをfail closedで拒否する
- `main` push、weekly schedule、manual dispatchではCodeQL full scanを維持する
- path classifierや条件付きjobの失敗を見落とさないよう、`required-gate` を `always()` で評価する
- duplicate PR runはconcurrencyでcancel

とします。

PR前後に以下を確認します。

1. changed files / diff
2. TypeScript型とimport/export
3. route/domain guard
4. capability matrix
5. purchase/sensitive-data boundary
6. fail-closed failure cases
7. unit test coverage
8. existing TOHO/AEON/109 regression影響
9. docsとの整合

CI greenはproviderの現行規約やlive UI互換性を保証しません。provider-specific changeでは必要に応じて低頻度のnon-purchasing live smokeを明示実行し、UI drift時は推測fallbackを追加せずfail closedの原因を調査します。

## Performance Review

機能追加時に確認します。

- runtime dependencyが増えるか
- Chrome再起動が増えるか
- full DOM scanが増えるか
- 必要nodeだけ抽出できないか
- 複数判定を1回の `Runtime.evaluate` にまとめられないか
- modelへ不要なtextを返していないか

**小さいstructured factsを1回で返す**ことを優先します。

3社Phase 1ではruntime dependencyを追加せず、既存の `chrome-remote-interface` と長寿命CDP sessionをそのまま利用します。

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

3社Phase 1では新しい環境変数を追加していません。

## Provider CapabilityのDefinition of Done

「一度動いた」だけでは完了ではありません。

1. 現行公式UIの導線がdocument化されている
2. capabilityに必要なprovider/compliance reviewが記録されている
3. semantic selectorが実装されている
4. stale/ambiguous stateがfail closed
5. normal/failure caseのunit testがある
6. 非破壊live test scriptがある
7. capability matrix更新済み
8. documentationと実装が一致

purchase submissionの場合は `PURCHASE_UNKNOWN` とduplicate submission防止テストも必須です。

TOHO / AEON / 109 Phase 1は1〜8を満たし、2026-08-13に3社の非購入live smoke greenを実ブラウザで確認済みです。live smokeは通常CIから分離して管理します。

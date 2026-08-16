# アーキテクチャ

## 全体像

`japan-cinema-browser-mcp` は、ユーザーのローカルChromeを対象にした薄い制御レイヤーとして設計します。

```text
MCPクライアント
      │
      │ stdio
      ▼
MCP server / tool layer
      │
      ├─ provider registry
      ├─ policy guard
      ├─ purchase confirmation gate
      │
      ▼
Cinema browser runtime
      │
      │ Chrome DevTools Protocol
      ▼
専用ローカルChrome
      │
      ├─ TOHOシネマズ公開UI
      ├─ イオンシネマ公開UI
      └─ 109シネマズ公開UI
```

ユーザー要求時点の公式Web UIをsource of truthとし、中央集約型の上映DBは持ちません。

## 現在の主要モジュール

### `src/index.ts`

プロセスのentry pointです。stdioでMCPを起動し、終了処理を管理します。

### `src/server.ts`

MCP toolの登録と引数検証を担当します。

- tool schema
- runtime errorのMCP error化
- 通常操作と最終購入操作の分離
- bounded result返却
- provider capabilityのruntime強制

現在は `list_theaters` / `get_showtimes` をTOHO / AEON / 109で、`get_seat_availability` / `recommend_seats` をTOHOだけで有効化しています。無効capabilityへのgeneric fuzzy fallbackはしません。

### `src/providers.ts`

provider registryと横断ポリシーを保持します。

- provider ID
- 公式root URL
- domain allow-list
- generic navigation用のreviewed public read-surface allow-list
- granular capability matrix
- capability enforcement
- sensitive field判定
- final purchase control判定

TOHO / AEON / 109は `theaters=true / showtimes=true`。TOHOと109はreview済みread-only `seatMap=true`、AEONはfalseです。`seatSelection / checkoutPreparation / purchaseSubmission` は全providerでfalseで、`CINEMA_ENABLE_PURCHASE=true` でも最終submitは実行できません。

### `src/providers/toho/adapter.ts`

Phase 1 showtime + Phase 3 seat intelligenceのTOHO read-only adapterです。

- 公式劇場一覧のvisible theater linkをsemanticに抽出
- 公開schedule routeをschedule groupとして正規化
- 同じrouteを共有する複数劇場名をaliasesとして保持
- visible date controlを `YYYY-MM-DD` へ正規化
- 日付切替後のselected stateを再検証
- 作品 / 上映時刻 / format / 字幕・吹替 / screen / availabilityを必要な範囲だけ抽出
- source URLを返却
- exact theater/date/movie/startTime/screenからvisible sellable showtimeを1件へbinding
- reviewed non-member intermediateだけを通り、seat clickなしでlive `座席指定` DOMを読む
- seat identity / availability / wheelchair attribute / rendered grid gapをprovider-neutral `CinemaSeatMap`へ正規化
- rendered `#screen-defimg.screen-map` + official `screen.gif` + seat位置関係が一致した場合だけscreen edgeを確定
- transient seat-map hydrationはbounded waitし、妥当なidentity countが出なければfail closed
- selected-seat state、route drift、capacity mismatch、曖昧identityではfail closed
- UI変更、曖昧grouping、movie/showtime対応不能時はfail closed

### `src/providers/aeon/adapter.ts`

Phase 1のAEON read-only adapterです。

- 公式 `https://www.aeoncinema.com/theater/` のvisible theater controlsをsemanticに抽出
- facility labelを劇場名本体から分離
- DOMに明示された `https://theater.aeoncinema.com/theaters/{slug}/` だけをschedule routeとして採用
- routeが明示されない場合はslugを推測せず、公式劇場選択UIからschedule pageへ進む
- public schedule pageの `?date=YYYYMMDD` でrequested dateを表示
- navigation後にhostname/path/date queryを再検証
- rendered DOMから作品 / start-end time / format / 字幕・吹替 / screen / explicit availabilityを抽出
- 1 DOM groupから複数time rangeが分離できない、またはmovie/time identityが曖昧ならfail closed
- `予約購入` controlはread contextに含まれてもadapterからclickしない

### `src/providers/109/adapter.ts`

Phase 1の109 read-only adapterです。

- 公式rootの「109シネマズの劇場」block内のvisible theater linksだけを採用
- `https://109cinemas.net/{slug}/` のslugをvisible hrefから取得し、劇場名から推測しない
- 各劇場ページの日付controlに実際に表示された `/schedules/YYYYMMDD.html...` hrefだけを採用
- 通常館とプレミアム新宿でquery形が異なるため、query仕様を生成せずexplicit hrefを保持
- schedule navigation後にexact hostname/path/query、theater ID、requested dateを再検証
- rendered pageからmovie / start-end time / screen / format / 字幕・吹替 / explicit availabilityを抽出
- unavailable dateはhrefを生成せず `dateAvailable=false`
- ambiguous time group、movie/screen binding不能、wrong theater/date/routeでfail closed
- `オンラインチケット購入` 等のpurchase controlはadapterからclickしない
- Phase 3ではschedule rowのexact rendered `cinema.109cinemas.net` hrefだけを採用し、read-only seat mapへ進む
- 10分session timerとselected=0を検証し、`input.seat` / `data-seat-key`からavailabilityとgap geometryを読む
- screen/front orientationは見える証拠がない限り推測しない

3社ともraw HTMLやfull DOMをadapter外へ返さず、CDP `Runtime.evaluate` 内で小さいstructured factへ落としてからNode側へ戻します。private/internal endpointやnetwork interceptionは利用しません。


### `src/seat-freshness.ts`

provider-neutral seat-map freshnessをdeterministic SHA-256 fingerprintへ落とします。`observedAt`はhashから除外し、同じ事実を別時刻に再readしても一致するようにします。

- context: provider / theater / screen / showtime identity / public source
- layout: seat identity / row / slot / attributes / gap/group / screen edge
- state: seat identity / availability / unavailable reason

### `src/seat-recommendation.ts` / `src/recommend-seats.ts`

純粋なseat scoringとbrowser orchestrationを分離します。`recommend_seats`は同一exact showtimeを2回readし、context/layout/stateの3 fingerprintが全一致した場合だけ2回目の観測からrecommendationを作ります。1席でも変化した場合はstale resultを返さずfail closedします。

推薦はconfirmed `available`だけを対象にし、semantic row、rendered gap、provider groupを尊重します。special/accessibility seatはavailabilityから独立して保持し、default推薦からは外して明示opt-inを要求します。

### `src/browser/chrome-process.ts`

Chrome process lifecycleを管理します。

- installed Chrome/Chromium検出
- 専用profile起動
- loopback CDP有効化
- MCP所有Chromeの再利用
- 明示許可されたexternal CDPへの接続
- MCP所有processだけ安全に終了

### `src/browser/runtime.ts`

CDP targetと、公開UIに対する最小限のbrowser primitiveを担当します。

- generic tool向けreviewed public read-surface navigation
- provider adapter向けexplicit reviewed navigation
- current URL確認
- bounded visible read
- visible control検索
- generic read-only click/fill policyとprovider capability enforcement
- provider adapter向けreviewed read-only click primitive
- TOHO exact non-member continuation専用のnarrow intermediate-control primitive（generic purchase matcherは緩和しない）
- generic上映時刻候補抽出
- Human-only surface（access challenge/CAPTCHA、sign-in/authentication、consent）のcategory-only検出
- Execution Handoff authority / resource epoch / exact invocation binding
- fail-closed error
- provider-neutral semantic evaluation primitive

`evaluateSemanticState()` はprovider IDのdomain checkとHuman-only surface checkを通したうえで、adapterが渡すdeterministicなDOM評価式を既存CDP session上で実行します。provider固有selectorや映画館概念はruntimeへ持ち込みません。

Northbound generic toolとadapter内部primitiveはpolicyを分離します。`navigate_cinema_official` はreview済みpublic read surfaceだけをpositive allow-listで許可し、adapter側はvisible public UIから採用済みのexplicit routeをadapter自身がshape/identity検証した上で `navigateReviewed()` へ渡します。generic click/fillはseat/checkout/purchase相当操作をcapability matrixへ接続し、未知のscript-driven interactionはfail closedします。

### Execution Handoff

Generic control planeはupstream `git-ksk/mcp-execution-handoff` v0.1.0のsource release commitをimmutable pinしてconsumeします。upstreamはAgent/Human authority、resource epoch、resume policy、adapter contract、MRTR requestState/owner bindingを担当し、Cinema固有のprovider URL/capability policy、Human surface classification、verification、replay policyはこのrepositoryへ残します。

Cinema policyはpure readのみ `replay_safe` とし、navigationは `revalidate`、semantic mutationとtransaction/payment actionは `never_replay` です。navigation/mutation/transactionはMCP側でも `require_fresh_semantic_action` を要求するため、Human完了後にautomatic replayしません。Human intervention開始時にはprepared purchase confirmationも破棄します。

詳細は [`EXECUTION_HANDOFF.md`](./EXECUTION_HANDOFF.md) を参照してください。

### `src/purchase-gate.ts`

購入確定のような重大操作に使う短時間confirmationを管理します。

confirmationはmaterial transaction contextにbindingし、短時間で失効し、1回だけ利用可能にします。

### `src/config.ts`

安全側のdefaultを持つruntime設定です。

重要なdefault:

- 専用Chrome profile
- external CDP attach無効
- final purchase無効
- bounded visible read
- 短いconfirmation TTL

## Provider Adapter Layer

```text
MCP Tools
   │
   ▼
Provider read routing
   │
   ├─ TOHO adapter      ← Phase 1 showtime + Phase 3 read-only seat intelligence
   ├─ AEON adapter      ← Phase 1 read-only
   └─ 109 adapter       ← Phase 1 read-only
   │
   ▼
Browser Semantic Primitives
   │
   ▼
CDP Runtime
```

provider-neutral `Theater` / `Showtime` contractとbounded `find_showtimes` orchestrationに加え、Phase 3ではavailabilityとspecial-seat attributeを分離した `CinemaSeatMap` contractとdeterministic recommendation coreを追加しています。provider固有DOM/routeはadapter内に閉じ込めます。

## Provider Adapter

最終形のadapterはCSS selectorではなく、映画館の概念を公開します。

```ts
interface CinemaProviderAdapter {
  readonly id: CinemaProviderId;
  capabilities(): ProviderCapabilities;

  listTheaters(...): Promise<Theater[]>;
  listShowtimes(...): Promise<Showtime[]>;
  openShowtime(...): Promise<ShowtimeContext>;
  readSeatMap(...): Promise<SeatMap>;
  selectSeats(...): Promise<SeatSelection>;
  prepareCheckout(...): Promise<CheckoutSummary>;
}
```

最終購入submitは通常adapter surfaceから分離するか、明示的なconsequential-action tokenを必須にします。

## Capability Model

```ts
interface ProviderCapabilities {
  theaters: boolean;
  showtimes: boolean;
  seatMap: boolean;
  seatSelection: boolean;
  checkoutPreparation: boolean;
  purchaseSubmission: boolean;
}
```

capability matrixは表示用metadataではなくruntime policy boundaryです。`showtimes=true` でも `purchaseSubmission=false` なら、上映検索だけを提供し、最終購入は拒否します。

UI変更や規約上の懸念が出た場合はcapabilityを落とします。無効化された機能をgeneric fuzzy automationで無理に代替しません。

## Browser Stateの扱い

ブラウザ画面は外部から変化し得るmutable stateです。

1. bounded semantic stateを読む
2. candidate ID/label/explicit routeを返す
3. 後続操作前に同じcandidate/contextか再確認する
4. 画面変更・曖昧化していれば拒否する

「近そうな要素」を推測してclickすることはしません。

TOHOは日付click後にselected stateを再確認します。AEONは明示routeがない場合のみvisible UIからscheduleへ進み、path/queryを再検証します。109は劇場・日付ともexplicit public hrefをsource of truthとし、遷移後にexact theater/path/query/date identityを再検証します。

## 3社共通Showtime Schemaへ進む際の境界

現在のprovider resultには差があります。

- TOHO: schedule group / aliasesを持つ
- AEON: theater slug + `?date=YYYYMMDD`
- 109: root theater slug + explicit date href。query形は劇場variantで異なる
- end time / format / language / screen / availabilityの観測可能性に差がある
- movie titleのvisible label表現に差がある

共通contractは `src/cinema.ts` に置き、provider固有routeやDOM selectorを漏らしません。3社adapterは共通 `CinemaReadAdapter` を実装し、少なくとも以下を同じ型で公開します。

- `CinemaTheater`: provider / stable id / display name / provenance `sourceUrl`
- `CinemaShowtime`: provider / theater identity / date / provider-visible movie title / required start time / optional end time
- canonical `formats` vocabulary（同一方式の表記をprovider横断で同じ値へ正規化）
- optional `language: subtitled | dubbed`
- optional `screen`
- `availability: unknown | limited | sold_out | unavailable`
- reviewed public schedule `sourceUrl`
- result-level `dateAvailable` / `availableDates`

`dateAvailable` はmovie filter適用前のdate-level factです。そのため、指定作品が0件でも日付自体がproviderのschedule surfaceで有効なら `true` のままです。`availableDates` はreviewed public UI/routeで観測した日付だけを扱い、未観測の日付routeを推測しません。

availabilityの意味は次で固定します。

- `unknown`: reviewed UIで明示的な残席状態を観測できない。空席ありとはみなさない
- `limited`: 残席わずか等の明示signal
- `sold_out`: 満席・完売・売り切れ等の明示signal
- `unavailable`: 上映回は存在するが、販売期間外・販売開始前・販売終了等の明示signal

movieはprovider-visible display titleを保持し、Phase 2.1では作品名のcross-provider同一作品判定やタイトル書き換えを行いません。TOHOのaliases、AEONのschedule route、109のexplicit route/queryなどはprovider extensionのままです。

`find_showtimes` はこのcontractを通した結果だけを比較します。core inputは最大3件のexplicit `{ provider, theater }` targetで、provider-wide theater discoveryは行いません。同じChrome/CDP sessionを共有するためprovider navigationは意図的にconcurrency=1で順次実行し、複数navigationのraceを作りません。

各provider resultは集約前にprovider/date/theater identity、canonical time/format、official `sourceUrl` provenanceを再検証します。1 providerがfail closedした場合は成功分を破棄しませんが、必ず `complete=false` とprovider別 `failures[]` を返すため、partial resultを完全結果として扱えません。共通filterは `movie` をprovider adapterへ渡し、`after` / `before` / canonical `format` を共通result上で適用します。rankingはdate/start time順、同時刻は明示targetの入力順です。

area解決はこのMCP内の巨大な地理DBや暗黙の全劇場scanへ発展させません。`resolve_theater_targets` をcomposition boundaryとして、`maps-browser-mcp` 等の外部resolverから受けたbounded place labelsをexplicit targetへ変換してから `find_showtimes` へ渡します。

外部place labelはuntrusted external dataです。resolverはlabelをそのままshowtime navigationへ使わず、まずTOHO / イオンシネマ / 109シネマズ（およびムービル）の明示ブランドだけをproviderへ分類し、対応providerのreviewed `list_theaters(label)` で公式公開UIへ再解決します。0件・複数件・provider failure・provenance mismatchはtarget化せず理由を返し、1件に一意解決できた劇場だけをcanonical provider theater nameへ変換します。duplicateは除外し、入力最大8候補・出力最大3targetです。

`maps-browser-mcp` との結合はserver-to-serverの隠れたruntime依存ではなくcaller orchestrationです。`maps_search` → `maps_read_place_summary` → `resolve_theater_targets` → `find_showtimes` の順に明示的にcompositionします。Maps summaryの`truncated` flagはresolver resultへ保持し、bounded visible resultsを完全なarea inventoryとして扱いません。

## 購入ステートマシン

```text
BROWSING
  ↓
SHOWTIME_SELECTED
  ↓
SEATS_REVIEWED
  ↓
SEATS_SELECTED
  ↓
CHECKOUT_PREPARED
  ↓
AWAITING_USER_CONFIRMATION
  ↓
USER_CONFIRMED
  ↓
PURCHASE_SUBMITTED
  ↓
PURCHASE_COMPLETE / PURCHASE_FAILED / PURCHASE_UNKNOWN
```

`PURCHASE_UNKNOWN` では最終操作を絶対に自動replayしません。ユーザーがprovider側で確認するまでterminal扱いにします。

Phase 1 read adaptersはこのtransaction flowへ入らず、上映回のpurchase controlもclickしません。

## Human Intervention

以下では自動操作を停止します。

- ログインが必要
- password入力
- CAPTCHA / anti-bot challenge
- OTP / MFA
- 3-D Secure
- card/payment credential入力
- 未レビューのthird-party identity/payment page
- UIが曖昧

人間操作後は、それ以前のDOM/state assumptionを破棄し、現在画面を再検証してから再開します。

## 軽量・高速化

- Chrome process再利用
- CDP connection/target再利用
- direct CDP
- deterministic処理はローカル実行
- visible readは上限付き
- screenshotは必要性が確認できるまで使わない
- provider adapterではsemantic selectorを優先
- DOM dumpをmodelへ送らない
- 複数判定を可能なら1回の `Runtime.evaluate` にまとめる

3社Phase 1でruntime dependencyは追加しません。

## 永続化

映画館コンテンツの永続化は対象外です。

永続化してよいのは基本的にローカル設定、専用Chrome profile、将来導入する場合のユーザー自身のpreferencesです。

上映履歴・seat availability履歴・HTML archiveへ発展させません。

## Remote / Cloud Run / Multi-user

標準runtimeは引き続きlocal stdioです。加えて、Phase 3ではsingle-user向けのbounded Cloud Run runtimeを実装しています。Streamable HTTP entryはMCP OAuth 2.1で保護し、Protected Resource Metadata、CIMD、PKCE S256、resource-bound opaque access/refresh tokenを扱います。Human authorization時だけFirebase Authでowner UIDを検証し、そのUIDからnon-secret logical principal bindingを作ります。これをheadless dedicated browser、exact Host/Origin boundary、bounded request body、browser operation timeout、Firestore-backed usage controlと組み合わせます。

Cloud Run runtimeではHuman Handoffとpurchase executionを意図的に無効化します。challenge、sign-in、consentが必要になった場合は回避せずfail closedし、必要ならlocal headed stdioへ戻します。

**Multi-user hostingは依然として対象外です。** 将来multi-user化する場合はprincipalごとのbrowser/profile isolation、durable operation ownership、generation fencing、secure human takeover、credential lifecycle、ambiguous payment handlingを別設計として追加する必要があります。single-user OAuth runtimeをそのままmulti-userへ拡張しません。

Cloud Run deployment contractは [`CLOUD_RUN.md`](./CLOUD_RUN.md) を参照してください。

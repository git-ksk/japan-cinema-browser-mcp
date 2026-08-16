# ロードマップ

このロードマップは「全社一斉対応」ではなく、providerごとにcapabilityを段階的に昇格させる前提です。

ステータス:

- ✅ 実装済み
- 🟡 進行中 / 次に着手
- ⬜ 予定
- 🚫 対象外

## Phase 0 — 基盤

目的: provider固有実装の前に、軽量・Local-first・fail-closedなMCP基盤を固める。

状態: ✅ ほぼ完了

- ✅ Public repository（2026-08-15 safety hardening後に公開）
- ✅ Node.js + MCP SDK + `chrome-remote-interface` + Zod
- ✅ CDP直接制御
- ✅ 専用Chrome profile
- ✅ external local CDPは明示opt-in
- ✅ TOHO / AEON / 109のdomain allow-list
- ✅ bounded visible read
- ✅ generic visible control操作
- ✅ sensitive field拒否
- ✅ final purchase controlの通常click拒否
- ✅ 短時間・one-shot purchase confirmation
- ✅ provider capabilityのruntime強制
- ✅ final purchaseデフォルト無効
- ✅ baseline compliance policy
- ✅ unit test / CI定義
- ✅ ドキュメント整備
- ✅ ローカルlive smoke確認

Exit criteria:

- build/typecheck/testが通る
- Chrome lifecycleが安定する
- generic toolから最終購入へ到達できない
- private/internal API依存がない

## Phase 1 — Provider別Read Adapter

目的: generic page readから、映画館ドメインを理解するread-only adapterへ移行する。

状態: ✅ complete — TOHO / AEON / 109実装済み。2026-08-13に3社の非購入live smoke greenを確認

### TOHOシネマズ

- ✅ 現行公式導線を確認
- ✅ 劇場一覧semantic
- ✅ 日付semantic / selected-state再検証
- ✅ 作品/上映回semantic
- ✅ IMAX等の上映方式を正規化
- ✅ 字幕/吹替表示を正規化
- ✅ provider-specific bounded semantic reader
- ✅ stale/ambiguous stateでfail closed
- ✅ unit test
- ✅ 非購入live smoke script追加
- ✅ 実ブラウザでのlive smoke実行確認

TOHOでは `list_theaters` / `get_showtimes` を有効化します。1つのschedule routeを複数劇場名が共有する公開UIもalias groupとして扱い、単純な「ID = 1劇場名」前提には依存しません。

### イオンシネマ

- ✅ 現行公式導線を確認
- ✅ 公式「劇場を探す」UIの劇場semantic
- ✅ public schedule route `theater.aeoncinema.com/theaters/{slug}` を確認
- ✅ public `?date=YYYYMMDD` 表示導線を確認
- ✅ 作品/上映時間range/screen semantic
- ✅ format/language正規化
- ✅ provider-specific bounded semantic reader
- ✅ explicit routeがない場合はslugを推測せず公式UI click経由
- ✅ redirect / theater identity / ambiguous time groupでfail closed
- ✅ unit test
- ✅ 非購入live smoke script追加
- ✅ 実ブラウザでのlive smoke実行確認

AEONではrendered public UIだけを読みます。`schedule.json` 等のprivate/internal endpointを直接利用せず、network interceptionもしません。`予約購入` controlはcontextとして読めてもread adapterからclickしません。

### 109シネマズ

- ✅ 現行公式導線を確認
- ✅ 公式rootの劇場blockから劇場選択semanticを特定
- ✅ 劇場ページのexplicit date hrefから日付semanticを特定
- ✅ `/[slug]/schedules/YYYYMMDD.html...` のpublic routeを確認
- ✅ 通常館とプレミアム新宿でquery形が異なることを考慮し、queryを推測しない
- ✅ 作品/上映時間range/screen semantic
- ✅ format/language/availability正規化
- ✅ provider-specific bounded semantic reader
- ✅ route / theater / date / grouping stale-state check
- ✅ wrong route / ambiguous grouping / unresolved movie-screenでfail closed
- ✅ unit test
- ✅ 非購入live smoke script追加
- ✅ 実ブラウザでのlive smoke実行確認

109ではrootや劇場名からschedule URLを合成せず、rendered public UIに明示された劇場link・日付linkだけを利用します。`オンラインチケット購入` 等の購入導線はread adapterからclickしません。

目標tools:

- `list_theaters` — TOHO / AEON / 109有効
- `get_showtimes` — TOHO / AEON / 109有効
- `find_showtimes` — TOHO / AEON / 109のbounded cross-provider searchとして実装済み

Exit criteria:

- 表示中の公式UIだけから上映情報を返す
- UI変更時はfail closed
- generic broad scanへ黙ってfallbackしない
- source provider / source URLを返す

## Phase 2 — 3社横断検索

目的: 3つの個別adapterを、1つの映画館検索体験にする。

状態: ✅ implementation complete

### P2.1 共通schema

状態: ✅ complete

- ✅ 共通 `CinemaTheater` schema
- ✅ 共通 `CinemaShowtime` schema
- ✅ provider-specific ID / aliases / display nameの整理
- ✅ `dateAvailable` / `availableDates` contract
- ✅ start/end timeのoptional/required整理
- ✅ canonical format vocabulary
- ✅ language `subtitled / dubbed` 統一
- ✅ screen表現をoptional stringへ統一
- ✅ availability `unknown / limited / sold_out / unavailable` の意味固定
- ✅ source URL / provenance固定
- ✅ movie display titleのprovider差を壊さない方針
- ✅ 3 provider adapterを共通 `CinemaReadAdapter` interfaceでtypecheck

`src/cinema.ts` をprovider-neutral contractとし、schemaは「各providerの最小公倍数を雑に文字列化する」のではなく、現在すでに返しているsemantic factsを明示contractへ移す。provider固有route/selector/alias fieldはadapter内のextensionとして残し、共通schemaへ漏らさない。

`dateAvailable` はmovie filter適用前に決定するdate-level factで、`showtimes=[]` と独立する。`availableDates` は現在のreviewed public schedule surfaceから観測した日付だけを返し、未観測routeを生成しない。`unknown` availabilityは「空席あり」を意味せず、明示的な残席signalを観測できなかった状態として扱う。

### P2.2 `find_showtimes`

状態: ✅ implementation complete

- ✅ TOHO / AEON / 109横断検索 — explicit provider/theater target core
- ✅ area / movie / date / before / after / format — areaはexternal bounded place candidates→verified target composition、その他はcore filter
- ✅ deterministic ranking — date/start time、同時刻はtarget入力順
- ✅ provider fan-out数の上限 — 1 request最大3 explicit targets
- ✅ 1 provider failure / ambiguous parseを明示するresult model — `complete=false` + `failures[]`
- ✅ request単位のbounded concurrency — shared browser navigation競合を避けるためconcurrency=1
- ✅ same Chrome/CDP sessionを維持
- ✅ `maps-browser-mcp`等とのcomposition hook / area→explicit target解決 — `resolve_theater_targets`

横断検索も毎回オンデマンドです。定期クロールによるindexは作りません。core toolは勝手にprovider-wide theater discoveryを行わず、呼び出し側が指定した最大3件のexplicit targetだけを読みます。area検索は `resolve_theater_targets` をcomposition boundaryとし、Maps等の外部resolverが返した最大8件のbounded place labelを、provider公式 `list_theaters` で再照合してから最大3件へ絞ります。external resultがtruncatedならその状態を保持し、area全体を走査済みとは扱いません。

特に以下は先に設計します。

1. provider failureを「上映なし」と同一視しない
2. 一社でfail closedした場合に、他社のpartial resultだけを完全結果のように返さない
3. provider-wide全劇場scanをdefaultにしない
4. area解決を本MCP内の巨大な地理DBへ発展させない
5. browser sessionをproviderごとに再起動しない

## Phase 3 — 座席表

目的: 無駄な仮押さえを作らず、表示中のseat mapを理解する。

状態: 🟡 Discovery complete / v0.3.0 implementation planned

2026-08-17にTOHO / AEON / 109のPhase 3 Discoveryを実施しました。seat clickは一切行わず、公開rendered UIと公式公開手順だけからhold境界・seat semantic・geometry候補を比較しています。詳細は [`PHASE3_SEAT_DISCOVERY.md`](./PHASE3_SEAT_DISCOVERY.md) を参照してください。

Discovery結果:

- ✅ TOHO: live `座席指定` surfaceまでseat clickなしで検証。entry時にvisible timer / selected seatなし。read-only safety gate通過、v0.3.0 first providerを維持
- ✅ 109: live seat-map entry時点で10分session timer開始を確認。ただし`選択座席 0／8席`で、独立2 sessionの223席fingerprintも一致。entryだけではseat hold / availability mutationを起こさない強い証拠あり（#35）
- 🟡 AEON: visible `予約購入`までは確認。click後のnew targetがisolated Chromeで`about:blank`のままのためlive seat map未到達。安全性ではなくpublic navigation/target handlingが未解決（#36）
- ✅ special seatはavailabilityと分離してattributeとしてmodel化する方針
- ✅ recommendationはconfirmed `available` のみをdefault対象とし、`unknown`を空席扱いしない
- ✅ TOHO live seat-map entryのread-only safety gateを実地確認（seat hold / material mutation / availability impactなし）
- ⬜ TOHO `get_seat_availability`
- ⬜ provider-neutral row / seat normalization + geometry
- ⬜ adjacent seat grouping / preference scoring
- ⬜ seat state refresh / stale detection

v0.3.0 first scope:

- first provider: TOHO Cinemas only
- `get_seat_availability`
- `recommend_seats`
- row / seat normalization
- adjacent seat grouping
- center / rear / rear-middle / aisle preference scoring
- seat state refresh / stale detection

`seatMap=true` は、実地確認済みのTOHO read-only entryを#32でprovider-specific adapterとして実装し、seat clickなし・UI変化時fail closed・selected seatなしをtestで固定した後にのみ有効化します。

`select_seats` / `seatSelection=true` はv0.3.0 first scopeに含めません。seat click / hold境界をprovider別に再レビューした場合だけ別Issueで検討します。

目標tools:

- `get_seat_availability`
- `recommend_seats`
- `select_seats`（将来のprovider別mutation review後のみ）

Exit criteria:

- seat recommendationだけなら不要な仮押さえを発生させない
- recommendation read/refreshがseat selectionを伴わない
- seat state変更を検出する
- unknown / stale / changed UIを空席として扱わずfail closedする
- 将来seat selectionを有効化する場合、user-intendedな1組だけを選択する

## Phase 4 — Checkout Preparation / Human Handoff

目的: 可逆・低リスク操作を自動化し、認証/決済はユーザーへ戻す。

状態: 🟡 generic Human Handoff基盤実装済み / checkout transaction capabilityは未解禁

- ⬜ ticket type normalization
- ⬜ member/non-member分岐
- ⬜ 非機密checkout field入力
- ✅ sign-in/authentication surface検出とHuman Handoff
- ✅ CAPTCHA / access challenge検出とHuman Handoff（bypassなし）
- ✅ OTP/MFA入力をMCPへ渡さずHuman-onlyに維持
- ✅ consent / reviewed-flow外identity surfaceのHuman Handoff
- ✅ Human操作後のofficial provider / challenge state再検証
- ✅ semantic mutation / transactionのautomatic replay禁止
- ✅ Human intervention開始時のprepared purchase confirmation破棄
- ⬜ provider-specific checkout summary正規化

`seatMap` / `seatSelection` / `checkoutPreparation` / `purchaseSubmission` は引き続き全providerでfalseです。Human Handoff実装はtransaction capabilityの解禁を意味しません。

目標tool:

- `prepare_checkout`

Exit criteria:

- password/payment secretがMCP引数に入らない
- human-only surfaceで必ず停止する
- checkout preparationと購入確定が分離されている

## Phase 5 — 購入確定

目的: providerごとの厳格な監査を通った場合のみ、最終購入を可能にする。

状態: 🟡 generic confirmation infrastructure実装済み / provider purchase capabilityは全社無効

共通runtime safety infrastructure:

- ✅ material transaction summaryをconfirmationへbinding
- ✅ current browser URL/contextへbinding
- ✅ TTL / one-shot confirmation test
- ✅ material context変更でconfirmation無効化
- ✅ duplicate submission防止のone-shot semantics
- ✅ timeout/disconnect後のno-auto-replay / `PURCHASE_UNKNOWN`思想
- ✅ generic final-action controlを通常clickから分離

providerごとに購入を解禁する前に必須:

- ⬜ 現行規約/サイトポリシー再確認
- ⬜ seat / checkout capabilityの個別review完了
- ⬜ exact final control確認
- ⬜ 劇場/作品/日時/座席/券種/金額をprovider UIから再検証
- ⬜ final submit後のvisible UI success/failure/unknown判定
- ⬜ provider-specific purchase regression / live review

既存tools:

- `prepare_purchase_confirmation` — confirmation作成のみ。購入しない
- `confirm_purchase_action` — provider `purchaseSubmission=true` が必要。現在全providerで拒否

購入対応はproviderごとに個別解禁します。3社同時ONは前提にしません。`CINEMA_ENABLE_PURCHASE=true` だけでは不十分で、providerの `purchaseSubmission` capabilityも明示的にtrueである必要があります。

## Phase 6 — Public Hardening

目的: 公開しても設計意図、安全境界、contribution/security運用が明確な状態にする。

状態: ✅ repository public hardening complete — 2026-08-15

- ✅ Git reachable history secret scan
- ✅ historical GitHub Actions logs secret-like pattern scan
- ✅ Cookie/token/payment/auth data path監査
- ✅ private/internal endpoint / network interception非利用確認
- ✅ generic navigation/click/fill capability bypass hardening
- ✅ read-only live smoke: TOHO / AEON / 109
- ✅ purchase gate / no-auto-replay regression
- ✅ SECURITY / COMPLIANCE整合
- ✅ trademark / non-affiliation表記
- ✅ dependency/license audit
- ✅ MIT LICENSE / lockfile / deterministic `npm ci`
- ✅ Public repository化
- ✅ secret scanning / push protection / Dependabot / CodeQL / protected `main`
- ✅ release versioning / milestone policy — `CONTRIBUTING.md` で確定
- ✅ release-note mechanics — GitHub Releasesをcanonical historyとし、現時点では独立CHANGELOGを持たない
- 🟡 npm publication packaging / policy — 明示的なnpm publish判断まで保留

**最初のPublic releaseに購入機能は必須ではありません。**

3社のread-only上映検索が堅く動けば、十分な公開価値があります。

## Phase 7 — Ecosystem Composition

目的: 隣接機能を再実装せず、他MCPとの組み合わせで価値を上げる。

状態: ⬜ 将来

候補:

- ⬜ `maps-browser-mcp` — 周辺劇場/移動時間
- ⬜ TMDB系MCP — 作品メタデータ
- ⬜ Calendar MCP — 購入後の予定登録

原則: **Compose rather than absorb.**

## 現時点でやらないもの

- 🚫 定期上映クロール
- 🚫 provider pollingによる予約開始監視
- 🚫 seat inventory履歴
- 🚫 centralized showtime DB
- 🚫 private/internal cinema API client
- 🚫 CAPTCHA/anti-bot回避
- 🚫 resale automation
- 🚫 multi-account bulk purchase
- 🚫 Local MVP段階でのshared browser fleet

## 推奨実装順

1. ✅ TOHO read adapter
2. ✅ AEON read adapter
3. ✅ 109 read adapter
4. ✅ common Theater / Showtime schema
5. ✅ `find_showtimes` + `resolve_theater_targets` bounded composition
6. ✅ Public repository safety hardening / CI / security operations
7. seat mapをproviderごとに個別reviewして追加
8. checkout preparationをproviderごとに個別reviewして追加
9. final purchaseはprovider監査後のみ

providerごとに難易度や利用条件が違うため、feature parityを無理に揃えません。capability単位で安全にdegradeできる設計を優先します。

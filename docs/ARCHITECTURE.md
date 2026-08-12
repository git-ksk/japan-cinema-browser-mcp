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
- provider capabilityの明示

Phase 1では `list_theaters` / `get_showtimes` を追加し、semantic read capabilityはTOHOだけ有効化しています。未実装providerへgeneric fuzzy fallbackはしません。

### `src/providers.ts`

provider registryと横断ポリシーを保持します。

- provider ID
- 公式root URL
- domain allow-list
- granular capability matrix
- sensitive field判定
- final purchase control判定

TOHOは `theaters=true / showtimes=true`、seat/checkout/purchase系はfalseです。AEON/109のsemantic readはまだfalseです。

### `src/providers/toho/adapter.ts`

Phase 1のTOHO read-only adapterです。

- 公式劇場一覧のvisible theater linkをsemanticに抽出
- 公開schedule routeをschedule groupとして正規化
- 同じrouteを共有する複数劇場名をaliasesとして保持
- visible date controlを `YYYY-MM-DD` へ正規化
- 日付切替後のselected stateを再検証
- 作品 / 上映時刻 / format / 字幕・吹替 / screen / availabilityを必要な範囲だけ抽出
- source URLを返却
- UI変更、曖昧grouping、movie/showtime対応不能時はfail closed

raw HTMLやfull DOMをadapter外へ返さず、CDP `Runtime.evaluate` 内で小さいstructured factへ落としてからNode側へ戻します。

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

- official-domain navigation
- current URL確認
- bounded visible read
- visible control検索・click
- 非機密field入力
- generic上映時刻候補抽出
- challenge検出
- fail-closed error
- provider-neutral semantic evaluation primitive

`evaluateSemanticState()` はprovider IDのdomain checkとchallenge checkを通したうえで、adapterが渡すdeterministicなDOM評価式を既存CDP session上で実行します。provider固有selectorや映画館概念はruntimeへ持ち込みません。

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

## 目標レイヤー構造

provider実装が増えたら、次のように分離します。

```text
MCP Tools
   │
   ▼
Cinema Workflow Service
   │
   ├─ cross-provider normalization
   ├─ search/filter/ranking
   └─ transaction state
   │
   ▼
Provider Adapter Interface
   │
   ├─ TOHO adapter      ← read-only Phase 1実装済み
   ├─ AEON adapter
   └─ 109 adapter
   │
   ▼
Browser Semantic Primitives
   │
   ▼
CDP Runtime
```

Phase 1では将来interface全体を先に作り込まず、TOHO read-only縦切りに必要なsurfaceだけを実装します。

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

provider対応は機能単位で管理します。

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

`showtimes=true` でも `purchaseSubmission=false` なら、上映検索だけ安全に提供できます。

UI変更や規約上の懸念が出た場合はcapabilityを落とします。無効化された機能をgeneric fuzzy automationで無理に代替しません。

## Browser Stateの扱い

ブラウザ画面は外部から変化し得るmutable stateです。

1. bounded semantic stateを読む
2. candidate ID/labelを返す
3. 後続toolで選択前に同じcandidateか再確認する
4. 画面変更・曖昧化していれば拒否する

「近そうな要素」を推測してclickすることはしません。

TOHOの日付切替では、visible date controlを一意に解決してclickした後、同じsemantic readerでもう一度画面を読み、requested dateがselected stateになったことを確認してから上映情報を返します。

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

Phase 1のTOHO adapterはこのtransaction flowへ入らず、上映回の購入controlもclickしません。

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

複数のdeterministic DOM判定は、可能なら1回の `Runtime.evaluate` にまとめます。TOHO Phase 1も劇場一覧/上映画面ごとにcompact semantic snapshotへまとめ、モデルへraw pageを渡しません。

## 永続化

映画館コンテンツの永続化は対象外です。

永続化してよいのは基本的にローカル設定、専用Chrome profile、将来導入する場合のユーザー自身のpreferencesです。

上映履歴・seat availability履歴・HTML archiveへ発展させません。

## Remote/Multi-user

現在のMVP対象外です。

将来remote化する場合はauthenticated principal、principalごとのbrowser/profile isolation、durable operation ownership、generation fencing、abuse/rate control、secure human takeover、ambiguous payment handling等を別途設計します。

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

### `src/providers.ts`

現時点ではprovider registryと横断ポリシーを保持します。

- provider ID
- 公式root URL
- domain allow-list
- sensitive field判定
- final purchase control判定

provider固有のDOM/semantic知識は今後adapterへ分離します。

### `src/browser/chrome-process.ts`

Chrome process lifecycleを管理します。

- installed Chrome/Chromium検出
- 専用profile起動
- loopback CDP有効化
- MCP所有Chromeの再利用
- 明示許可されたexternal CDPへの接続
- MCP所有processだけ安全に終了

### `src/browser/runtime.ts`

現在のCDP targetと、公開UIに対する最小限のbrowser primitiveを担当します。

- official-domain navigation
- current URL確認
- bounded visible read
- visible control検索・click
- 非機密field入力
- 上映時刻候補抽出
- challenge検出
- fail-closed error

provider固有ロジックはここに増やさず、上位adapter/controllerへ置きます。

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
   ├─ TOHO adapter
   ├─ AEON adapter
   └─ 109 adapter
   │
   ▼
Browser Semantic Primitives
   │
   ▼
CDP Runtime
```

## Provider Adapter

adapterはCSS selectorではなく、映画館の概念を公開します。

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
- provider adapter完成後はsemantic selectorを優先
- DOM dumpをmodelへ送らない

複数のdeterministic DOM判定は、可能なら1回の `Runtime.evaluate` にまとめます。

## 永続化

映画館コンテンツの永続化は対象外です。

永続化してよいのは基本的にローカル設定、専用Chrome profile、将来導入する場合のユーザー自身のpreferencesです。

上映履歴・seat availability履歴・HTML archiveへ発展させません。

## Remote/Multi-user

現在のMVP対象外です。

将来remote化する場合はauthenticated principal、principalごとのbrowser/profile isolation、durable operation ownership、generation fencing、abuse/rate control、secure human takeover、ambiguous payment handling等を別途設計します。

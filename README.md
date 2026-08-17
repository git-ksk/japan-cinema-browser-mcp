# japan-cinema-browser-mcp


日本の映画館公式サイトを、ユーザー本人のブラウザ上で安全に操作するための Browser-first MCP です。

当面の対応対象は次の3社です。

- TOHOシネマズ
- イオンシネマ
- 109シネマズ

## このプロジェクトが目指すもの

映画館ごとに異なるWeb UIを、MCPから共通の概念で扱えるようにします。

最終的には、次のような一連の操作を対象にします。

```text
上映を探す
  ↓
劇場・日時・上映方式を比較する
  ↓
座席を確認する
  ↓
座席を選ぶ
  ↓
購入直前まで進む
  ↓
ユーザーが内容を明示確認する
  ↓
購入を確定する
```

ただし、これは映画館データを収集・再配布するサービスではありません。ユーザーの要求時に、公式サイト上で通常のブラウザ操作を行うことを基本とします。

## 基本方針

- 公式Web UIを優先し、非公開・内部APIを解析して直接利用しない
- 定期クロールや全国上映データのDB化を行わない
- 上映情報、座席表、HTML、画像、Cookie、決済情報を永続保存しない
- CAPTCHA、MFA、OTP、3-D Secureなどを自動突破しない
- パスワード、OTP/MFA、CAPTCHA answer、カード/銀行情報などの機密情報をMCP経由で入力しない
- Human handoff完了を別actionのapprovalとして扱わない
- Human interventionで中断したstateful/consequential actionを自動replayしない
- 購入確定などの重大操作は通常のclick toolから分離する
- 最終購入はデフォルト無効とし、明示確認を必須にする
- UIが変わった、対象が曖昧、状態が不明な場合は推測せず停止する
- 軽量・高速を維持し、ブラウザセッションを再利用する

詳細は [`COMPLIANCE.md`](./COMPLIANCE.md) を正本とします。

## アーキテクチャ

`maps-browser-mcp` と同じ思想で、Playwrightを使わずChrome DevTools Protocol（CDP）を直接利用します。

```text
MCPクライアント
      │
      │ stdio
      ▼
japan-cinema-browser-mcp
      │
      │ CDP
      ▼
専用ローカルChrome
      │
      ├─ TOHOシネマズ
      ├─ イオンシネマ
      └─ 109シネマズ
```

ランタイム依存は現在3つだけです。

- `@modelcontextprotocol/server`
- `chrome-remote-interface`
- `mcp-execution-handoff` v0.1.0（source release commitへimmutable pin）
- `zod`

PlaywrightやChromium本体は同梱しません。

## 現在の状態

Public repositoryとして、次の安全基盤とread capabilityを実装済みです。

- 専用Chromeプロファイルの起動・再利用
- CDP接続
- 3社公式ドメインのallow-list
- 表示中ページのbounded read
- 表示中コントロールの操作
- 上映時刻候補の簡易抽出
- 機密入力フィールドの拒否
- 購入確定系コントロールの通常clickからの拒否
- 短時間・one-shot・URL-boundの購入確認ゲート
- provider capabilityの実行時強制
- 最終購入のデフォルト無効化
- TOHOシネマズの劇場一覧semantic read
- TOHOシネマズの劇場・日付・作品・上映回semantic read
- TOHOシネマズの日付切替後のselected-state再検証
- TOHOシネマズ / イオンシネマ / 109シネマズのread-only `get_seat_availability`（seat identity / availability / rendered gap geometry、seat clickなし）
- TOHOシネマズのread-only `recommend_seats`（2回のbounded readでcontext/layout/state freshnessを確認してから adjacent / center / rear / rear-middle / aisle候補を返す）
- イオンシネマの公式「劇場を探す」UIからの劇場一覧semantic read
- イオンシネマの公開 `theater.aeoncinema.com/theaters/{slug}` schedule route利用
- イオンシネマの日付・作品・上映時間・screen・format/language semantic read
- 109シネマズ公式トップの劇場ブロックからの劇場一覧semantic read
- 109シネマズ各劇場ページに表示された公開日付linkからのschedule route discovery
- 109シネマズの日付・作品・上映時間・screen・format/language/availability semantic read
- TOHO / AEON / 109ともUI変更・曖昧状態・identity mismatchでfail closed

TOHO / AEON / 109の3社showtime read adapterとread-only `seatMap=true` を有効化しています。109はseat-map entry時に10分session timerが開始しますが、座席を選択しません。AEONはreview済みのCookie拒否 → exact showtime → Watatheatre non-member → Smart Theater seat routeだけを通り、actual seat classをread-onlyで抽出します。`seatSelection / checkoutPreparation / purchaseSubmission` は全社falseのままです。

自然発生したaccess challenge/CAPTCHA、sign-in/authentication、consentはgeneric Execution Handoffへ接続しています。Agent/Human authorityは排他で、resource epoch、exact invocation/requestState binding、post-Human replay policyを適用します。これによってtransaction capabilityが有効になることはありません。

109は `https://109cinemas.net/` の表示中劇場linkと、各劇場ページに表示された `/[theater]/schedules/YYYYMMDD.html...` の明示hrefだけを利用します。slug・日付route・query値を推測して生成しません。`オンラインチケット購入` 等の購入導線はread contextとして表示されてもadapterからclickしません。

## セットアップ

必要環境:

- Node.js 20+
- npm
- Google Chrome

```bash
npm ci --ignore-scripts
npm run build
npm start
```

MCPは標準ではstdioで動作し、ログはstderrに出します。

### Single-user Cloud Run mode

`--http` と明示的なremote設定を組み合わせると、headless Chromiumを使うsingle-user向けStreamable HTTP deploymentも利用できます。これはlocal stdioの代替となる汎用multi-user hostingではありません。

Cloud Run modeでは次を強制します。

- MCP OAuth 2.1 resource-server / authorization-server boundary
- RFC 9728 Protected Resource Metadata、CIMD、PKCE S256、refresh-token rotation
- Human authorization時だけFirebase Authをidentity providerとして使用し、検証したUIDをlogical principalへbind
- single-user Cloud Runでは許可UIDを明示allowlist
- exact Host / Origin boundary
- headless dedicated browser profile
- external CDP禁止
- purchase execution禁止
- challenge / sign-in / consent時はHuman Handoffせずfail closed
- browser operation timeout
- Firestore-backed `mcp-usage-control` によるdurable daily budget

詳細は [`docs/CLOUD_RUN.md`](./docs/CLOUD_RUN.md) を参照してください。

## Chromeの使い方

### 標準: 専用Chromeプロファイル

特別な設定は不要です。インストール済みChromeを起動し、次の専用プロファイルを再利用します。

```text
~/.japan-cinema-browser-mcp/chrome-profile
```

映画館サイトのログイン状態を通常のChromeプロファイルから分離できます。

### 任意: 既存CDPポートへ接続

通常のChromeセッションへの接続はアクセス範囲が広がるため、明示的なopt-inが必要です。

```bash
CINEMA_ALLOW_EXTERNAL_CDP=true \
CINEMA_CDP_PORT=9222 \
npm start
```

## Execution Handoff

Execution Handoffのgeneric control planeはupstream `git-ksk/mcp-execution-handoff` v0.1.0のsource release commitをimmutable pinして利用します。Cinema側にはprovider policy、Human surface classification、postcondition verification、resume policyを残します。

| 操作class | core resume policy | MCP strategy |
| --- | --- | --- |
| bounded pure read | `replay_safe` | `retry_original` |
| navigation/provider semantic flow | `revalidate` | `require_fresh_semantic_action` |
| semantic mutation | `never_replay` | `require_fresh_semantic_action` |
| transaction/payment action | `never_replay` | `require_fresh_semantic_action` |

Human handoffが始まった時点でprepared purchase confirmationを破棄します。seat selection / checkout / purchase / payment系はhandoff完了後もautomatic replayせず、fresh semantic actionと必要なexplicit confirmationを要求します。credential、OTP/MFA、CAPTCHA answer、payment dataはMCPへ渡しません。

仕様は [`docs/EXECUTION_HANDOFF.md`](./docs/EXECUTION_HANDOFF.md) を参照してください。

## 購入機能

最終購入はデフォルトで無効です。

```bash
CINEMA_ENABLE_PURCHASE=true npm start
```

この設定だけでは購入実行は有効になりません。providerごとの `purchaseSubmission` capabilityもtrueである必要があり、現在はTOHO/AEON/109すべてfalseです。購入確認ゲートも省略できません。

購入前には少なくとも以下を確認対象として固定します。

- provider
- 劇場
- 作品
- 日付
- 上映時刻
- 座席
- 券種
- 合計金額
- 現在の購入ページ

確認は短時間で失効し、1回しか使えません。画面や購入内容が変わった場合は再確認が必要です。

## 現在のMCP Tools

- `list_cinema_providers` — 対応provider一覧とcapability
- `browser_status` — Chrome/CDP状態
- `open_cinema_provider` — 公式サイトを開く
- `navigate_cinema_official` — 明示レビュー済みのpublic read surfaceだけへ移動する。同一公式domain内でも任意path/subdomainは許可しない
- `read_cinema_page` — 表示中情報を上限付きで読む
- `extract_showtime_candidates` — 表示中の上映時刻候補を抽出する
- `list_theaters` — providerの公式公開UIから劇場をsemanticに読む。TOHO / AEON / 109有効
- `get_showtimes` — 劇場・日付・作品・上映回をsemanticに読む。TOHO / AEON / 109有効
- `get_seat_availability` — exact theater/date/movie/startTime/screenにbindingしたTOHO / AEON / 109のlive seat mapをread-onlyで読む。109はrendered public hrefをそのまま採用して10分session semanticsを保持し、AEONはreview済みexternal target chainだけを採用する。いずれもseat click / hold生成なし
- `recommend_seats` — 同一TOHO seat mapを2回readし、context/layout/state fingerprintが一致した時だけconfirmed availableの隣接候補を順位付けする。special seatは明示opt-in
- `resolve_theater_targets` — Maps等のbounded external place labelsをprovider公式劇場UIで再照合し、最大3件のverified `{ provider, theater }` targetへ変換する
- `find_showtimes` — 最大3件の明示provider/theater targetを同一request内で順次読み、共通contractでfilter・集約する。provider failureは`complete=false`と`failures`で明示
- `click_cinema_control` — reviewed read surface内の明示的read操作だけを実行する。seat/checkout/purchase系はprovider capabilityで拒否
- `fill_cinema_field` — reviewed read-only search/filter fieldだけ入力する。seat/checkout fieldと機密fieldは拒否
- `prepare_purchase_confirmation` — 現在の購入内容を確認用に固定する
- `confirm_purchase_action` — 最終購入操作。provider capabilityが必要で、現在全provider無効
- `close_browser_session` — MCP所有Chromeを閉じる

## 開発時の確認

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
git diff --check
```

`main` はGitHub rulesetで保護し、pull request + squash merge、required CI、linear history、force-push/delete禁止を適用しています。GitHub ActionsはGitHub-owned actionだけを許可し、workflow内のactionはfull commit SHAへ固定します。依存関係とGitHub ActionsはDependabotで週次確認します。

providerの非購入live smokeは通常CIには含めず、低頻度で明示実行します。

Generic navigation/click/fill と provider adapter内部のreviewed flowは別policyです。Generic toolはpositive allow-listのpublic read surfaceだけを扱い、adapterはrendered public UIから採用・検証したexplicit route/controlだけを内部primitiveで操作します。

```bash
npm run smoke:toho
npm run smoke:aeon
npm run smoke:109
```

これらのsmoke testは公式公開UIの劇場一覧・上映画面を読むだけで、座席選択や購入操作は行いません。2026-08-13にTOHO / AEON / 109の3社すべてでgreenを確認済みです。

## 次の段階

3社のread capabilityに加え、provider-neutral `CinemaTheater` / `CinemaShowtime` / `CinemaSeatMap` contractを `src/cinema.ts` に追加済みです。Phase 3のTOHO first vertical sliceではread-only seat extraction、freshness fingerprint、deterministic seat recommendationまで実装し、provider固有route・selector・seat DOM semanticはadapter側に残します。

Phase 2.2では `resolve_theater_targets` と `find_showtimes` を分離しています。`find_showtimes` は最大3件の明示 `{ provider, theater }` targetだけを受け、同じChrome/CDP session上で順次実行します。`date` / `movie` / `after` / `before` / canonical `format` filterを適用し、開始時刻順 + target入力順でdeterministicに集約します。

area検索はこのMCP自身が地理DBや全劇場scanを持つのではなく、外部resolverとのcompositionで行います。たとえば `maps-browser-mcp` のbounded visible resultを使う場合は、次のようにcaller側で接続します。

```text
maps_search({ query: "映画館 横浜駅" })
  -> maps_read_place_summary()
  -> resolve_theater_targets({ candidates: summary.items, sourceTruncated: summary.truncated })
  -> find_showtimes({ targets: resolved.targets, ...filters })
```

`resolve_theater_targets` は外部labelを命令として扱わず、TOHO / イオンシネマ / 109シネマズ（およびムービル）の明示ブランドだけを分類します。その後、各providerのreviewed `list_theaters` で公式UIへ再照合し、1劇場に一意解決できてofficial provenanceも再検証できた候補だけをcanonical targetへ変換します。入力は最大8候補、出力は最大3targetで、unsupported / zero-match / ambiguous / provider failure / duplicate / limit reachedを明示します。外部summaryの`truncated`状態も保持するため、bounded結果を完全なarea inventoryとして誤認しません。

一社のfail-closedは「上映なし」に変換せず、成功分を返す場合も必ず `complete=false` と `failures[]` を併記します。provider resultのprovider/date/theater/sourceUrl provenanceが共通contractに一致しない場合も `CONTRACT_VIOLATION` として集約対象から除外します。provider-wide全劇場scan・background crawl・巨大な地理DBは導入しません。

## ドキュメント

- [`docs/PROJECT.md`](./docs/PROJECT.md) — プロジェクト定義・非目標
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — 設計・状態境界
- [`docs/EXECUTION_HANDOFF.md`](./docs/EXECUTION_HANDOFF.md) — Execution Handoff
- [`docs/ROADMAP.md`](./docs/ROADMAP.md) — 開発ロードマップ
- [`docs/SECURITY.md`](./docs/SECURITY.md) — セキュリティモデル
- [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md) — 実装ルール
- [`docs/PROVIDERS.md`](./docs/PROVIDERS.md) — provider対応状況
- [`COMPLIANCE.md`](./COMPLIANCE.md) — コンプライアンス方針
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — contribution / safety / testルール
- [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) — community code of conduct
- [`.github/SECURITY.md`](./.github/SECURITY.md) — vulnerability reporting policy

## 非公式プロジェクトであることについて

本プロジェクトはTOHOシネマズ、イオンシネマ、109シネマズおよび各運営会社とは提携・後援・公認関係にありません。provider名は相互運用対象を示すためにのみ使用します。

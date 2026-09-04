# japan-cinema-browser-mcp

日本の映画館公式サイトを、ユーザー本人のブラウザ上で安全に操作するための Browser-first MCP です。

映画館ごとに異なるWeb画面を、MCPから「劇場」「上映回」「座席」といった共通の概念で扱えるようにします。映画館データの収集・集約・再配布を目的としたサービスではなく、**ユーザーが依頼したときだけ公式Web画面を操作する**ことを基本にしています。

現在の主な対象は次の3社です。

- TOHOシネマズ
- イオンシネマ
- 109シネマズ

> [!IMPORTANT]
> 本プロジェクトは各映画館・運営会社の非公式プロジェクトです。提携、後援、公認を受けているものではありません。

## できること

現在は、3社の公式公開画面を使った**読み取り中心の操作**を実装しています。

| 機能 | TOHO | イオン | 109 |
|---|---:|---:|---:|
| 劇場一覧を読む | ✅ | ✅ | ✅ |
| 上映情報を読む | ✅ | ✅ | ✅ |
| 座席表を読む | ✅ | ✅ | ✅ |
| 座席候補を提案する | ✅ | — | — |
| 座席を選択する | ❌ | ❌ | ❌ |
| 購入直前まで自動で進める | ❌ | ❌ | ❌ |
| 購入を確定する | ❌ | ❌ | ❌ |

実装上の識別子では、3社とも `seatMap=true`、`seatSelection=false`、`checkoutPreparation=false`、`purchaseSubmission=false` です。

### 代表的な利用イメージ

```text
上映を探す
  ↓
劇場・日時・上映方式を比較する
  ↓
座席表を確認する
  ↓
空席から候補を提案する
  ↓
必要に応じて人間へ操作を戻す
```

座席選択や購入のように状態を変える操作は、映画館ごとに安全性を確認できるまで有効にしません。

## 基本方針

このリポジトリでは、便利さより先に次の境界を守ります。

- 公式の公開Web画面だけを利用する
- 非公開APIや内部APIを探索・直接利用しない
- 定期クロールや全国上映データのDB化を行わない
- HTML、座席表、Cookie、セッショントークン、決済情報を永続保存しない
- CAPTCHA、MFA、OTP、3-D Secure、待機列、アクセス制御を自動突破しない
- パスワード、OTP、カード情報などをMCPの引数として受け取らない
- 画面や対象が曖昧なら推測せず安全側に停止する
- 人間の操作完了を、別の操作の承認として扱わない
- 状態を変える操作や購入操作を自動で再実行しない

詳細な正本は [`COMPLIANCE.md`](./COMPLIANCE.md) と [`docs/SECURITY.md`](./docs/SECURITY.md) です。

## アーキテクチャ

Playwrightは使用せず、Chrome DevTools Protocol（CDP）を直接利用します。

```text
MCPクライアント
      │
      │ stdio
      ▼
japan-cinema-browser-mcp
      │
      │ CDP
      ▼
専用Chromeプロファイル
      │
      ├─ TOHOシネマズ
      ├─ イオンシネマ
      └─ 109シネマズ
```

主な実行時依存は次のとおりです。

- `@modelcontextprotocol/server`
- `chrome-remote-interface`
- `mcp-execution-handoff`
- `zod`

Chromium本体は同梱しません。標準では端末にインストールされたChromeを、専用プロファイルで起動します。

## セットアップ

必要環境:

- Node.js 20以上
- npm
- Google Chrome または Chromium

```bash
npm ci --ignore-scripts
npm run build
npm start
```

標準ではstdioで動作し、ログはstderrへ出力します。

### 専用Chromeプロファイル

標準では次の専用プロファイルを使います。

```text
~/.japan-cinema-browser-mcp/chrome-profile
```

通常利用しているChromeプロファイルと映画館サイトの状態を分離するためです。

### 既存のCDPポートへ接続する場合

通常のChromeセッションへ接続するとアクセス範囲が広がるため、明示的な許可が必要です。

```bash
CINEMA_ALLOW_EXTERNAL_CDP=true \
CINEMA_CDP_PORT=9222 \
npm start
```

## Cloud Run

ローカルstdioが標準構成です。`--http` とリモート用設定を組み合わせると、**1ユーザー限定**のCloud Run構成も利用できます。

この構成では次を必須にしています。

- MCP OAuth 2.1
- 許可するFirebase UIDは1件
- 専用のheadless Chromium
- 外部CDP接続は禁止
- 購入実行は禁止
- 映画館サイトで人間操作が必要になった場合は安全側に停止
- 同じブラウザ状態を複数ユーザーで共有しない

汎用的なマルチユーザーMCPホスティングとして使う構成ではありません。詳しくは [`docs/CLOUD_RUN.md`](./docs/CLOUD_RUN.md) を参照してください。

## Human Handoff

ログイン、アクセスチャレンジ、同意画面など、人間が操作すべき場面では `mcp-execution-handoff` を利用して実行権限を人間へ移します。Phase 4 TOHOのGate 0b physical acceptanceは `BrowserHandoffAdapter` + WebRTCで完了済みです。current Gate 1と今後のGate 0b再実行は、headedな専用Chromeのexact macOS windowへHandoffのfirst-class `WindowWebSocketHandoffAdapter`を接続するWSS-only経路を使います。Cinemaはseat intent / provider policy / postcondition verificationと、専用Chrome PIDからexactly oneのCGWindowIDを選ぶ境界だけを所有し、WSS session/capture/input/focus fencing/reconnect/revokeはHandoffへ委譲します。Human inputはpointer/scrollだけで、text/keyはserver-sideで拒否します。current WSS pathではICE/STUN/TURNを構成せず、この経路はCloud Run headless runtimeや一般的なremote browser hostingを有効化するものではありません。

重要なのは、**人間が操作を終えたからといって、中断した操作をそのまま再実行しない**ことです。

- 読み取りだけの操作は、検証後に再試行できる場合がある
- 画面遷移は、現在状態を読み直してから新しい操作として扱う
- 座席選択など状態を変える操作は自動再実行しない
- 購入・決済操作は自動再実行しない
- Human Handoffを開始した時点で、準備済みの購入確認は無効化する

詳細は [`docs/EXECUTION_HANDOFF.md`](./docs/EXECUTION_HANDOFF.md) を参照してください。

## 現在のMCPツール

| ツール | 内容 |
|---|---|
| `list_cinema_providers` | 対応映画館と現在の対応機能を返す |
| `browser_status` | Chrome / CDPの状態を確認する |
| `open_cinema_provider` | 映画館の公式サイトを開く |
| `navigate_cinema_official` | レビュー済みの公開画面だけへ移動する |
| `read_cinema_page` | 表示中の情報を上限付きで読む |
| `extract_showtime_candidates` | 表示中の上映時刻候補を抽出する |
| `list_theaters` | 公式画面から劇場一覧を読む |
| `get_showtimes` | 劇場・日付・作品・上映回を読む |
| `get_seat_availability` | 指定上映回の座席表を読み取り専用で確認する |
| `recommend_seats` | TOHOの座席表から候補を順位付けする |
| `start_checkout_handoff` | TOHOで上映回・seat mapを再確認し、座席選択から購入完了までHumanへ操作権を渡す |
| `resolve_theater_targets` | 外部の場所候補を公式劇場一覧で再照合する |
| `find_showtimes` | 最大3件の劇場を横断して上映情報を検索する |
| `click_cinema_control` | レビュー済みの読み取り系操作だけを実行する |
| `fill_cinema_field` | レビュー済みの検索・絞り込み欄だけへ入力する |
| `prepare_purchase_confirmation` | 購入内容を短時間の確認対象として固定する |
| `confirm_purchase_action` | 最終購入用。現在は全映画館で実行不可 |
| `close_browser_session` | MCPが起動したChromeを閉じる |

無効化された機能を、汎用クリックや曖昧な画面操作で迂回することはありません。

## 3社横断検索

`find_showtimes` は勝手に全国の映画館を巡回しません。呼び出し側が指定した最大3件の `{ provider, theater }` だけを、同じChrome/CDPセッションで順番に読みます。

場所検索と組み合わせる場合は、Maps系MCPなどから得た候補を `resolve_theater_targets` で公式劇場一覧へ再照合してから利用します。

```text
場所検索
  -> 劇場候補
  -> resolve_theater_targets
  -> 公式UIで一意に確認できた劇場だけ採用
  -> find_showtimes
```

一部の映画館で読み取りに失敗した場合は「上映なし」に置き換えず、部分結果であることを明示します。

## 座席表と座席提案

3社とも座席表の読み取りに対応しています。Agentが座席をクリックして確保する `seatSelection` は無効のままです。TOHOだけは別capabilityの `humanCheckoutHandoff=true` とし、上映回のseat mapを2回安定readした後、`start_checkout_handoff` から座席選択〜利用規約〜券種〜購入者情報〜支払い〜最終購入までをHumanが専用Chromeで一貫して操作できます。seatIdsはoptionalで、未指定なら座席自体もHandoff内でHumanが選びます。Agentは購入submitを行いません。

TOHOの `recommend_seats` では、同じ座席表を2回読み、上映回・レイアウト・空席状態が一致した場合だけ候補を返します。状態が変わっていた場合は古い結果を使いません。

特別席や車椅子対応席は「空いているかどうか」と別の属性として扱い、標準の候補からは除外します。

## 開発時の確認

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
git diff --check
```

映画館公式サイトを使う確認は通常CIに含めず、必要な映画館だけ低頻度で明示実行します。

```bash
npm run smoke:toho
npm run smoke:aeon
npm run smoke:109
```

これらは購入・決済を行うテストではありません。

## ドキュメント

最初に [`docs/README.md`](./docs/README.md) を読むと、目的別のドキュメントへ辿れます。

主な文書:

- [`docs/PROJECT.md`](./docs/PROJECT.md) — 目的・非目標・設計方針
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — アーキテクチャ
- [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md) — 開発方針
- [`docs/SECURITY.md`](./docs/SECURITY.md) — セキュリティモデル
- [`docs/PROVIDERS.md`](./docs/PROVIDERS.md) — 映画館ごとの対応状況
- [`docs/ROADMAP.md`](./docs/ROADMAP.md) — ロードマップ
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — コントリビューション方法
- [`SUPPORT.md`](./SUPPORT.md) — サポート窓口

## 非公式プロジェクトについて

本プロジェクトはTOHOシネマズ、イオンシネマ、109シネマズおよび各運営会社とは提携・後援・公認関係にありません。

各社名は、相互運用の対象となるWebサイトを識別するためにのみ使用しています。

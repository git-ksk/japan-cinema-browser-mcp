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
- パスワードやカード番号などの機密情報をMCP経由で入力しない
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
- `zod`

PlaywrightやChromium本体は同梱しません。

## 現在の状態

Private MVPでは、次の基盤まで実装済みです。

- 専用Chromeプロファイルの起動・再利用
- CDP接続
- 3社公式ドメインのallow-list
- 表示中ページのbounded read
- 表示中コントロールの操作
- 上映時刻候補の簡易抽出
- 機密入力フィールドの拒否
- 購入確定系コントロールの通常clickからの拒否
- 短時間・one-shot・URL-boundの購入確認ゲート
- 最終購入のデフォルト無効化

次は各社の現在のWeb UIを確認し、劇場・日付・作品・上映回を映画館ドメインの概念として扱うprovider adapterを実装します。

## セットアップ

必要環境:

- Node.js 20+
- npm
- Google Chrome

```bash
npm install
npm run build
npm start
```

MCPはstdioで動作し、ログはstderrに出します。

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

## 購入機能

最終購入はデフォルトで無効です。

```bash
CINEMA_ENABLE_PURCHASE=true npm start
```

この設定を有効にしても、購入確認ゲートは省略できません。

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

- `list_cinema_providers` — 対応provider一覧
- `browser_status` — Chrome/CDP状態
- `open_cinema_provider` — 公式サイトを開く
- `navigate_cinema_official` — 許可済み公式ドメイン内だけ移動する
- `read_cinema_page` — 表示中情報を上限付きで読む
- `extract_showtime_candidates` — 表示中の上映時刻候補を抽出する
- `click_cinema_control` — 表示中の通常操作を実行する
- `fill_cinema_field` — 非機密フィールドだけ入力する
- `prepare_purchase_confirmation` — 現在の購入内容を確認用に固定する
- `confirm_purchase_action` — 最終購入操作。デフォルト無効
- `close_browser_session` — MCP所有Chromeを閉じる

## ドキュメント

- [`docs/PROJECT.md`](./docs/PROJECT.md) — プロジェクト定義・非目標
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — 設計・状態境界
- [`docs/ROADMAP.md`](./docs/ROADMAP.md) — 開発ロードマップ
- [`docs/SECURITY.md`](./docs/SECURITY.md) — セキュリティモデル
- [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md) — 実装ルール
- [`docs/PROVIDERS.md`](./docs/PROVIDERS.md) — provider対応状況
- [`COMPLIANCE.md`](./COMPLIANCE.md) — コンプライアンス方針

## 開発

```bash
npm run typecheck
npm test
npm run build
```

## 非公式プロジェクトであることについて

本プロジェクトはTOHOシネマズ、イオンシネマ、109シネマズおよび各運営会社とは提携・後援・公認関係にありません。provider名は相互運用対象を示すためにのみ使用します。

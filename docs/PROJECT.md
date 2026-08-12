# プロジェクト定義

## ミッション

`japan-cinema-browser-mcp` は、日本の映画館公式サイトをユーザー本人の意思に基づいて操作するための、軽量・Browser-firstなMCPです。

映画館ごとにバラバラなWeb UIを、AIからは共通の映画館ドメイン概念で扱えるようにしつつ、認証・機密情報・購入確定などの重要操作はユーザー管理下に残します。

当面の対象は以下の3社です。

- TOHOシネマズ
- イオンシネマ
- 109シネマズ

## プロダクト仮説

汎用ブラウザ操作でも映画館サイトは触れますが、毎回モデル側が「劇場」「日付」「作品」「上映回」「座席」「券種」「購入」といった意味をDOMから再発見する必要があります。

このプロジェクトの価値は、映画データそのものではなく、**公式映画館Web UIの上に、安定した映画館向け操作レイヤーを作ること**です。

## 主要ユースケース

### 上映を探す

例:

> 土曜19時以降、横浜周辺でこの映画をIMAXで観られるところを探して。

目標フロー:

1. 対象provider/劇場を絞る
2. 公式サイトをオンデマンドで開く
3. 表示中の上映情報を読む
4. 共通schemaへ正規化する
5. ユーザー条件で比較・順位付けする

### 良い座席を探す

例:

> 真ん中より少し後ろで、2席並び空いてる？

目標フロー:

1. 対象上映回を開く
2. 表示中の座席表を読む
3. 座席位置をローカルで正規化する
4. 候補をスコアリングする
5. 不要な仮押さえを避けつつ候補を提示する

### 購入直前まで進める

例:

> その2席で購入直前まで進めて。

目標フロー:

1. 上映回と座席を1件に確定する
2. 券種など非機密情報を入力する
3. ログイン、CAPTCHA、MFA、3-D Secure、決済情報入力が必要なら停止する
4. 購入内容を整理する
5. 現在の購入コンテキストに紐づいた短時間・one-shot確認を作る

### 購入を確定する

最終購入は通常操作とは別機能として扱います。

デフォルトでは無効で、providerごとにUI・規約・失敗時挙動まで確認できたものだけ段階的に有効化します。

## やらないこと

このプロジェクトは次のものにはしません。

- 全国上映情報の集約DB
- 定期クロール/バックグラウンド巡回サービス
- 映画館の非公式APIクライアント
- private/internal endpointを直接利用するクライアント
- TMDB等の映画メタデータDBの代替
- 転売・大量購入・在庫占有ツール
- CAPTCHA/MFA/待機列/地域制限/anti-bot回避ツール
- パスワードやカード情報の保管庫
- 汎用ブラウザ自動化フレームワーク

## Local-first

標準構成はユーザーのローカル環境で動作し、専用ChromeプロファイルをChrome DevTools Protocol（CDP）で操作します。

この形を優先する理由:

- Cookieやログイン状態がユーザー端末内に残る
- 中央集約型crawlerにならない
- MCP側でprovider認証情報を保管しなくてよい
- 一度Chromeが起動すれば操作レイテンシを抑えられる
- 通常のユーザー操作との距離が近い

Hosted/Remote/Multi-user版は当面の対象外です。将来検討する場合は、identity・browser isolation・abuse prevention・complianceを別設計として見直します。

## 共通ドメインモデル

将来的にAIが扱う共通概念はできるだけ小さく保ちます。

- provider
- 劇場
- 日付
- 作品
- 上映回
- 上映方式
- 字幕/吹替/言語
- スクリーン
- 座席表/座席候補
- 券種
- checkout summary
- purchase confirmation

provider adapterが各社UIをこの共通概念へ変換します。

## 優先順位

1. コンプライアンスとユーザー管理
2. 正確性・fail-closed
3. 軽量・高速
4. UI変更への耐性
5. MCPとしての使いやすさ
6. 対応映画館チェーンの拡大

速度のために安全境界やprovider側制約を回避することはしません。

## パフォーマンス方針

- Node.js + MCP SDK + `chrome-remote-interface` + Zod
- Playwrightなし
- ブラウザ本体を同梱しない
- 1 MCP processにつき1つの長寿命Chrome session
- tool callごとにChromeを再起動しない
- visible stateは上限付きで読む
- provider adapter完成後はgeneric scanよりsemantic selectorを優先
- tool resultは小さいstructured dataにする
- showtime indexer/cacheを持たない

現在のgeneric visible read上限は8,000文字です。

## 最初のPublic releaseの成功条件

Public化の基準は「機能数」ではなく、安全に価値が出る縦切りです。

最低条件:

- TOHO/AEON/109のprovider情報と利用境界が最新化されている
- 3社の公開UIを安定して開いて読める
- 少なくとも上映検索がprivate APIなしでproviderごとに動く
- stale/ambiguous stateで推測せず止まる
- 機密入力拒否がテストされている
- 購入確認ゲートがテストされ、最終購入はデフォルト無効
- Git履歴にSecret/Cookie/Token等がない
- Public化直前にprovider規約・サイトポリシーを再確認する
- README/Compliance/Security/Roadmapが実装と一致している

購入機能は最初のPublic release必須条件ではありません。

## 他MCPとの連携方針

置き換え可能な隣接機能は吸収せず、compositionを優先します。

例:

- 映画メタデータ → TMDB系MCP等
- 周辺劇場/移動時間 → `maps-browser-mcp`
- 購入後の予定登録 → Calendar MCP

本プロジェクトは映画館Web UIの意味理解と操作に集中します。

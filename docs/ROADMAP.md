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

- ✅ Private repository
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
- ✅ final purchaseデフォルト無効
- ✅ baseline compliance policy
- ✅ unit test / CI定義
- 🟡 ドキュメント整備
- 🟡 ローカルlive smoke確認

Exit criteria:

- build/typecheck/testが通る
- Chrome lifecycleが安定する
- generic toolから最終購入へ到達できない
- private/internal API依存がない

## Phase 1 — Provider別Read Adapter

目的: generic page readから、映画館ドメインを理解するread-only adapterへ移行する。

状態: 🟡 次

各providerごとに:

- 🟡 現行公式導線を確認
- 🟡 利用規約/サイトポリシーを再確認
- ⬜ 劇場選択semanticを特定
- ⬜ 日付選択semanticを特定
- ⬜ 作品/上映カードsemanticを特定
- ⬜ IMAX等の上映方式を正規化
- ⬜ 字幕/吹替/言語表示を正規化
- ⬜ provider-specific bounded reader
- ⬜ stale-state check
- ⬜ unit test
- ⬜ 非購入live smoke test

目標tools:

- `list_theaters`
- `get_showtimes`
- `find_showtimes`

Exit criteria:

- 表示中の公式UIだけから上映情報を返す
- UI変更時はfail closed
- generic broad scanへ黙ってfallbackしない
- source provider / source URLを返す

## Phase 2 — 3社横断検索

目的: 3つの個別adapterを、1つの映画館検索体験にする。

状態: ⬜ 予定

- ⬜ 共通 `Theater` schema
- ⬜ 共通 `Showtime` schema
- ⬜ format/language normalization
- ⬜ TOHO / AEON / 109横断検索
- ⬜ area / movie / date / before / after / format filter
- ⬜ deterministic ranking
- ⬜ providerアクセス数の上限
- ⬜ `maps-browser-mcp`等とのcomposition hook

横断検索も毎回オンデマンドです。定期クロールによるindexは作りません。

## Phase 3 — 座席表

目的: 無駄な仮押さえを作らず、表示中のseat mapを理解する。

状態: ⬜ 予定

providerごとに:

- ⬜ いつseat holdが発生するか確認
- ⬜ available / unavailable / special seat等のsemantic確認
- ⬜ row / seat label正規化
- ⬜ aisle/gap geometry解析
- ⬜ adjacent seat grouping
- ⬜ seat preference scoring
- ⬜ center / rear / rear-middle / aisle等の指定対応
- ⬜ 不要なseat clickをしない設計

目標tools:

- `get_seat_availability`
- `recommend_seats`
- `select_seats`（providerレビュー後）

Exit criteria:

- seat recommendationだけなら不要な仮押さえを発生させない
- user-intendedな1組だけを選択する
- seat state変更を検出する

## Phase 4 — Checkout Preparation / Human Handoff

目的: 可逆・低リスク操作を自動化し、認証/決済はユーザーへ戻す。

状態: ⬜ 予定

- ⬜ ticket type normalization
- ⬜ member/non-member分岐
- ⬜ 非機密field入力
- ⬜ login required検出
- ⬜ CAPTCHA / challenge検出
- ⬜ MFA / OTP / 3-D Secure handoff
- ⬜ third-party payment/identity検出
- ⬜ human操作後のstate再検証
- ⬜ checkout summary正規化

目標tool:

- `prepare_checkout`

Exit criteria:

- password/payment secretがMCP引数に入らない
- human-only surfaceで必ず停止する
- checkout preparationと購入確定が分離されている

## Phase 5 — 購入確定

目的: providerごとの厳格な監査を通った場合のみ、最終購入を可能にする。

状態: ⬜ 予定 / デフォルト無効

providerごとに必須:

- ⬜ 規約/サイトポリシー再確認
- ⬜ exact final control確認
- ⬜ 劇場/作品/日時/座席/券種/金額を確認画面に固定
- ⬜ confirmationをcurrent browser contextにbinding
- ⬜ TTL / one-shot test
- ⬜ material context変更で無効化
- ⬜ duplicate submission防止
- ⬜ `PURCHASE_UNKNOWN`定義・テスト
- ⬜ timeout/disconnect時の自動replay禁止
- ⬜ visible UIからsuccess/failureを確認

目標tool:

- `confirm_purchase`

購入対応はproviderごとに個別解禁します。3社同時ONは前提にしません。

## Phase 6 — Public化前Hardening

目的: Privateで動くだけでなく、公開しても設計意図と安全境界が明確な状態にする。

状態: ⬜ 予定

- ⬜ provider review日付更新
- ⬜ Git全履歴secret scan
- ⬜ Cookie/token/payment data混入確認
- ⬜ private/internal endpoint利用ゼロ確認
- ⬜ read-only live smoke test
- ⬜ purchase gate test
- ⬜ SECURITY/COMPLIANCE最終確認
- ⬜ trademark/non-affiliation表記確認
- ⬜ dependency/license audit
- ⬜ npm packaging確認
- ⬜ changelog/versioning policy
- ⬜ publication checklist通過後にPublic化

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

1. TOHO read adapter
2. AEON read adapter
3. 109 read adapter
4. cross-provider normalized search
5. seat mapをproviderごとに追加
6. checkout preparationをproviderごとに追加
7. final purchaseはprovider監査後のみ
8. Public release hardening

providerごとに難易度や利用条件が違うため、feature parityを無理に揃えません。capability単位で安全にdegradeできる設計を優先します。

# ドキュメント案内

`japan-cinema-browser-mcp` のドキュメントは、用途ごとに次の順で読むと全体像を追いやすくなります。

このリポジトリは日本の映画館公式サイトを対象としているため、利用者・コントリビューター向けの主要ドキュメントは日本語を第一言語として整備します。設定名、MCP tool名、エラーコード、環境変数、プロトコル名など、実装と対応する識別子は原文の英語表記を維持します。

## まず読む

- [`../README.md`](../README.md) — プロジェクト概要、セットアップ、現在利用できるMCP tool
- [`PROJECT.md`](PROJECT.md) — 目的、非目標、Local-first方針、主要ユースケース
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — ランタイム構成、provider adapter、状態境界
- [`../COMPLIANCE.md`](../COMPLIANCE.md) — 自動化対象、禁止事項、重大操作の安全境界
- [`SECURITY.md`](SECURITY.md) — 脅威モデル、信頼境界、フェイルクローズ方針

## 利用・運用

- [`CLOUD_RUN.ja.md`](CLOUD_RUN.ja.md) — single-user Cloud Run構成の日本語ガイド
- [`CLOUD_RUN.md`](CLOUD_RUN.md) — Cloud Run構成の英語版
- [`EXECUTION_HANDOFF.md`](EXECUTION_HANDOFF.md) — Human Handoff、再開ポリシー、replay境界
- [`PROVIDERS.md`](PROVIDERS.md) — TOHOシネマズ / イオンシネマ / 109シネマズの対応状況

## 開発・コントリビューション

- [`DEVELOPMENT.md`](DEVELOPMENT.md) — 実装原則、adapter規約、テスト方針
- [`../CONTRIBUTING.ja.md`](../CONTRIBUTING.ja.md) — 日本語のコントリビューションガイド
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — English contribution guide
- [`../SUPPORT.ja.md`](../SUPPORT.ja.md) — 日本語のサポート案内
- [`../CODE_OF_CONDUCT.ja.md`](../CODE_OF_CONDUCT.ja.md) — 日本語の行動規範

## ロードマップと開発記録

- [`ROADMAP.md`](ROADMAP.md) — 現在の実装状況と今後の方向性
- [`PHASE3_SEAT_DISCOVERY.md`](PHASE3_SEAT_DISCOVERY.md) — 座席表・座席状態の調査記録
- [`PHASE4_CHECKOUT_DISCOVERY.md`](PHASE4_CHECKOUT_DISCOVERY.md) — checkout / Human Handoffの調査記録
- [`PHASE4_TOHO_CONTINUATION_DESIGN.md`](PHASE4_TOHO_CONTINUATION_DESIGN.md) — TOHO向け継続処理の設計記録

Phase単位の文書は、現在の利用手順というより設計判断や受入根拠を残すための記録です。実際の現行仕様を確認するときは、`README.md`、`PROJECT.md`、`ARCHITECTURE.md`、`SECURITY.md`、`PROVIDERS.md`、`ROADMAP.md` を優先してください。

## Provider別資料

`providers/` 配下には、各映画館サイトで確認した公開UI、route、前提条件、フェイルクローズ条件を記録します。

- [`providers/TOHO.md`](providers/TOHO.md)
- [`providers/AEON.md`](providers/AEON.md)
- [`providers/109.md`](providers/109.md)

これらは公式各社による承認・提携・法的適合を示すものではありません。UIや利用条件はリポジトリとは独立して変更されるため、重大なautomation surface変更やtransaction capabilityの解禁前には再確認が必要です。

## 日本語ドキュメントの方針

日本語版は機械的な直訳ではなく、次の基準で整備します。

- 日本語だけ読んでも安全境界と実行手順が分かること
- `provider`、`capability`、`fail closed` など実装と密接な語は、必要に応じて英語識別子を残しつつ日本語で意味を補うこと
- コマンド、環境変数、schema名、tool名、エラーコードは翻訳しないこと
- 英語版と意味がずれた場合は、安全側の記述を優先して修正すること
- 実装変更時は関連する日本語ドキュメントも同じPRで更新すること

# ドキュメント案内

`japan-cinema-browser-mcp` は、日本語を主要ドキュメントの標準言語として扱います。

利用者・コントリビューター向けの説明は、**日本語だけ読めば使い方・安全境界・現在の実装状況を理解できること**を基準に整備します。

MCP tool名、型名、環境変数、エラーコード、protocol名、URL、DOM selectorなど、実装と正確に照合する必要がある識別子だけは英語表記を維持します。

## まず読む

- [`../README.md`](../README.md) — プロジェクト概要、セットアップ、現在利用できるMCP tool
- [`PROJECT.md`](PROJECT.md) — 目的、非目標、ローカル優先方針、主要ユースケース
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — ランタイム構成、映画館別adapter、状態境界
- [`../COMPLIANCE.md`](../COMPLIANCE.md) — 自動化対象、禁止事項、重大操作の安全境界
- [`SECURITY.md`](SECURITY.md) — 脅威モデル、信頼境界、安全停止方針

## 利用・運用

- [`CLOUD_RUN.md`](CLOUD_RUN.md) — single-user Cloud Run構成
- [`EXECUTION_HANDOFF.md`](EXECUTION_HANDOFF.md) — Human Handoff、再開方針、再実行境界
- [`PROVIDERS.md`](PROVIDERS.md) — TOHOシネマズ / イオンシネマ / 109シネマズの対応状況

## 開発・コントリビューション

- [`DEVELOPMENT.md`](DEVELOPMENT.md) — 実装原則、adapter規約、テスト方針
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — コントリビューションガイド
- [`../SUPPORT.md`](../SUPPORT.md) — サポート案内
- [`../CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md) — 行動規範
- [`../.github/SECURITY.md`](../.github/SECURITY.md) — 脆弱性報告方法

## ロードマップと開発記録

- [`ROADMAP.md`](ROADMAP.md) — 現在の実装状況と今後の方向性
- [`PHASE3_SEAT_DISCOVERY.md`](PHASE3_SEAT_DISCOVERY.md) — 座席表・座席状態の調査記録
- [`PHASE4_CHECKOUT_DISCOVERY.md`](PHASE4_CHECKOUT_DISCOVERY.md) — チェックアウト / Human Handoffの調査記録
- [`PHASE4_TOHO_CONTINUATION_DESIGN.md`](PHASE4_TOHO_CONTINUATION_DESIGN.md) — TOHO向け継続処理の設計記録

Phase単位の文書は、現在の利用手順というより、設計判断と安全確認の根拠を残すための記録です。

現行仕様を確認するときは、`README.md`、`PROJECT.md`、`ARCHITECTURE.md`、`SECURITY.md`、`PROVIDERS.md`、`ROADMAP.md` を優先してください。

## 映画館別資料

`providers/` 配下には、各映画館サイトで確認した公開UI、経路、前提条件、安全停止条件を記録します。

- [`providers/TOHO.md`](providers/TOHO.md)
- [`providers/AEON.md`](providers/AEON.md)
- [`providers/109.md`](providers/109.md)

これらは各映画館会社による承認・提携・法的適合を示すものではありません。公開UIや利用条件はリポジトリとは独立して変更されるため、重大な自動操作範囲の変更や取引系機能を有効化する前には再確認が必要です。

## 日本語ドキュメントの基準

- 日本語だけで安全境界と実行手順を理解できること
- 普通の説明文では、可能な限り自然な日本語を使うこと
- 実装識別子を無理に翻訳しないこと
- `seatMap`、`prepare_checkout`、`UI_STATE_CHANGED` のような実装名はバッククォートで区別すること
- 英語由来の技術用語を使う場合も、日本語文として意味が伝わるように書くこと
- 機械翻訳調ではなく、日本語の技術文書として読みやすい語順にすること
- 実装変更時は関連する日本語ドキュメントも同じPRで更新すること

`.ja.md` を別に並べる方式ではなく、GitHubが標準で表示するファイルそのものを日本語の正本とします。
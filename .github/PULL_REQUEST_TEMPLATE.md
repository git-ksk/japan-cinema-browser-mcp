## 変更概要

<!-- 何を、なぜ変更しましたか？ -->

## 安全性・providerへの影響

<!-- 影響するbrowser / provider / capability / security boundaryを記載してください。該当しない場合は「なし」で構いません。 -->

- [ ] private/internal API、hidden endpoint、network interception、route/queryの推測を追加していません。
- [ ] 無効化されているseat / checkout / purchase capabilityをgeneric automationで迂回していません。
- [ ] 機密データの取扱いとchallenge/CAPTCHAのHuman Handoff挙動は変更していない、または明示的にレビュー済みです。
- [ ] provider固有のDOM知識は該当adapter内に閉じています。

## 確認内容

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `git diff --check`
- [ ] 関連ドキュメントを更新しました。またはドキュメント変更が不要であることを確認しました。

### Live smoke

<!-- 任意・provider別です。購入、seat hold、login、高頻度automationは実行しないでください。 -->

- Provider:
- 結果 / 未実施の理由:

## 残っているリスク・不確実性

<!-- UI drift、provider policy、互換性、rollout上の不確実性などを記載してください。法的な承認を得たかのような表現は避けてください。 -->

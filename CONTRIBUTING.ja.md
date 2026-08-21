# コントリビューションガイド

> English: [`CONTRIBUTING.md`](CONTRIBUTING.md)

`japan-cinema-browser-mcp` の改善に協力していただき、ありがとうございます。

このプロジェクトは、安全境界を意図的に狭く保っています。Chrome + direct CDPで**レビュー済みの映画館公式Web UIだけ**を操作し、provider側の画面やworkflowが明示的に確認されていない場合はフェイルクローズします。

## IssueやPRを作る前に

- まず既存のIssueとPull Requestを検索してください。
- 通常の不具合、ドキュメント改善、機能提案は公開Issueを利用できます。
- 脆弱性、credential、Cookie、session token、payment data、private browsing data、機密情報を含むスクリーンショットは公開Issueへ投稿しないでください。セキュリティ上の問題はGitHub Private Vulnerability Reportingを利用してください。
- 映画館各社の利用規約、サイトポリシー、UIは、このリポジトリとは独立して変更されます。「現在動作する」ことを法的な許可やproviderからの承認と表現しないでください。

## 開発環境

必要なもの:

- Node.js 20以上
- npm
- providerのlive smoke確認を行う場合はChromeまたはChromium

lockfileから依存関係を入れます。

```bash
npm ci --ignore-scripts
```

通常の変更では、少なくとも次をローカルで確認してください。

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

通常のtest suiteは、映画館公式サイトへのlive accessを必要としない構成を維持してください。

## 必ず守る安全境界

別途明示的なsecurity reviewで仕様変更されない限り、次を維持してください。

- Chrome + direct CDPを基本とし、network interceptionを近道として追加しない。
- rendered public UIだけを使い、private/internal APIやhidden JSON endpointを探索・直接利用しない。
- 公開UIがrouteやquery値を明示していない場合、provider slugやURLを推測して生成しない。
- CAPTCHA、access challenge、MFA、OTP、3-D Secure、waiting roomなど、人間・セキュリティ上のcontrolを回避しない。
- provider pageの文章や外部place labelを「命令」として扱わず、untrusted dataとして処理する。
- provider固有のDOM知識は該当adapter内へ閉じ込め、generic parserを安易に広げない。
- 無効化されているcapabilityをgeneric fuzzy navigation / click / fillで迂回しない。
- `seatMap` は現在TOHO / AEON / 109で有効。`seatSelection`、`checkoutPreparation`、`purchaseSubmission` は全providerで無効のまま維持する。
- purchase confirmationのone-shot / TTLと、結果不明時のno-auto-replayを維持する。
- Execution Handoffのowner / requestState bindingとresource epoch fencingを維持する。Human completionを別actionのapprovalへ変換しない。
- semantic mutationとtransaction/payment handoffは `never_replay` のままにする。
- purchaserの氏名、電話番号、メールアドレス等のPII、credential、consent、payment surfaceは、明示的なsecurity/compliance reviewなしに自動化対象へ追加しない。
- pre-releaseの `mcp-execution-handoff` dependencyは、release方針が決まるまでimmutable commit pinを維持する。
- credential、Cookie、localStorage、sessionStorage、Authorization header、payment dataをdumpする経路を追加しない。

`CINEMA_CHROME_EXECUTABLE`、`CINEMA_CHROME_PROFILE_DIR`、external CDP opt-inなどのローカルprocess設定は、信頼されたoperator configurationです。MCP tool argument、provider page、その他の外部入力から設定してはいけません。

## Providerを変更するとき

TOHO、AEON、109のprovider実装を変更する場合は、次の順で確認してください。

1. rendered public UIで実際の挙動を再現する。
2. 実装を広げる前にregression testを追加・更新する。
3. deny-listを増やすより、レビュー済みsurfaceのpositive allow-listを優先する。
4. navigation後のidentity verificationとfail-closed behaviorを維持する。
5. live smokeを通すためだけの推測的fallback selectorを追加しない。
6. reviewed surfaceや前提条件が変わる場合は `docs/PROVIDERS.md` と該当する `docs/providers/*.md` を更新する。

live smokeは意図的に手動・非購入で実行します。

```bash
npm run smoke:toho
npm run smoke:aeon
npm run smoke:109
```

通常は変更対象providerだけ実行し、広いregression確認が必要な場合のみ範囲を広げてください。

purchase、seat hold、login、高頻度provider accessをCIへ入れないでください。

## Pull Request

`main` は保護されています。変更はPull Request経由で行い、required check通過後にsquash mergeします。

PRはできるだけ1つの目的に絞ってください。本文には次を記載してください。

- 何を、なぜ変更したか
- 影響するbrowser / provider / capability / security boundary
- ローカルで実行したtest
- provider live smokeを実行したか。実行しなかった場合はその理由
- 更新したドキュメント
- 残っている不確実性やprovider-policy上の懸念

CIがgreenであることは、repository test/buildが通ったことを示します。映画館各社の規約があらゆる利用を許可していることを証明するものではなく、provider-specific live reviewの代わりにもなりません。

## バージョンとリリース

このリポジトリはSemantic Versioningを互換性モデルとして使用し、`0.x`期間には通常のSemVerより厳しい運用ルールを適用します。

### 公開互換性として扱うもの

次はpublic compatibility contractに含まれます。

- MCP tool名と公開availability
- tool input schema
- tool output schemaとdocumented field semantics
- documented error code / error semantics
- provider capability state
- supported remote authentication / discovery interface
- supported deployment modeのoperator-facing configuration / runtime requirement

selector、内部実装構造、ログ詳細、test、非契約のdiagnostic自体はpublic APIではありません。ただし、それらの変更によって上記の公開挙動が変わる場合は互換性変更として扱います。

### `0.x`期間のversion選択

- **patch (`0.x.Y`)** — public compatibility contractを変えないbug fix、security fix、performance / reliability improvement
- **minor (`0.X.0`)** — 新しいtool / capability / provider functionality / supported deployment behavior、またはbreaking public-contract change
- documentation、test、CI、内部refactorだけなら通常releaseは不要

security fixであっても、safe fixがbreaking public-contract changeを必要とする場合はminor bumpです。

`1.0.0`以降は通常のSemVerに従います。

次のversionは、前回release tagからrelease candidateまでの**累積diff全体**で決めます。最後のPR種別だけでは決めません。累積diff内で必要となる最も大きいbumpを採用します。

### Deploymentとreleaseは別

`main`を本番へdeployしても、それだけではpackage versionやGitHub Releaseは作成しません。

version bump、release note確定、tag、GitHub Releaseは明示的なrelease作業としてまとめて行います。通常のfeature / bug fix PRでpackage versionをついでに上げないでください。

古いsupported releaseへsecurity / critical fixが必要で、`main`により大きな変更がすでに含まれている場合は、dedicated release / backport branchを利用します。

### Release note

GitHub Releasesをcanonicalなrelease-note historyとして扱います。プロジェクト規模が小さい間は、別途 `CHANGELOG.md` を必須としません。

release noteには少なくとも次を含めます。

- user-visible capability
- compatibility / safety relevant change
- 現在のtransaction capability boundary

source releaseを作成してもnpm publishを意味しません。npm publicationは別の明示判断です。

### MilestoneとRoadmap

`docs/ROADMAP.md` は長期的なphase / capability directionを示します。

GitHub Milestoneを利用する場合は、`v0.2.0` のような具体的なtarget release versionを表します。

次releaseのscopeをまとめる価値がある場合は、active milestoneを1つに絞ることを推奨します。Roadmap phaseが自動的にrelease versionへ対応するわけではなく、MilestoneもRoadmapの代替ではありません。

GitHub Projectsは任意のworkflow visualizationであり、Issue → PR → required checks → squash mergeの運用に必須ではありません。

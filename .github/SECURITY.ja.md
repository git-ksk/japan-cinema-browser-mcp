# セキュリティポリシー

> English: [`SECURITY.md`](SECURITY.md)

## サポート対象

現在、セキュリティ修正は最新の `main` ブランチに対して行います。長期サポート用のrelease lineはまだ設けていません。

## 脆弱性の報告

exploitの詳細、credential、private browsing data、その他の機密情報を公開Issueへ投稿しないでください。

このリポジトリに関する脆弱性は、GitHub Private Vulnerability Reportingを利用してください。

Repositoryの **Security** タブから **Advisories** → **Report a vulnerability** を選択できます。

GitHubのprivate reporting UIが一時的に利用できない場合は、このリポジトリに紐づくGitHubアカウント経由でメンテナーへ連絡し、機密情報を送る前にprivate channelを依頼してください。

公開Issueを使う場合は「非公開の連絡手段が必要」という依頼だけに留め、脆弱性の詳細を書かないでください。

## 報告に含めてほしい情報

可能な範囲で、次を含めてください。

- 影響を受けるcommit / version
- 影響するMCP toolまたはprovider workflow
- 安全な再現手順
- 期待した挙動と実際の挙動
- browser / provider / capability / secret / purchase-confirmationのどの境界を越えられる可能性があるか

credential、Cookie、session token、payment data、個人情報、不要なprivate browsing dataは含めないでください。

## このプロジェクトの主要なセキュリティ境界

本プロジェクトは、Chrome + direct CDPを使い、映画館公式サイトのrendered public UIだけを操作します。

次の手法には依存しません。

- private/internal API
- hidden JSON endpoint
- network interception
- Cookie / token dump
- CAPTCHA / challenge bypass

provider capabilityはフェイルクローズです。

現在、TOHO / AEON / 109ではread-only `seatMap` が有効ですが、次は全providerで無効です。

```text
seatSelection=false
checkoutPreparation=false
purchaseSubmission=false
```

generic navigationはレビュー済みpublic read surfaceに限定し、generic click/fillからdisabled capabilityを迂回できないようにします。

将来final purchaseを有効化する場合も、短いTTL・one-shotの独立したconfirmation flowを必須とします。

Human-onlyなbrowser stateはExecution Handoffで扱い、Agent/Human authorityの排他制御、exact invocation / request-state binding、resource epoch fencing、consumer側で定義したreplay policyを維持します。

Human completionはtransaction approvalではありません。また、新しいHuman interventionを開始した時点でprepared purchase confirmationを無効化します。

詳細:

- [`../docs/SECURITY.md`](../docs/SECURITY.md)
- [`../COMPLIANCE.md`](../COMPLIANCE.md)
- [`../docs/PROVIDERS.md`](../docs/PROVIDERS.md)

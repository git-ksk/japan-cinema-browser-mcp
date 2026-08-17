# セキュリティモデル

この文書は `japan-cinema-browser-mcp` のセキュリティ設計をまとめたものです。コンプライアンス上の正本は [`../COMPLIANCE.md`](../COMPLIANCE.md) とします。

## セキュリティ目標

provider側のUIが変わったり、予期しないコンテンツが含まれていても、次の性質を守ります。

1. レビュー済み映画館domain外へ勝手に自動遷移しない
2. provider page上のテキストを命令として扱わない
3. password/card/CVV/OTP/tokenなどをmodel/tool result/logへ流さない
4. 通常browser toolから最終購入を実行できない
5. stale/ambiguous stateはfail closed
6. 購入結果が不明な場合に自動再実行しない
7. 専用Chrome profileをユーザー端末内に保持する
8. 中央集約型の上映/座席/provider session DBを作らない

## Trust Boundary

### MCP client / model

ユーザー意図を表現する主体として扱いますが、secret取扱いや重大操作判定をmodel判断だけには任せません。

コード側で行うもの:

- schema validation
- domain allow-list
- sensitive field拒否
- final action分類
- confirmation TTL / one-shot

### Cinema MCP Runtime

trusted codeです。安全判定は可能な限りdeterministicにローカル実行します。

### Provider Web Page

untrusted external contentです。

広告、埋め込みwidget、予期しない文言、DOM変更があっても、それをruntime policyとして解釈しません。

### Chrome Profile

Cookieやsessionを含むため、通常のproject fileより高感度です。

- repository外に保存
- 専用profileを標準
- external CDP attachはデフォルト無効
- Cookie/session export toolは作らない

### Third-party Identity / Payment Surface

初期trust boundary外です。明示レビューされるまではautomationを停止してユーザーへ返します。

## 主な脅威と対策

### Page content由来のPrompt Injection

provider pageや広告に「この指示に従え」等の文言が含まれる可能性があります。

対策:

- full page dumpを避ける
- semantic factだけ返す
- external textをuntrusted dataとして扱う
- provider adapterは既知fieldを抽出し、命令文として解釈しない

### Domain Escape

link/redirectで未レビューdomainへ移動するリスクがあります。

対策:

- HTTPS provider allow-list
- navigation後のfinal URL再確認
- third-party payment/identityは標準停止
- arbitrary URL navigationを許さない

### Secret Exfiltration

password/card number/CVV/OTP/MFA/session tokenをMCPに読ませたり入力させるリスクがあります。

対策:

- sensitive field label拒否
- Cookie/token read toolを作らない
- network interception toolを作らない
- localStorage/sessionStorage dumpを作らない
- logへfield valueを出さない

### Transactional Workflow Bypass / Accidental Purchase

generic navigation/click/fillからseat selectionやcheckoutへ進み、provider capabilityを迂回するリスクがあります。

対策:

- generic navigationはreview済みpublic read surfaceのpositive allow-list
- same-domainの任意path/subdomainを許可しない
- generic click/fillでseat map / seat selection / checkout preparation / purchase submissionをcapability gateへ接続
- 未レビューのscript-driven control / fieldはfail closed
- provider adapter内部のreviewed read-only primitiveをnorthbound generic toolから分離
- final-action label分類とgeneric clickからの拒否
- final submitは別tool
- runtime flagでデフォルト無効
- transaction summaryを確認してからconfirmation発行

### Stale UI / TOCTOU

一覧を読んだ後、clickまでに画面が変わる可能性があります。

対策:

- expected label/contextを後続actionにbinding
- duplicate/ambiguous target拒否
- material context変更でconfirmation無効化
- 近似matchでclickしない

### Timeout後の重複決済

最終click送信後にdisconnect/timeoutし、retryで二重購入するリスクがあります。

対策:

- confirmationはone-shot
- final purchaseを自動replayしない
- `PURCHASE_UNKNOWN`を明示状態として扱う
- provider側で結果確認するまで再submitしない

### Seat Hoarding

複数候補を順番にclickして一時holdを大量発生させるリスクがあります。

対策:

- 可能な限りclick前にseat候補をread/score
- user-intendedな1組だけselect
- speculative bulk seat selection禁止
- provider-wide availability monitoring禁止

### Browser Profile Exposure

通常ChromeへCDP接続すると映画館以外のtab/sessionへアクセス可能になるため、専用profileを標準にします。

- external CDPは明示opt-in
- runtimeはreviewed cinema targetへscope
- local stdioでは専用profileを標準にする
- Phase 3 Cloud Runはsingle allowlisted Firebase UID + dedicated headless profile + max instance 1に限定する
- multi-user remote化時はprincipal単位のbrowser/profile isolationを別途実装するまで禁止


### Bounded Cloud Run Runtime

Phase 3 remote runtimeは汎用browser hostingではありません。以下をsecurity invariantとします。

- non-loopback bindは明示opt-in + MCP OAuth/Firebase Auth設定 + single-user UID allowlistが必須
- `/mcp` / `/ready` はCinema発行のresource-bound OAuth access tokenだけを受け付け、Firebase ID Tokenをresource credentialとして直接受け付けない
- Protected Resource MetadataとAuthorization Server metadataをstandard well-known endpointで公開し、CIMD client metadataは明示host allowlist + exact redirect URIで検証する
- authorization codeはPKCE S256へbindしてone-shot、refresh tokenは使用時rotation、access/refresh/code/request secretはFirestoreへraw保存せずSHA-256 document identityだけを使う
- Firebase passwordはauthorization pageのbrowserからFirebase Authenticationへ直接送信し、Cinema server / MCP / LLMへ渡さない
- OAuth code/token、Firebase ID/refresh tokenをrepository・ログ・MCP resultへ出さない
- Host allowlistをexact Cloud Run hostnameへ固定する
- remote modeはheadless必須、external CDP禁止、purchase flag false必須
- challenge / sign-in / consentはHuman Handoffへ昇格せずfail closed
- operation timeout超過時はdedicated browser sessionを閉じる
- optionalなMCPUsageを有効化する場合は、Firebase UIDからderiveしたauthenticated logical principalへbindし、現在のCloud Run profileではFirestore transactionでreserve / liable / settleする
- usage stateへraw credential、page text、Cookie、bearer、payment/auth dataを保存しない
- Firestoreは現在のCloud Run implementationでOAuth state / optional usage stateに採用するbackendであり、protocol上の必須要件ではない。代替backendは同等のone-shot / rotation / binding / expiry / atomicity semanticsを維持すること
- `/health` はpassive livenessのみ。browser起動を伴う `/ready` と `/mcp` はscope `mcp:tools` を持つOAuth bearer必須
- Chromium sandboxは既定で有効。`CINEMA_ALLOW_UNSANDBOXED_CHROMIUM` はverified incompatibility時だけの明示fallback

### Provider UI Drift

selectorがUI変更後に別controlへ当たる可能性があります。

対策:

- semantic assertion
- expected label check
- non-purchasing live smoke test
- capability downgrade
- risky generic fallback禁止

## Execution HandoffのInvariant

Human-only surfaceは `mcp-execution-handoff` のgeneric control planeへ接続しますが、Cinema固有policyはconsumer側に残します。

- AgentとHumanが同時にbrowser execution authorityを持たない
- handoff ownerをexact tool / canonical args / intervention / resource epoch / logical principalへbindする
- challenge/sign-in/consent検出からMCPへ返すのはcategoryだけとし、password、OTP/MFA、CAPTCHA answer、Cookie、payment data、raw page/dialog textをhandoff stateへ含めない
- Human completionでresource epochを進めてからCinema固有verificationを行う
- pure read以外はfresh semantic actionを要求し、semantic mutation / transactionは `never_replay`
- Human intervention開始時にprepared purchase confirmationを破棄する
- Human completionをpurchaseや別actionのapprovalとして扱わない
- seat/checkout/purchase capabilityのfalseをhandoff経由で迂回しない
- provider adapter内部のexact pointer primitiveをnorthbound generic click/fillやdisabled capabilityの迂回路として公開しない。TOHO #50ではexact rendered seat ID/tag hit-test後のordinary-seat mutationだけに限定し、post-consent hold境界が未証明の間はtool/capabilityへ接続しない
- Phase 4 checkout intentへpurchaser PII/contact、credential、payment、consent、caller-supplied amount/summary/final-controlを追加しない
- checkout summaryはprovider-rendered bounded factsを再読した結果だけから作り、missing amount factを0等へ補完しない
- provider-specific raw page/dialog、arbitrary provider data、opaque checkout URL/session tokenをgeneric checkout resultへ流さない
- seat mutation候補は2回のread-only freshness確認後のexact intended seatだけとし、stale/missing/unavailable時に代替席を自動選択しない
- CAPTCHA/challenge bypass、solver、anti-bot evasionを追加しない

仕様は [`EXECUTION_HANDOFF.md`](./EXECUTION_HANDOFF.md) を参照してください。

## 最終購入のInvariant

final purchaseは次をすべて満たす場合のみ許可します。

- runtime purchase flagが有効
- provider capabilityでpurchase submissionが有効
- expected provider surface上にいる
- transaction summaryが最新
- confirmationが直前に発行されている
- TTL内
- 未使用
- browser/material contextが変わっていない
- final controlが一意に識別できる
- human-only challengeがactiveでない

1つでもfalse/unknownならsubmitしません。

## Ambiguous Outcome Rule

購入結果は少なくとも次の3状態に分けます。

- `PURCHASE_COMPLETE` — visible UIで成功が明確
- `PURCHASE_FAILED` — visible UIで未成立/失敗が明確
- `PURCHASE_UNKNOWN` — submitされた可能性はあるが結果を確定できない

`PURCHASE_UNKNOWN`では自動処理を終了し、絶対に自動retryしません。

## Logging

記録してよいもの:

- process lifecycle
- provider ID
- high-level error code
- secretを含まないbounded diagnostic

記録禁止:

- password
- card number
- CVV/CVC
- OTP/MFA
- Cookie
- authorization/session token
- full HTML
- 個人情報/決済情報を含むcheckout screenshot

## Dependency Policy

現在のruntime dependency:

- `@modelcontextprotocol/server`
- `chrome-remote-interface`
- `zod`

新しいbrowser automation frameworkは「便利だから」だけでは追加しません。direct CDPでは合理的に解決できない具体要件がある場合のみ、security/performance/maintenance impactを確認して追加します。

## Public repository security operations

Public repositoryではGitHub Private Vulnerability Reportingを有効化し、外部向けの報告方法を [`.github/SECURITY.md`](../.github/SECURITY.md) に明示します。通常のIssueへexploit details、credential、Cookie/token、private browsing data、payment/auth dataを投稿しません。

GitHub側ではsecret scanning / push protection / Dependabot security updates / Dependency Review / CodeQL advanced setup（security-and-quality suite）を有効化します。`main` はrulesetでPR、required CI、linear history、force-push/delete禁止を強制し、CodeQL security resultもmerge protectionへ接続します。

`CINEMA_CHROME_EXECUTABLE`、`CINEMA_CHROME_PROFILE_DIR`、`CINEMA_CDP_PORT` 等はローカルoperatorが起動時に与えるtrusted configurationです。MCP tool argument、provider page、external place result等のuntrusted inputからこれらを生成・上書きしてはいけません。

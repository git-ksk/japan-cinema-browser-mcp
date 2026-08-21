# Cloud Run デプロイメント

> English: [`CLOUD_RUN.md`](CLOUD_RUN.md)

この文書では、`japan-cinema-browser-mcp` を Cloud Run で動かす場合の、**single-user に限定したリモート実行構成**を説明します。

標準の実行方式は引き続きローカルの stdio です。Cloud Run 構成は、汎用的なマルチユーザーMCPホスティングを提供するものではありません。

## 対象範囲

Cloud Run プロファイルは意図的に狭く設計しています。

- 論理ユーザーは1人だけ
- Firebase UID は明示的に1件だけ許可
- リモートMCPクライアントとの境界は MCP OAuth 2.1
- Firebase Authentication は Human authorization 時の本人確認にのみ使用
- 専用の headless Chromium を使用
- 映画館サイトの read / navigation 系workflowのみ
- external CDP attach は禁止
- purchase execution は禁止
- リモートでの Human Handoff は行わない
- CAPTCHA / MFA / challenge / anti-bot を回避しない
- 複数ユーザーで同じbrowser stateを共有しない

映画館サイト側でログイン、同意、アクセスチャレンジなど人間の操作が必要になった場合は、その場でフェイルクローズします。映画館サイト上で手動操作が必要なworkflowには、ローカルの headed stdio 構成を使用してください。

## ランタイム設定

コンテナは `node dist/index.js --http` で起動し、少なくとも次を設定します。

```text
CINEMA_REMOTE_MODE=true
CINEMA_HEADLESS=true
CINEMA_ENABLE_PURCHASE=false
MCP_HTTP_HOST=0.0.0.0
MCP_ALLOW_NONLOOPBACK=true
MCP_ALLOWED_HOSTS=<exact-service-hostname>
MCP_PUBLIC_BASE_URL=https://<exact-service-hostname>
MCP_OAUTH_ALLOWED_CLIENT_HOSTS=chatgpt.com
MCP_FIREBASE_PROJECT_ID=<firebase-project-id>
MCP_FIREBASE_WEB_API_KEY=<firebase-web-api-key>
MCP_ALLOWED_FIREBASE_UIDS=<single-owner-uid>
MCP_FIREBASE_LOOKUP_TIMEOUT_MS=5000
CINEMA_OPERATION_TIMEOUT_MS=90000
```

OAuth関連の有効期限は、未指定時に次の値を使用します。

```text
MCP_OAUTH_AUTHORIZATION_TTL_SECONDS=600
MCP_OAUTH_CODE_TTL_SECONDS=120
MCP_OAUTH_ACCESS_TTL_SECONDS=3600
MCP_OAUTH_REFRESH_TTL_DAYS=30
MCP_OAUTH_CLIENT_METADATA_TIMEOUT_MS=5000
```

本番環境固有の値をこの公開リポジトリへcommitしないでください。

Firebase Web API key は Firebase project を識別するための値であり、それ単体をcaller authorizationとして受け付けることはありません。一方、OAuth access / refresh token、authorization code、Firebase ID / refresh token、password はcredentialです。ログやリポジトリへ残してはいけません。

## リモート認証フロー

リモートのMCP endpointは OAuth Resource Serverとして動作し、同じoriginから対応クライアント向けの限定的なAuthorization Serverも提供します。

```text
MCP client
  -> Protected Resource Metadata
  -> Authorization Server metadata
  -> CIMD client metadata validation
  -> /authorize with PKCE S256 + exact resource
  -> Human enters existing Firebase email/password in browser
  -> browser sends password directly to Firebase Authentication
  -> browser sends only the resulting Firebase ID Token to /authorize/complete
  -> Cinema verifies Firebase UID against the single-owner allowlist
  -> one-shot authorization code
  -> /token issues resource-bound OAuth access + rotating refresh token
  -> /mcp validates scope/resource/expiry and restores the Firebase UID principal
```

Firebase passwordはCinema serverへ送信しません。ブラウザからFirebase Authenticationへ直接送信します。

Cinema serverが受け取るのはauthorization完了時の短命なFirebase ID Tokenだけで、これを永続保存しません。

### CIMD / redirect URI

CIMD client identifier は、設定で明示した HTTPS host のallow-listに含まれるものだけを許可します。

取得したmetadataについて、次を厳密に確認します。

- `client_id` が完全一致すること
- `redirect_uri` がmetadataに登録されたURIと完全一致すること
- metadata取得時にredirectを追従しないこと

このプロファイルでは Dynamic Client Registration は公開しません。

public client の token endpoint authentication method は `none` とし、authorization-code exchangeでは PKCE S256 を必須とします。

## OAuth state の保存

現在の Cloud Run 実装では、OAuth control-plane state の共有永続storeとしてFirestoreを使用します。

authorization request handle、authorization code、access token、refresh tokenをraw値のまま保存しません。SHA-256値をdocument identityとして使用します。

また、次の性質を維持します。

- authorization request / code はone-shot
- refresh token は使用時にrotate
- expiry後のrecordはbest-effortで削除
- resource / client / principalへbind

Firestoreは**現在の実装上の選択**であり、OAuth protocolそのものの必須要件ではありません。

別backendへ置き換える場合も、次のsecurity semanticsを維持する必要があります。

- 必要箇所でのatomic one-shot consumption
- refresh-token rotation / revocation
- TTL / expiry
- resource / client / principal binding
- restartや複数instanceが存在しても安全に扱えること

現時点でリポジトリに含まれるのはFirestore-backed OAuth storeだけです。別backendは設定変更だけでは利用できず、互換性のある `CinemaOAuthStore` 実装が必要です。

## HTTP endpoint

- `GET /health` — 認証不要のpassive liveness。Chromiumは起動しない
- `GET /.well-known/oauth-protected-resource/mcp` — Protected Resource Metadata
- `GET /.well-known/oauth-authorization-server` — Authorization Server Metadata
- `GET /authorize` — CIMD / resource / PKCE検証後にOAuth authorizationを開始
- `POST /authorize/complete` — 検証済みFirebase identityを消費し、one-shot authorization codeを作成
- `POST /token` — authorization-code / refresh-token exchange
- `POST /revoke` — token revoke
- `GET /ready` — OAuth認証済みbrowser readiness
- `POST /mcp` — OAuth認証済みStreamable HTTP MCP endpoint

`/mcp` と `/ready` は `mcp:tools` scopeを必須とします。

`offline_access` はrefresh可能なsession向けにAuthorization Serverからadvertiseしますが、Protected Resource Metadata上のresource scopeとしてはadvertiseしません。

Cloud Runには末尾が `z` の一部pathに予約上の制約があるため、このdeploymentでは `healthz` / `readyz` ではなく `/health` / `/ready` を使用します。

## Usage accounting / rate limiting

Cinema MCP coreは、usage accounting、quota、billing guard、rate limitingの実装を内包しません。

必要な場合は、認証済みdeployment boundaryにgatewayやsidecar等を組み合わせ、環境に合った実装・storage backendを選択してください。

その外部layerには、次を渡さないでください。

- browser page payload
- credential
- Cookie
- OAuth bearer material
- payment / authentication data

また、外部usage layerをCinema MCPとは別のexecution authorityやreplay authorityとして扱わないでください。

browser、provider policy、Human Handoff、purchase safetyの責務は引き続きCinema MCP側にあります。

## 低トラフィック向け推奨構成

低頻度利用では、次の構成を推奨します。

```text
region: us-central1
billing: request-based / CPU throttling enabled
startup CPU boost: disabled
CPU: 1
memory: 4 GiB
concurrency: 1
min instances: 0
max instances: 1
request timeout: 360 seconds
browser operation timeout: 90 seconds per explicit provider target
find_showtimes aggregate timeout: 275 seconds for three targets
```

### メモリを4 GiBにしている理由

2026-08-16のlive Cloud Run validationでは、Chromiumがまず1 GiBの上限を超え、続いて2 GiB構成でもproviderを順次readした際に上限を超えました。

このため、concurrencyを1に固定したうえで4 GiBを標準構成としています。

メモリを下げる場合は、3 provider workflowでbrowser reliabilityを実測してから変更してください。

### provider timeout

remote provider timeoutは `90000` msです。

AEONのlive validationでは、OOMを解消したあともCloud Run上で60秒を超えるケースがありました。このtimeout延長によってpublic-UI safety pathを省略することはありません。AEONでは引き続き、rendered theater listから劇場を再解決し、review済みの公開導線を通ってscheduleを読みます。

HTTP request timeoutを長くしてもprovider read自体はunboundedになりません。

- `CINEMA_OPERATION_TIMEOUT_MS` が1 providerあたりのsemantic budget
- `find_showtimes` は最大3件のexplicit targetを順次処理
- timeoutしたtargetは切り離してfailureとして扱う
- 90秒 × 3 targetを基準に、browser workを275秒以内へbound
- HTTP側は360秒とし、cold startやauth/proxy overheadを含めてもstructured partial resultを返せる余白を確保

quotaやbilling guardを外部で構成するかどうかに関係なく、Cloud Runのbilling alert設定は推奨します。

Chromiumを含むためimage sizeもAPI-only serviceより大きくなります。不要な古いcontainer imageは、運用上問題がなければ整理してください。

## Identity boundary

Human identityのsource of truthはFirebase Authenticationです。

`/authorize` ではブラウザがFirebaseへ直接認証し、Cinemaは返されたID TokenをFirebase Auth backendで検証します。その後、project / issuer / subject / time claimとuserの `validSince` 境界を再確認し、設定されたowner UIDだけを許可します。

OAuth exchange後、Resource Serverがcredentialとして受け付けるのはCinemaが発行したOAuth access tokenだけです。Firebase ID TokenをMCP resource credentialとして直接利用しません。

OAuth token recordは次へbindします。

- Firebase UID
- OAuth client ID
- exact MCP resource
- scope set
- expiration

そのUIDからCinema request / handoff ownershipに使うlogical principalを導出します。

### multi-user化は禁止

これはprincipalごとのbrowser isolationを備えたmulti-user設計ではありません。

`MCP_ALLOWED_FIREBASE_UIDS` に複数UIDを追加するだけの拡張は禁止です。

将来multi-user deploymentへ進む場合は、少なくともbrowser/profile/runtime stateをauthenticated principalごとに分離してからallowlistを広げる必要があります。

## Chromium sandbox

containerには `chromium-sandbox` を導入し、Chromium sandboxをデフォルトで有効にします。

Cloud Run runtimeとの互換性問題が実際に確認され、sandbox有効のままではChromiumを起動できない場合に限り、`CINEMA_ALLOW_UNSANDBOXED_CHROMIUM=true` を明示的なcompatibility fallbackとして使用できます。

事前に有効化しないでください。

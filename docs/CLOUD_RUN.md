# Cloud Runへのデプロイ

この文書では、`japan-cinema-browser-mcp` をCloud Runで動かす場合の、**1ユーザー限定のリモート実行構成**を説明します。

標準の実行方式は引き続きローカルstdioです。Cloud Run構成は、複数ユーザー向けの汎用MCPホスティングを提供するものではありません。

## 対象範囲

Cloud Run構成は意図的に狭くしています。

- 論理ユーザーは1人だけ
- 許可するFirebase UIDは1件だけ
- リモートMCPクライアントとの認証境界はMCP OAuth 2.1
- Firebase Authenticationは、人間が認可するときの本人確認にのみ使用
- 専用のheadless Chromiumを使用
- 映画館サイトの読み取り・画面遷移だけを対象にする
- 外部CDP接続は禁止
- 購入実行は禁止
- リモートでHuman Handoffは行わない
- CAPTCHA、MFA、アクセスチャレンジ、anti-bot機構を回避しない
- 複数ユーザーで同じブラウザ状態を共有しない

映画館サイト側でログイン、同意、アクセスチャレンジなど人間の操作が必要になった場合は安全側に停止します。手動操作が必要な利用には、ローカルの画面ありstdio構成を使ってください。

## 起動設定

コンテナは次で起動します。

```bash
node dist/index.js --http
```

少なくとも次の環境変数を設定します。

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

OAuth関連の有効期限は、未指定時に次を使います。

```text
MCP_OAUTH_AUTHORIZATION_TTL_SECONDS=600
MCP_OAUTH_CODE_TTL_SECONDS=120
MCP_OAUTH_ACCESS_TTL_SECONDS=3600
MCP_OAUTH_REFRESH_TTL_DAYS=30
MCP_OAUTH_CLIENT_METADATA_TIMEOUT_MS=5000
```

本番環境固有の値をこの公開リポジトリへコミットしないでください。

Firebase Web API keyはFirebaseプロジェクトを識別する値であり、それだけで呼び出しを許可する認証情報ではありません。一方、OAuth access token、refresh token、authorization code、Firebase ID token、Firebase refresh token、passwordは認証情報です。ログやリポジトリへ残してはいけません。

## リモート認証の流れ

リモートMCPエンドポイントはOAuth Resource Serverとして動作し、同じオリジンから対応クライアント向けの限定的なAuthorization Serverも提供します。

```text
MCP client
  -> Protected Resource Metadata
  -> Authorization Server metadata
  -> CIMD client metadata validation
  -> /authorize + PKCE S256 + exact resource
  -> 人間がブラウザ上でFirebaseへログイン
  -> passwordはブラウザからFirebase Authenticationへ直接送信
  -> Firebase ID Tokenだけを /authorize/complete へ送信
  -> CinemaがFirebase UIDを1ユーザー許可リストと照合
  -> 1回限りのauthorization codeを発行
  -> /token でresource-bound access token + rotating refresh tokenを発行
  -> /mcp がscope/resource/expiryを検証
```

Cinema serverはFirebase passwordを受け取りません。認可完了時に短命なFirebase ID Tokenだけを受け取り、永続保存しません。

### CIMDとredirect URI

CIMD client identifierは、設定で明示したHTTPS hostの許可リストに含まれるものだけを許可します。

取得したmetadataについて次を厳密に確認します。

- `client_id` が完全一致する
- `redirect_uri` がmetadataに登録されたURIと完全一致する
- metadata取得時にredirectを追従しない

この構成ではDynamic Client Registrationを公開しません。

public clientのtoken endpoint authentication methodは `none` とし、authorization-code交換ではPKCE S256を必須とします。

## OAuth状態の保存

現在のCloud Run実装では、OAuthの共有状態をFirestoreへ保存します。

次の値はraw値のまま保存しません。

- authorization request handle
- authorization code
- access token
- refresh token

SHA-256値をdocument identityとして利用し、次の性質を維持します。

- authorization request / codeは1回限り
- refresh tokenは利用時にローテーション
- 期限切れrecordは可能な範囲で削除
- resource / client / principalへ結び付ける

Firestoreは現在の実装上の選択であり、OAuthプロトコル自体の必須要件ではありません。

別の保存先へ置き換える場合も、次を維持する必要があります。

- 必要箇所での原子的な1回限りの消費
- refresh tokenのローテーションと失効
- TTLと期限管理
- resource / client / principalへの結び付け
- 再起動や複数instanceが存在しても安全に扱えること

現時点でリポジトリに含まれるのはFirestore版 `CinemaOAuthStore` だけです。

## HTTPエンドポイント

| エンドポイント | 用途 |
|---|---|
| `GET /health` | 認証不要の生存確認。Chromiumは起動しない |
| `GET /.well-known/oauth-protected-resource/mcp` | Protected Resource Metadata |
| `GET /.well-known/oauth-authorization-server` | Authorization Server Metadata |
| `GET /authorize` | CIMD / resource / PKCE検証後に認可開始 |
| `POST /authorize/complete` | 検証済みFirebase identityから1回限りのauthorization codeを作成 |
| `POST /token` | authorization code / refresh token交換 |
| `POST /revoke` | tokenの失効 |
| `GET /ready` | OAuth認証済みのブラウザ準備確認 |
| `POST /mcp` | OAuth認証済みのStreamable HTTP MCP |

`/mcp` と `/ready` は `mcp:tools` scopeを必須とします。

Cloud Runでは末尾が `z` の一部パスに予約上の制約があるため、`healthz` / `readyz` ではなく `/health` / `/ready` を使います。

## 利用量制御とレート制限

Cinema MCP本体は、利用量集計、quota、課金防止、レート制限を内包しません。

必要な場合は、認証済みのデプロイ境界にgatewayやsidecarを組み合わせてください。

その外部層へ次を渡してはいけません。

- ブラウザページ本文
- 認証情報
- Cookie
- OAuth bearer material
- 決済・認証データ

また、外部の利用量制御層を、Cinema MCPとは別の実行権限・再実行権限として扱わないでください。

ブラウザ操作、映画館ごとの許可範囲、Human Handoff、購入安全性はCinema MCP側の責務です。

## 低トラフィック向け推奨構成

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

2026-08-16の実環境確認では、Chromiumが1 GiB構成の上限を超え、その後2 GiB構成でも複数映画館を順番に読む処理で上限へ到達しました。

そのため、同時実行数を1に固定したうえで4 GiBを標準構成としています。メモリを下げる場合は、3社を読む処理でブラウザの安定性を実測してください。

### タイムアウト

`CINEMA_OPERATION_TIMEOUT_MS=90000` は、1映画館あたりの意味解析処理の上限です。

`find_showtimes` は最大3件を順番に処理します。90秒 × 3件を基準にブラウザ処理を275秒以内へ収め、HTTP側は360秒としてcold startや認証処理の余白を確保します。

1件がタイムアウトしても、他の成功結果を「完全な結果」とは扱わず、失敗情報を含む部分結果として返します。

Cloud Runのbilling alertは、外部quotaを使うかどうかにかかわらず設定を推奨します。

## 本人確認の境界

人間の本人確認元はFirebase Authenticationです。

`/authorize` ではブラウザがFirebaseへ直接認証し、Cinemaは返されたID Tokenを検証します。その後、project / issuer / subject / time claimとuserの `validSince` を再確認し、設定されたowner UIDだけを許可します。

OAuth交換後、MCP Resource Serverが認証情報として受け付けるのはCinemaが発行したOAuth access tokenだけです。Firebase ID TokenをMCP呼び出し用credentialとして直接利用しません。

OAuth token recordは次へ結び付けます。

- Firebase UID
- OAuth client ID
- 対象MCP resource
- scope
- 有効期限

## 複数ユーザー化は禁止

この構成には、ユーザーごとのブラウザ・プロファイル分離がありません。

`MCP_ALLOWED_FIREBASE_UIDS` に複数UIDを追加するだけの拡張は禁止です。

将来複数ユーザーへ対応する場合は、ブラウザ、プロファイル、実行状態を認証済みユーザーごとに分離してから許可範囲を広げる必要があります。

## Chromium sandbox

コンテナには `chromium-sandbox` を導入し、Chromium sandboxを標準で有効にします。

Cloud Runとの互換性問題が実際に確認され、sandbox有効では起動できない場合に限り、`CINEMA_ALLOW_UNSANDBOXED_CHROMIUM=true` を明示的な互換モードとして利用できます。

事前に有効化しないでください。

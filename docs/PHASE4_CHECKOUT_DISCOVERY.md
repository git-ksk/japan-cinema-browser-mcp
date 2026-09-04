# Phase 4 購入準備・Human Handoff調査

レビュー日: 2026-08-17  
Tracking: #48

## 目的

Phase 4では、座席選択や購入準備を有効にする前に、**どこまでをAgentが扱い、どこからを人間へ戻すべきか**を映画館ごとに整理しました。

この調査は、公式公開情報、表示中の公式Web画面、すでにレビュー済みの既存実装だけを対象にしています。

次は許可していません。

- 非公開API・内部APIの利用
- 通信内容の傍受
- 隠しエンドポイントの探索
- URLやクエリ値の推測
- CAPTCHAやアクセスチャレンジの回避
- 認証情報の自動入力
- 決済処理
- 最終購入

## 結論

**この調査だけでは、状態を変える購入系機能を1つも有効にしません。**

| 映画館 | `seatMap` | `seatSelection` | `checkoutPreparation` | `purchaseSubmission` | Phase 4の状態 |
|---|---:|---:|---:|---:|---|
| TOHO | true | false | false | false | 最初の候補。追加ゲートで段階確認 |
| イオン | true | false | false | false | 座席確保・解除条件の追加確認が必要 |
| 109 | true | false | false | false | 10分の座席確保が明示されており、状態変更レビューが必要 |

座席選択は意味のある状態変更です。`never_replay` を維持し、汎用クリックやHuman Handoff完了後の自動再実行で代替してはいけません。

## 座席選択と一時確保の境界

### TOHOシネマズ

公式案内では、座席選択の後に券種、購入者情報、支払い、最終確認へ進みます。また、希望座席を決定してから15分以内に購入を完了する必要があると説明されています。

Phase 3では、座席表へ入るだけでは選択席が発生しないことを確認しました。

一方、調査開始時点では「どの操作からサーバー側の座席確保が始まるか」は未確定でした。

候補は次のいずれかです。

- 座席画像を選択した時点
- 座席を `確認する` で確定した時点
- その後の画面遷移

#### Gate 0で分かったこと

調査後、1上映・通常席1席だけを使い、事前に2回の読み取り結果が一致した状態で、対象座席を1回だけ選択しました。

結果:

- 画面上は `空席(選択可)` から `選択中` へ変化
- 別の新規プロファイルから見ると、同じ座席は引き続き空席
- 事前の座席状態fingerprintとも一致

このため、**座席画像を1回選択しただけでは、別セッションへ影響するサーバー側座席確保は始まらない**と判断しました。

その後のB1事前確認で、TOHOの実画面には利用規約同意より前に `確認する` という座席決定段階が存在することを再確認しました。

座席画像が `選択中` になっても、選択座席の要約は先へ進まず、`確認する` も操作可能な状態になりませんでした。そのため、座席画像の選択と「希望座席を決定」は同じ状態とみなしません。

2026-08-25のGate 0b v6 physical acceptanceで、この境界を実機確認しました。Humanがexact `A-2` → `確認する` 1回 → provider自身の `terms_check` を明示的にON → Doneまで実行し、CinemaはTOHO自身の `bookSeatIntForm.seat_no` とrendered `#seatList2` がexact seat 1件だけで一致すること、およびcheckbox checkedをread-only検証しました。直後の独立fresh sessionでも同じ `A-2` は `available` でした。このため、**`確認する` とterms acknowledgementまででは、少なくとも別sessionから観測できるserver-side holdは開始していませんでした**。

利用規約欄と `terms_check` checkboxはseat page下部に常設されるため、欄や `利用規約に同意して次へ` の**存在**だけをpostconditionには使いません。seat画像の `選択中` 表示も補助diagnosticだけにし、canonical truthはprovider-owned form + rendered summaryとします。Gate 0bでは `利用規約に同意して次へ` を押していません。

2026-09-04のGate 1 physical acceptanceでは、このcontrolをHumanが1回だけ操作して直後 `TNPI2010J02.do` で停止しました。独立fresh profileではexact `A-2` が `unavailable` となり、Gate 0bまででは観測されなかったserver-side holdがGate 1遷移で始まることを確認しました。J02は「今から15分以内に購入が完了しない場合、自動的に座席は解除されます」と表示し、能動的な取消/戻る/解除を使わず後のfresh profileでA-2が `available` に戻ったため自然releaseも確認済みです。連続pollはしていないため、解除のexact secondは証明していません。

2026-09-05のJ02 read-only reviewでは、seat slot `A2`、hidden `ticket_type_name`、exact modal trigger、TOHO自身の `SelectTicket.setTicket(...)` に埋め込まれたprovider ticket ID / label / price、`ログインせず次へ` のguest continuation identityを確認しました。券種選択後はprovider Ajaxが3D/追加料金・キャンペーン・決済限定・MovieTicket等を返し得るため、B2は選択後にこれらを再読して条件があれば停止します。資格を推測しません。`一般`は追加確認なしで選択候補とし、資格条件付きのreview済み券種はexact provider ticket ID / label / rendered price / eligibility textを会話上でユーザーへ提示し、同じfactsへの明示確認がcheckout intentへbindされた場合だけ選択候補にします。

同日のB2 physical mutation acceptanceでは、callerが明示した`一般` 1枚のみをexact pointerで選択しました。選択後のprovider IDは`529-2100-0010-0`、表示は`一般 2,100円`、hidden/rendered totalはいずれも2,100円、Ajaxはsettled、追加料金/キャンペーン/MovieTicket/決済限定/provider warningは観測されませんでした。`ログインせず次へ`はこのB2 runでは未操作です。後続B3a physical acceptanceでは、同じexact general-ticket状態からreview済みguest controlを1回だけ操作し、same browser targetで `TNPI2030J02.do` へ到達しました。選択後に同じmodal anchorの表示labelが選択済み券種へ変わるため初回post-readがfail closedしましたが、PR #83でread-only stage normalizationだけを選択済みDOMへ対応し、pointer mutation直前のexact未選択label検証は維持しています。さらに実DOMでは選択summaryの要素IDも事前想定と異なったため、PR #84でexact `.ticket-item` 内のunique `.ticket-content` へbindingし直し、同じretained live J02で `一般 2,100円` / provider ID / total / Ajax / 追加条件なしを再検証しました。

また、隔離環境の標準 `756x469` viewportでは横向き表示に関するブロックが出ました。`1280x813` ではその環境要因は解消しましたが、`確認する` は依然として操作可能になりませんでした。

このため、画面サイズを変えて無理に続行したり、座席選択を繰り返したりせず安全側に停止します。

### イオンシネマ

公式e席リザーブの案内では、選択した座席をもう一度押して解除できること、座席選択後に券種・支払い・確認へ進むことが分かります。

ただし、画面上で解除できることは「サーバー側で一時確保されていない」証拠にはなりません。

公開情報だけでは、次がまだ確定していません。

- 座席確保が始まる正確な操作
- 確保時間
- 解除条件

そのため `seatSelection=false` を維持します。

#### 現行UIの再確認

Phase 4開始時、上映スケジュールのDOM構造がPhase 3時点から変化し、既存実装は推測して続けず `UI_STATE_CHANGED` で停止しました。

#59では現在の表示を改めて狭く確認し、次だけを採用するよう修正しています。

- T360 Cookie表示では `全て拒否` だけを操作
- 作品を開く場合は表示中の `上映時間を見る` だけ
- 同じ作品カード内で表示中の `.p-schedule__ticket` だけを上映回として採用
- 非表示のticket DOMは結果へ含めない

#60では `予約購入` の操作位置も、対象のBUTTONそのものへ当たっていることを再確認するよう強化しました。

一方、修正後に予定していた「新規プロファイル2本での座席表再証明」はまだ完了していません。

現在画面では、対象上映回の完全一致、`about:blank` を含む新規targetの採用条件、Smart Theater側の劇場・作品・日時・screen一致などで安全停止するケースが残っています。

座席選択、代替座席の試行、券種、同意、個人情報、支払い、購入は行っていません。

#51はGate 0前のままです。

### 109シネマズ

109の公式購入案内には、座席を10分間確保することが明示されています。

Phase 3では、座席表へ入った時点から10分タイマーが始まる一方、選択席は0で、別セッションの空席状態にも変化がないことを確認しました。

つまり次を分離して考えられます。

- 座席表へ入る → 時間制限付き購入セッションは始まる
- 座席を選ぶ → サーバー側の可逆・期限付き座席確保が始まる可能性が高い

したがって `seatSelection=false` を維持します。

#### 表示変更への対応

座席表の0席選択表示が、以前の `選択座席 0／8席` から `選択座席：0／8席` へ変化していました。

既存実装は安全側に停止したため、確認済みの同じラベルに限り、ASCIIまたは全角コロンを任意で許可するよう狭く修正しました。

その後、新規プロファイル2本で同じ上映回を確認し、どちらも次で一致しました。

- 10分の解放案内を表示
- 選択席0
- 全94席
- 空席83
- 利用不可11
- universal属性2
- context / layout / state fingerprint一致

座席は1つも選択していません。

この結果は「座席表へ入るだけでは座席確保が発生しない」ことの再確認にはなりますが、座席選択を許可する根拠にはなりません。#52で状態変更と解除条件を別途確認します。

## 購入フローの比較

| 段階 | TOHO | イオン | 109 |
|---|---|---|---|
| 上映回選択 | 読み取り中心 | 読み取り中心 | 読み取り中心 |
| 座席表へ入る | 読み取り可能 | 状態付き画面遷移後に読み取り | 10分セッション開始、入場だけでは確保なし |
| 座席選択 | 確保開始点を追加確認中 | サーバー側確保条件未確認 | 10分確保が公式明記 |
| 券種 | 購入準備の状態変更候補 | 購入準備の状態変更候補 | 購入準備の状態変更候補 |
| 会員・非会員 | 非会員導線あり。ログインはHuman | 非会員導線あり。ログインはHuman | 非会員導線あり。ログインはHuman |
| 購入者情報 | Human | Human | Human |
| 規約同意 | Human | Human | Human |
| 決済 | Human | Human | Human |
| 購入内容要約 | 表示中の事実だけ読み取り候補 | 同左 | 同左 |
| 最終購入 | Phase 5以降 | Phase 5以降 | Phase 5以降 |

## Human Handoffへ戻すもの

次は人間だけが扱います。

- password / passcode
- OTP / MFA / verification code / 3-D Secure
- CAPTCHA / access challenge / waiting room
- カード情報、決済credential、wallet承認
- 会員認証情報、PIN相当のsecret
- voucher / coupon / MovieTicket等で認証・PIN性を持つ値
- 利用規約などへの法的同意
- 初期Phase 4では購入者氏名、電話番号、メールアドレス、生年月日

最後の個人情報は、単なるsecret deny-listより厳しく扱います。「パスワードではないからMCPへ入力してよい」とはしません。

Human Handoff後も、元の座席選択や購入操作を自動再実行しません。現在画面を読み直し、新しい意味操作として再発行する必要があります。

## 券種の共通モデル案

映画館側の表示を正本とし、共通モデルでは必要な事実だけを保持します。

```ts
interface CinemaTicketType {
  providerTicketTypeId?: string;
  label: string;
  price?: number;
  currency: "JPY";
  category?: "standard" | "child" | "student" | "senior" | "member" | "accessibility" | "special" | "other";
  eligibilityText?: string;
  restrictionText?: string;
  minQuantity?: number;
  maxQuantity?: number;
}
```

原則:

- 現在画面に表示されたラベル・価格・条件・数量制限を読む
- 共通カテゴリへ変換しても元ラベルを保持する
- 年齢、学生、シニア、障害、会員資格を推測しない
- 資格条件付き券種は会話上のexplicit user acknowledgementを要求し、PIN/credential/provider-required manual stepが必要な割引はHuman Handoffまたは安全停止へ戻す
- 券数と選択席数を一致させる

## 購入内容要約

購入準備の要約は、呼び出し側の入力ではなく**現在の映画館画面を再読して作る**必要があります。

表示されている場合に対象とする事実:

- 映画館
- 劇場
- 作品
- 日付
- 開始時刻
- screen
- 座席
- 券種と枚数
- 小計
- 手数料
- 合計
- 通貨
- 現在の購入段階
- 観測時刻・状態fingerprint

表示されていない金額や手数料を0として補完しません。

## v0.4.0の既定導線

Gate 0b / Gate 1 / B2 / B3の調査でhold・ticket・guest・purchaser/payment境界を実証した後、製品の初期導線はより単純なFull Checkout Human Handoffへ切り替えます。Agentはexact showtime seat mapの2回readまでを担当し、座席選択以降はHumanが専用browser上で実購入まで操作します。B2/B3 automationはoptional研究として残し、`prepare_checkout` はv0.4.0既定UXのblockerにしません。

TOHOのみ `humanCheckoutHandoff=true` とし、`seatSelection=false / checkoutPreparation=false / purchaseSubmission=false` は維持します。実購入完了後のsuccess route/markerは有料physical acceptance時に確定し、それまでは購入成功を機械的に断定しません。

## `prepare_checkout` が担う範囲

将来公開する場合の責務は次のとおりです。

1. ユーザーが指定した上映回・座席・券種を厳密に固定する
2. 状態変更前に上映回と座席状態を再確認する
3. 映画館ごとにレビュー済みの状態変更だけを呼び出す
4. 指定席だけを1回操作し、代替席探索や自動再試行をしない
5. 操作後に選択状態を画面から再確認する
6. 券種を正規化しても利用資格を勝手に判断しない
7. 確認済みの非会員導線だけを利用する
8. 認証、個人情報、同意、決済、チャレンジではHumanへ戻す
9. Human操作後は現在状態を再確認し、新しい意味操作を要求する
10. 安全に到達できる場合だけ購入直前の要約を返す
11. 最終購入・決済確定は行わない

映画館共通の「必ず元に戻せる処理」は保証しません。解除操作を自動化する場合も、その映画館で解除条件を別途確認できた場合だけです。

## 実装の分割

- #49 — 共通 `prepare_checkout` 契約と安全コア
- #50 — TOHOの最初の縦切り。座席確保・解除条件のゲートを個別確認
- #51 — イオンの座席確保・解除調査
- #52 — 109の10分座席確保調査

Phase 4では3社同時対応を必須にしません。

## リリース候補

新しい公開機能として `prepare_checkout` を提供する場合、候補は `v0.4.0 — Checkout Preparation` です。

ただしMilestoneへ入っていることは、その映画館の機能を有効にしてよい根拠にはなりません。各映画館の安全ゲートを通過してから対応機能を変更します。

この調査自体には、バージョン変更、タグ、GitHub Release、npm公開、本番デプロイを含みません。

## 参照した公式公開資料

- TOHO vit: https://www.tohotheater.jp/vit/vit_buy.html
- TOHO 非会員購入: https://www.tohotheater.jp/vit/index.html
- TOHO FAQ: https://help.tohotheater.jp/category/show/469?site_domain=default
- イオン e席リザーブ: https://www.aeoncinema.com/service/onlineticket/instructions/?tab=tab3
- 109 チケット購入方法: https://109cinemas.net/tickets/howto/

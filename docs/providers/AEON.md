# イオンシネマ対応メモ

Provider ID: `aeon`  
公式サイト: `https://www.aeoncinema.com/`

初回レビュー: 2026-08-12  
上映情報adapterレビュー: 2026-08-13  
座席表adapterレビュー: 2026-08-17

## 現在の対応状況

| 機能 | 状態 | 備考 |
|---|---|---|
| 公式サイトを開く | 有効 | 許可domainを限定 |
| 限定的な画面読み取り | 有効 | ページ内容は永続保存しない |
| 劇場選択 | 有効 | 公式「劇場を探す」UIのみ |
| 上映情報取得 | 有効 | 公開スケジュール画面の表示内容のみ |
| 座席表の読み取り | 有効 | #36 / #43でread-only境界を確認 |
| 座席選択 | 無効 | `seatSelection=false` |
| チェックアウト準備 | 無効 | `checkoutPreparation=false` |
| 最終購入 | 無効 | `purchaseSubmission=false` |

## 公式サイトポリシー

2026-08-13に公式サイトポリシーとe席リザーブ利用規約を再確認しました。

本プロジェクトは、ユーザー要求時の低頻度な公式公開UI読み取りに限定します。定期クロール、全国上映DB化、素材の再配布、private/internal endpoint利用、challenge回避、購入自動化は行いません。

営利利用や大きなautomation surface変更、取引系機能を有効化する前には改めてレビューします。

## Phase 1で確認した公開導線

- 劇場一覧: `https://www.aeoncinema.com/theater/`
- 上映スケジュール: `https://theater.aeoncinema.com/theaters/{slug}/`
- 日付指定: 同じ公開schedule pageの `?date=YYYYMMDD`

adapterが読むのはブラウザに表示された公開情報だけです。`schedule.json` 等の内部endpointを直接利用せず、network interceptionも行いません。

## 上映情報adapter

### `list_theaters`

公式「劇場を探す」ページで表示されている劇場controlだけを対象にします。

- 都道府県見出し配下の表示controlを抽出
- `IMAXレーザー`、`4DX`、`ULTIRA`、`Dolby Atmos` 等の施設labelを劇場名から分離
- 公開schedule URLがDOMへ明示されている場合だけ採用
- URLを確定できない場合はslugを推測せず、公式UIの選択導線を使う
- SPA描画途中なら上限付きで表示完了を待つ
- 劇場件数や構造がレビュー済み範囲から外れたら安全停止

### `get_showtimes`

1. 劇場を一意に解決する
2. 明示された公開schedule URL、または公式UI導線からschedule pageへ進む
3. 要求日付を `?date=YYYYMMDD` で表示する
4. hostname / path / date queryを再確認する
5. 表示完了まで上限付きで待つ
6. 作品、開始・終了時刻、screen、format、字幕・吹替、明示availabilityだけを構造化する

`予約購入` は表示されていても、上映情報adapterからは操作しません。

## 安全停止する条件

次の場合は部分結果を推測して返しません。

- 劇場一覧の構造や件数がレビュー済み状態と一致しない
- 劇場を一意に解決できない
- schedule routeがレビュー済み形から外れる
- 日付切替後のpath / queryが一致しない
- 劇場identityが一致しない
- 上映時間と作品を一意に結び付けられない
- 上映回0件なのに明示的な空状態もない

raw HTML、full DOM、Cookie、token、private API responseは返却・永続保存しません。

## テスト

```bash
npm run smoke:aeon
```

live smokeは公式劇場一覧と上映ページを読むだけで、座席選択・checkout・購入は行いません。通常CIには含めません。

## Phase 3 座席情報調査 — 2026-08-17

港北ニュータウンの現行scheduleから、表示中の `上映時間を見る` と正確な `予約購入` を使って座席表導線を確認しました。

初期検証では新規targetが `about:blank` のまま止まりましたが、原因を切り分けるとT360 Cookie bannerがpointerを遮っていました。

表示中の `全て拒否` を選んだ後、次の公式UI導線だけで座席表へ到達できます。

```text
正確な作品・時間・screenの「予約購入」
  -> Watatheatre「チケット購入のみ（会員登録しない）」
  -> reserve.smart-theater.com/#/purchase/cinema/seat
```

独立したclean profile 2本で同一上映を確認し、どちらも168 seats、selected(active)=0で座席状態fingerprintが一致しました。

この結果から、**座席表を表示するだけでは座席holdや他利用者の空席状態変更を起こさない**という読み取り専用ゲートを通過しています。

hold開始点やtimeoutは公開情報だけでは確定できないため、座席選択は引き続き無効です。

## #43 読み取り専用adapter

#43ではAEON専用のレビュー済みtarget / action chainと座席DOM adapterを実装しました。汎用navigation allow-listへSmart Theaterを追加していません。

主な境界:

- theater / movie / date / start / screenを厳密に結び付ける
- `.p-schedule__ticket` 内の正確な `予約購入` が見えている場合だけ操作する
- Cookie surfaceでは `全て拒否` だけを扱う
- 操作前から存在する外部targetは採用しない
- 操作直後に生成されたtargetだけを候補にする
- Watatheatreではレビュー済みの非会員導線だけを使う
- Smart Theater URLを推測生成しない
- unexpected route、選択済みseat、要求context不一致では安全停止する
- 実座席は `seat-[ROW]-[NUMBER]` classを持つ要素だけを対象にする
- geometryは表示rectから取得し、明確なgapだけを境界として扱う
- screen位置を証明できなければ `screenEdge` を設定せず、AEONの `recommend_seats` は有効化しない

live smokeではfresh temporary Chrome profile 2本で同一上映を確認し、両方で168 seats / active 0でした。

これにより `seatMap=true` とし、`seatSelection=false / checkoutPreparation=false / purchaseSubmission=false` は維持しています。

詳細: [`../PHASE3_SEAT_DISCOVERY.md`](../PHASE3_SEAT_DISCOVERY.md)

## Phase 4 現行UI再確認 — 2026-08-17

Phase 4 #51開始時、schedule UIがPhase 3実装時から変化し、`getShowtimes` は曖昧な結果を返さず `UI_STATE_CHANGED` で安全停止しました。

現在の画面は主に次で構成されています。

- 作品ごとの `.p-schedule__information`
- 表示中の正確な `上映時間を見る`
- 展開後の `.p-schedule__ticket`

#59ではこの現行UIだけを狭く再レビューし、同じ作品card内で表示中の `.p-schedule__ticket` だけを上映情報の根拠にしました。hidden ticketや曖昧なgroupは採用しません。

#60では座席入口pointerも厳密化し、`elementFromPoint(...).closest(...)` が同じticket BUTTONへ戻る点だけを操作対象にしています。

ただし、現行UIでfresh temporary Chrome profile 2本による座席表状態一致の再証明はまだ成立していません。

独立fresh runでは、座席入口を再解決できない、新規targetが `about:blank` のまま止まる、Smart Theaterへ到達してもtheater / movie / date / time / screenを厳密に結び付けられない、といったケースで安全停止しています。

これらを迂回するretry loop、別操作、推測routeは追加していません。

そのためPhase 3時点の読み取り専用実績は維持しつつ、**現行UIで2つのfresh profileによる安定性を再証明できるまでは#51を先へ進めません。**

`seatSelection=false` / `checkoutPreparation=false` / `purchaseSubmission=false` を維持し、`prepare_checkout` も公開しません。
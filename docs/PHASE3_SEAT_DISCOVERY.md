# Phase 3 座席情報調査

調査日: 2026-08-17  
親Issue: #30  
Milestone: `v0.3.0 — Seat Intelligence`

## 目的

Phase 3では、**不要な座席確保を発生させずに、表示中の座席表を理解できるか**を確認しました。

座席機能を有効にする前に、TOHOシネマズ、イオンシネマ、109シネマズの3社について、座席表へ入るまでの経路、座席状態の読み取り方、一時確保が始まる境界を比較しています。

調査中は次の安全境界を維持しました。

- 公式の公開Web画面と公式公開資料だけを利用
- 非公開API・内部APIを探索・直接利用しない
- 通信内容を傍受しない
- 隠しURL、映画館識別子、クエリ値を推測しない
- CAPTCHAやアクセスチャレンジを回避しない
- ログイン、決済、購入を行わない
- 座席をクリックしない
- 意図的な座席確保を発生させない

初期調査では3社とも `seatMap`、`seatSelection`、`checkoutPreparation`、`purchaseSubmission` を無効のまま進めました。

## 結論

調査と追加検証の結果、**座席表を読み取るだけの機能は3社とも有効化できる**と判断しました。一方、座席選択は別の状態変更として扱い、引き続き無効です。

| 映画館 | 座席表への進入 | 読み取り | 座席選択 | 主な注意点 |
|---|---|---:|---:|---|
| TOHO | 公開上映回 → 非会員導線 → `座席指定` | ✅ | ❌ | 入場時点では選択席・カウントダウンを確認せず。座席決定後15分の公式説明あり |
| イオン | `予約購入` → 非会員導線 → Smart Theater | ✅ | ❌ | 座席表表示時は選択席0。座席を有効化した時点のサーバー側確保条件は未確認 |
| 109 | 公開上映回の明示リンク → 座席表 | ✅ | ❌ | 入場直後から10分タイマーが始まるが、選択席0で空席状態も別セッションと一致 |

現在の実装状態は次のとおりです。

```text
TOHO: seatMap=true, recommend_seats=true, seatSelection=false
AEON: seatMap=true, recommend_seats=false, seatSelection=false
109:  seatMap=true, recommend_seats=false, seatSelection=false
```

## 映画館ごとの確認結果

### TOHOシネマズ

公開されている上映回から、表示中の非会員向け導線を通って `座席指定` 画面まで進みました。座席自体はクリックしていません。

座席表へ入った直後には、次を確認しました。

- 選択中の座席なし
- 目立ったカウントダウン表示なし
- 空席、選択中、販売済み・販売対象外を区別できる表示あり

公式FAQでは、希望座席を決定してから15分以内に購入を完了する必要があると説明されています。このため、通常の上映情報閲覧より後、少なくとも座席決定付近に時間制約のある状態が存在すると考えられます。

読み取り専用の実装では、座席表へ入ったこと自体で座席確保や空席変化を起こさないことを安全条件としました。#32で座席表読み取り、#33で鮮度確認と座席候補提案を実装し、`seatMap=true` へ変更しています。

`seatSelection=false` は維持します。

### イオンシネマ

初期調査では `about:blank` が残る挙動を座席遷移の問題と誤認しましたが、#36で原因を切り分けました。実際にはT360 Cookie表示が `予約購入` ボタンへの操作を遮っていました。

確認済みの経路は次です。

```text
T360 Cookie表示
  -> 「全て拒否」
  -> 対象上映回の「予約購入」
  -> Watatheatreの非会員購入
  -> Smart Theater座席画面
```

この経路は、通常の表示中Web画面だけを使っています。

独立した新規プロファイル2本で同じ上映回を確認し、座席表表示時に選択中の座席が0で、座席状態のfingerprintも一致しました。

#43では次だけを読み取ります。

- 実際の `seat-[ROW]-[NUMBER]` 座席識別子
- `default` / `disabled` など確認済みの公開class
- premium / special / wheelchair属性
- 表示位置から得られる座席配置

`active` な座席が存在する場合や、上映回・劇場・画面遷移の同一性を確認できない場合は安全側に停止します。

スクリーン方向を示す明確な証拠が取れていないため、イオンでは `recommend_seats` をまだ有効にしていません。

### 109シネマズ

表示中の上映回にある**実際の公開リンク**をそのまま使って座席表へ進みました。URLやクエリは生成していません。

座席表へ入ると10分の購入セッションタイマーがすぐ始まります。一方、画面上は `選択座席 0／8席` で、座席を1つも選んでいません。

同じ上映回を独立した2つのブラウザセッションから確認したところ、座席識別子と利用不可座席の状態が一致し、選択席はどちらも0でした。

この結果から、**座席表へ入ること自体は時間制限付きセッションを作るが、座席確保や空席変化は起こしていない**と判断しました。

ただし座席を選択した後は、公式案内上も10分の一時確保を伴う状態変更です。したがって `seatSelection=false` を維持します。

## 座席モデル

特別席は「空いている・埋まっている」と同じ軸で扱いません。

たとえばD-BOX、Gold Class、Executive、Pair、車椅子対応席などは、**座席属性**と**利用状態**を分離します。

```ts
type CinemaSeatState =
  | "available"
  | "unavailable"
  | "selected"
  | "unknown";

type CinemaSeatUnavailableReason =
  | "sold"
  | "blocked"
  | "not_for_sale"
  | "unknown";

interface CinemaSeat {
  id: string;
  row?: string;
  number?: string;
  state: CinemaSeatState;
  unavailableReason?: CinemaSeatUnavailableReason;
  attributes: string[];
  rowIndex?: number;
  x?: number;
  y?: number;
  groupId?: string;
}
```

重要な原則:

- 画面上で区別できない状態を勝手に細分化しない
- 映画館側で表示される座席識別子を保持する
- 特別席の属性と空席状態を分ける
- 観測元URLと観測時刻を保持する
- `unknown` を「空席」とみなさない

## 座席候補の共通化

映画館固有のアダプターが正規化済みの座席配置を返せれば、次の評価は共通処理にできます。

- N席連続の判定
- 中央寄り
- 後方寄り
- 後方中央
- 通路寄り
- ペア席・グループ席のまとまり

候補の対象は、明確に `available` と確認できた座席だけです。

`unknown` は候補に含めません。特別席やアクセシビリティ対応席も標準候補から外し、呼び出し側が明示的に希望した場合だけ対象にします。

## 情報の鮮度

座席状態は外部で変化するため、読み取った結果には鮮度確認が必要です。

現在の設計では次を確認します。

1. 映画館・劇場・上映回・スクリーンが同一であること
2. 観測時刻
3. 座席識別子と状態から作る決定的なfingerprint
4. 同じ座席表を上限付きで再読する
5. 上映回、配置、空席状態が変わっていたら古い結果を使わない

`recommend_seats` は状態確認のために座席を選択しません。

## v0.3.0で実装した範囲

- 3社共通の座席モデル
- TOHO / イオン / 109の `get_seat_availability`
- 3社のread-only `seatMap=true`
- TOHOの `recommend_seats`
- 座席行・番号の正規化
- 表示上の隙間・通路境界の抽出
- TOHOでのスクリーン方向確認
- 連席、中央、後方、後方中央、通路寄りの評価
- context / layout / state fingerprintによる変更検知
- 座席クリックを伴わないunit testと実サイト確認

### 対象外

- `select_seats`
- `seatSelection=true`
- 座席クリックや一時確保
- ログイン自動化
- 購入準備
- 決済・購入
- スクリーン方向を明示確認できるまでのイオン / 109 `recommend_seats`

## 関連Issue

- #31 — 共通座席モデルと座席候補評価
- #32 — TOHO読み取り専用座席アダプター
- #33 — 座席状態の鮮度確認と `recommend_seats`
- #35 — 109読み取り専用座席アダプター
- #36 — イオン座席表への公開導線と安全条件
- #43 — イオン読み取り専用座席アダプター

`select_seats` を実装する場合は、映画館ごとに座席確保・解除の状態変更を別途レビューしてから着手します。この調査だけでは座席選択を許可していません。

## 参照した公式公開資料

TOHOシネマズ:

- https://www.tohotheater.jp/vit/vit_buy.html
- https://help.tohotheater.jp/faq/show/2049
- https://www.tohotheater.jp/theater/036/institution.html

イオンシネマ:

- https://www.aeoncinema.com/service/onlineticket/instructions/?tab=tab3
- https://www.aeoncinema.com/kohoku/facility/

109シネマズ:

- https://109cinemas.net/tickets/howto/
- https://109cinemas.net/kohoku/establishment.html

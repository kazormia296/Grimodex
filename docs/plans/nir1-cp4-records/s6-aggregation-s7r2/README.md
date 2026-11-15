# S6 集計（S4b 7 回目のまま・候補 `29a120dd`・K6/6）

2026-11-15 に integrator が作った、CP-4 の ⑤ の S6 集計です。

- **入力**：S4b `f2f99b13e18bcf4dd84ff6778de56189a3e1ef9b`（再凍結なし。ユーザー決定 2026-11-15）の下で走らせた、候補 `29a120ddd3dd8ec5a43845a76cbda837e9b20f6a` の正式の run の受領書と台帳です。
  - 候補は PR #909（DR-DBC-6、WAL の restart の先払い）の merge commit で、tree は `97ae2b7a` です。
- **契約**：K6/6（`56fb4fad`、SHA-256 `58c634fa…`）、K6/5（`07fc80ec`）、K6/4（`5dea38af`）、K6/2（`af643a93`）。
- **S6 がすること**：受領書の数値に事前登録の規則を当て、規則が指す先を記録するだけです。
  - 閾値、期待値、Gold、Q と U の定義、pool の選び方、失効の読み、K6/6 の値は変えていません。

再現は次の 3 本の script で行います。

- `scripts/s6-aggregate.mjs`：集計。出力は `s6-aggregation.json` です。
- `scripts/recompute-trace-k64.mjs`：trace の K6/4 の読みへの再計算。出力は `trace-k64-recompute.json` です。
- `scripts/recompute-trace-base.mjs`：基準の再現。

script は s7r1 の script を写して書き換えたものです。変更点は `scripts/s6-aggregate.mjs` の冒頭のコメントにあります。

- s7r1 は Gold が 2 回あったので、それを前提にした箇所を直しました。既定の Gold は `gold-s7r2-1` で、台帳は 8 件です。
- 前回候補の Gold を開示する欄を足しました。

本文の数値は、断りがない限り `s6-aggregation.json` から写しています。品質の判定は別の記録 `../quality-verdict-s7r2-1/` にあります。

## 1. 許可リストと集計の対象

- 台帳 `../attempts-final-s7r2/` は **8 件**です。
  - 8 件すべてで、`(s4Commit, candidate.commit)` が `(f2f99b13…, 29a120dd…)` です。
  - status はすべて `completed` です。
  - contracts の写しは `.artifacts/cp4/attempts/` と byte 一致します（script が確認）。
- 集計の対象は、次の 8 件すべてです。
  - `sp-p4-s7r2-1`
  - `trace-editing-s7r2-1`、`trace-browsing-s7r2-1`
  - `parity-s7r2-1`
  - `gold-s7r2-1`
  - `neg-n2／n3／n4-s7r2-1`
- **Gold の取り直しはありません。** Gold の 13 receipt の `priorAttempts.gold` は、すべて空配列です。script は、空でなければ `[precheck]` で止まります。
- 受領書は 31 件で、すべて K6/6 の束縛に一致しました（`bindings.receipts`＝31）。
  - 内訳は SP-P4 1、Gold 13、parity 12、negative 3、trace 2 です。
- `constantsMatchCandidateConstantsMjs` は true です。

## 2. 事前登録の規則

s7r1 と同じです。

- **可用性の物差し**：次のどれかを超えたら、可用性を満たしたと主張せず、HOLD とします。
  - 定常状態の表示の欠落が `floor(1%·n)` を超える。
  - trace の窓外率が 1% を超える。
  - trace の失効率が 1% を超える。
- **`[precheck]`**：失効率が基準を満たさない trace が 1 つでもあれば、`[precheck]` とします。
- **K6/6 の追加**：窓内に合流して Graph が表示に寄与した親が、first-render の条件を欠くとき（`contributedNotCounted > 0`）、その variant の品質は FAIL です。品質判定 v2 が出します。

## 3. 結果

### (a) 定常状態（`gold-s7r2-1`、13 variant、regime k64）

- 13 variant すべてが measured・valid で、窓の sampler も clean でした。
- **pool（9 variant、n＝270）**
  - 表示は 270、欠落は **0**（許容 2）です。
  - 内訳は first-render 244、follow-up 26 です。
  - 表示が 0 の variant はありません。
  - `contributedNotCounted` は 0 です。
  - first-render の候補は 244 で、数えられなかったものは 0 です。`firstRenderNotCountedReasons` は全 variant で空です。

| variant | first-render／follow-up |
|---|---|
| G-01/v1 | 30／0 |
| G-02/base | 28／2 |
| G-03/base | 30／0 |
| G-04/base | 25／5 |
| G-05/base | 29／1 |
| G-06/base | 30／0 |
| G-07/base | 12／18 |
| G-08/base-usable | 30／0 |
| G-08/graph-recovered | 30／0 |

- **窓外率（開示だけで、物差しではない）**
  - first-render の窓外率（K6/6）は 26／270（9.6%）です。
  - K6/2 の字義の窓外率は 270／270 です。
- **stamp の内訳（pool）**：`stamp0-missing` 266、`fresh` 4 です。`unavailable` は 0 です。
- **境界**：`boundaryDisagreement` は、pool で `not-joined-in-time` 0、`joined-late-within-tolerance` 0 です。
- **pool の外の 4 variant**：いずれも表示は 0／0／0 で、窓は clean です。
  - 対象は G-03/frontier-exceeded と、G-08 の graph-index-unusable、chronicle-index-unusable、both-indexes-unusable です。
- **startSlot**
  - pool の 9 variant の Graph arm は、すべて `empty` でした。
  - `G-03/frontier-exceeded` は 35 sample すべてが `graph-late` で、slot は `empty` でした。
  - `G-08/graph-index-unusable` は `registration-unavailable` が 35、`suspended` が 23 でした。これは s7r1 と同じ形で、index が使えない variant の想定どおりです。

### (b) 実際の操作の trace

| trace | K6/2 の読み（受領書の記録） | K6/4 の読み（再計算） |
|---|---|---|
| editing | 失効 0、窓外 16／201（超える） | 失効 0、窓外 0／201。first-render 185、follow-up 16 |
| browsing | 失効 0、窓外 152／201（超える） | 失効 0、窓外 0／201。first-render 49、follow-up 152 |

- 基準の再現（`recompute-trace-base.mjs`）は、受領書の要約と完全に一致しました。regime、Q、U、lapse、outcomes、mainReason、notApplied がすべて一致しています。
- K6/4 の再計算は、keep test を走らせて得た証拠に依ります。
  - 証拠：`candidate-test`、head `29a120dd`、8 件 pass、`runDigest 7adf240f…`、testFile の sha256 `2a642216…`。
  - keep test は、全 run の後、窓の外で走らせました。
- q1（親の return から Graph の到着まで）の max は、editing 48.5 ms、browsing 88.4 ms です。いずれも `T_late` 100 ms 以内です。
- C7 による除外（`i-chronicle-stop`）は 0 件で、C7 は働いていません。
- 境界（`boundaryDisagreement`）は、editing と browsing のどちらも `not-joined-in-time` が 1、`joined-late-within-tolerance` が 0 です。定常状態の pool は 0 です。
- 取り直しはありません。両 trace とも attempt 1 で、stall もありません。

### (c) SP-P4・parity・negative・G-01 診断

- SP-P4：passed。8 variant、差異 0、IR の期限切れ 0 です。
- parity：12 variant がすべて valid で、窓は clean です。
- negative：N2、N3、N4 はすべて measured・valid・established です。判定には数えません。
- G-01 診断（`g01-e2e-s7r2-1`）：end-to-end まで到達しました。head と束縛は一致しています。判定には数えません。

## 4. 規則の当てはめ（判定ではなく、規則が指す先）

- **規則は HOLD を指さず、`[precheck]` にも当たりません。** K6/4 の読み（trace は再計算）で、次の物差しはどれも超えていません。
  - (a) 定常状態の欠落は 0／270（許容 2）で、表示 0 の variant もありません。
  - (b) 窓外と失効は、editing と browsing のどちらも 0／201 です。
  - `contributedNotCounted` は 0 です。
- **読みへの依存は隠しません。**
  - K6/2 の読みでは、trace の窓外が editing 16、browsing 152 で物差しを超えます。定常状態の K6/2 の字義の窓外率も 270／270 です。
  - K6/4 の読みを当てたのは、前回と同じく、事前登録の規則 (2) が読み替えを定めているためです。
- 超えた物差しが無いことは、可用性の物差しの結果にすぎません。次のものの代わりにはなりません。
  - (i) 品質の判定（品質判定 v2）
  - (ii) S7 の報告と、ユーザーの受入れ
- 閾値、期待値、Gold、pool の選び方、失効の読み、K6/6 の値は変えていません。

## 5. 注意（開示）

1. **この候補での Gold は 1 回だけです。** 取り直しはありません。
   - 前回 s7r1 の Gold 2 回（`gold-s7r1-1` stopped と `gold-s7r1-2` completed）は、別の候補 `3f333a83` の試行です。
   - 台帳の key が (candidate, S4) なので、それらはこの run の台帳にも `priorAttempts.gold` にも自動では出ません。そこで `previousCandidateGoldDisclosure` に載せました（集計にも判定にも数えません）。
2. **「欠落 0」は K6/6 の数え方（R-7）の下の値です。**
   - pool の stamp は 266 件が `stamp0-missing` で、R-7 はこれを first-render に数えます。
   - 先払い（DR-DBC-6）は、主接続の Mutex を握る間、鮮度 stamp の `try_lock` を `None`（`unavailable`）にしえます。今回の pool の `unavailable` は 0 で、`FR3:stamp-*` による不算入も 0 でした。
3. **trace の K6/4 の再計算は、keep test の証拠に依ります。** この再現性の限界は s7r1 と同じです。
4. **前回の G-03/frontier-exceeded の連鎖は、今回は起きていません。**
   - 前回は Graph arm 35 sample のうち 30 が `registration-unavailable`、23 が `suspended` でした。今回はどちらも 0 です。
   - 期待の理由（`graph-limit-exceeded`）は、今回も出ていません（`limit` は 0）。この variant は pool に入らないので、欠落の結論には効きません。
5. **parity が通ったことは、Gold の worker が READY になる証拠ではありません。** parity は Graph arm を測らないためです。
6. **dev の測定は、この集計に入れていません。** 対象は prepay-impl-ab、outliers、dev 予行などで、いずれも凍結外の fixture です。
7. **受領書の読み先**
   - 受領書は `.artifacts/cp4/`（候補の worktree。読むだけ）から読みました。
   - 台帳は contracts の `attempts-final-s7r2/` から読みました。`.artifacts/cp4/attempts/` との byte 一致は script が確かめています。
   - G-01 の診断の記録は、contracts の `g01-e2e-s7r2-1/` と `g01-e2e-s7r2-1-report/` から読みました。
   - `.artifacts` の受領書 31 件（SP-P4 1、trace 2、parity 12、Gold 13、negative 3）は、contracts の写しと `cmp` で byte 一致しました。
   - 各 dir の `files.sha256` もすべて一致しました。
   - 台帳の開始時の sha256（`priorAttempts.thisAttempt.fileSha256AtStart`）は、parity、Gold、N2〜N4 で contracts の `attempts/<run>.json` と一致しました。
8. **実行環境**：Node v24.18.0（fnm の既定）で実行しました。同じ入力から 2 回実行し、`s6-aggregation.json` が byte 一致することを確かめています。

## 6. 前回（s7r1：同じ S4b・候補 `3f333a83`・K6/6）との比較

| 項目 | s7r1（`gold-s7r1-2`） | s7r2（`gold-s7r2-1`） |
|---|---|---|
| Gold の試行 | 2 回（1 回目は V-10 で停止） | 1 回 |
| pool の欠落／表示 | 0／270 | 0／270 |
| first-render／follow-up | 156／114 | 244／26 |
| first-render の窓外率（開示） | 42.2% | 9.6% |
| stamp（pool） | `stamp0-missing` 269・`fresh` 1 | `stamp0-missing` 266・`fresh` 4 |
| `contributedNotCounted` | 0 | 0 |
| editing の失効／窓外（K6/4） | 1／1（C7） | 0／0 |
| editing の first-render／follow-up | 23／177 | 185／16 |
| browsing の失効／窓外（K6/4） | 0／0 | 0／0 |
| browsing の first-render／follow-up | 3／198 | 49／152 |
| frontier-exceeded の `registration-unavailable`／`suspended` | 30／23 | 0／0 |
| Graph arm の p95（品質判定 v2） | 92.70 ms | 60.10 ms |

規則が指す先は、前回も今回も「HOLD に当たらない」です。

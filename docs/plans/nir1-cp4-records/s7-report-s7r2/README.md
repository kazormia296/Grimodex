# S7 報告（草稿）：CP-4 の Graph arm の評価（S4b f2f99b13・候補 `29a120dd`・K6/6、s7r2）

> **草稿です。ユーザーの受入れは済んでいません。** 2026-11-15 に、run の後の記録から作りました。形は `s7-report-s7r1/README.md` に合わせています。

## 記録の置き場

| 内容 | 場所（いずれも `nir1-cp4-records/` の下） |
|---|---|
| 測定の記録 | `sp-p4-s7r2-1/`、`traces-s7r2-1/`、`parity-s7r2-1/`、`gold-s7r2-1/`、`negatives-s7r2-1/`、`g01-e2e-s7r2-1/`、`attempts-final-s7r2/`、`setups-s7r2/` |
| 実施記録 | `s7r2-run-record.md` |
| 集計 | `s6-aggregation-s7r2/` |
| 品質の判定（補助） | `quality-verdict-s7r2-1/` |
| 前回の報告 | `s7-report-s7r1/` |

**今回は、S4b も契約（K6/6）も前回と同じです。違うのは候補（製品）だけです。** そのため、前回との比較は同じ物差しでの比較になります。

## 1. 結論

**事前登録の規則を当てた結果は、HOLD にも `[precheck]` にも当たりません。** Gold の定常状態の pool の欠落は 0／270 で、許容は 2 件です。

ただし、「CP-4 の Graph arm は可用性を満たした」と言い切る前に、3 の条件を読んでください（K6/6 の数え方への依存など）。

受入れは 2 つに分けます。

1. **規則の当てはめ結果の記録**：integrator の技術判断です（DR-CP4-S6-6 の案。前例は DR-CP4-S6-2〜S6-4）。
2. **「可用性を満たした」の確定**：K6/2 の 621 行の「受入れへの影響」（Lane unlocked）の発効を含みます。**ユーザー本人の 1 行確認に残します**（5 を参照）。

| 指標（K6/4 の読み） | 前回（s7r1、候補 `3f333a83`） | 今回（s7r2、候補 `29a120dd`） | 物差し |
|---|---|---|---|
| (a) Gold の pool の欠落 | 0／270（first-render 156、follow-up 114） | **0／270**（first-render 244、follow-up 26） | 2 件（floor(0.01×270)） |
| 表示が 0／30 の variant | 0 | 0 | K6/4:167 |
| `contributedNotCounted` | 0 | 0 | 0（超えると品質が FAIL） |
| (b) 編集 trace の失効 | 1／201（`i-chronicle-stop`＝C7） | **0／201** | 1%（許容 2 件） |
| (b) 編集 trace の窓外 | 1／201 | **0／201** | 2 件 |
| (b) 閲覧 trace | 失効 0、窓外 0 | 失効 0、窓外 0 | — |
| q1 の max（editing／browsing） | 50.7／83.1 ms | 48.5／88.4 ms | `T_late` 100 ms |
| ④ SP-P4／parity | passed／12 variant valid | passed（差異 0、IR の期限切れ 0）／12 variant valid、窓 clean | — |
| 負例 N2／N3／N4（判定に数えない） | すべて established | すべて measured・valid・established | — |
| 品質の判定（補助） | hold（unverified-required-items） | hold（unverified-required-items）。fail と hold の条件は無い | — |
| Hybrid p95（R+IR arm／Graph arm、上限 94.2 ms） | 22.60／92.70 ms（余裕 1.5 ms） | 26.10／**60.10 ms**（**余裕 34.1 ms**） | pass |
| **規則が指す先** | HOLD に当たらない | **HOLD にも `[precheck]` にも当たらない** | — |

**Graph arm の p95 の余裕は、1.5 ms から 34.1 ms に広がりました。**

- nearest-rank で 60.10 ms、線形補間で 60.05 ms です。
- 上位 20 件は 60.1〜64.1 ms で、75 ms 以上の sample は 0 件です（前回の上位 20 件は 92.7〜116.5 ms）。
- variant 別の p95（開示用）の最大は 63.8 ms（G-03/frontier-exceeded）です。94.2 ms を超える variant はありません。

**前回の Gold の中で起きていた V-10 の根の連鎖は、今回は起きていません。**

- 対象は判定外の variant `G-03/frontier-exceeded` です。
- 前回は、Graph arm 35 sample のうち 30 が `registration-unavailable`、23 が `suspended` でした。
- 今回は 35 sample すべてが `graph-late` で、slot は `empty` でした。pool の 9 variant の slot も、すべて `empty` です。

## 2. 測ったもの

- S4b `f2f99b13e18bcf4dd84ff6778de56189a3e1ef9b`、候補 `29a120ddd3dd8ec5a43845a76cbda837e9b20f6a`。
- 台帳は 8 件で、すべて completed です。

| run | 所要 | 前回の所要（参考） |
|---|---|---|
| SP-P4 | 1.8 分 | 1.8 分 |
| trace editing | 15.6 分 | 10.5 分 |
| trace browsing | 5.2 分 | 3.7 分 |
| parity | 7.2 分 | 7.2 分 |
| Gold（`gold-s7r2-1`、1 回目で 13 variant すべて completed） | 44.5 分 | 46.9 分（取り直しの 2 回目） |
| N2／N3／N4 | 2.4／2.3／2.5 分 | 各 2.3〜2.4 分 |
| G-01 の e2e 診断 | exit 0 | — |

- 時刻と経緯は `s7r2-run-record.md` にあります。
- 台帳はすべて `(f2f99b13…, 29a120dd…)` です。
- 受領書 31 件（SP-P4 1、Gold 13、parity 12、negative 3、trace 2）は、すべて K6/6 の束縛に一致しました（S6 の script が確認）。
- 集計の対象は、completed の 8 件すべてです。

## 3. 言えること、言えないこと

### 言えること

- **Gold の定常状態**
  - K6/6 の数え方の下で、pool の 270 sample はすべて表示されました（first-render 244、follow-up 26）。
  - 欠落は 0、`contributedNotCounted` は 0、表示が 0 の variant はありません。
  - first-render の候補 244 は、すべて first-render に数えられました。`firstRenderNotCountedReasons` は全 variant で空です。
- **trace**
  - editing と browsing のどちらも、失効 0、窓外 0（K6/4 の読み）でした。
  - `T_late` の超過はありません。
  - C7 による除外は 0 件で、C7 は働いていません。
- **ほかの run**
  - SP-P4 は passed、parity は 12 variant が valid、N2〜N4 は established でした。
  - G-01 の診断は end-to-end まで到達しました（判定外）。
- **品質の判定（補助）**
  - G-01 の事前指定改善、macro 非回帰（G-case 13 variant）、Hybrid p95、edge の束縛、禁止寄与の (a)(b) は、すべて pass でした。

### 言えないこと、読み方の条件

- **「欠落 0」は K6/6 の数え方に依存します。**
  - pool の stamp は、`stamp0-missing` が 266、`fresh` が 4、`unavailable` が 0 でした。R-7 は `stamp0-missing` を数えます。
  - K6/2 の字義のまま読むと、窓外は 270／270 で、HOLD に当たります。
  - first-render の窓外率は 26／270（9.6%）です（前回は 114／270、42.2%）。これは開示だけで、物差しではありません。
- **WAL の先払いは、stamp の `unavailable` を生む可能性がありました。** 今回の正式 run では、`unavailable` は 0、`FR3:stamp-*` も 0 でした。ただし、一度測っただけです。
- **Gold を測ったのは、この候補では 1 回だけです。** 前回の V-10 は確率的でした。今回 1 回通ったことは、V-10 が起きないことの証明にはなりません。
- **p95 が下がった理由は、確かめていません。**
  - 候補には、WAL の restart の先払い（DR-DBC-6）を含む 69 commit が入っています。
  - dev（凍結外）で見た外れ値（WAL header の fsync、約 45 ms）が消えた形とは合います。
  - ただし、正式 run の中で機構は確かめていません。ほかの commit の効果とも切り分けていません。
  - R+IR arm は 22.60 → 26.10 ms と上がりました。上限の範囲内ですが、理由は確かめていません。
- **`G-03/frontier-exceeded` が期待の理由（`graph-limit-exceeded`）で unavailable になったかは、今回も言えません**（`limit` は 0）。
  - この variant は pool に入らないので、欠落の結論には効きません。
  - frontier の上限の端から端の検査は、PUB-G の前提に載せてあります。
- **品質の判定の not-evaluable は、今回も測れていません。**
  - 対象は、既存 24 件の Graph arm の受領書、evidence の 4 項目、禁止寄与の (c) です。
  - S4b を再凍結していないので、受領書の形は前回と同じです。
  - そのため、品質の「Recall・nDCG の改善」を、24 件の P についても言うことはできません。
- **製品の退行が無いことは、受領書の範囲の形跡にすぎず、証明ではありません。**
- **受領書には、sample 単位の FR-1〜FR-8 の内訳がありません。** 前回と同じ形です。判定には効きません。

## 4. 前回（s7r1）との比較

契約（K6/6）も S4b も同じなので、同じ物差しでの比較です。製品は、前回の候補 `3f333a83` から 69 commit 進んでいます（`s7r2-run-record.md` の開示 3）。**候補の違いのうち何が効いたかは、この 2 回の run からは言えません。**

| 指標 | s7r1（候補 `3f333a83`） | s7r2（候補 `29a120dd`） |
|---|---|---|
| Gold の pool の欠落／表示 | 0／270 | 0／270 |
| Gold で窓内に合流した親の数（first-render） | 156／270 | 244／270 |
| first-render の窓外率（K6/6、開示） | 114／270（42.2%） | 26／270（9.6%） |
| K6/2 の字義の窓外率（pool、開示） | 270／270 | 270／270 |
| stamp の内訳（pool） | `stamp0-missing` 269、`fresh` 1 | `stamp0-missing` 266、`fresh` 4 |
| editing の first-render／follow-up（K6/4） | 23／177 | 185／16 |
| browsing の first-render／follow-up | 3／198 | 49／152 |
| editing の失効 | 1（`i-chronicle-stop`、C7） | 0 |
| K6/2 の読みの窓外（editing／browsing） | 178／198 | 16／152 |
| q1 の max（editing／browsing） | 50.7／83.1 ms | 48.5／88.4 ms |
| p95（R+IR arm／Graph arm、nearest-rank） | 22.60／92.70 ms | 26.10／60.10 ms |
| variant 別の p95 が 94.2 ms を超えたもの | G-04 116.5、G-02 108.3、G-07 100.8、G-05 100.3 | なし（最大 63.8） |
| `G-03/frontier-exceeded` の `registration-unavailable`／`suspended` | 30／23 | 0／0 |
| 品質の判定（補助）の全体 | hold（unverified-required-items） | hold（unverified-required-items） |
| Gold の run | 2 回（1 回目は V-10 で stopped） | 1 回 |
| 規則が指す先 | HOLD にも `[precheck]` にも当たらない | 同じ |

**読み方**

- Graph の結果が窓内に届く割合が、Gold でも trace でも大きく上がりました。
- p95 の余裕も広がりました。
- これらを製品の変更と結びつけるのは、dev の測定の範囲までです。dev の測定は、凍結外の fixture と一時 DB で行ったものです。

## 5. 決めたことと、ユーザーに残すこと

### 決めたこと（integrator の技術判断。DR-CP4-S6-6 の案として記録する）

- 規則の当てはめの結果：HOLD にも `[precheck]` にも当たりません。
- 集計の Gold は `gold-s7r2-1` です（取り直しはありません）。
- trace は K6/4 の読みへ再計算しました。前例と同じ扱いです。
- 判定外の variant（`G-03/frontier-exceeded`、G-08 の 3 つ）は、前回と同じ扱いです。

### ユーザーに決めてほしいこと

**1. 「CP-4 の Graph arm は可用性を満たした」を、今回の候補と結果で確定するか**

これには、K6/2 の 621 行の「受入れへの影響」（Lane unlocked、編集中の可用性を合否から外す緩和）の発効が含まれます。

- 前回の回答：「確定する（推奨）」（2026-11-09T03:10:38Z）。ただし、これは s7r1 の結果に対する回答です。
- 今回の論点：前回の回答を、今回の候補 `29a120dd` と今回の結果にも当てはめてよいか。1 行の確認をお願いします。
- この確定は、製品の公開（Graph の published 化）や PUB-G の承認ではありません。

**2. 品質判定の not-evaluable**

- 確認済み：2026-11-15 に「凍結はそのまま」が選ばれ、not-evaluable の受領書の拡張は、PR-3 と一緒に次の S4（9 回目）で 1 回にまとめることになりました。
- そのため、今回は改めて伺いません。
- 次の S4 の進め方は、PR-3 の質問（Q5〜Q7）と一緒に伺います。

**3. (g)（LP-GATE を維持の cycle にも広げる）**

- 前回の条件：dev で (c)+(f) が足りないと分かったときだけ、1 行確認の後に着手する。
- 材料
  - (c) に当たる DR-MP-8（#859）と、(f) に当たる DR-MPS-15（#843）は、候補に入っています。
  - DR-MPS-15 の dev の A/B は a2 型で 3/3 でした。
  - 今回の正式 run の Gold でも、Suspended の連鎖は起きていません。
- integrator の読み：**(g) は今は不要**です。
- この読みで閉じてよいかを、1 の確認と一緒に伺います。

**4. PUB-G #15：s7r2 の合格を、PR-3 の後の候補に持ち越せるか**

- PR-3 の質問の Q7 として、別に伺います。

### 確認済み

- 2026-11-15 の決定（AskUserQuestion）
  - 「凍結はそのまま (Recommended)」
  - 「準備でき次第すぐ (Recommended)」
  - 「外れ値を先に調べる (Recommended)」
  - 「製品：背景が先払い (Recommended)」
  - DR-DBC-1 の改訂「認める。形は任せる (Recommended)」
- 今回の結果に対する回答は、まだありません。

## 6. 開示（必須）

1. **K6/6 の下での 2 回目の正式の測定です。** S4b、契約、harness は s7r1 と同じで、違うのは候補だけです。
   - first-render の数え方（R-6・R-7）は、s7r1 の前に確定した契約で、今回の測定でも変えていません。
   - s7r1 の開示（K6/6 の起案の前に s6r1 の結果を見ていたこと、品質判定 v2 の D2・D3 の緩和など）は、そのまま有効です。`s7-report-s7r1/README.md` の 6 の 1 を参照してください。
   - s7r1 の受領書は、今回の判定には使っていません。
2. **Gold の回数は、今回 1 回です。**
   - 前回 s7r1 の Gold 2 回（`gold-s7r1-1` は V-10 で stopped、`gold-s7r1-2` は completed）は、別の候補での試行です。
   - 台帳の key が (candidate, S4) なので、それらはこの run の台帳にも `priorAttempts.gold` にも自動では出ません。
   - そこで `s7r2-run-record.md` で開示し、S6 の `previousCandidateGoldDisclosure` にも載せました。
3. **欠落は K6/6 の数え方に依存します**（3 を参照）。K6/2 の字義では、窓外は 270／270 です。
4. **trace の読み**
   - 受領書（K6/2 の読み）の窓外は、editing 16／201、browsing 152／201 で、物差しを超えます。
   - K6/4 の読みへの再計算は、前回と同じく integrator の技術判断です。keep test の証拠（`candidate-test`、候補 `29a120dd`、8 件 pass）に依ります。
   - 基準の再現（`recompute-trace-base`）は、記録済みの要約と一致しました。
5. **R5 は再利用しました。**
   - R5 の記録（`56d4ec54`、確認 `82119012`）をそのまま使いました。
   - 候補 `29a120dd` には、R5 の記録の後に merge した製品変更が、s7r1 の候補よりもさらに多く入っています。
6. **pin の外で差分がある file が 10 個あります。** 一覧は `s7r2-run-record.md` の開示 1 にあります。
   - S2 の pin は 94 件とも一致しています。
   - harness は、`f2f99b13` から候補まで差分 0 です。
7. **WAL の restart の先払い（DR-DBC-6、PR #909）**
   - 正式 run での stamp の `unavailable` は 0 でした。
   - Graph arm の p95 は、92.70 ms から 60.10 ms に下がりました。
   - 機構は確かめていません（3 を参照）。
8. **候補に入った製品の変更の一覧**は、`s7r2-run-record.md` の開示 3 にあります。
9. **S4b は s7r1 と同一です**（再凍結していません）。そのため、受領書の形は前回と同じです。
10. **G-01 の診断は判定外です**（`countsInCaseJudgement: false`、別 session）。結果は end-to-end まで到達し、束縛も一致しました。
11. **品質の判定は補助です。** S6 の規則を置き換えません。p95 は nearest-rank です。
12. **記録の欠けはありません。** `setups-s7r2/` と `g01-e2e-s7r2-1-report/` にも `files.sha256` を作りました。
13. **窓**
    - Gold、parity、negative は、全 variant で窓 true でした。SP-P4 と trace は、設計上 sampler の記録を持ちません。
    - dev の HDD の測定は、窓より前に終わっていました。
14. **dev の測定は CP-4 の結果に数えていません。** dev の予行、dev の診断、dev の確認（先払いの A/B を含む）が対象です。
15. **この報告は、製品の公開について何も決めません。** `PRODUCT_GRAPH_PUBLISHED` は false のままです。
16. **S6 の script は書き換えました。** s7r1 の script を写して、既定を Gold 1 回・台帳 8 件にしました（`s6-aggregation-s7r2/CHANGES.md`）。
    - `[precheck]` では止まりませんでした。
    - 2 回実行して、出力が byte 一致することを確かめました。

## 7. 次

1. ユーザーの 1 行確認：5 の 1 と 3。
2. DR-CP4-S6-6（判断記録）の docs PR。
3. PR-3（DB 段 1、stamp の削除）の質問（Q2〜Q4、その後 Q5〜Q7）。
4. PUB-G の前提一覧（#5・#24・#11、frontier の端から端の検査）。
5. 片付け：dev の worktree（cp4-dev-ratio の A、B、M、P）と cargo target、先払いの worktree。

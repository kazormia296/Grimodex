# CP-4 品質の判定（s7r2。S4b `f2f99b13`・候補 `29a120dd`・K6/6・品質判定 v2）

手順外の補助の記録です。正式の判定ではなく、それを置き換えません。

- 根拠：DR-CP4-QV-0・QV-1 と品質判定 v2（`../quality-verdict-prereg-v2.md`）。確定版は commit `8b2a5dafc22bd344f7572b4adbfb3018f7363245`、実装は `7652a86e2252eec55a22143921c33f81a481e48c` です。
- S2・S4 の bytes、閾値、Gold、fixture、受領書は変えていません。
- S6 の集計は `../s6-aggregation-s7r2/` にあります。

## 実行

- command：`quality-verdict-cli.mjs --root <候補の worktree cp4-formal-s7r2> --v2-file ../quality-verdict-prereg-v2.md --v2-commit 8b2a5daf… --impl-commit 7652a86e… --remote-time-record remote-time-record.json --sp-p4-dir ../sp-p4-s7r2-1 --trace-dir ../traces-s7r2-1 --parity-dir ../parity-s7r2-1 --gold-dir ../gold-s7r2-1 --negative-dir ../negatives-s7r2-1 --g01-diagnostic-dir ../g01-e2e-s7r2-1 --allow-list allow-list-s7r2-s4-f2f99b13-candidate-29a120dd.json --ledger ../attempts-final-s7r2/gold-s7r2-1.json`
- Node 22 で実行しました。`--verify` の結果は `bindings match` です。
- **Gold は `gold-s7r2-1`（1 回目、13 variant）を読みます。** 取り直しはありません。台帳は 8 件で、すべて completed です。

## v2 §0（remote 時刻）

- `remote-time-record.json` は s7r1 のものと同じ bytes です。
  - v2 確定版 `8b2a5daf` の push は 2026-11-08T10:49:28Z です。
  - 実装 `7652a86e` の push は 10:47:05Z です。
- どちらも今回の最初の正式 run（SP-P4 の開始、2026-11-15T09:34Z）より前です。

## 全体：**hold（unverified-required-items）**

前回 s7r1 と同じ verdict です。fail と hold の条件はありません。残るのは、受領書に無い項目の not-evaluable だけです。

- 既存 24 件の Graph arm の受領書がありません。
- evidence の utf16-range、explicit-pin-association、raw-excerpt-unchanged、added-scene-body-anchor が受領書にありません。
- 禁止寄与の (c) が受領書にありません。

内訳は `quality-verdict-s7r2.md` にあります。

### 条件ごとの結果

| 条件 | 結果 |
|---|---|
| G-01 の事前指定改善 | pass |
| macro 非回帰（G-case 13 variant） | pass |
| Hybrid p95 | pass。R+IR arm 26.10 ms、Graph arm **60.10 ms**（各 n＝390、上限 94.2 ms）。**余裕は 34.1 ms**（前回は 1.5 ms） |
| edge の束縛 | pass（9 variant、検査 270、検査できず 0） |
| 禁止寄与の (a)・(b) | pass（違反 0） |

### p95 の詳細

- Graph arm の p95 は、前回 s7r1 の 92.70 ms から 60.10 ms に下がりました。
  - nearest-rank（ceil(0.95n)）で 60.10 ms、線形補間でも 60.05 ms です。
  - 上位 20 件は 60.1〜64.1 ms に収まっています。前回は 92.7〜116.5 ms でした。
  - 75 ms 以上の sample は 0 件です。
- variant 別の p95（開示用）の最大は G-03/frontier-exceeded の 63.8 ms です。94.2 ms を超える variant はありません。
  - 前回は G-04/base 116.5、G-02/base 108.3、G-07/base 100.8、G-05/base 100.3 ms が上限を超えていました。
- 候補には WAL の restart の先払い（DR-DBC-6、#909）が入っています。dev で見た外れ値（WAL header の fsync、約 45 ms）が消えた形と合います。
  - ただし、正式 run の中で機構を確かめてはいません。
- R+IR arm は 22.60 → 26.10 ms と上がりました。上限には関係しない範囲です。機構は確かめていません。

### `G-03/frontier-exceeded`

- 表示は 0／0／0 で、期待（unavailable）と合います。
- 今回の Graph arm 35 sample は、すべて `graph-late` で、startSlot はすべて `empty` でした。
  - 前回の Suspended の連鎖（`registration-unavailable` 30、`suspended` 23）は起きていません。
- 期待の理由（`graph-limit-exceeded`）は、今回も出ていません。
  - この判定は `expectedGraph === "unavailable"` だけを見て、reasonClass を見ません（`quality-verdict.mjs:519`）。

## 注意

この判定は S6 の可用性の集計とは別の補助です。S6 の規則を置き換えません。

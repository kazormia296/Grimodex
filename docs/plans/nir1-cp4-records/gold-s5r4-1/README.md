# ⑤ Gold（S4b''・候補 `86427ee5`、run `gold-s5r4-1`）の記録

2026-11-01（UTC）に integrator が実行した、CP-4 の ⑤ の Gold（`--run-kind gold`、`d2aMode: restricted`、arm は hybrid と graph の両方）。④ SP-P4（`sp-p4-s5r4-1`、passed）、⑤ trace（`trace-*-s5r4-1`）、⑤ parity（`parity-s5r4-1`、completed）の後に、同じ候補・同じ S4b''（`557e683c`）で取った。**この記録は測定の記録で、case の判定（pass、hold）ではない**（判定は S6 の集計）。

## 結果

- **台帳 `attempts/gold-s5r4-1.json`：status `completed`**（attempt 1）。開始 2026-11-01T00:51:05Z、終了 01:25:56Z（command は 00:51:02Z〜01:25:56Z）。`run-report.json` の `problems` は空。
- 13 variant（G-01/v1、G-02/base、G-03/base、G-03/frontier-exceeded、G-04/base、G-05/base、G-06/base、G-07/base、G-08/{base-usable、graph-index-unusable、graph-recovered、chronicle-index-unusable、both-indexes-unusable}）がすべて `measured`・`valid: true`・blocked／error 無し・verdict `recorded`。各 variant は hybrid 35 sample と graph 35 sample（warm-up 5、measured 30）、`requeryCount` 0。`validation` は 13 件とも `valid: true`（`errors` 空）、受領書の `aggregates.invalid` は空。**L-27 による無効化（`started without a usable snapshot`）は起きていない**。
- gate：`checks.spP4.summary` は passed（`sp-p4-s5r4-1`）、`checks.parity.used` は `parity-s5r4-1`（完了 1 件、`fileSha256` `84802f85…`）、`checks.seedPinGate.status` は `match`（R5）、`priorAttempts.gold` は空（この候補と S4 の Gold の 1 回目）、`thisAttempt.fileSha256AtStart` は `422a58c1406deaef1d425e05d80311b1ffdd48be78d773fecc98d470fcc7e9e8` で、contracts に写した開始時の台帳（`0c4018e0`）と同じ。
- 台帳の sha256：開始時 `422a58c1406deaef1d425e05d80311b1ffdd48be78d773fecc98d470fcc7e9e8`、終了後 `ce5a4f6abad9bd21eb32c1034c1f3a00a2b7741f4731f1b2a2f64a7d8d518b15`。`run-report.json` の sha256 `977d54edf20c0f9a987f083b24bd5f166d4ad2f4d4d883606d90a72efe4f3100`。variant ごとの受領書・validation の sha256 は `receipts.sha256`。

## 観測の分布（解釈しない。S6 の集計の入力）

hybrid arm の IR は、使える 11 variant の全 sample で `ir-ready`、Chronicle の Index が使えない G-08/chronicle-index-unusable と G-08/both-indexes-unusable は全 sample で `index-unavailable`（構成のとおり）。**IR の期限切れ（`timeout`）は、warm-up を含む全 sample で 0 件**。

graph arm の measured 390 件（13 variant × 30。全件 `status: completed`）：

| variant | `freshnessStamp.result` | `graph.outcome` |
|---|---|---|
| G-01/v1、G-02〜G-07 の base（G-03/frontier-exceeded を含む）、G-08/base-usable、G-08/graph-recovered | `stamp0-missing` 30 | `graph-late` 30 |
| G-08/graph-index-unusable | なし 30 | `graph-unavailable` 28、`graph-late` 2 |
| G-08/chronicle-index-unusable | `stamp0-missing` 30 | `graph-unavailable` 30 |
| G-08/both-indexes-unusable | なし 30 | `graph-unavailable` 30 |

合計：`stamp0-missing` 330、なし 60。`graph-late` 302、`graph-unavailable` 88。snapshot が usable だった sample は 362、usable でなかった sample は 28（すべて G-08/graph-index-unusable で、`reason` は `registration-unavailable`、`graph.outcome` は `graph-unavailable`。同 variant の残り 2 件は usable で `graph-late`）。

- `steadyStateCase` は 13 variant とも `inWindow` 0、`outOfWindow` 30（`outOfWindowRate` 1）、`notReadyAtStart` 30、`stampMismatch` 30。`stampWithoutComparison` は 30（G-08/graph-index-unusable と G-08/both-indexes-unusable は 0）。`inPool` は 9 variant で true、G-03/frontier-exceeded、G-08/{graph-index-unusable、chronicle-index-unusable、both-indexes-unusable} で false（`qualityHold` も同じ 4 variant で false）。K6/4 の `violations` は全 variant で空。`x` の非 0 は G-04/base の `X5` 30 件だけ。
- Graph が window に間に合う（`graph-ready`）sample は無い。これは測定の結果として記録するだけで、case の判定には使っていない（判定は S6）。
- **前回の旧 S4b' の下の Gold（`gold-s5r3-1`、候補 `0b1984dd`）との差**：`stamp0-missing` が 329 + `fresh` 1（G-03/frontier-exceeded の 1 件）から 330 + `fresh` 0 に、他の分布（`graph-late` 302、`graph-unavailable` 88）は同じ。旧 S4b' の下の観測は S6 の集計と S7 の判定に入れない（`s4-revocation-9f52e7da-2026-11-01.md`）。

## 条件

- 候補 `86427ee53a73e669e34631c5774fbd56960ac050`（tree `5ed0204d363c52659dcd072d46ef5c693be0722c`、clean）、`--prep-commit 557e683c…`、`--k62-commit af643a93…`、`--k64-commit 5dea38af…`、`--keep-test-worktree` は候補の worktree、`--sp-p4-receipt` は `sp-p4-s5r4-1/sp-p4-receipt.json`。標準 build・評価 build・13 setup は `sp-p4-s5r4-1/README.md` のとおり（同じもの）。
- 機械：開始前に `wait-quiet.sh 3` が 3 回連続の静けさを確認した（parity の終了の約 1 分後に開始）。窓の sampler（約 20 秒間隔）の記録が受領書の `environment.windowSamples` にあり、13 件（13 variant）の `windowAssessment` は全件 `clean: true`（違反 0・欠け 0）。sample 118 件で `otherMeasurements` と `buildProcesses` は常に空、`sameWorktreeBuild` は 0 件、`heavySlotsInUse` の最大は 0、lock は常に読めた。1 分 load average の最大は 2.85（run 自身の Electron を含む）、CPU の PSI（some avg10）の最大は 0.36%。`environment.x11` は run の前後で X socket が増減していない（新しい entry 0 件）。（run の後の Xvfb・electron の残りの確認は、negative の後に行った。`negatives-s5r4-1/README.md`。）

## 次

- negative（K24-G01-N2／N3／N4、`--run-kind negative --negative <id>`、G-01/v1 だけ）→ S6 の集計（`s4Commit` を S4b'' だけに限る許可リスト）→ S7。

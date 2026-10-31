# ⑤ Gold（新候補 `0b1984dd`、run `gold-s5r3-1`）の記録

2026-10-31（UTC）に integrator が実行した、CP-4 の ⑤ の Gold（`--run-kind gold`、`d2aMode: restricted`、arm は hybrid と graph の両方）。④ SP-P4（`sp-p4-s5r3-1`、passed）と ⑤ parity（`parity-s5r3-1`、completed）の後に、同じ候補・同じ S4b' で取った。**この記録は測定の記録で、case の判定（pass、hold）ではない**（判定は S6 の集計）。

## 結果

- **台帳 `attempts/gold-s5r3-1.json`: status `completed`**。開始 2026-10-31T11:29:15Z、終了 12:04:37Z（command は 11:29:11Z〜12:04:37Z）。`run-report.json` の `problems` は空。
- 13 variant（G-01/v1、G-02/base、G-03/base、G-03/frontier-exceeded、G-04/base、G-05/base、G-06/base、G-07/base、G-08/{base-usable、graph-index-unusable、graph-recovered、chronicle-index-unusable、both-indexes-unusable}）がすべて `measured`・`valid: true`・blocked 無し・verdict `recorded`。各 variant は hybrid 35 sample と graph 35 sample（warm-up 5、measured 30）、`requeryCount` 0。`validation` はすべて `valid: true`（`errors` 空）。**L-27 による無効化（`started without a usable snapshot`）は起きなかった**ので、Gold の取り直しは不要だった。
- gate：`checks.spP4.summary` は passed（`sp-p4-s5r3-1`）、`checks.parity.used` は `parity-s5r3-1`（完了 1 件、`fileSha256` `571b2497…`）、`checks.seedPinGate.status` は `match`（R5）、`priorAttempts.gold` は空（この候補と S4 の Gold の 1 回目）、`thisAttempt.fileSha256AtStart` は `341c08261ec92f8dd321de4bdff27670a223099e15712e0d82bf45977f6704f7` で、contracts に写した開始時の台帳（`66bc3f72`）と同じ。
- 台帳の sha256：開始時 `341c08261ec92f8dd321de4bdff27670a223099e15712e0d82bf45977f6704f7`、終了後 `4b56ebbe5236038b84f97afcd0937b23b6ed2a69cb8e86c79065162e86659e87`。`run-report.json` の sha256 `a3f85b117115e0b070f33bf24fbcb8ba60ea0d3d0185603e6031fa6e1f7220af`。variant ごとの受領書の sha256 は `receipts.sha256`（`<variant>.receipt.json`、`<variant>.validation.json`）。

## 観測の分布（解釈しない。S6 の集計の入力）

hybrid arm の IR は、使える 11 variant の全 sample で `ir-ready`、Chronicle の Index が使えない G-08/chronicle-index-unusable と G-08/both-indexes-unusable は全 sample で `index-unavailable`（構成のとおり）。**IR の期限切れ（`timeout`）は 0 件**。

graph arm の measured 390 件（13 variant × 30）：

| variant | `freshnessStamp.result` | `graph.outcome` |
|---|---|---|
| G-01/v1、G-02〜G-07 の base、G-08/base-usable、G-08/graph-recovered | `stamp0-missing` 30（G-03/frontier-exceeded だけ 29 と `fresh` 1） | `graph-late` 30 |
| G-08/graph-index-unusable | なし 30 | `graph-unavailable` 28、`graph-late` 2 |
| G-08/chronicle-index-unusable | `stamp0-missing` 30 | `graph-unavailable` 30 |
| G-08/both-indexes-unusable | なし 30 | `graph-unavailable` 30 |

合計：`stamp0-missing` 329、`fresh` 1、なし 60。`graph-late` 302、`graph-unavailable` 88。

- **DR-CP4-V-1（IR の経路の短縮、#768）が未測定としていた「seed 付き request の `stamp0_missing`」の観測**。`stamp0-missing` はほぼ全 sample（329/330）で、Graph の答えは Raw が準備できてから約 20〜24 ms 後、native の worker は約 37 ms で決着する（例：G-06/base の 1 件目、`graphAnswerAfterRawReadyMs` 24.2、`nativeWorkerMs` 37.5）。window は D = 10.84 ms。
- **#768 の前から同じ性質である**：`cp4-decisions.md` の CQ-DEFER の D′ の測定（受渡しから query の 2 つ目の stamp の試みまで p50 24.9／p90 26.0 ms、決着まで p50 30.0 ms）は、`stamp0Missing` が 30/30 で、原因を「S0 の try-lock が毎回失敗。DR-CQD の §7.4 の IR scoring の読取との重なりと見られる」と記している。今回の 329/330 は、その値と同じ向きで、**P2／P3 で悪化した形跡はない**。ただし D′ の測定は debug の Native test binary で、harness も違うので、同条件の A/B ではない（#768 の前の候補で同じ Gold を取っていないため、厳密な前後比較はできない）。
- Graph が window に間に合う（`graph-ready`）sample は無い。これは測定の結果として記録するだけで、case の判定には使っていない（判定は S6）。

## 条件

- 候補 `0b1984dd68ec132aea394664e2ba61759e1e2830`（tree `900ba98b…`、clean）、`--prep-commit 9f52e7da…`、`--k62-commit af643a93…`、`--k64-commit 5dea38af…`、`--keep-test-worktree` は候補の worktree、`--sp-p4-receipt` は `sp-p4-s5r3-1/sp-p4-receipt.json`。標準 build・評価 build・13 setup は `sp-p4-s5r3-1/README.md` のとおり（同じもの）。
- 機械：開始前に `wait-quiet.sh` が 3 回連続の静けさを確認し、ユーザーはブラウザを閉じていた。run の後に `/tmp/.X11-unix` は X0・X1 のみ、Xvfb の残りは無い。この run は窓の sampler を持たず、測定中の他の process の記録は無い。

## 次

- negative（K24-G01-N2／N3／N4、`--run-kind negative --negative <id>`、G-01/v1 だけ）→ trace → S6 の集計（`s4Commit=b7d74950` を除く）→ S7。

# K6/4 の分類器の Negative（K6/4-N1〜N40）の合成の記録による検出力の記録

K6/4「受入れ」の「CP-4 の分類器は、合成の記録（実 run の記録を複製し、通知、counter、begin の記録、子の outcome、時刻を書き換えたもの）で Negative のそれぞれを期待どおりに分けることを、観測の前に示して記録する」に対する記録。**Graph の実行出力を一つも見ずに**（runtime を起動しない node の試験だけで）取った。

- 実行日：2026-10-27（K6/4 の凍結 `5dea38af` の後、条件の判定に使う run の前）。
- 候補：origin/master `9e1a564efe5d7ac9d72d3c4008a6d9677b2b6d6f`（tree `9eea09f6d731d82ce4a7ee4af3e3f92719929d79`。K6/4 の道具 P1〜P4 と T14〔`K64_FREEZE.freezeCommit` の固定〕を含む）。clean な worktree（detach）。
- command：`node --test --test-reporter=tap scripts/quality/nir1-graph-eval/*.test.mjs`。結果：**353 件、pass 353、fail 0、skipped 0**。TAP の出力の sha256 `21087937f012825f31130a9fd81af4f670cea036416c7c6a6cf5370dfd0438b0`。
- K6/4-N1〜N40 のすべてが、少なくとも 1 件の合成の記録の試験の題に現れ、すべて pass（下の表。`件` はその N を題に持つ試験の数）。
- 検出力の確認：統合 branch の各段で、これらの試験の期待を変える変異（分類の入替、判定の削除、閾値の変更など）を当て、試験が落ちることを確かめた（記録は `docs/plans/nir1-lane-decisions/cp4-decisions.md` の DR-CP4-K64-*、H-*、F-*、G-*、R-*、I-*、J-*、K-7、T14-* の変異の節。例：S1i／S1j で 24 件、S1e のハードニングで 33/34、T14 で 10 件）。この記録のための変異は新たに当てていない。
- この候補以後に分類器（`followup.mjs`、`outcome.mjs`、`availability.mjs`、`window.mjs`、`receipt.mjs`）を変えたら、この記録は新しい候補では無効で、取り直す。S1j-2 と (b) trace runner の PR が master に入ったら、その候補で取り直す。

| 番号 | 試験 file | 件 | 結果 |
|---|---|---|---|
| N1 | followup.test.mjs | 2 | pass |
| N2 | followup.test.mjs | 1 | pass |
| N3 | followup.test.mjs | 1 | pass |
| N4 | followup.test.mjs | 1 | pass |
| N5 | followup.test.mjs | 1 | pass |
| N6 | followup.test.mjs | 1 | pass |
| N7 | followup.test.mjs | 1 | pass |
| N8 | followup.test.mjs | 1 | pass |
| N9 | followup.test.mjs | 1 | pass |
| N10 | followup.test.mjs | 1 | pass |
| N11 | followup.test.mjs | 1 | pass |
| N12 | followup.test.mjs, outcome.test.mjs | 2 | pass |
| N13 | followup.test.mjs, outcome.test.mjs | 1 | pass |
| N14 | followup.test.mjs, outcome.test.mjs | 2 | pass |
| N15 | followup.test.mjs | 1 | pass |
| N16 | followup.test.mjs, receipt.test.mjs | 2 | pass |
| N17 | receipt.test.mjs | 1 | pass |
| N18 | receipt.test.mjs | 1 | pass |
| N19 | followup.test.mjs | 1 | pass |
| N20 | followup.test.mjs | 1 | pass |
| N21 | receipt.test.mjs | 1 | pass |
| N22 | followup.test.mjs | 1 | pass |
| N23 | followup.test.mjs | 1 | pass |
| N24 | followup.test.mjs | 1 | pass |
| N25 | followup.test.mjs | 1 | pass |
| N26 | followup.test.mjs | 1 | pass |
| N27 | followup.test.mjs | 1 | pass |
| N28 | followup.test.mjs | 1 | pass |
| N29 | followup.test.mjs | 1 | pass |
| N30 | followup.test.mjs | 1 | pass |
| N31 | followup.test.mjs, receipt.test.mjs | 2 | pass |
| N32 | followup.test.mjs | 1 | pass |
| N33 | followup.test.mjs | 1 | pass |
| N34 | followup.test.mjs | 1 | pass |
| N35 | followup.test.mjs | 1 | pass |
| N36 | followup.test.mjs | 1 | pass |
| N37 | followup.test.mjs | 1 | pass |
| N38 | followup.test.mjs | 1 | pass |
| N39 | followup.test.mjs | 1 | pass |
| N40 | followup.test.mjs | 1 | pass |

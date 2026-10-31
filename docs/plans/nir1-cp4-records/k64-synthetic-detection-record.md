# K6/4 の分類器の Negative（K6/4-N1〜N40）の合成の記録による検出力の記録

K6/4「受入れ」の「CP-4 の分類器は、合成の記録（実 run の記録を複製し、通知、counter、begin の記録、子の outcome、時刻を書き換えたもの）で Negative のそれぞれを期待どおりに分けることを、観測の前に示して記録する」に対する記録。**Graph の実行出力を一つも見ずに**（runtime を起動しない node の試験だけで）取った。

- 実行日：2026-11-01（UTC 18:01、JST 03:01。K6/4 の凍結 `5dea38af` の後、新しい S4b''〔`557e683c`〕の merge の後、条件の判定に使う run の前）。取り直しの理由：前の記録（contracts `b90f6874`、候補 `82d42746`）の「取り直しの規則」に挙がった `followup.mjs` が、trace の経路の修正（DR-CP4-V-3 (A)、V-4 (B1)）で変わったので、最終の候補で取り直した。
- 候補：origin/master `86427ee53a73e669e34631c5774fbd56960ac050`（PR #770 の merge commit。tree `5ed0204d363c52659dcd072d46ef5c693be0722c`）。trace の経路の harness の修正（DR-CP4-V-2〜V-4）、S2 追補 #10、S4b''、3D ワークスペースのオーバーレイ（#769、製品側）を含む。clean な worktree（detach）。
- command：`node --test --test-reporter=tap scripts/quality/nir1-graph-eval/*.test.mjs`。結果：**601 件、pass 601、fail 0、skipped 0**。TAP の出力の sha256 `1d622480c515957270c1f4a93cc459f49414dc4fcfd863674756fb07eae4a265`。
- 前の記録（commit `b90f6874`）：候補 `82d427465b16a12809c6f93adad74ac97859c85a`、552 件 pass、TAP の sha256 `ca2dc770c372ffc3d619880bfb0ea91150c6a35c2ee574e5f824bb7f79f1d774`。N ごとの件数は前の記録と同じ。**N13 の file の欄だけ、題を持つ file（`outcome.test.mjs`）に直した**（前の記録は `followup.test.mjs` のコメントの言及も file に含めていた。試験の件数は 1 件のままで変わらない）。
- K6/4-N1〜N40 のすべてが、少なくとも 1 件の合成の記録の試験の題に現れ、すべて pass（下の表。`件` はその N を題に持つ試験の数）。
- 検出力の確認：統合 branch の各段で、これらの試験の期待を変える変異（分類の入替、判定の削除、閾値の変更など）を当て、試験が落ちることを確かめた（記録は `docs/plans/nir1-lane-decisions/cp4-decisions.md` の DR-CP4-K64-*、H-*、F-*、G-*、R-*、I-*、J-*、K-7、T14-* の変異の節）。N1〜N40 のための変異は、今回の候補でも新たに当てておらず、試験が pass することだけを確かめた（検出力そのものは上の以前の変異の記録による）。
- この候補以後に分類器（`followup.mjs`、`outcome.mjs`、`availability.mjs`、`window.mjs`、`receipt.mjs`）を変えたら、この記録は新しい候補では無効で、取り直す。

## X12 `cancelled-before-begin` の補足（番号を付けない）

K6/4 の Negative の一覧（N1〜N40）は凍結された契約で、番号を足さない（N41 を足すと契約の変更になる）。N22 は X12 の `graph-unavailable:warming／stale／busy` の枝だけを扱い、K6/4:160 の「親の合流が `cancelled` の世代」の枝の Negative は一覧に無い。DR-CP4-V-3 (A)（begin の前に取り消された counted parent を X12 にする）で、この枝に trace の文脈の分類が入ったので、次の試験を **N22 補** として記録する（いずれも今回の候補で pass）。

| 試験 file | 題（抜粋） | 結果 |
|---|---|---|
| followup.test.mjs | DR-CP4-V-3: (b) で begin の前に取り消された親は観測できる欄だけを求め X12（cancelled-before-begin）で終える（X10 にしない）。trace は Q に数え U に入れず、K6/4 で X12、K6/2 と K6/4 で失効 (i) | pass |
| trace-record.test.mjs | DR-CP4-V-3: begin の前に取り消された親は defect にせず Q に数え、U に入れない。K6/2 で失効 (i)、K6/4 で X12、trace は valid。再 query は Q の外で index-ready に帰属し、受領書に開示する | pass |
| trace-record.test.mjs | DR-CP4-V-4: cycle end の後に呼ばれた再 query は子にせず（v3 の #178 の形）、親の段（X11／X12）の失敗で E-6 にならず trace は valid。再 query は行と受領書に開示する | pass |
| trace-record.test.mjs | DR-CP4-V-4 × V-3: begin の前に取り消された親の再 query が cycle end の後なら、V-3 の開示はそのままで requeryAfterCycleEnd を足し、違反の検査を当てる（分類は X12 のまま） | pass |

- 検出力：この補足の試験に対して、独立レビュー（V-3 の 2 回目と V-4 の 3 回目）が変異を当てた。V-4 の 3 回目では、V-4 (A) の変異 10 種、B1（印と sample 側の値の照合）の 4 つの照合、B3 の 2 種、B2 の 3 種がすべて試験で落ち、落ちなかったのは境界の 3 つ（`>` を `>=`、`finite(cycleEndAt)` の guard の削除、親を除外に含める）だけだった。その 3 つは、その後に足した境界の試験（`45dac68e`）で落ちる（実装担当が確認）。B1 は、基点との differential（合成の入力 30 万件）で、印の無い入力と定常状態の文脈（Gold）の差が 0 だった。
- この補足は番号つきの Negative ではなく、分類器の取り直しの条件（上）の対象。

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
| N13 | outcome.test.mjs | 1 | pass |
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

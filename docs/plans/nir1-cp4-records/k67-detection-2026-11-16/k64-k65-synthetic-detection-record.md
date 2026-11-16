# K6/4 の Negative（N1〜N40）、K6/5（N1〜N4、P1）、C7 の合成の記録による検出力の記録（9 回目の S4 の取り直し。2026-11-16）

## 目的と規則

- K6/4・K6/5 の「合成の記録で N を期待どおりに分ける」記録と、C7（DR-CP4-C7）の 9 変異の検出。S2 の `r5Gate.k65DetectionRecord`（`S4:k65-detection-record`）に対する記録。前の版は `../k65-detection-2026-11-08/k64-k65-synthetic-detection-record.md`（候補 `f7e1fec1`）で、9 回目の S4 の変更（`trace-record.mjs`・`k64-record.mjs` ほか）の後なので無効、この候補で取り直した。
- K6/4（N1〜N40）は変異ではなく、全体の TAP から N の試験を数える（`tools/count-n.mjs`）。K6/5・C7 は変異 23 件（K6/5-N1〜N4、K6/5-P1、C7 の 9 件）。
- 製品の runtime は起動していない。

## 実行の共通

- 候補：`c3209e1d0881fdee1acead14e20645d9b7e87494`（tree `99def299b86e8d346f0e5197f62a6e8c227e5433`。枝 `claude/s4-9-pr3` の、setup の定数を validator の `HARNESS_CONSTANTS` に移し、検出力の欠け 11 件に試験を足した commit。判定 3 file と pin 対象の harness の非試験 file の bytes は `6430b75b` と同じ）。枝の worktree そのもの（`/home/grimodex/worktrees/Grimodex/s4-9-pr3`。detach の複製は作らない）で、node は v22.23.3。run の前後で `git status --porcelain --untracked-files=all` が空で、`git rev-parse HEAD` が上の値であることを道具が確かめた。S4b と bytes の pin の取り直し（⑥）の前。
- Graph の実行出力は一つも見ていない（合成の記録の試験と、候補の worktree の読込み時の置換だけ。製品・Electron・Native は起動していない）。
- 全体の command：`node --test --test-reporter=tap scripts/quality/nir1-graph-eval/*.test.mjs`（SP-N の run の `baselineAll`）。結果：**799 件、pass 799、fail 0、cancelled 0、skipped 0、todo 0**。TAP の sha256 `685ff998246f7845945fe4426eaf50061a13fbba23f63e588b302df22b8d4dc1`、`ok` 行の sha256 `59ef6a7fca1574194a8051ddceed69680050f5283e1deb3e1fc9f072d3f936c8`。（S2 の bytes の pin の試験は `scripts/quality/nir1-graph/` にあり、この command に含まれない。）
- 道具（`tools/`）：`hook.mjs` `e5732d013845a5a5b19e5cfeaf4042ef624ae7e02ae24c34b4fbef9389682994`、`register.mjs` `5f651fffc2f71745446c0e05cf12136e73f5062b1f00766b9716cd6a0383fcaf`、`run.mjs` `0f29e79b0eaadf6d6c2f826232ce0d505a2842b62cd7e9dd96d6c49a575aa897`、`count-n.mjs` `79adcb04a2fc471daf215ee07874b7de19f42c8e22dcfff828ca59535e5825cc` は 7 回目の取り直し（`../k65-detection-2026-11-08/tools/`）と同じ bytes。変異と陽性の対照の一覧は `tools/mutations-*.json`・`positive-*.json`（変更点は `tools/README.md`）。TAP の file は追跡していない（sha256 は結果の JSON にある）。
- 取り直しの前に、この候補の 1 つ前（`6430b75b`）で 6 組を取った。K6/7 の変異 83 件のうち 11 件が、どの試験も落とさず生き残った（検出力の欠け）。ユーザーの回答（contracts `516bb3fe` の `user-confirmation-2026-11-16-detection-gaps.md`、SHA-256 `f70e443a8aac4c660bd334dfddb5bd33f7e152d981125b79707ec9a3c4424d98`）は「試験を足して、検出力を取り直す」で、試験を足した（`c3209e1d`）うえで 6 組を最初から取り直したのがこの記録。`6430b75b` の結果は記録に含めない（候補が違う）。

## 実行

- K6/5・C7：2026-11-16T13:37:03.522Z〜2026-11-16T13:40:42.665Z（UTC）。対象の試験の baseline 293 件、pass 293、fail 0（TAP の sha256 `9382360fb1ba2337b478bd58e800037f81e39b3e56319c024f9e3fbff3821584`、`ok` 行の sha256 `220416b101b81177bad340343513634559a351b4bfcd470327d0cb73dfd92b69`）。陽性の対照 14 件はすべて ok。全 23 件、当たりはすべて 1（`allHitOnce: true`）、`allAsExpected: true`、`exactCount: 23`、`positiveControlsOk: true`、`probeOk: true`、`clean: true`（run の前後で `git status --porcelain` が空、ignored も不変）。結果 `results-k65-c3209e1d.json`（sha256 `8e54ce31c5a031b7909a0a5b7f68f4b53fe688c5b4949f87b0632f79ab38a20b`）。
- 変異：**23 件、検出 21、等価 2、余分に落ちた試験も落ちなかった試験もない**（`exact` 23）。等価の 2 件は `equivalentReason` に理由（下の表）。
- K6/4：全体の TAP（上の 799 件）から数えた（`counts-c3209e1d.json`、sha256 `db94e91c9035678f0081e173b666890433e8728267502c8a3edeffc7ab66c4fa`）。

## K6/4・K6/5 の試験の件数（N の記号ごと）

`tools/count-n.mjs` の結果。件は、その記号を題に持つ試験の数（範囲の記号は展開）。**`K6/5-P1` は 0 件**：K6/5-P1 の試験は K6/6 の変える点 4 で `K6/6-P1` に置き換えられた（7 回目の記録と同じ。`K65-P1-window` の変異は `K6/6-P1・K6/7 N-g` の試験を指す）。

| 記号 | 件 | 試験 file | 結果 |
|---|---|---|---|
| K6/4-N1 | 3 | followup.k66.test.mjs, followup.test.mjs | pass |
| K6/4-N2 | 1 | followup.test.mjs | pass |
| K6/4-N3 | 1 | followup.test.mjs | pass |
| K6/4-N4 | 1 | followup.test.mjs | pass |
| K6/4-N5 | 1 | followup.test.mjs | pass |
| K6/4-N6 | 1 | followup.test.mjs | pass |
| K6/4-N7 | 1 | followup.test.mjs | pass |
| K6/4-N8 | 1 | followup.test.mjs | pass |
| K6/4-N9 | 1 | followup.test.mjs | pass |
| K6/4-N10 | 1 | followup.test.mjs | pass |
| K6/4-N11 | 1 | followup.test.mjs | pass |
| K6/4-N12 | 2 | followup.test.mjs, outcome.test.mjs | pass |
| K6/4-N13 | 1 | outcome.test.mjs | pass |
| K6/4-N14 | 2 | followup.test.mjs, outcome.test.mjs | pass |
| K6/4-N15 | 1 | followup.test.mjs | pass |
| K6/4-N16 | 2 | followup.test.mjs, receipt.test.mjs | pass |
| K6/4-N17 | 1 | receipt.test.mjs | pass |
| K6/4-N18 | 1 | receipt.test.mjs | pass |
| K6/4-N19 | 1 | followup.test.mjs | pass |
| K6/4-N20 | 1 | followup.test.mjs | pass |
| K6/4-N21 | 1 | receipt.test.mjs | pass |
| K6/4-N22 | 1 | followup.test.mjs | pass |
| K6/4-N23 | 1 | followup.test.mjs | pass |
| K6/4-N24 | 1 | followup.test.mjs | pass |
| K6/4-N25 | 1 | followup.test.mjs | pass |
| K6/4-N26 | 1 | followup.test.mjs | pass |
| K6/4-N27 | 1 | followup.test.mjs | pass |
| K6/4-N28 | 1 | followup.test.mjs | pass |
| K6/4-N29 | 2 | followup.test.mjs | pass |
| K6/4-N30 | 1 | followup.test.mjs | pass |
| K6/4-N31 | 2 | followup.test.mjs, receipt.test.mjs | pass |
| K6/4-N32 | 2 | followup.test.mjs | pass |
| K6/4-N33 | 1 | followup.test.mjs | pass |
| K6/4-N34 | 1 | followup.test.mjs | pass |
| K6/4-N35 | 1 | followup.test.mjs | pass |
| K6/4-N36 | 1 | followup.test.mjs | pass |
| K6/4-N37 | 1 | followup.test.mjs | pass |
| K6/4-N38 | 1 | followup.test.mjs | pass |
| K6/4-N39 | 2 | followup.k66.test.mjs, followup.test.mjs | pass |
| K6/4-N40 | 1 | followup.test.mjs | pass |
| K6/5-N1 | 1 | receipt.test.mjs | pass |
| K6/5-N2 | 3 | admission.test.mjs | pass |
| K6/5-N3 | 3 | admission.test.mjs, receipt.test.mjs | pass |
| K6/5-N4 | 2 | quality-verdict.test.mjs, receipt.test.mjs | pass |
| K6/5-P1 | 0 |  | NOT-PASS |
| DR-CP4-C7 | 7 | trace-record.test.mjs | pass |

## K6/5・C7 の変異（落ちた試験）

| 変異 | 下位条件 | 変異の file | 落ちた試験 | 備考 |
|---|---|---|---|---|
| C7-indexUsable | C7 | trace-record.mjs | trace-record.test.mjs:2785 |  |
| C7-querySupported | C7 | trace-record.mjs | trace-record.test.mjs:2785 |  |
| C7-irStatus | C7 | trace-record.mjs | trace-record.test.mjs:2785 |  |
| C7-irReason | C7 | trace-record.mjs | trace-record.test.mjs:2785 |  |
| C7-graphOutcome | C7 | trace-record.mjs | trace-record.test.mjs:2785 |  |
| C7-total-count | C7 | trace-record.mjs | （等価）試験は落ちない | 総数の照合 stopped.length !== stoppedFetches.length は、直後の「条件を満たす fetch ごとにちょうど 1 つの begin」の照合 stoppedFetches.some(beginsOf !== 1) に含まれる。外した begin は必ず条件を満たす fetch の begin で（stopped は chronicleStopFetch を満たす owner の begin だけ）、全 fetch で beginsOf が 1 なら総数は fetch の数と等しい。したがってこの照合を外しても判定は変わらない（等価の変異。生き残るのが期待） |
| C7-per-fetch-begin | C7 | trace-record.mjs | trace-record.test.mjs:3142 |  |
| C7-clock-range | C7 | trace-record.mjs | trace-record.test.mjs:2982 |  |
| C7-lapse-count | C7 | trace-record.mjs | trace-record.test.mjs:2636 |  |
| K65-N1-receipt-values | K6/5-N1・N4 | receipt.mjs | receipt.test.mjs:705 |  |
| K65-N1-loader-values | K6/5-N1・N4 | procedure-file.mjs | procedure-file.test.mjs:130 |  |
| K65-N1-late-graph-boundary | K6/5-N1 | k64-record.mjs | k64-record.test.mjs:295 |  |
| K65-N2-admission-wait | K6/5-N2 | admission.mjs | admission.test.mjs:738, admission.test.mjs:804, admission.test.mjs:958, admission.test.mjs:1292 |  |
| K65-N2-admission-ancestor | K6/5-N2 | admission.mjs | admission.test.mjs:738, admission.test.mjs:958 |  |
| K65-N2-sample-window | K6/5-N2 | followup.mjs | followup.test.mjs:517 |  |
| K65-N2-sample-window-null | K6/5-N2 | followup.mjs | （等価）試験は落ちない | null の窓の検査 parent.graphWindowMs === null は、次の !Number.isFinite(parent.graphWindowMs) が null で true になるので、外しても判定は変わらない（等価の変異。生き残るのが期待） |
| K65-N3-head-sha | K6/5-N3 | receipt.mjs | receipt.test.mjs:354 |  |
| K65-N3-head-commit | K6/5-N3 | receipt.mjs | receipt.test.mjs:354 |  |
| K65-N3-head-required | K6/5-N3 | receipt.mjs | receipt.test.mjs:354 |  |
| K65-N4-verdict-values | K6/5-N4 | quality-verdict.mjs | quality-verdict.test.mjs:1326 |  |
| K65-N4-p95-limit | K6/5-N4 | quality-verdict.mjs | quality-verdict.test.mjs:640, quality-verdict.test.mjs:694 |  |
| K65-N4-b | K6/5-N4 | quality-verdict.mjs | quality-verdict.test.mjs:694 |  |
| K65-P1-window | K6/5-P1 | join.mjs | followup.k66.test.mjs:68 |  |

## 期待の決め方（開示）

`mutations-k65.json` の `expected`（落ちるべき試験の file・行・題の先頭）は 7 回目の記録の表の題を引き継ぎ、行だけ今の試験の行に取り直した。最初の run で期待と落ちた試験が全件一致した（写し直しは無い）。

## 取り直しの規則

この候補（`c3209e1d0881fdee1acead14e20645d9b7e87494`）以後に、K6/4・K6/5・C7 の検出に関わる file（`admission.mjs`、`followup.mjs`、`k64-record.mjs`、`procedure-file.mjs`、`quality-verdict*.mjs`、`receipt.mjs`、`trace-record.mjs`、または上の試験 file）を変えた commit を S4 以後の判定に使うなら、この記録はその候補では無効で、その候補で取り直す。⑤〜⑦ の間は規則の file（`scripts/quality/nir1-graph-eval/*.mjs`。試験を含む）を変えない。

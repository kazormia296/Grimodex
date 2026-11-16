# K6/6 の Negative・Positive の合成の記録による検出力の記録（9 回目の S4 の取り直し。2026-11-16）

K6/6「この draft が確認されたときに変わる harness の file」の「検出力の記録」の行に対する記録（本体・追補・追補 2・3 の 3 組。S2 の `r5Gate.k66DetectionRecord`、`S4:k66-detection-record`）。前の版は `../k66-detection-2026-11-08/k66-synthetic-detection-record.md`（候補 `f7e1fec1`。commit `833e5dfc`）で、DB 段 1 の PR-3（stamp の削除）・項目 C（品質判定 v3）の後なので無効、この候補で取り直した。道具と変異の当て方は同じ。

## 実行の共通

- 候補：`c3209e1d0881fdee1acead14e20645d9b7e87494`（tree `99def299b86e8d346f0e5197f62a6e8c227e5433`。枝 `claude/s4-9-pr3` の、setup の定数を validator の `HARNESS_CONSTANTS` に移し、検出力の欠け 11 件に試験を足した commit。判定 3 file と pin 対象の harness の非試験 file の bytes は `6430b75b` と同じ）。枝の worktree そのもの（`/home/grimodex/worktrees/Grimodex/s4-9-pr3`。detach の複製は作らない）で、node は v22.23.3。run の前後で `git status --porcelain --untracked-files=all` が空で、`git rev-parse HEAD` が上の値であることを道具が確かめた。S4b と bytes の pin の取り直し（⑥）の前。
- Graph の実行出力は一つも見ていない（合成の記録の試験と、候補の worktree の読込み時の置換だけ。製品・Electron・Native は起動していない）。
- 全体の command：`node --test --test-reporter=tap scripts/quality/nir1-graph-eval/*.test.mjs`（SP-N の run の `baselineAll`）。結果：**799 件、pass 799、fail 0、cancelled 0、skipped 0、todo 0**。TAP の sha256 `685ff998246f7845945fe4426eaf50061a13fbba23f63e588b302df22b8d4dc1`、`ok` 行の sha256 `59ef6a7fca1574194a8051ddceed69680050f5283e1deb3e1fc9f072d3f936c8`。（S2 の bytes の pin の試験は `scripts/quality/nir1-graph/` にあり、この command に含まれない。）
- 道具（`tools/`）：`hook.mjs` `e5732d013845a5a5b19e5cfeaf4042ef624ae7e02ae24c34b4fbef9389682994`、`register.mjs` `5f651fffc2f71745446c0e05cf12136e73f5062b1f00766b9716cd6a0383fcaf`、`run.mjs` `0f29e79b0eaadf6d6c2f826232ce0d505a2842b62cd7e9dd96d6c49a575aa897`、`count-n.mjs` `79adcb04a2fc471daf215ee07874b7de19f42c8e22dcfff828ca59535e5825cc` は 7 回目の取り直し（`../k65-detection-2026-11-08/tools/`）と同じ bytes。変異と陽性の対照の一覧は `tools/mutations-*.json`・`positive-*.json`（変更点は `tools/README.md`）。TAP の file は追跡していない（sha256 は結果の JSON にある）。
- 取り直しの前に、この候補の 1 つ前（`6430b75b`）で 6 組を取った。K6/7 の変異 83 件のうち 11 件が、どの試験も落とさず生き残った（検出力の欠け）。ユーザーの回答（contracts `516bb3fe` の `user-confirmation-2026-11-16-detection-gaps.md`、SHA-256 `f70e443a8aac4c660bd334dfddb5bd33f7e152d981125b79707ec9a3c4424d98`）は「試験を足して、検出力を取り直す」で、試験を足した（`c3209e1d`）うえで 6 組を最初から取り直したのがこの記録。`6430b75b` の結果は記録に含めない（候補が違う）。

## 実行

- 本体：2026-11-16T13:49:03.440Z〜2026-11-16T13:52:20.981Z（UTC）。対象の試験の baseline 180 件、pass 180、fail 0（TAP の sha256 `5802bcc348121f32baefc6793148982d5d735ad7640d33c5ebf9566042d9f2ba`、`ok` 行の sha256 `62008e6609b6e6ea78178b9316bbd14b086aeb58dd0877883ac2c8774a9a9c98`）。陽性の対照 9 件はすべて ok。全 51 件、当たりはすべて 1（`allHitOnce: true`）、`allAsExpected: true`、`exactCount: 51`、`positiveControlsOk: true`、`probeOk: true`、`clean: true`（run の前後で `git status --porcelain` が空、ignored も不変）。結果 `results-k66-c3209e1d.json`（sha256 `148c348efa63d408cd264a44b3cef6cb799b6b9aa668e672c12b8fa5c1adc469`）。
- 追補（理由 code）：2026-11-16T13:43:06.836Z〜2026-11-16T13:45:30.466Z（UTC）。対象の試験の baseline 88 件、pass 88、fail 0（TAP の sha256 `86768c132563f0ad491026bbde5814a95fe7362cf0f7388dc53a9bfc2b7b192c`、`ok` 行の sha256 `f83c153b30565f2a71795d05b1471d3d782347f2585026946c6392f7e99c5595`）。陽性の対照 8 件はすべて ok。全 28 件、当たりはすべて 1（`allHitOnce: true`）、`allAsExpected: true`、`exactCount: 28`、`positiveControlsOk: true`、`probeOk: true`、`clean: true`（run の前後で `git status --porcelain` が空、ignored も不変）。結果 `results-k66-addendum-c3209e1d.json`（sha256 `771eb527ae29759bec169c8ba55c004362cd1c91c66dfd0429b42f6923461841`）。
- 追補 2・3（品質判定 v2）：2026-11-16T13:49:03.441Z〜2026-11-16T13:54:46.755Z（UTC）。対象の試験の baseline 109 件、pass 109、fail 0（TAP の sha256 `6a4a7d73a59739480e712bb3c99d9426337adaf218c63af23fc36ad14f8634e9`、`ok` 行の sha256 `f258afb6639fa962f1b2677b45f51eef1c731c3ff0635b11e9790a803cc88965`）。陽性の対照 12 件はすべて ok。全 48 件、当たりはすべて 1（`allHitOnce: true`）、`allAsExpected: true`、`exactCount: 48`、`positiveControlsOk: true`、`probeOk: true`、`clean: true`（run の前後で `git status --porcelain` が空、ignored も不変）。結果 `results-k66-qv3-c3209e1d.json`（sha256 `a3e116e013d99db72bd58a1b39e390a0966ed355e8fb66ba3b7c4485087daa2f`）。
- 変異：本体 **51 件**（検出 50、等価 1）、追補 **28 件**（検出 27、等価 1）、追補 2・3 **48 件**（検出 47、等価 1）。すべて exact（51、28、48）。検出力の欠け（試験が 1 つも落ちない非等価の変異）は 0。
- 等価の 3 件は `equivalentReason` に理由（下の表）。

## 7 回目の記録から変えたこと（開示）

- **廃止 3 件**：`K66-N-d-stale`（文が消えた（followup.mjs の stamp の検査は削除）。K6/6-N4 も題ごと無い）、`K66-FR3-revalidation`（等価だった変異の行が消えた（②-2 は観測 (ii-b) に変わった））、`K66-FR3-stamp-other`（文が消えた。K6/6-N3a・N3b も題ごと無い）。stamp の文が PR-3 で消え、対の試験（K6/6-N3a〜N3e、N4）も K6/7 の N-e*・N-f*・N-g に置き換わった。代替の変異は K6/7 の記録（`k67-synthetic-detection-record.md`）にある。**`K66-N-d-stale` の FR-8（stale）の検査の代替は無い**（K6/7 本文が開示済み）。
- **移した 1 件**：`K66-FR3-ticket` → `K67-N-e1-ticket`（K6/7 の記録。find も当て直し）。
- **find を当て直した 1 件**：`QV3b-P32-branch`（品質判定 v3 の commit の束縛で式が変わった。置換は branch の束縛を外す）。
- 本体は 55 → 51 件（廃止 3、移動 1）。追補 28、追補 2・3 48 は件数が同じ。
- **期待の書き換え**：`expected`（落ちるべき試験の file・行・題）は、変異を当てる前に決めたものではない。7 回目の表の題を今の試験の題で引き直して行を写し（題が変わったものは K6/7 の対応の表で置き換え）、最初の run の結果を見て、期待と落ちた試験が違った 7 件を、最初の run で落ちた試験（同じ試験 file 内で、変異との対応を確かめたもの）に写し直した。これらはすべて「別の試験も落ちる」か「下書きが推測した試験が落ちない」で、検出されないものは無い。写し直した run は最後の run（記録の run）。
- `K66-FR3-declaration`：期待 346、567 → 346、567、630
- `K66-FR5-declaration`：期待 567、346 → 567、630
- `K66-FR7-no-edge`：期待 346 → 346、494
- `QV3-D7-not-before-equal`：期待 162 → 162、494
- `QV3-D7-earliest-run`：期待 110、162、220 → 110、162、220、494
- `QV3b-P32-branch`：期待 410 → 410、494
- `QV3b-P32-g01-json-dir`：期待 220 → 220、608
  （`QV3-D7-*`、`QV3b-P32-*` は `quality-verdict-first-run.test.mjs` の v3 の commit の束縛の試験が追加で落ちる。`K66-FR3-declaration`・`K66-FR5-declaration` は FR-3 ② の宣言の検査と N12a と開示の試験、`K66-FR7-no-edge` は K6/6-N7a〜N7e の試験が落ちる。`K66-FR5-declaration` は下書きが期待した K6/7 N-e4 が落ちず、N12a と開示の試験が落ちる〔N-e4 は FR-3 の宣言の検査だけを見る〕。）

## 本体の変異（落ちた試験）

| 変異 | 下位条件 | 変異の file | 落ちた試験 | 備考 |
|---|---|---|---|---|
| K66-N-d-driftAtQuery | N-d | followup.mjs | followup.k66.test.mjs:547 |  |
| K66-N-d-prepareFailures | N-d | followup.mjs | followup.k66.test.mjs:547 |  |
| K66-FR1-source | FR-1 | followup.mjs | followup.k66.test.mjs:556 |  |
| K66-a-reachedQuiet | N1a | followup.mjs | followup.k66.test.mjs:195 |  |
| K66-a-r1-self-report | N1b | followup.mjs | followup.k66.test.mjs:203 |  |
| K66-b-begin-records | N2a | followup.mjs | followup.k66.test.mjs:211 |  |
| K66-b-start-slot | N2b | followup.mjs | followup.k66.test.mjs:219 |  |
| K66-b-preparesStarted | N2c | followup.mjs | followup.k66.test.mjs:165, followup.k66.test.mjs:228, followup.k66.test.mjs:630 |  |
| K66-b-preparesReady | N2d | followup.mjs | followup.k66.test.mjs:228 |  |
| K66-b-deferredReleased | N2e | followup.mjs | followup.k66.test.mjs:228 |  |
| K66-b-staleReadyRetired | N2g | followup.mjs | followup.k66.test.mjs:228 |  |
| K66-c-unrecorded | N2h | followup.mjs | followup.k66.test.mjs:241 |  |
| K66-c-diff | N2h | followup.mjs | followup.k66.test.mjs:241, followup.k66.test.mjs:696 |  |
| K66-c-next-undefined | (c) | followup.mjs | followup.k66.test.mjs:241 |  |
| K66-FR3-declaration | N12a | followup.mjs | followup.k66.test.mjs:346, followup.k66.test.mjs:567, followup.k66.test.mjs:630 |  |
| K66-FR3-not-joined | N3 | followup.mjs | followup.k66.test.mjs:346 |  |
| K66-FR3-edge-count | N3 | followup.mjs | followup.k66.test.mjs:346 |  |
| K66-FR4-begins | N5a | followup.mjs | followup.k66.test.mjs:423 |  |
| K66-FR4-lateCached | N5b | followup.mjs | followup.k66.test.mjs:423 |  |
| K66-FR4-cacheHits | N5c | followup.mjs | followup.k66.test.mjs:423 |  |
| K66-FR4-cache-left | N5d | followup.mjs | followup.k66.test.mjs:423 |  |
| K66-FR4-after-block | N5a | followup.mjs | followup.k66.test.mjs:423 |  |
| K66-FR4-after-release-block | N5a | followup.mjs | followup.k66.test.mjs:423 |  |
| K66-FR5-declaration | N12a | followup.mjs | followup.k66.test.mjs:567, followup.k66.test.mjs:630 |  |
| K66-FR5-publishCount | N12b | followup.mjs | followup.k66.test.mjs:576 |  |
| K66-FR6-notice | N6a | followup.mjs | followup.k66.test.mjs:459 |  |
| K66-FR6-child | N6b | followup.mjs | followup.k66.test.mjs:466 |  |
| K66-FR6-ir-retry | N6c | followup.mjs | followup.k66.test.mjs:473 |  |
| K66-FR7-no-record | N7a | followup.mjs | followup.k66.test.mjs:494 |  |
| K66-FR7-basis | N7b | followup.mjs | followup.k66.test.mjs:494 |  |
| K66-FR7-unresolved | N7c | followup.mjs | followup.k66.test.mjs:494 |  |
| K66-FR7-no-edge | N7d | followup.mjs | followup.k66.test.mjs:346, followup.k66.test.mjs:494 |  |
| K66-FR7-expected | N7e | followup.mjs | followup.k66.test.mjs:494 |  |
| K66-6-contributed-outcome | N13 | followup.mjs | outcome.test.mjs:813 |  |
| K66-6-contributed-joined | N13 | followup.mjs | （等価）試験は落ちない | parentContributed は join.inWindow を先に要求し、classifyJoin は inWindow を joined===true のときだけ返す。graph.joined === true の検査は inWindow に含まれ、置換しても判定が変わらない。 |
| K66-6-contributed-used | N13 | followup.mjs | outcome.test.mjs:813 |  |
| K66-6-contributed-edgeCount | N13 | followup.mjs | outcome.test.mjs:813 |  |
| K66-6-outcome-fail | N13 | outcome.mjs | outcome.test.mjs:775, outcome.test.mjs:791 |  |
| K66-5-heading-rate-entry | 5 | availability.mjs | followup.k66.test.mjs:597, followup.k66.test.mjs:630 |  |
| K66-N9-receipt-sha | N9 | receipt.mjs | receipt.test.mjs:410 |  |
| K66-N9-receipt-commit | N9 | receipt.mjs | receipt.test.mjs:410 |  |
| K66-N9-receipt-null-descriptor | N9 | receipt.mjs | receipt.test.mjs:410 |  |
| K66-N9-receipt-required-when-formal | N9 | receipt.mjs | receipt.test.mjs:410 |  |
| K66-N9-admission-commit | N9 | admission.mjs | admission.test.mjs:1034 |  |
| K66-N9-admission-sha | N9 | admission.mjs | admission.test.mjs:1034 |  |
| K66-N9-admission-null | N9 | admission.mjs | admission.test.mjs:1034 |  |
| K66-D3d-not-latest | D3(d) | quality-verdict.mjs | quality-verdict.test.mjs:1597 |  |
| K66-D3d-no-edge-hold | D3(d) | quality-verdict.mjs | quality-verdict.test.mjs:1597 |  |
| K66-D3d-no-setup-hold | D3(d) | quality-verdict.mjs | quality-verdict.test.mjs:1597 |  |
| K66-D3d-refused-skipped | D3(d) | quality-verdict.mjs | quality-verdict.test.mjs:1597, quality-verdict.test.mjs:1855 |  |
| K66-D3d-prepare-skip-removed | D3(d) | quality-verdict.mjs | quality-verdict.test.mjs:1855 |  |

## 追補の変異（落ちた試験）

| 変異 | 下位条件 | 変異の file | 落ちた試験 | 備考 |
|---|---|---|---|---|
| K66-b-preparesStarted-tolerate-0 | N2c (0) | followup.mjs | followup.k66.test.mjs:228 |  |
| K66-b-preparesStarted-tolerate-2 | N2c (2) | followup.mjs | followup.k66.test.mjs:165, followup.k66.test.mjs:228, followup.k66.test.mjs:630 |  |
| K66-b-preparesReady-tolerate-0 | N2d (0) | followup.mjs | followup.k66.test.mjs:228 |  |
| K66-b-preparesReady-tolerate-2 | N2d (2) | followup.mjs | followup.k66.test.mjs:228 |  |
| K66-b-deferredReleased-tolerate-0 | N2e/N2f (0) | followup.mjs | followup.k66.test.mjs:228 |  |
| K66-b-deferredReleased-tolerate-2 | N2e/N2f (2) | followup.mjs | followup.k66.test.mjs:228 |  |
| K66-FR4-begins-skip-after | N5 (after, begins) | followup.mjs | followup.k66.test.mjs:423 |  |
| K66-FR4-lateCached-skip-after | N5 (after, lateCached) | followup.mjs | followup.k66.test.mjs:423 |  |
| K66-FR4-cacheHits-skip-after | N5 (after, cacheHits) | followup.mjs | followup.k66.test.mjs:423 |  |
| K66-FR4-begins-skip-after-release | N5 (after-release, begins) | followup.mjs | followup.k66.test.mjs:423 |  |
| K66-FR4-lateCached-skip-after-release | N5 (after-release, lateCached) | followup.mjs | followup.k66.test.mjs:423 |  |
| K66-FR4-cacheHits-skip-after-release | N5 (after-release, cacheHits) | followup.mjs | followup.k66.test.mjs:423 |  |
| K66-FR5-window-not-D | N12c | followup.mjs | followup.k66.test.mjs:584 |  |
| K66-c-next-includes-hybrid | (c) hybrid を飛ばす | followup.mjs | followup.k66.test.mjs:94, followup.k66.test.mjs:597, followup.k66.test.mjs:630, followup.k66.test.mjs:696 |  |
| K66-c-next-includes-requery | (c) 再 query 行を飛ばす | followup.mjs | followup.k66.test.mjs:735 |  |
| K66-c-next-across-phase | (c) phase の区切り | followup.mjs | followup.k66.test.mjs:117 |  |
| K66-c-next-across-variant | (c) variant の区切り | followup.mjs | followup.k66.test.mjs:117, followup.k66.test.mjs:597, followup.k66.test.mjs:630, followup.k66.test.mjs:696 |  |
| K66-N8-schedule-check | N8 | availability.mjs | followup.k66.test.mjs:683 |  |
| K66-D4-requery-rows-ignored | D4 requeries | quality-verdict.mjs | quality-verdict.test.mjs:1888 |  |
| K66-D4-requery-user-operation-counted | D4 requeries | quality-verdict.mjs | quality-verdict.test.mjs:1888 |  |
| K66-D4-requery-hybrid-counted | D4 requeries | quality-verdict.mjs | quality-verdict.test.mjs:1888 |  |
| K66-D3b-record-only-when-edges | D3 (b)(d) | quality-verdict.mjs | quality-verdict.test.mjs:1965 |  |
| K66-D3b-null-edgecount-no-hold | D3 (b)(d) | quality-verdict.mjs | quality-verdict.test.mjs:1965 |  |
| K66-D3b-revision-resolution-always | D3 (d) | quality-verdict.mjs | quality-verdict.test.mjs:1965, quality-verdict.test.mjs:2504 |  |
| K66-D3-disclose-edge-count | D3 開示 | quality-verdict.mjs | quality-verdict.test.mjs:2060 |  |
| K66-D3-disclose-outside-expectation | D3 開示 | quality-verdict.mjs | （等価）試験は落ちない | D3 の対象は G-08/chronicle-index-unusable だけで、その期待は unavailable（expectedContributions 0 件）なので expectedScenes は空。`!expectedScenes.has(id)` は常に真で、外す変異は判定も開示も変えない（読みによる） |
| K66-D3-disclose-missing-conditions | D3 開示 | quality-verdict.mjs | quality-verdict.test.mjs:2060, quality-verdict.test.mjs:2428 |  |
| K66-D3-missing-6 | D3 開示 | quality-verdict.mjs | quality-verdict.test.mjs:1597, quality-verdict.test.mjs:2060 |  |

## 追補 2・3（品質判定 v2）の変異（落ちた試験）

| 変異 | 下位条件 | 変異の file | 落ちた試験 | 備考 |
|---|---|---|---|---|
| QV3-P1-notdisplayed-first | P1-1 / C8 | quality-verdict.mjs | quality-verdict.test.mjs:1494, quality-verdict.test.mjs:2230, quality-verdict.test.mjs:2323 |  |
| QV3-P21-empty-observed | P2-1 / C4 | quality-verdict.mjs | quality-verdict.test.mjs:1965, quality-verdict.test.mjs:2266 |  |
| QV3-P32a-scene-null | P3-2 / C4 | quality-verdict.mjs | quality-verdict.test.mjs:1965, quality-verdict.test.mjs:2297 |  |
| QV3-C3-record-missing-only-graph | §3 字義 | quality-verdict.mjs | quality-verdict.test.mjs:1965, quality-verdict.test.mjs:2266 |  |
| QV3-P22-requeries-N29-N32 | P2-2 / C6 | quality-verdict.mjs | quality-verdict.test.mjs:2323 |  |
| QV3-P22-requeries-a | P2-2 / C6 (ii) | quality-verdict.mjs | quality-verdict.test.mjs:2323 |  |
| QV3-P22-FR6-rows | P2-2 / C6 (i) | followup.mjs | followup.k66.test.mjs:480 |  |
| QV3-P22-FR6-not-list | P2-2 / C6 (i) | followup.mjs | followup.k66.test.mjs:480 |  |
| QV3-C5-no-variantkey | P3-2 / C5 | quality-verdict.mjs | quality-verdict.test.mjs:2375 |  |
| QV3-C5-hybrid-row | P3-2 / C5 | quality-verdict.mjs | quality-verdict.test.mjs:1888 |  |
| QV3-C1-key-order | P3-3 / C1 | quality-verdict.mjs | quality-verdict.test.mjs:1597, quality-verdict.test.mjs:1855 |  |
| QV3-C1-refused-any | P3-3 / C1 (iii) | quality-verdict.mjs | quality-verdict.test.mjs:1597, quality-verdict.test.mjs:1855 |  |
| QV3-C1-order-not-in-fixture | P3-3 / C1 | quality-verdict.mjs | quality-verdict.test.mjs:1597 |  |
| QV3-C1-order-empty | P3-3 / C1 | quality-verdict.mjs | （等価）試験は落ちない | order が空なら ordered は空集合で、setup の記録に 1 つでも Revision（直前の hasSetup の検査で 1 つ以上ある）があれば `some((id) => !ordered.has(id))` が真になり同じ hold（d-revision-order-unavailable）になる。`ordered.size === 0` は単独では判定を変えない（読みによる）。 |
| QV3-C1-loader-order | P3-3 / C1 | quality-verdict-cli.mjs | quality-verdict.test.mjs:1597, quality-verdict.test.mjs:2266, quality-verdict.test.mjs:2297, quality-verdict.test.mjs:2504 |  |
| QV3-D3-3-refreshTrigger | P3-1 D3 (3) | quality-verdict.mjs | quality-verdict.test.mjs:2060, quality-verdict.test.mjs:2428 |  |
| QV3-D3-4-chronicle-usable | P3-1 D3 (4) | quality-verdict.mjs | quality-verdict.test.mjs:2428 |  |
| QV3-D3-4-ir-outcome | P3-1 D3 (4) | quality-verdict.mjs | quality-verdict.test.mjs:2060, quality-verdict.test.mjs:2428 |  |
| QV3-D3-5-graph-usable | P3-1 D3 (5) | quality-verdict.mjs | quality-verdict.test.mjs:2060, quality-verdict.test.mjs:2428 |  |
| QV3-D3-2-origin | P3-1 D3 (2) | quality-verdict.mjs | quality-verdict.test.mjs:1597 |  |
| QV3-D3-6-child-chronicle | P3-1 D3 (6) | quality-verdict.mjs | quality-verdict.test.mjs:1597, quality-verdict.test.mjs:2060 |  |
| QV3-D3-1-variant | P3-1 D3 (1) / D2 | quality-verdict.mjs | quality-verdict.test.mjs:2428 |  |
| QV3-D2-eligible-stays-child | D2 | quality-verdict.mjs | quality-verdict.test.mjs:2060 |  |
| QV3-D2-unavailable-not-d3 | D2 | quality-verdict.mjs | quality-verdict.test.mjs:1597, quality-verdict.test.mjs:2060 |  |
| QV3-D3a-added-list | P3-1 D3 (a) | quality-verdict.mjs | quality-verdict.test.mjs:2504 |  |
| QV3-D3a-blocked | P3-1 D3 (a) | quality-verdict.mjs | quality-verdict.test.mjs:2504 |  |
| QV3-D3b-forbidden-path | D3 (b) | quality-verdict.mjs | quality-verdict.test.mjs:1597, quality-verdict.test.mjs:1965 |  |
| QV3-D8b-not-displayed-differs | P3-1 D8 (b) | quality-verdict.mjs | quality-verdict.test.mjs:1545 |  |
| QV3-D7-not-before-equal | D7 | quality-verdict-cli.mjs | quality-verdict-first-run.test.mjs:162, quality-verdict-first-run.test.mjs:494 |  |
| QV3-D7-earliest-run | D7 | quality-verdict-cli.mjs | quality-verdict-first-run.test.mjs:110, quality-verdict-first-run.test.mjs:162, quality-verdict-first-run.test.mjs:220, quality-verdict-first-run.test.mjs:494 |  |
| QV3-D7-kind-empty | D7 | quality-verdict-cli.mjs | quality-verdict-first-run.test.mjs:110 |  |
| QV3-D7-remote-earliest | D7 | quality-verdict-cli.mjs | quality-verdict-first-run.test.mjs:162 |  |
| QV3-D7-source | D7 | quality-verdict-cli.mjs | quality-verdict-first-run.test.mjs:162 |  |
| QV3-D7-v2-bytes | D7 | quality-verdict-cli.mjs | quality-verdict-first-run.test.mjs:220 |  |
| QV3-D7-cli-required | D7 | quality-verdict-cli.mjs | quality-verdict-first-run.test.mjs:347 |  |
| QV3b-P21-unaccounted | 再レビュー P2-1 / C1 | quality-verdict.mjs | quality-verdict.test.mjs:1597 |  |
| QV3b-P21-refused-any-stage | 再レビュー P2-1 / C1 | quality-verdict.mjs | quality-verdict.test.mjs:1597 |  |
| QV3b-P33-unknown-variant | 再レビュー P3-3 / C5 | quality-verdict.mjs | quality-verdict.test.mjs:2375 |  |
| QV3b-P31-pair-observationPrep | 再レビュー P3-1 | quality-verdict-cli.mjs | quality-verdict-first-run.test.mjs:377 |  |
| QV3b-P31-pair-candidate | 再レビュー P3-1 | quality-verdict-cli.mjs | quality-verdict-first-run.test.mjs:110, quality-verdict-first-run.test.mjs:377 |  |
| QV3b-P32-branch | 再レビュー P3-2 | quality-verdict-cli.mjs | quality-verdict-first-run.test.mjs:410, quality-verdict-first-run.test.mjs:494 |  |
| QV3b-P32-impl-bound | 再レビュー P3-2 | quality-verdict-cli.mjs | quality-verdict-first-run.test.mjs:220, quality-verdict-first-run.test.mjs:442 |  |
| QV3b-P32-v2-path | 再レビュー P3-2 | quality-verdict-cli.mjs | quality-verdict-first-run.test.mjs:220 |  |
| QV3b-P32-g01-json-dir | 再レビュー P3-1 / P1-1 | quality-verdict-cli.mjs | quality-verdict-first-run.test.mjs:220, quality-verdict-first-run.test.mjs:608 |  |
| QV3b-P11-g01-head-kind | 再レビュー P1-1 | pubg16-e2e-run.mjs | pubg16-e2e-run.test.mjs:336 |  |
| QV3b-P11-head-kind-traces | 再レビュー P1-1 | frozen-diagnostics.mjs | pubg16-e2e-run.test.mjs:336 |  |
| QV3b-P11-frozen-requires-head | 再レビュー P1-1 | pubg16-e2e-run.mjs | pubg16-e2e-run.test.mjs:236 |  |
| QV3b-P11-dev-refuses-head | 再レビュー P1-1 | pubg16-e2e-run.mjs | pubg16-e2e-run.test.mjs:236 |  |

## 取り直しの規則

この候補（`c3209e1d0881fdee1acead14e20645d9b7e87494`）以後に、K6/6 の検出に関わる file（`followup.mjs`、`outcome.mjs`、`receipt.mjs`、`admission.mjs`、`quality-verdict*.mjs`、`pubg16-e2e-run.mjs`、または上の試験 file）を変えた commit を S4 以後の判定に使うなら、この記録はその候補では無効で、その候補で取り直す。⑤〜⑦ の間は規則の file（`scripts/quality/nir1-graph-eval/*.mjs`。試験を含む）を変えない。

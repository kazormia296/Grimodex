# SP/1 の Negative（SP-N1〜N5、SP-N9〜SP-N13）の合成の記録による検出の記録（9 回目の S4 の取り直し。2026-11-16）

## 目的と規則

- SP/1 の draft（`docs/plans/nir1-graph-case-seed-pin-proposal-1-draft.md` :178）の「CP-4 は、合成の記録で SP-N1〜SP-N5、SP-N9〜SP-N13 を期待どおりに分けることを、観測の前に示す」に対する記録。S2 の `r5Gate.syntheticDetection`（`record: "S4:sp-synthetic-detection-record"`）の `recordRule` に従う。
- **取り直し（9 回目の S4）**：前の版（7 回目。`../k65-detection-2026-11-08/sp-synthetic-detection-record.md`、候補 `f7e1fec1`）の「取り直しの規則」に挙げた file（`receipt.mjs`、`receipt.test.mjs`、`run-sample.mjs`、`test-support.mjs`、`constants.mjs` など）が 9 回目の S4（DB 段 1 の PR-3・項目 B・項目 C）で `f7e1fec1` から変わったので、前の版はこの候補では無効で、この候補で取り直した。
- 変異の置換の文字列は前の版と同じ 23 件。期待の行だけ今の試験の行に取り直した（題は同じ）。試験の assert の要旨・陽性の対照・限界の本文は前の版（`../k65-detection-2026-11-08/sp-synthetic-detection-record.md` の「SP-N ごとの結果」「限界の開示」）のまま。合成の記録の作り方（実際の setup の receipt の複製ではない）も同じ。
- 製品の runtime は起動していない。node の試験と、試験の module を読み込み時に書き換える変異だけを行った。

## 実行の共通

- 候補：`c3209e1d0881fdee1acead14e20645d9b7e87494`（tree `99def299b86e8d346f0e5197f62a6e8c227e5433`。枝 `claude/s4-9-pr3` の、setup の定数を validator の `HARNESS_CONSTANTS` に移し、検出力の欠け 11 件に試験を足した commit。判定 3 file と pin 対象の harness の非試験 file の bytes は `6430b75b` と同じ）。枝の worktree そのもの（`/home/grimodex/worktrees/Grimodex/s4-9-pr3`。detach の複製は作らない）で、node は v22.23.3。run の前後で `git status --porcelain --untracked-files=all` が空で、`git rev-parse HEAD` が上の値であることを道具が確かめた。S4b と bytes の pin の取り直し（⑥）の前。
- Graph の実行出力は一つも見ていない（合成の記録の試験と、候補の worktree の読込み時の置換だけ。製品・Electron・Native は起動していない）。
- 全体の command：`node --test --test-reporter=tap scripts/quality/nir1-graph-eval/*.test.mjs`（SP-N の run の `baselineAll`）。結果：**799 件、pass 799、fail 0、cancelled 0、skipped 0、todo 0**。TAP の sha256 `685ff998246f7845945fe4426eaf50061a13fbba23f63e588b302df22b8d4dc1`、`ok` 行の sha256 `59ef6a7fca1574194a8051ddceed69680050f5283e1deb3e1fc9f072d3f936c8`。（S2 の bytes の pin の試験は `scripts/quality/nir1-graph/` にあり、この command に含まれない。）
- 道具（`tools/`）：`hook.mjs` `e5732d013845a5a5b19e5cfeaf4042ef624ae7e02ae24c34b4fbef9389682994`、`register.mjs` `5f651fffc2f71745446c0e05cf12136e73f5062b1f00766b9716cd6a0383fcaf`、`run.mjs` `0f29e79b0eaadf6d6c2f826232ce0d505a2842b62cd7e9dd96d6c49a575aa897`、`count-n.mjs` `79adcb04a2fc471daf215ee07874b7de19f42c8e22dcfff828ca59535e5825cc` は 7 回目の取り直し（`../k65-detection-2026-11-08/tools/`）と同じ bytes。変異と陽性の対照の一覧は `tools/mutations-*.json`・`positive-*.json`（変更点は `tools/README.md`）。TAP の file は追跡していない（sha256 は結果の JSON にある）。
- 取り直しの前に、この候補の 1 つ前（`6430b75b`）で 6 組を取った。K6/7 の変異 83 件のうち 11 件が、どの試験も落とさず生き残った（検出力の欠け）。ユーザーの回答（contracts `516bb3fe` の `user-confirmation-2026-11-16-detection-gaps.md`、SHA-256 `f70e443a8aac4c660bd334dfddb5bd33f7e152d981125b79707ec9a3c4424d98`）は「試験を足して、検出力を取り直す」で、試験を足した（`c3209e1d`）うえで 6 組を最初から取り直したのがこの記録。`6430b75b` の結果は記録に含めない（候補が違う）。

## 実行

- SP-N：2026-11-16T13:36:28.833Z〜2026-11-16T13:37:03.482Z（UTC）。対象の試験の baseline 51 件、pass 51、fail 0（TAP の sha256 `a2e39abff7445067122b52479634edd6194478f1c866279ed39f7600031f7cbf`、`ok` 行の sha256 `9ec984e1bae2ed0c5299f0c1ba12159ae6789badd2c4dbfa65fa9cf8331940c1`）。陽性の対照 8 件はすべて ok。全 23 件、当たりはすべて 1（`allHitOnce: true`）、`allAsExpected: true`、`exactCount: 23`、`positiveControlsOk: true`、`probeOk: true`、`clean: true`（run の前後で `git status --porcelain` が空、ignored も不変）。結果 `results-spn-c3209e1d.json`（sha256 `e1f287b01971dccbe5f02f03a4ae2f35618d4dbf6517aacae5eedfcdcaf66290`）。
- 変異：**23 件、検出 23、等価 0、余分に落ちた試験も落ちなかった試験もない**（`exact` 23）。

## SP-N ごとの結果（落ちた試験）

| 変異 | 下位条件 | 変異の file | 落ちた試験 | 備考 |
|---|---|---|---|---|
| N1-step | SP-N1 | seed-pin-setup.mjs | seed-pin-setup.test.mjs:260 |  |
| N1-r5 | SP-N1 | seed-pin.mjs | seed-pin.test.mjs:69, seed-pin.test.mjs:161, seed-pin.test.mjs:255 |  |
| N2-step | SP-N2 | seed-pin-setup.mjs | seed-pin-setup.test.mjs:260 |  |
| N2-r5 | SP-N2 | seed-pin.mjs | seed-pin.test.mjs:161 |  |
| N3-step | SP-N3 | seed-pin-setup.mjs | seed-pin-setup.test.mjs:260 |  |
| N4-writer | SP-N4 | seed-pin-setup.mjs | seed-pin-setup.test.mjs:260 |  |
| N4-createdAt | SP-N4 | seed-pin-setup.mjs | seed-pin-setup.test.mjs:260 |  |
| N5-before | SP-N5 | seed-pin-setup.mjs | seed-pin-setup.test.mjs:260 |  |
| N5-outside | SP-N5 | seed-pin-setup.mjs | seed-pin-setup.test.mjs:260 |  |
| N9-step | SP-N9 | seed-pin-setup.mjs | seed-pin-setup.test.mjs:260 |  |
| N9-sceneLive | SP-N9 | seed-pin.mjs | seed-pin.test.mjs:34, seed-pin.test.mjs:161 |  |
| N9-project | SP-N9 | seed-pin.mjs | seed-pin.test.mjs:34, seed-pin.test.mjs:161 |  |
| N9-blank | SP-N9 | seed-pin.mjs | seed-pin.test.mjs:34 |  |
| N9-long | SP-N9 | seed-pin.mjs | seed-pin.test.mjs:34 |  |
| N10-differ | SP-N10 | seed-pin-setup.mjs | seed-pin-setup.test.mjs:493 |  |
| N11-nopin | SP-N11 | seed-pin.mjs | seed-pin.test.mjs:161 |  |
| N11-missing | SP-N11 | seed-pin.mjs | seed-pin.test.mjs:161 |  |
| N12-validate | SP-N12 | receipt.mjs | receipt.test.mjs:1268 |  |
| N12-select | SP-N12 | receipt.mjs | receipt.test.mjs:1268 |  |
| N13-sealedRead | SP-N13 | seed-pin.mjs | seed-pin.test.mjs:161, seed-pin.test.mjs:367 |  |
| N13-sealedSetup | SP-N13 | seed-pin.mjs | seed-pin.test.mjs:161 |  |
| N13-label-read | SP-N13 | seed-pin.mjs | seed-pin.test.mjs:161, seed-pin.test.mjs:367 |  |
| N13-label-setup | SP-N13 | seed-pin.mjs | seed-pin.test.mjs:161 |  |

## 取り直しの規則

この候補（`c3209e1d0881fdee1acead14e20645d9b7e87494`）以後に、SP-N の検出に関わる file（`seed-pin.mjs`、`seed-pin-setup.mjs`、`workspace-db.mjs`、`receipt.mjs`、`run-sample.mjs`、`setup-receipt.mjs`、`test-support.mjs`、`constants.mjs`、`k64-runner.mjs`、`runner.mjs`、`r5-check-runner.mjs`、`frozen-setup-driver.mjs`、`setup-driver.mjs`、または上の試験 file）を変えた commit を S4 以後の判定に使うなら、この記録はその候補では無効で、その候補で取り直す。⑤〜⑦ の間は規則の file（`scripts/quality/nir1-graph-eval/*.mjs`。試験を含む）を変えない。

# K6/7 の合成の記録による検出力の記録（K6/7 の harness の実装と品質判定 v3。9 回目の S4。2026-11-16）

K6/7（`nir1-final-request-eval-proposal/7`。contracts `b9559a22`）の負例（N-e1〜N-e6、N-f1〜N-f3、N-g、N-h1〜N-h7、N3b′・N9′ ほか）、R-12・R-13 の 1 組、品質判定 v3（contracts `160f5fa5`。項目 C の evidence 4 件の fail／hold、集約、平文混入の拒否）に対する検出力の記録（S2 の `r5Gate.k67DetectionRecord`、`S4:k67-detection-record`。品質判定 v3 を含む）。K6/6 の前例（`../k66-detection-2026-11-08/`）の道具と当て方に、変異の一覧を足した。**Graph の実行出力は一つも見ていない。**

## 実行の共通

- 候補：`c3209e1d0881fdee1acead14e20645d9b7e87494`（tree `99def299b86e8d346f0e5197f62a6e8c227e5433`。枝 `claude/s4-9-pr3` の、setup の定数を validator の `HARNESS_CONSTANTS` に移し、検出力の欠け 11 件に試験を足した commit。判定 3 file と pin 対象の harness の非試験 file の bytes は `6430b75b` と同じ）。枝の worktree そのもの（`/home/grimodex/worktrees/Grimodex/s4-9-pr3`。detach の複製は作らない）で、node は v22.23.3。run の前後で `git status --porcelain --untracked-files=all` が空で、`git rev-parse HEAD` が上の値であることを道具が確かめた。S4b と bytes の pin の取り直し（⑥）の前。
- Graph の実行出力は一つも見ていない（合成の記録の試験と、候補の worktree の読込み時の置換だけ。製品・Electron・Native は起動していない）。
- 全体の command：`node --test --test-reporter=tap scripts/quality/nir1-graph-eval/*.test.mjs`（SP-N の run の `baselineAll`）。結果：**799 件、pass 799、fail 0、cancelled 0、skipped 0、todo 0**。TAP の sha256 `685ff998246f7845945fe4426eaf50061a13fbba23f63e588b302df22b8d4dc1`、`ok` 行の sha256 `59ef6a7fca1574194a8051ddceed69680050f5283e1deb3e1fc9f072d3f936c8`。（S2 の bytes の pin の試験は `scripts/quality/nir1-graph/` にあり、この command に含まれない。）
- 道具（`tools/`）：`hook.mjs` `e5732d013845a5a5b19e5cfeaf4042ef624ae7e02ae24c34b4fbef9389682994`、`register.mjs` `5f651fffc2f71745446c0e05cf12136e73f5062b1f00766b9716cd6a0383fcaf`、`run.mjs` `0f29e79b0eaadf6d6c2f826232ce0d505a2842b62cd7e9dd96d6c49a575aa897`、`count-n.mjs` `79adcb04a2fc471daf215ee07874b7de19f42c8e22dcfff828ca59535e5825cc` は 7 回目の取り直し（`../k65-detection-2026-11-08/tools/`）と同じ bytes。変異と陽性の対照の一覧は `tools/mutations-*.json`・`positive-*.json`（変更点は `tools/README.md`）。TAP の file は追跡していない（sha256 は結果の JSON にある）。
- 取り直しの前に、この候補の 1 つ前（`6430b75b`）で 6 組を取った。K6/7 の変異 83 件のうち 11 件が、どの試験も落とさず生き残った（検出力の欠け）。ユーザーの回答（contracts `516bb3fe` の `user-confirmation-2026-11-16-detection-gaps.md`、SHA-256 `f70e443a8aac4c660bd334dfddb5bd33f7e152d981125b79707ec9a3c4424d98`）は「試験を足して、検出力を取り直す」で、試験を足した（`c3209e1d`）うえで 6 組を最初から取り直したのがこの記録。`6430b75b` の結果は記録に含めない（候補が違う）。

## 実行

- K6/7 core：2026-11-16T13:49:03.440Z〜2026-11-16T13:51:22.614Z（UTC）。対象の試験の baseline 319 件、pass 319、fail 0（TAP の sha256 `b589ce16f4673e3c7dd46328aa7d85dae2ed4957761b04dd998389286639a2e5`、`ok` 行の sha256 `d3d3caf6d47f4c887ae2259010a5e12868954f9e5c4c6f1b019a6f1b57d0ba8f`）。陽性の対照 8 件はすべて ok。全 38 件、当たりはすべて 1（`allHitOnce: true`）、`allAsExpected: true`、`exactCount: 38`、`positiveControlsOk: true`、`probeOk: true`、`clean: true`（run の前後で `git status --porcelain` が空、ignored も不変）。結果 `results-k67-c3209e1d.json`（sha256 `03959c756bc456d577d971a05fed3418d9f2676ed5d16afe9454c00fe48c2ac8`）。
- K6/7 v3（品質判定 v3）：2026-11-16T13:54:46.798Z〜2026-11-16T14:00:18.013Z（UTC）。対象の試験の baseline 105 件、pass 105、fail 0（TAP の sha256 `8a0473f08a35d2eab788b56894afa9a0f9818dd8b13ba9975598c2337af3e5ba`、`ok` 行の sha256 `2524fc2ecccfdcf45a6c5def67ea20fd34a26756c7085838e07487ffefcea86c`）。陽性の対照 5 件はすべて ok。全 45 件、当たりはすべて 1（`allHitOnce: true`）、`allAsExpected: true`、`exactCount: 45`、`positiveControlsOk: true`、`probeOk: true`、`clean: true`（run の前後で `git status --porcelain` が空、ignored も不変）。結果 `results-k67-v3-c3209e1d.json`（sha256 `b7836ae4346a4070e0bcb929199c8242ebda1073609d3d17b2a4a7fbb837caf6`）。
- 変異：core **38 件**、v3 **45 件**（計 83 件）。**すべて検出**（等価 0。試験が 1 つも落ちない非等価の変異は 0）、すべて exact（38、45）。

## 検出力の欠け 11 件と、足した試験（ユーザーの回答に従う）

候補 `6430b75b` の最初の取り直しで、次の 11 件の変異はどの試験も落とさなかった（等価と言える理由は見つからなかった）。ユーザーの回答（contracts `516bb3fe`。上の共通の節）に従い、変異ごとに落ちる試験を足した（`c3209e1d`。`.test.mjs` だけ。規則の file・判定 3 file は変えていない）。足した試験は、変異を当てる前（baseline）に通り、当てると落ちることを hook で 1 件ずつ確かめた。

| 変異 | 試験 file | 足した試験 |
|---|---|---|
| K67-N-e1-ticket-null | followup.k66.test.mjs | K6/7 N-e1（検出力の取り直し）：親の ticket が null の記録も FR3:ticket-not-available を理由に持つ |
| K67-N-e3-requal | followup.k66.test.mjs | K6/7 N-e3（検出力の取り直し）：returned が true でも result が passed でなければ [artifact]（result の検査を returned の検査から分ける） |
| K67-N-g-key-k64 | k64-record.test.mjs | K6/7 N-g（検出力の取り直し）：旧形の counters の stamp0Missing を dPrimeCounters に出さない |
| K67-N-g-key-trace | trace-record.test.mjs | K6/7 N-g（検出力の取り直し）：旧形の poll の stamp0Missing を counter の run の key に入れない |
| K67-N-g-category-stamp | availability.test.mjs | K6/7 N-h1・N-g の試験に、readyFresh が true で旧形の stamp が stale・unavailable・stamp0-missing の graph-late も区分「その他」とする loop を足した |
| K67V3-U-id-not-in-revision | quality-verdict.test.mjs | 品質 v3 §2.1（検出力の取り直し）：1 つの edge の行の 1 つだけが Revision に無いとき、問題は fail のまま、status は fail |
| K67V3-U-no-endpoint-text | quality-verdict.test.mjs | 同上：1 つだけ hash が端点の text に合わない行 |
| K67V3-U-hash-both | quality-verdict.test.mjs | 同上：表示の hash は text に合うが、読み取った行の hash が違えば fail |
| K67V3-U-edge-unresolved | quality-verdict.test.mjs | 品質 v3 §2.1（検出力の取り直し）：同じ端点をつなぐ relation が path に 2 つ以上ある edge は hold（candidates 2） |
| K67V3-X-pageonly-fields | evidence-fields.test.mjs | v3 §4（検出力の取り直し）：evidenceFieldErrors は evidenceRaw・rowTexts の key を needle なしでも拒否する |
| K67V3-X-opt-needle-entities | evidence-fields.test.mjs | v3 §4 (ii)（検出力の取り直し）：走査する本文に Entity の summary を含める |

- **`K67V3-X-opt-needle-entities`**：下書きでは任意の変異だった（entities の summary を needle に採る処理）。`plaintextNeedlesOf` の規則（v3 §4 (ii)「Scene の本文と Entity の summary を走査する」）が要るもの（受領書に Entity の summary が平文で混ざったときに止める）なので、**変異を残し、試験を足した**。集合から外していない。
- `K67-N-g-key-k64`・`K67-N-g-key-trace` は、最初は対象の試験 file の指定が `followup.k66.test.mjs` で、`trace-record.mjs` を読み込まない試験を指していた（probe が 0 件）。`k64-record.test.mjs`・`trace-record.test.mjs` を指すよう直した。
- 品質判定 v3 の `quality-evidence-items.mjs` が edge 単位の判定（`1dd6fb35`）に変わったので、下書きの hold 分岐の変異 4 件（`K67V3-U-hold-branch`、`-unread-counter`、`-hold-undecided`、`-reintroduce-skip`。対象のコードが消えた）を外し、新しい構造の `K67V3-U-edge-unresolved`、`-unread-edge-skip`、`-directed` を足した。

## 期待の決め方（開示）

`expected`（落ちるべき試験の file・行・題の先頭）は、変異を当てる前に決めたものではない。K6/7 の負例の題（K6/7 本文の表の「期待」の列に当たる試験）を下書きが推測し、**最初の run で落ちた試験を見て、変異との対応（例：`K67-N-h2-reading` は N-h2・攻撃 33）を確かめた上で写し直した**。写し直しは、別の試験も落ちる・下書きが推測した試験が落ちない、のどちらかで、検出されないものは無い（検出力の欠けとは別）。写し直した run が記録の run。

core の写し直し 12 件：
- `K67-N-e1-ticket`：期待 278 → 278、630
- `K67-N-g-key-followup`：期待 175 → 68、94、140、165、175、195、203、211、219、228、241、278、289、298、310、328、346、358、370、382、395、408、423、459、466、473、480、494、547、556、567、576、584、597、630、696
- `K67-R12-readyfresh-stamp`：期待 378 → 378、409
- `K67-N-h1-stale-start`：期待 521 → 521、744
- `K67-N-h1-fresh-start`：期待 521 → 521、744、780
- `K67-N-h2-reading`：期待 592、628、687 → 462、592、628、948
- `K67-N-h2-branch`：期待 592、628 → 592、628、948
- `K67-N-h5-fold-before`：期待 687 → 462、474、592、687、948
- `K67-N-h-before-record`：期待 592 → 462、474、592、687、703
- `K67-N-h-lapse-none`：期待 687、703 → 687、948
- `K67-N-h3-ticket-freshness`：期待 1265 → 1171、1265、1308、1352
- `K67-N-h6-ticket-lapse`：期待 1308、1352 → 1171、1308、1352

v3 の写し直し 15 件：
- `K67V3-U-first-null`：期待 2632、2803 → 2632、2803、2904、3658
- `K67V3-U-range`：期待 2632、2803 → 2632、2803、2904
- `K67V3-U-endpoint-without`：期待 2632 → 2632、2751
- `K67V3-U-undecided-guard`：期待 2751、2803 → 2632、2751
- `K67V3-U-unread-edge-skip`：期待 2803、2904 → 2751、2803、2904
- `K67V3-P-seed-hold`：期待 3041、3835 → 3835
- `K67V3-R-graph-only-row`：期待 3183 → 2571、3183、3539
- `K67V3-A-range`：期待 3305 → 3305、3404
- `K67V3-A-hash`：期待 3305、3855 → 3305
- `K67V3-G-order`：期待 2571、2632 → 2632、3539
- `K67V3-X-needle-value`：期待 304 → 304、545
- `K67V3-X-needle-key`：期待 304 → 304、383
- `K67V3-X-pageonly-plaintext`：期待 511、304 → 511
- `K67V3-X-no-needle-precheck`：期待 304 → 304、511
- `K67V3-X-rowexcerpts-check`：期待 250 → 250、383

- `K67-N-g-key-followup` は `dPrimeCounters` の key の一覧に `stamp0Missing` を戻す変異で、全 record がその key を欠くため `followup.k66.test.mjs` の 34 件が落ちる（期待にすべて書いた）。
- `run.mjs` は変異ごとに `testFile` の 1 file だけを走らせ、その file の落ちた試験だけを期待と照合する。**ほかの file の試験が同じ変異で落ちるかは、この記録では見ていない**（例：`K67-N-f1-*`・`-f2-*` は `native-sample.test.mjs` だけを期待とし、`followup.k66.test.mjs` の N-f1・N-f2 は期待に入れていない。同様に `K67-N-f3-all-pending`、`K67-N-h6-ticket-lapse`、`K67V3-X-needle-value`）。

## 7 回目の記録（K6/6）との対応

K6/6 の stamp の変異 3 件（`K66-N-d-stale`、`K66-FR3-stamp-other`、`K66-FR3-revalidation`）の廃止と `K66-FR3-ticket` の移動は `k66-synthetic-detection-record.md` に書いた。その対（置換）は `K67-N-g-stale-read`（stamp の戻し）、`K67-N-f1-*`・`K67-N-f2-*`（(ii-b) の欠け・形）、`K67-N-e3-requal`（旧 `K66-FR3-revalidation` は等価だったが、K6/7 では result と returned の検査を別に落とす）。

## core の変異（落ちた試験）

| 変異 | 下位条件 | 変異の file | 落ちた試験 | 備考 |
|---|---|---|---|---|
| K67-N-e1-ticket | K6/7 N-e1 (N3c') | followup.mjs | followup.k66.test.mjs:278, followup.k66.test.mjs:630 |  |
| K67-N-e1-ticket-null | K6/7 N-e1 | followup.mjs | followup.k66.test.mjs:289 |  |
| K67-N-e2-drift | K6/7 N-e2 | followup.mjs | followup.k66.test.mjs:298 |  |
| K67-N-e5-not-clear | K6/7 N-e5 | followup.mjs | followup.k66.test.mjs:358 |  |
| K67-N-e3-requal | K6/7 N-e3 | followup.mjs | followup.k66.test.mjs:328 |  |
| K67-N-e6-returned | K6/7 N-e6 | followup.mjs | followup.k66.test.mjs:370 |  |
| K67-N-f1-drift-missing | K6/7 N-f1 (N3b') | native-sample.mjs | native-sample.test.mjs:185 |  |
| K67-N-f1-requal-missing | K6/7 N-f1 | native-sample.mjs | native-sample.test.mjs:185 |  |
| K67-N-f2-returned | K6/7 N-f2 | native-sample.mjs | native-sample.test.mjs:185 |  |
| K67-N-f2-cause | K6/7 N-f2 | native-sample.mjs | native-sample.test.mjs:185 |  |
| K67-N-f2-reason | K6/7 N-f2 | native-sample.mjs | native-sample.test.mjs:185 |  |
| K67-N-f3-all-pending | K6/7 N-f3 | native-sample.mjs | native-sample.test.mjs:185 |  |
| K67-N-g-stale-read | K6/7 N-g | followup.mjs | followup.k66.test.mjs:68, followup.k66.test.mjs:408 |  |
| K67-N-g-key-followup | K6/7 N-g | followup.mjs | followup.k66.test.mjs:68, followup.k66.test.mjs:94, followup.k66.test.mjs:140, followup.k66.test.mjs:165, followup.k66.test.mjs:175, followup.k66.test.mjs:195, followup.k66.test.mjs:203, followup.k66.test.mjs:211, followup.k66.test.mjs:219, followup.k66.test.mjs:228, followup.k66.test.mjs:241, followup.k66.test.mjs:278, followup.k66.test.mjs:289, followup.k66.test.mjs:298, followup.k66.test.mjs:310, followup.k66.test.mjs:328, followup.k66.test.mjs:346, followup.k66.test.mjs:358, followup.k66.test.mjs:370, followup.k66.test.mjs:382, followup.k66.test.mjs:395, followup.k66.test.mjs:408, followup.k66.test.mjs:423, followup.k66.test.mjs:459, followup.k66.test.mjs:466, followup.k66.test.mjs:473, followup.k66.test.mjs:480, followup.k66.test.mjs:494, followup.k66.test.mjs:547, followup.k66.test.mjs:556, followup.k66.test.mjs:567, followup.k66.test.mjs:576, followup.k66.test.mjs:584, followup.k66.test.mjs:597, followup.k66.test.mjs:630, followup.k66.test.mjs:696 |  |
| K67-N-g-key-k64 | K6/7 N-g | k64-record.mjs | k64-record.test.mjs:754 |  |
| K67-N-g-key-trace | K6/7 N-g | trace-record.mjs | trace-record.test.mjs:69 |  |
| K67-R12-readyfresh-stamp | K6/7 R-12 | join.mjs | outcome.test.mjs:378, outcome.test.mjs:409 |  |
| K67-N-g-category-stamp | K6/7 N-g | availability.mjs | availability.test.mjs:521 |  |
| K67-N-h1-stale-start | K6/7 N-h1 | availability.mjs | availability.test.mjs:521, availability.test.mjs:744 |  |
| K67-N-h1-fresh-start | K6/7 N-h1 | availability.mjs | availability.test.mjs:521, availability.test.mjs:744, availability.test.mjs:780 |  |
| K67-N-h2-reading | K6/7 N-h2 | availability.mjs | availability.test.mjs:462, availability.test.mjs:592, availability.test.mjs:628, availability.test.mjs:948 |  |
| K67-N-h2-branch | K6/7 N-h2 | availability.mjs | availability.test.mjs:592, availability.test.mjs:628, availability.test.mjs:948 |  |
| K67-N-h5-fold-before | K6/7 N-h5 | availability.mjs | availability.test.mjs:462, availability.test.mjs:474, availability.test.mjs:592, availability.test.mjs:687, availability.test.mjs:948 |  |
| K67-N-h7-unknown-a | K6/7 N-h7 | availability.mjs | availability.test.mjs:657 |  |
| K67-N-h7-unknown-b | K6/7 N-h7 | availability.mjs | availability.test.mjs:657 |  |
| K67-N-h-before-record | K6/7 N-h2 | availability.mjs | availability.test.mjs:462, availability.test.mjs:474, availability.test.mjs:592, availability.test.mjs:687, availability.test.mjs:703 |  |
| K67-N-h-lapse-none | K6/7 N-h5 | availability.mjs | availability.test.mjs:687, availability.test.mjs:948 |  |
| K67-N-h3-ticket-freshness | K6/7 N-h3 | followup.mjs | followup.test.mjs:1171, followup.test.mjs:1265, followup.test.mjs:1308, followup.test.mjs:1352 |  |
| K67-N-h6-ticket-lapse | K6/7 N-h6 | followup.mjs | followup.test.mjs:1171, followup.test.mjs:1308, followup.test.mjs:1352 |  |
| K67-N-h4-setup | K6/7 N-h4 | followup.mjs | followup.test.mjs:1308 |  |
| K67-N-h4-setup-row | K6/7 N-h4 | followup.mjs | followup.test.mjs:1308 |  |
| K67-N9-receipt-sha | K6/7 N9' | receipt.mjs | receipt.test.mjs:472 |  |
| K67-N9-receipt-commit | K6/7 N9' | receipt.mjs | receipt.test.mjs:472 |  |
| K67-N9-receipt-null-descriptor | K6/7 N9' | receipt.mjs | receipt.test.mjs:472 |  |
| K67-N9-receipt-required | K6/7 N9' | receipt.mjs | receipt.test.mjs:472 |  |
| K67-N9-admission-commit | K6/7 N9' | admission.mjs | admission.test.mjs:1162 |  |
| K67-N9-admission-null | K6/7 N9' | admission.mjs | admission.test.mjs:1162 |  |
| K67-N9-admission-bound | K6/7 N9' | admission.mjs | admission.test.mjs:1162 |  |

## 品質判定 v3 の変異（落ちた試験）

| 変異 | 下位条件 | 変異の file | 落ちた試験 | 備考 |
|---|---|---|---|---|
| K67V3-U-id-not-in-revision | v3 §2.1 (ii) | quality-evidence-items.mjs | quality-verdict.test.mjs:3658 |  |
| K67V3-U-no-endpoint-text | v3 §2.1 (i) | quality-evidence-items.mjs | quality-verdict.test.mjs:3658 |  |
| K67V3-U-first-null | v3 §2.1 (i) | quality-evidence-items.mjs | quality-verdict.test.mjs:2632, quality-verdict.test.mjs:2803, quality-verdict.test.mjs:2904, quality-verdict.test.mjs:3658 |  |
| K67V3-U-hash-both | v3 §2.1 (i) | quality-evidence-items.mjs | quality-verdict.test.mjs:3658 |  |
| K67V3-U-range | v3 §2.1 (i) | quality-evidence-items.mjs | quality-verdict.test.mjs:2632, quality-verdict.test.mjs:2803, quality-verdict.test.mjs:2904 |  |
| K67V3-U-endpoint-without | v3 §2.1 (iii) | quality-evidence-items.mjs | quality-verdict.test.mjs:2632, quality-verdict.test.mjs:2751 |  |
| K67V3-U-undecided-guard | v3 §2.1 (iii) | quality-evidence-items.mjs | quality-verdict.test.mjs:2632, quality-verdict.test.mjs:2751 |  |
| K67V3-U-edge-unresolved | v3 §2.1 hold (再確認 必須 1) | quality-evidence-items.mjs | quality-verdict.test.mjs:3715 |  |
| K67V3-U-unread-edge-skip | v3 §2.1 hold (再確認 必須 1) | quality-evidence-items.mjs | quality-verdict.test.mjs:2751, quality-verdict.test.mjs:2803, quality-verdict.test.mjs:2904 |  |
| K67V3-U-directed | v3 §2.1 (再確認 必須 1) | quality-evidence-items.mjs | quality-verdict.test.mjs:2904 |  |
| K67V3-P-graph-only-pin | v3 §2.2 | quality-evidence-items.mjs | quality-verdict.test.mjs:3041 |  |
| K67V3-P-graph-only-hop | v3 §2.2 | quality-evidence-items.mjs | quality-verdict.test.mjs:3041 |  |
| K67V3-P-graph-only-scene | v3 §2.2 | quality-evidence-items.mjs | quality-verdict.test.mjs:3041 |  |
| K67V3-P-attachment-outside | v3 §2.2 | quality-evidence-items.mjs | quality-verdict.test.mjs:3041 |  |
| K67V3-P-terminal | v3 §2.2 | quality-evidence-items.mjs | quality-verdict.test.mjs:3041, quality-verdict.test.mjs:3800 |  |
| K67V3-P-attachment-hop | v3 §2.2 | quality-evidence-items.mjs | quality-verdict.test.mjs:3041 |  |
| K67V3-P-seed-hold | v3 §2.2 | quality-evidence-items.mjs | quality-verdict.test.mjs:3835 |  |
| K67V3-R-compare | v3 §2.3 | quality-evidence-items.mjs | quality-verdict.test.mjs:3183 |  |
| K67V3-R-values | v3 §2.3 | quality-evidence-items.mjs | quality-verdict.test.mjs:3183 |  |
| K67V3-R-length | v3 §2.3 | quality-evidence-items.mjs | quality-verdict.test.mjs:3183 |  |
| K67V3-R-generation | v3 §2.3 | quality-evidence-items.mjs | quality-verdict.test.mjs:3183 |  |
| K67V3-R-ir-ready | v3 §2.3 | quality-evidence-items.mjs | quality-verdict.test.mjs:3183 |  |
| K67V3-R-graph-only-row | v3 §2.3 | quality-evidence-items.mjs | quality-verdict.test.mjs:2571, quality-verdict.test.mjs:3183, quality-verdict.test.mjs:3539 |  |
| K67V3-A-scene | v3 §2.4 | quality-evidence-items.mjs | quality-verdict.test.mjs:3305 |  |
| K67V3-A-range | v3 §2.4 | quality-evidence-items.mjs | quality-verdict.test.mjs:3305, quality-verdict.test.mjs:3404 |  |
| K67V3-A-hash | v3 §2.4 | quality-evidence-items.mjs | quality-verdict.test.mjs:3305 |  |
| K67V3-A-length | v3 §2.4 | quality-evidence-items.mjs | quality-verdict.test.mjs:3305 |  |
| K67V3-A-hold-no-row | v3 §2.4 | quality-evidence-items.mjs | quality-verdict.test.mjs:3305 |  |
| K67V3-G-not-evaluable | v3 §2.0 | quality-evidence-items.mjs | quality-verdict.test.mjs:3404 |  |
| K67V3-G-order | v3 §2.0 | quality-evidence-items.mjs | quality-verdict.test.mjs:2632, quality-verdict.test.mjs:3539 |  |
| K67V3-X-needle-value | v3 §4 (ii) | evidence-fields.mjs | evidence-fields.test.mjs:304, evidence-fields.test.mjs:545 |  |
| K67V3-X-needle-key | v3 §4 (ii) | evidence-fields.mjs | evidence-fields.test.mjs:304, evidence-fields.test.mjs:383 |  |
| K67V3-X-evidence-json | v3 §4 (iii) | evidence-fields.mjs | evidence-fields.test.mjs:304 |  |
| K67V3-X-pageonly-plaintext | v3 §4 | evidence-fields.mjs | evidence-fields.test.mjs:511 |  |
| K67V3-X-pageonly-fields | v3 §4 | evidence-fields.mjs | evidence-fields.test.mjs:528 |  |
| K67V3-X-no-needle-precheck | v3 §4 | evidence-fields.mjs | evidence-fields.test.mjs:304, evidence-fields.test.mjs:511 |  |
| K67V3-X-key-message | v3 §4 | evidence-fields.mjs | evidence-fields.test.mjs:383 |  |
| K67V3-X-observation-check | v3 §4 (i) | evidence-fields.mjs | evidence-fields.test.mjs:250, evidence-fields.test.mjs:418 |  |
| K67V3-X-rowexcerpts-check | v3 §4 (i) | evidence-fields.mjs | evidence-fields.test.mjs:250, evidence-fields.test.mjs:383 |  |
| K67V3-X-receipt-fields | v3 §4 | receipt.mjs | receipt.test.mjs:1676 |  |
| K67V3-X-receipt-needles | v3 §4 | receipt.mjs | receipt.test.mjs:1676 |  |
| K67V3-X-opt-hex | v3 §4 (i) | evidence-fields.mjs | evidence-fields.test.mjs:250 |  |
| K67V3-X-opt-id | v3 §4 (i) | evidence-fields.mjs | evidence-fields.test.mjs:250 |  |
| K67V3-X-opt-needle-scenes | v3 §4 (ii) | evidence-fields.mjs | evidence-fields.test.mjs:344 |  |
| K67V3-X-opt-needle-entities | v3 §4 (ii) | evidence-fields.mjs | evidence-fields.test.mjs:545 |  |

## 取り直しの規則

この候補（`c3209e1d0881fdee1acead14e20645d9b7e87494`）以後に、K6/7・品質判定 v3 の検出に関わる file（`followup.mjs`、`join.mjs`、`availability.mjs`、`native-sample.mjs`、`run-sample.mjs`、`k64-record.mjs`、`trace-record.mjs`、`receipt.mjs`、`admission.mjs`、`evidence-fields.mjs`、`quality-evidence-items.mjs`、`quality-verdict*.mjs`、または上の試験 file）を変えた commit を S4 以後の判定に使うなら、この記録はその候補では無効で、その候補で取り直す。⑤〜⑦ の間は規則の file（`scripts/quality/nir1-graph-eval/*.mjs`。試験を含む）を変えない。

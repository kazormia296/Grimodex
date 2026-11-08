# K6/6 の Negative・Positive の合成の記録による検出力の記録（K6/6 の harness の実装。2026-11-08）

K6/6「この draft が確認されたときに変わる harness の file」の表の「検出力の記録」の行（K6/6-P・N の合成の記録で、下位条件ごとに取り直す）に対する記録。K6/5 の前例（`../k65-detection-2026-11-07/`）と同じ道具で、K6/6 の first-render の下位条件ごとに変異を当て、その下位条件の試験だけが落ちることを示す。**Graph の実行出力は一つも見ていない**（合成の記録の試験と、候補の worktree の読込み時の置換だけ。製品・Electron・Native は起動していない）。

- 実行：2026-11-08T08:57:55.994Z から 2026-11-08T09:02:28.736Z（UTC）。K6/6 の凍結 `56fb4fad` の後、S2 追補・S4 の 7 回目の前、正式の run の前。
- 候補：`dda975bc1afbad47cc9a680a71e9deb5a7c90282`（tree `f982df6335c6eae43e5e9f378adeb8d496ac898f`。枝 `claude/k66-harness`。試作 `d12b78e5` の取り込み `00f9c999`、`K66_FREEZE` の固定と品質判定 v2 D3 (d) の実装 `1fdeed6f`、試験の穴を埋めた `dda975bc`）。detach の worktree で、node v22.23.3、work tree は clean（run の前後で `git status --porcelain --untracked-files=all` が空、ignored の一覧も不変）。
- 全体の command：`node --test --test-reporter=tap scripts/quality/nir1-graph-eval/*.test.mjs`（47 file）。結果：**714 件、pass 714、fail 0、cancelled 0、skipped 0、todo 0**。TAP の sha256 `d5f3369d9e10db8ce6c03011de09a7d6dae267376517363ab3561fdc2158ae14`。（S2 の bytes の pin の試験は `scripts/quality/nir1-graph/` にあり、この command に含まれない。赤の一覧は PR 本文と DR-CP4-K66-1 に書く。）
- 変異の対象の試験（`followup.k66.test.mjs`、`outcome.test.mjs`、`receipt.test.mjs`、`admission.test.mjs`、`quality-verdict.test.mjs`）の baseline：141 件、pass 141、fail 0。陽性の対照 9 件はすべて baseline で ok（`positive-k66.json`）。probe（hook が試験の子 process で効くこと）はすべて ok。
- **変異 54 件**：すべて 1 回だけ当たり（`allHitOnce`）、表どおりに落ち余分も欠けも無い（`exact` 54 件）。うち等価の変異 2 件は試験が落ちない（期待どおり）。残り 52 件は、その下位条件の試験（下の表の `落ちた試験`）が落ちる。
- 道具・変異の一覧・期待の決め方（期待は最初の run の結果から写した。変異の前に決めていない）は `tools/README.md`。結果 `results-k66-dda975bc.json`（sha256 `23c1f8c52df842fc9eaa7ba077e58bb530e3f3f9712abd0bd3cd5fbc868f6fa4`）、件数 `counts-dda975bc.json`（sha256 `4fa97c2ea558925bfb38c68772750d4f3791516a913d600f7f3695186efe6b0c`）。

## K6/6-P と K6/6-N の試験（下位条件ごとの件数）

題の記号の部分に下位条件の記号を持つ試験の数（`tools/count-n.mjs`。「N2c〜N2g」のような範囲は展開）。番号だけの行（N1 など）は、その番号の下位条件のどれかを持つ試験の和集合。すべて pass。

| 記号 | 件 | 試験 file | 結果 |
|---|---|---|---|
| K6/6-P1 | 2 | followup.k66.test.mjs | pass |
| K6/6-P2 | 1 | outcome.test.mjs | pass |
| K6/6-P3 | 1 | followup.k66.test.mjs | pass |
| K6/6-P4 | 1 | followup.k66.test.mjs | pass |
| K6/6-P5 | 1 | followup.k66.test.mjs | pass |
| K6/6-N1 | 2 | followup.k66.test.mjs | pass |
| K6/6-N1a | 1 | followup.k66.test.mjs | pass |
| K6/6-N1b | 1 | followup.k66.test.mjs | pass |
| K6/6-N2 | 4 | followup.k66.test.mjs | pass |
| K6/6-N2a | 1 | followup.k66.test.mjs | pass |
| K6/6-N2b | 1 | followup.k66.test.mjs | pass |
| K6/6-N2c | 1 | followup.k66.test.mjs | pass |
| K6/6-N2d | 1 | followup.k66.test.mjs | pass |
| K6/6-N2e | 1 | followup.k66.test.mjs | pass |
| K6/6-N2f | 1 | followup.k66.test.mjs | pass |
| K6/6-N2g | 1 | followup.k66.test.mjs | pass |
| K6/6-N2h | 1 | followup.k66.test.mjs | pass |
| K6/6-N3 | 5 | followup.k66.test.mjs | pass |
| K6/6-N3a | 1 | followup.k66.test.mjs | pass |
| K6/6-N3b | 1 | followup.k66.test.mjs | pass |
| K6/6-N3c | 1 | followup.k66.test.mjs | pass |
| K6/6-N3d | 1 | followup.k66.test.mjs | pass |
| K6/6-N3e | 1 | followup.k66.test.mjs | pass |
| K6/6-N4 | 1 | followup.k66.test.mjs | pass |
| K6/6-N5 | 1 | followup.k66.test.mjs | pass |
| K6/6-N5a | 1 | followup.k66.test.mjs | pass |
| K6/6-N5b | 1 | followup.k66.test.mjs | pass |
| K6/6-N5c | 1 | followup.k66.test.mjs | pass |
| K6/6-N5d | 1 | followup.k66.test.mjs | pass |
| K6/6-N6 | 3 | followup.k66.test.mjs | pass |
| K6/6-N6a | 1 | followup.k66.test.mjs | pass |
| K6/6-N6b | 1 | followup.k66.test.mjs | pass |
| K6/6-N6c | 1 | followup.k66.test.mjs | pass |
| K6/6-N7 | 1 | followup.k66.test.mjs | pass |
| K6/6-N7a | 1 | followup.k66.test.mjs | pass |
| K6/6-N7b | 1 | followup.k66.test.mjs | pass |
| K6/6-N7c | 1 | followup.k66.test.mjs | pass |
| K6/6-N7d | 1 | followup.k66.test.mjs | pass |
| K6/6-N7e | 1 | followup.k66.test.mjs | pass |
| K6/6-N8 | 1 | followup.k66.test.mjs | pass |
| K6/6-N9 | 2 | admission.test.mjs, receipt.test.mjs | pass |
| K6/6-N10 | 1 | followup.k66.test.mjs | pass |
| K6/6-N10a | 1 | followup.k66.test.mjs | pass |
| K6/6-N10b | 1 | followup.k66.test.mjs | pass |
| K6/6-N11 | 2 | followup.k66.test.mjs | pass |
| K6/6-N11a | 1 | followup.k66.test.mjs | pass |
| K6/6-N11b | 1 | followup.k66.test.mjs | pass |
| K6/6-N12 | 3 | followup.k66.test.mjs | pass |
| K6/6-N12a | 1 | followup.k66.test.mjs | pass |
| K6/6-N12b | 1 | followup.k66.test.mjs | pass |
| K6/6-N12c | 1 | followup.k66.test.mjs | pass |
| K6/6-N13 | 3 | outcome.test.mjs, quality-verdict.test.mjs | pass |
| K6/6-N13a | 2 | outcome.test.mjs, quality-verdict.test.mjs | pass |
| K6/6-N13b | 2 | outcome.test.mjs, quality-verdict.test.mjs | pass |

K6/6-N1〜N13 とK6/6-P1〜P5 のすべてに 1 件以上の試験がある。FR-3 の合流の項目（N3d）と edgeCount（N3e）、品質の FAIL の条件の宣言・outcome（N13 の側）は、この取り直しの最初の run で変異が生き残ったので試験を足した（`tools/README.md`）。

## 下位条件ごとの変異（K6/6-P・N の検出力）

`変異` は `tools/mutations-k66.json` の id（find と replace の bytes はその file）。`対応` は K6/6 の記号。`落ちた試験` は、その変異だけで落ちた試験の file:行。等価の変異は試験が落ちないことが期待。

| 変異 | 対応 | 変える file | 落ちた試験 |
|---|---|---|---|
| K66-N-d-stale | N-d | followup.mjs | followup.k66.test.mjs:301 |
| K66-N-d-driftAtQuery | N-d | followup.mjs | followup.k66.test.mjs:427 |
| K66-N-d-prepareFailures | N-d | followup.mjs | followup.k66.test.mjs:427 |
| K66-FR1-source | FR-1 | followup.mjs | followup.k66.test.mjs:436 |
| K66-a-reachedQuiet | N1a | followup.mjs | followup.k66.test.mjs:188 |
| K66-a-r1-self-report | N1b | followup.mjs | followup.k66.test.mjs:196 |
| K66-b-begin-records | N2a | followup.mjs | followup.k66.test.mjs:204 |
| K66-b-start-slot | N2b | followup.mjs | followup.k66.test.mjs:212 |
| K66-b-preparesStarted | N2c | followup.mjs | followup.k66.test.mjs:158, followup.k66.test.mjs:221, followup.k66.test.mjs:522 |
| K66-b-preparesReady | N2d | followup.mjs | followup.k66.test.mjs:221 |
| K66-b-deferredReleased | N2e | followup.mjs | followup.k66.test.mjs:221 |
| K66-b-staleReadyRetired | N2g | followup.mjs | followup.k66.test.mjs:221 |
| K66-c-unrecorded | N2h | followup.mjs | followup.k66.test.mjs:234 |
| K66-c-diff | N2h | followup.mjs | followup.k66.test.mjs:234, followup.k66.test.mjs:586 |
| K66-c-next-undefined | (c) | followup.mjs | followup.k66.test.mjs:234 |
| K66-FR3-ticket | N3c | followup.mjs | followup.k66.test.mjs:268 |
| K66-FR3-declaration | N12a | followup.mjs | followup.k66.test.mjs:447, followup.k66.test.mjs:522 |
| K66-FR3-not-joined | N3 | followup.mjs | followup.k66.test.mjs:288 |
| K66-FR3-revalidation | N11b | followup.mjs | （等価）試験は落ちない |
| K66-FR3-edge-count | N3 | followup.mjs | followup.k66.test.mjs:294 |
| K66-FR3-stamp-other | N3a | followup.mjs | followup.k66.test.mjs:251, followup.k66.test.mjs:264, followup.k66.test.mjs:522 |
| K66-FR4-begins | N5a | followup.mjs | followup.k66.test.mjs:317 |
| K66-FR4-lateCached | N5b | followup.mjs | followup.k66.test.mjs:317 |
| K66-FR4-cacheHits | N5c | followup.mjs | followup.k66.test.mjs:317 |
| K66-FR4-cache-left | N5d | followup.mjs | followup.k66.test.mjs:317 |
| K66-FR4-after-block | N5a | followup.mjs | followup.k66.test.mjs:317 |
| K66-FR4-after-release-block | N5a | followup.mjs | followup.k66.test.mjs:317 |
| K66-FR5-declaration | N12a | followup.mjs | followup.k66.test.mjs:447, followup.k66.test.mjs:522 |
| K66-FR5-publishCount | N12b | followup.mjs | followup.k66.test.mjs:469 |
| K66-FR6-notice | N6a | followup.mjs | followup.k66.test.mjs:353 |
| K66-FR6-child | N6b | followup.mjs | followup.k66.test.mjs:360 |
| K66-FR6-ir-retry | N6c | followup.mjs | followup.k66.test.mjs:367 |
| K66-FR7-no-record | N7a | followup.mjs | followup.k66.test.mjs:374 |
| K66-FR7-basis | N7b | followup.mjs | followup.k66.test.mjs:374 |
| K66-FR7-unresolved | N7c | followup.mjs | followup.k66.test.mjs:374 |
| K66-FR7-no-edge | N7d | followup.mjs | followup.k66.test.mjs:294, followup.k66.test.mjs:374 |
| K66-FR7-expected | N7e | followup.mjs | followup.k66.test.mjs:374 |
| K66-6-contributed-outcome | N13 | followup.mjs | outcome.test.mjs:783 |
| K66-6-contributed-joined | N13 | followup.mjs | （等価）試験は落ちない |
| K66-6-contributed-used | N13 | followup.mjs | outcome.test.mjs:783 |
| K66-6-contributed-edgeCount | N13 | followup.mjs | outcome.test.mjs:783 |
| K66-6-outcome-fail | N13 | outcome.mjs | outcome.test.mjs:745, outcome.test.mjs:761 |
| K66-5-heading-rate-entry | 5 | availability.mjs | followup.k66.test.mjs:490, followup.k66.test.mjs:522 |
| K66-N9-receipt-sha | N9 | receipt.mjs | receipt.test.mjs:402 |
| K66-N9-receipt-commit | N9 | receipt.mjs | receipt.test.mjs:402 |
| K66-N9-receipt-null-descriptor | N9 | receipt.mjs | receipt.test.mjs:402 |
| K66-N9-receipt-required-when-formal | N9 | receipt.mjs | receipt.test.mjs:402 |
| K66-N9-admission-commit | N9 | admission.mjs | admission.test.mjs:1025 |
| K66-N9-admission-sha | N9 | admission.mjs | admission.test.mjs:1025 |
| K66-N9-admission-null | N9 | admission.mjs | admission.test.mjs:1025 |
| K66-D3d-not-latest | D3(d) | quality-verdict.mjs | quality-verdict.test.mjs:1363 |
| K66-D3d-no-edge-hold | D3(d) | quality-verdict.mjs | quality-verdict.test.mjs:1363 |
| K66-D3d-no-setup-hold | D3(d) | quality-verdict.mjs | quality-verdict.test.mjs:1363 |
| K66-D3d-refused-skipped | D3(d) | quality-verdict.mjs | quality-verdict.test.mjs:1561 |

## 残る穴・読み

- 等価の変異 2 件の等価性は読みによる。`K66-FR3-revalidation`：`classifyJoin` が joined の sample に revalidation passed を要求し、first-render の候補はそこを通った後にだけ来る（FR-3 の revalidation の検査は、記録の誤りを見つける空の検査）。`K66-6-contributed-joined`：`parentContributed` は `join.inWindow` を先に要求し、`classifyJoin` は inWindow を joined のときだけ返す。
- 変異の期待の行は、変異の前に決めていない（最初の run から写した）。K6/4-N1〜N40、K6/5-N1〜N4、SP-N の変異は今回当てていない（変えていない file の記録は `../k65-detection-2026-11-07/` のまま。`followup.mjs`・`outcome.mjs`・`receipt.mjs`・`admission.mjs`・`constants.mjs` は K6/6 で変わったので、K6/4・K6/5 の検出力の記録は S4 の 7 回目の前に取り直すかを integrator が決める）。
- 検出力の記録は独立レビューを受けていない。
- `K66-N9-*` は `receipt.test.mjs`・`admission.test.mjs` の 1 件の試験が落ちる。1 件の試験が複数の検査（sha、commit、null の descriptor）を含むので、変異ごとの落ち方は同じ試験の中の別の assert（変異 id と assert の対応は目視）。
- 品質判定 v2 の D3 (d) の変異は `quality-verdict.test.mjs` の D2・D3 の試験と D3 (d) の試験で落ちる。v2 の確定・独立のコードレビューは未了（次の段）。


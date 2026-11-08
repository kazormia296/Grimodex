# K6/6 の Negative・Positive の合成の記録による検出力の記録（K6/6 の harness の実装。7 回目の S4 の取り直し。2026-11-08）

K6/6「この draft が確認されたときに変わる harness の file」の表の「検出力の記録」の行（K6/6-P・N の合成の記録で、下位条件ごとに取り直す）に対する記録。K6/5 の前例（`../k65-detection-2026-11-08/`、6 回目は `../k65-detection-2026-11-07/`）と同じ道具で、K6/6 の first-render の下位条件ごとに変異を当て、その下位条件の試験だけが落ちることを示す。**Graph の実行出力は一つも見ていない**（合成の記録の試験と、候補の worktree の読込み時の置換だけ。製品・Electron・Native は起動していない）。

**この版は 7 回目の S4 の取り直し**（S3 の 9 回目の B1-3：本体と追補 1 の記録は `dda975bc`・`720509a7` の後に `bf5ec217` が `followup.mjs` の `firstRenderOf` に FR-6 の `requeries` の検査を足し、`quality-verdict*.mjs` も `6342a02d`〜`99699dda` で変わったので、今の bytes に対して取られていなかった）。本体・追補（理由 code）・追補 2・3（品質判定 v2）の 3 組を、同じ候補で取り直した。前の版（候補 `dda975bc`、`720509a7`、`57c13dc5`、`99699dda`）の結果の JSON（`results-k66-dda975bc.json`、`results-k66-addendum-720509a7.json`、`results-k66-qv3-57c13dc5.json`、`results-k66-qv3-99699dda.json`、`counts-dda975bc.json`）は、その候補の記録として残す。

- 実行：本体 2026-11-08T14:55:50.658Z〜2026-11-08T14:58:15.216Z、追補 2026-11-08T14:59:58.423Z〜2026-11-08T15:01:04.966Z、追補 2・3（品質判定 v2）2026-11-08T14:42:11.436Z〜2026-11-08T14:44:48.500Z（UTC）。K6/6 の凍結 `56fb4fad` の後、S4b の前、正式の run の前。
- 候補：`f7e1fec1824952e3dbb03670b8a3f57029eb5aed`（tree `e3cc22261156433b462ad5dd16590002c71fcfa2`。枝 `claude/k66-harness`〔PR #840〕の、S3 の 9 回目の反映、再確認の指摘の直し、master `918d3def` と contracts `1c821c4b` の merge commit での取り込み、製品の変更の開示の追記の後の commit。S4b と bytes の pin の取り直しの前）。detach の worktree `claude-k67-detect`で、node v22.23.3、work tree は clean（run の前後で `git status --porcelain --untracked-files=all` が空、ignored の一覧も不変。3 組とも `verdict.clean: true`）。
- 全体の command：`node --test --test-reporter=tap scripts/quality/nir1-graph-eval/*.test.mjs`（K6/5 の記録の `baselineAll` と同じ run）。結果：**735 件、pass 735、fail 0、cancelled 0、skipped 0、todo 0**。TAP の sha256 `ace9ccce45e4d912792e63f10c89610af82a719011b65abba7437bf0c666bf0b`。（S2 の bytes の pin の試験は `scripts/quality/nir1-graph/` にあり、この command に含まれない。赤の一覧は PR 本文と DR に書く。）
- baseline：本体の対象の試験（`followup.k66.test.mjs`、`outcome.test.mjs`、`receipt.test.mjs`、`admission.test.mjs`、`quality-verdict.test.mjs`）154 件 pass、fail 0。追補の対象（`followup.k66.test.mjs`、`quality-verdict.test.mjs`）66 件 pass。追補 2・3 の対象（上の 2 file と `quality-verdict-first-run.test.mjs`、`pubg16-e2e-run.test.mjs`）84 件 pass。陽性の対照は本体 9 件（`positive-k66.json`）、追補 8 件（`positive-k66-addendum.json`）、追補 2・3 は `positive-k66-qv3.json` で、すべて baseline で ok（3 組とも `positiveControlsOk: true`）。probe（hook が試験の子 process で効くこと）もすべて ok。
- **変異 55 件（本体）、28 件（追補）、48 件（追補 2・3）**：すべて 1 回だけ当たり（`allHitOnce: true`）、表どおりに落ち余分も欠けも無い（`exact`：55、28、48。`allAsExpected: true`）。等価の変異は本体 2 件、追補 1 件、追補 2・3 1 件で、試験が落ちない（期待どおり）。残りは、その下位条件の試験（下の表の `落ちた試験`）が落ちる。検出は本体 53、追補 27、追補 2・3 47。
- 道具・変異の一覧・期待の決め方は `tools/README.md`。結果 `results-k66-f7e1fec1.json`（sha256 `817e565c7b572defcba8cbbbc6f92a64b9acfb0ea64c8da9d304c2ee73c91bf4`）、`results-k66-addendum-f7e1fec1.json`（`ad7204215fd83120940b802ebf9b77630421c6dd847dfb8225b0fe250c70ad5d`）、`results-k66-qv3-f7e1fec1.json`（`0955f2328a4ddbaaba8d361ff9e6cfd020b8330b4f485c1cc664d7f7b7127d5c`）、件数 `counts-f7e1fec1.json`（`77ef23c063ef0c248e43a5a6b9ffc4593ee0e0b33e9b2248361f7fd056d56fc1`）。

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
| K6/6-N6 | 4 | followup.k66.test.mjs | pass |
| K6/6-N6a | 1 | followup.k66.test.mjs | pass |
| K6/6-N6b | 1 | followup.k66.test.mjs | pass |
| K6/6-N6c | 1 | followup.k66.test.mjs | pass |
| K6/6-N6d | 1 | followup.k66.test.mjs | pass |
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

K6/6-N1〜N13 とK6/6-P1〜P5 のすべてに 1 件以上の試験がある（前の版と同じ。`K6/6-N6` は 3 件から 4 件に、`K6/6-N6d` が増えた：後で足された試験）。

## 下位条件ごとの変異（K6/6-P・N の検出力）

`変異` は `tools/mutations-k66.json` の id（find と replace の bytes はその file）。`対応` は K6/6 の記号。`落ちた試験` は、その変異だけで落ちた試験の file:行。等価の変異は試験が落ちないことが期待。

| 変異 | 対応 | 変える file | 落ちた試験 |
|---|---|---|---|
| K66-N-d-stale | N-d | followup.mjs | followup.k66.test.mjs:301 |
| K66-N-d-driftAtQuery | N-d | followup.mjs | followup.k66.test.mjs:441 |
| K66-N-d-prepareFailures | N-d | followup.mjs | followup.k66.test.mjs:441 |
| K66-FR1-source | FR-1 | followup.mjs | followup.k66.test.mjs:450 |
| K66-a-reachedQuiet | N1a | followup.mjs | followup.k66.test.mjs:188 |
| K66-a-r1-self-report | N1b | followup.mjs | followup.k66.test.mjs:196 |
| K66-b-begin-records | N2a | followup.mjs | followup.k66.test.mjs:204 |
| K66-b-start-slot | N2b | followup.mjs | followup.k66.test.mjs:212 |
| K66-b-preparesStarted | N2c | followup.mjs | followup.k66.test.mjs:158, followup.k66.test.mjs:221, followup.k66.test.mjs:536 |
| K66-b-preparesReady | N2d | followup.mjs | followup.k66.test.mjs:221 |
| K66-b-deferredReleased | N2e | followup.mjs | followup.k66.test.mjs:221 |
| K66-b-staleReadyRetired | N2g | followup.mjs | followup.k66.test.mjs:221 |
| K66-c-unrecorded | N2h | followup.mjs | followup.k66.test.mjs:234 |
| K66-c-diff | N2h | followup.mjs | followup.k66.test.mjs:234, followup.k66.test.mjs:600 |
| K66-c-next-undefined | (c) | followup.mjs | followup.k66.test.mjs:234 |
| K66-FR3-ticket | N3c | followup.mjs | followup.k66.test.mjs:268 |
| K66-FR3-declaration | N12a | followup.mjs | followup.k66.test.mjs:461, followup.k66.test.mjs:536 |
| K66-FR3-not-joined | N3 | followup.mjs | followup.k66.test.mjs:288 |
| K66-FR3-revalidation | N11b | followup.mjs | （等価）試験は落ちない |
| K66-FR3-edge-count | N3 | followup.mjs | followup.k66.test.mjs:294 |
| K66-FR3-stamp-other | N3a | followup.mjs | followup.k66.test.mjs:251, followup.k66.test.mjs:264, followup.k66.test.mjs:536 |
| K66-FR4-begins | N5a | followup.mjs | followup.k66.test.mjs:317 |
| K66-FR4-lateCached | N5b | followup.mjs | followup.k66.test.mjs:317 |
| K66-FR4-cacheHits | N5c | followup.mjs | followup.k66.test.mjs:317 |
| K66-FR4-cache-left | N5d | followup.mjs | followup.k66.test.mjs:317 |
| K66-FR4-after-block | N5a | followup.mjs | followup.k66.test.mjs:317 |
| K66-FR4-after-release-block | N5a | followup.mjs | followup.k66.test.mjs:317 |
| K66-FR5-declaration | N12a | followup.mjs | followup.k66.test.mjs:461, followup.k66.test.mjs:536 |
| K66-FR5-publishCount | N12b | followup.mjs | followup.k66.test.mjs:483 |
| K66-FR6-notice | N6a | followup.mjs | followup.k66.test.mjs:353 |
| K66-FR6-child | N6b | followup.mjs | followup.k66.test.mjs:360 |
| K66-FR6-ir-retry | N6c | followup.mjs | followup.k66.test.mjs:367 |
| K66-FR7-no-record | N7a | followup.mjs | followup.k66.test.mjs:388 |
| K66-FR7-basis | N7b | followup.mjs | followup.k66.test.mjs:388 |
| K66-FR7-unresolved | N7c | followup.mjs | followup.k66.test.mjs:388 |
| K66-FR7-no-edge | N7d | followup.mjs | followup.k66.test.mjs:294, followup.k66.test.mjs:388 |
| K66-FR7-expected | N7e | followup.mjs | followup.k66.test.mjs:388 |
| K66-6-contributed-outcome | N13 | followup.mjs | outcome.test.mjs:783 |
| K66-6-contributed-joined | N13 | followup.mjs | （等価）試験は落ちない |
| K66-6-contributed-used | N13 | followup.mjs | outcome.test.mjs:783 |
| K66-6-contributed-edgeCount | N13 | followup.mjs | outcome.test.mjs:783 |
| K66-6-outcome-fail | N13 | outcome.mjs | outcome.test.mjs:745, outcome.test.mjs:761 |
| K66-5-heading-rate-entry | 5 | availability.mjs | followup.k66.test.mjs:504, followup.k66.test.mjs:536 |
| K66-N9-receipt-sha | N9 | receipt.mjs | receipt.test.mjs:402 |
| K66-N9-receipt-commit | N9 | receipt.mjs | receipt.test.mjs:402 |
| K66-N9-receipt-null-descriptor | N9 | receipt.mjs | receipt.test.mjs:402 |
| K66-N9-receipt-required-when-formal | N9 | receipt.mjs | receipt.test.mjs:402 |
| K66-N9-admission-commit | N9 | admission.mjs | admission.test.mjs:1025 |
| K66-N9-admission-sha | N9 | admission.mjs | admission.test.mjs:1025 |
| K66-N9-admission-null | N9 | admission.mjs | admission.test.mjs:1025 |
| K66-D3d-not-latest | D3(d) | quality-verdict.mjs | quality-verdict.test.mjs:1379 |
| K66-D3d-no-edge-hold | D3(d) | quality-verdict.mjs | quality-verdict.test.mjs:1379 |
| K66-D3d-no-setup-hold | D3(d) | quality-verdict.mjs | quality-verdict.test.mjs:1379 |
| K66-D3d-refused-skipped | D3(d) | quality-verdict.mjs | quality-verdict.test.mjs:1379, quality-verdict.test.mjs:1637 |
| K66-D3d-prepare-skip-removed | D3(d) | quality-verdict.mjs | quality-verdict.test.mjs:1637 |

## 残る穴・読み

- 等価の変異 2 件の等価性は読みによる。`K66-FR3-revalidation`：`classifyJoin` が joined の sample に revalidation passed を要求し、first-render の候補はそこを通った後にだけ来る（FR-3 の revalidation の検査は、記録の誤りを見つける空の検査）。`K66-6-contributed-joined`：`parentContributed` は `join.inWindow` を先に要求し、`classifyJoin` は inWindow を joined のときだけ返す。
- 変異の期待の行は、変異の前に決めていない（最初の run から写した）。**7 回目の取り直しで `expected` を書き換えた範囲は、行番号のずれ・後で足された試験が追加で落とす分・2 件の変異の `find` の当て直し（下の「7 回目の取り直しで変えたこと」）だけで、題は変えていない**。K6/4-N1〜N40、K6/5-N1〜N4、SP-N の変異は、同じ候補で取り直した `../k65-detection-2026-11-08/` に記録した。
- 検出力の記録は独立レビューを受けていない（S3 の 9 回目の B1-3 の指摘を受けた取り直しで、S3 の再確認は取り直しの前の head を見ている）。取り直した bytes は S3 が見ていない。
- `K66-N9-*` は `receipt.test.mjs`・`admission.test.mjs` の 1 件の試験が落ちる。1 件の試験が複数の検査（sha、commit、null の descriptor）を含むので、変異ごとの落ち方は同じ試験の中の別の assert（変異 id と assert の対応は目視）。
- 品質判定 v2 の D3 (d) の変異は `quality-verdict.test.mjs` の D2・D3 の試験と D3 (d) の試験で落ちる。v2 の確定（`8b2a5daf`）と独立のコードレビューは済んでいる（DR-CP4-QV-3）。

## 7 回目の取り直しで変えたこと（開示）

- **`find` の当て直し（2 件）**：旧 `K66-D3d-refused-skipped`（`if (row?.refusedAtSetup) continue;` を削除）と旧 `K66-D3b-record-only-when-edges`（`if (hasRecord || mayHaveShownGraph) {` を edge のある子に限る）の `find` の code は、`bf5ec217` などの D3 の修正で置き換わり、今の候補には無い（最初の run で当たった数が 0 になり NG）。今の code に当て直した：`K66-D3d-refused-skipped` は `if (!row || row.refusedAtSetup === "prepare") continue;` を `if (!row || row.refusedAtSetup) continue;`（prepare 以外の拒否も飛ばす）に、`K66-D3b-record-only-when-edges` は記録の検査の枝 `  else {` を `  else if (mayHaveShownGraph) {` に。どちらも落ちる試験がある（生き残りではない）。
- **旧意図の変異を別 ID で足した（本体 54→55 件）**：`K66-D3d-prepare-skip-removed`（`if (!row || row.refusedAtSetup === "prepare") continue;` を `if (!row) continue;` にして prepare の拒否の skip を除く。旧 `K66-D3d-refused-skipped` の意図〔skip の除去〕）。落ちる試験がある（`quality-verdict.test.mjs:1637` の D3 (d) の試験）ので等価ではなく、検出として記録する。`quality-verdict.mjs` の prepare の拒否は `typedRevisions` に書かれない（setup driver は `refusedAtSetup` に書く）というコメントの読みとは別に、実行で確かめた。
- **期待（`expected`）を書き換えた範囲**：変異ごとの落ちた試験の題（`titlePrefix`）は変えていない。変えたのは（1）試験 file の行番号のずれ（`followup.k66.test.mjs`、`quality-verdict.test.mjs` の行が動いた。取り直しの最初の run で、本体 54 件中 19 件、追補 28 件中 15 件が期待と合わなかった。うち 2 件は上の `find` の不一致、残りは行のずれと、追補 2 以後に足した試験が同じ変異を追加で落とす分）、（2）追補の `K66-D3b-revision-resolution-always` と `K66-D3-disclose-missing-conditions` が、追補 2 以後に足した試験（`P3-1` の試験）でも落ちるようになった分を `expected` に足したこと、（3）2 件の `find` の当て直しと 1 件の追加の `expected` を run の結果から写したこと。期待を変異の前に決めていないことは変わらない（上の「残る穴」）。結果の `verdict` は、書き換えた期待で取り直した run のもの（最初の run の結果は記録に含めない）。陽性の対照の行（`positive-k66.json`）も、題で引いて行を直した。追補の run には `positive-k66-addendum.json`（`positive-k66.json` のうち `followup.k66.test.mjs` と `quality-verdict.test.mjs` の 8 件）を渡した（前の版は渡さず、`positiveControlsOk` は『渡していない』の意味で false だった）。
- **K6/5 の記録との関係**：K6/5-P1 の試験は K6/6 の変える点 4 により K6/6-P1 に置き換えられた（`../k65-detection-2026-11-08/` に記録）。

## 追補：レビュー指摘への対応（下位条件ごとの理由 code、N2e／N2f・N5・N8・N12c・(c) の区切り、品質判定 v2 の D3・D4）

独立のレビューが次を指摘した：(1) 記録の表は『変異 → 落ちた試験』だけで、`firstRenderFails` の理由 code が無い。(2) N8、N12c、(c) の hybrid を飛ばす経路・phase の区切りに変異が無く、N2e／N2f、N5 の block ごと、N10a／N10b は 1 つの試験を共有する。ここでその両方に答える。上の本体の表と結果は、7 回目の取り直しで同じ候補（`f7e1fec1`）の run に置き換えた（前の版の結果は `results-k66-dda975bc.json` に残る）。

- 実行：2026-11-08T14:59:58.423Z〜2026-11-08T15:01:04.966Z（UTC）、候補 `f7e1fec1824952e3dbb03670b8a3f57029eb5aed`。baseline 変異の対象の試験 66 件 pass、全体 735 件 pass。陽性の対照 8 件（`positive-k66-addendum.json`）ok。
- **変異 28 件**：すべて 1 回だけ当たり（`allHitOnce`）、表どおり（`exact` 28 件）。等価の変異は 1 件（下）、残り 27 件はその下位条件の試験が落ちる。変異は `tools/mutations-k66-addendum.json`、理由 code は `tools/reasons-k66.json`。結果 `results-k66-addendum-f7e1fec1.json`（sha256 `ad7204215fd83120940b802ebf9b77630421c6dd847dfb8225b0fe250c70ad5d`）。
- **期待の決め方（開示）**：`expected` は、最初の run（候補 `6342a02d`。期待は空）の結果から写した。最初の run で試験が落ちない変異が 2 件あった：`K66-c-next-includes-requery`（試験を `720509a7` で足した）と `K66-D3-disclose-outside-expectation`（等価、下）。7 回目の取り直しでの書き換えは上の「7 回目の取り直しで変えたこと」。

### 追補の変異と、落ちた試験・理由 code

`理由 code` は、その変異が外した検査が出す code（`followup.mjs` の `firstRenderOf` の `fails`、`quality-verdict.mjs` の problem の code）。N2c〜N2f は 1 つの試験の中で code ごとに assert する（`notCounted` が落ちた理由をちょうど 1 つに限り、期待の code を要求する）。変異は『その値だけを許す』ので、落ちるのはその code の assert（0 を許す変異は `-0` の、2 を許す変異は `-2` の assert）。N5 は block と key を 1 つずつ外す。

| 変異 | 対応 | 変える file | 落ちた試験 | 理由 code |
|---|---|---|---|---|
| K66-b-preparesStarted-tolerate-0 | N2c (0) | followup.mjs | followup.k66.test.mjs:221 | `b:prepares-started-0` |
| K66-b-preparesStarted-tolerate-2 | N2c (2) | followup.mjs | followup.k66.test.mjs:158, followup.k66.test.mjs:221, followup.k66.test.mjs:536 | `b:prepares-started-2` |
| K66-b-preparesReady-tolerate-0 | N2d (0) | followup.mjs | followup.k66.test.mjs:221 | `b:prepares-ready-0` |
| K66-b-preparesReady-tolerate-2 | N2d (2) | followup.mjs | followup.k66.test.mjs:221 | `b:prepares-ready-2` |
| K66-b-deferredReleased-tolerate-0 | N2e/N2f (0) | followup.mjs | followup.k66.test.mjs:221 | `b:deferred-released-0` |
| K66-b-deferredReleased-tolerate-2 | N2e/N2f (2) | followup.mjs | followup.k66.test.mjs:221 | `b:deferred-released-2` |
| K66-FR4-begins-skip-after | N5 (after, begins) | followup.mjs | followup.k66.test.mjs:317 | `FR4:counters-after-begins=…,lateCached=…,cacheHits=…（begins の差分）` |
| K66-FR4-lateCached-skip-after | N5 (after, lateCached) | followup.mjs | followup.k66.test.mjs:317 | `FR4:counters-after-begins=…,lateCached=…,cacheHits=…（lateCached の差分）` |
| K66-FR4-cacheHits-skip-after | N5 (after, cacheHits) | followup.mjs | followup.k66.test.mjs:317 | `FR4:counters-after-begins=…,lateCached=…,cacheHits=…（cacheHits の差分）` |
| K66-FR4-begins-skip-after-release | N5 (after-release, begins) | followup.mjs | followup.k66.test.mjs:317 | `FR4:counters-after-release-begins=…,lateCached=…,cacheHits=…（begins の差分）` |
| K66-FR4-lateCached-skip-after-release | N5 (after-release, lateCached) | followup.mjs | followup.k66.test.mjs:317 | `FR4:counters-after-release-begins=…,lateCached=…,cacheHits=…（lateCached の差分）` |
| K66-FR4-cacheHits-skip-after-release | N5 (after-release, cacheHits) | followup.mjs | followup.k66.test.mjs:317 | `FR4:counters-after-release-begins=…,lateCached=…,cacheHits=…（cacheHits の差分）` |
| K66-FR5-window-not-D | N12c | followup.mjs | followup.k66.test.mjs:491 | `[precheck] K6/5 変える点 6（親の窓が D でない）` |
| K66-c-next-includes-hybrid | (c) hybrid を飛ばす | followup.mjs | followup.k66.test.mjs:87, followup.k66.test.mjs:504, followup.k66.test.mjs:536, followup.k66.test.mjs:600 | `c:next-prepares-ready-diff-` |
| K66-c-next-includes-requery | (c) 再 query 行を飛ばす | followup.mjs | followup.k66.test.mjs:639 | `c:next-prepares-ready-diff-（再 query の行を next に数えない）` |
| K66-c-next-across-phase | (c) phase の区切り | followup.mjs | followup.k66.test.mjs:110 | （nextGraphArmOf の group。code でなく引いた next の値） |
| K66-c-next-across-variant | (c) variant の区切り | followup.mjs | followup.k66.test.mjs:110, followup.k66.test.mjs:504, followup.k66.test.mjs:536, followup.k66.test.mjs:600 | （nextGraphArmOf の group。code でなく引いた next の値） |
| K66-N8-schedule-check | N8 | availability.mjs | followup.k66.test.mjs:587 | `[artifact] variant/phase/repeat/arm order differs from the predeclared AB/BA schedule` |
| K66-D4-requery-rows-ignored | D4 requeries | quality-verdict.mjs | quality-verdict.test.mjs:1670 | `requery-row-forbidden-or-blocked-contribution` |
| K66-D4-requery-user-operation-counted | D4 requeries | quality-verdict.mjs | quality-verdict.test.mjs:1670 | （user-operation の行は requeries の対象外） |
| K66-D4-requery-hybrid-counted | D4 requeries | quality-verdict.mjs | quality-verdict.test.mjs:1670 | （R+IR arm の行は baseline） |
| K66-D3b-record-only-when-edges | D3 (b)(d) | quality-verdict.mjs | quality-verdict.test.mjs:1747 | `b-forbidden-path`、`d-unresolved-edges` |
| K66-D3b-null-edgecount-no-hold | D3 (b)(d) | quality-verdict.mjs | quality-verdict.test.mjs:1747 | `b-material-revision-record-missing` |
| K66-D3b-revision-resolution-always | D3 (d) | quality-verdict.mjs | quality-verdict.test.mjs:1747, quality-verdict.test.mjs:2286 | （観測が空の記録に d-revision-resolution-unavailable を出さない） |
| K66-D3-disclose-edge-count | D3 開示 | quality-verdict.mjs | quality-verdict.test.mjs:1842 | （開示 graphEdgeCount） |
| K66-D3-disclose-outside-expectation | D3 開示 | quality-verdict.mjs | （等価）試験は落ちない | （等価） |
| K66-D3-disclose-missing-conditions | D3 開示 | quality-verdict.mjs | quality-verdict.test.mjs:1842, quality-verdict.test.mjs:2210 | （開示 missingConditions） |
| K66-D3-missing-6 | D3 開示 | quality-verdict.mjs | quality-verdict.test.mjs:1379, quality-verdict.test.mjs:1842 | （開示 missingConditions [6]、D2・D3 の試験で子のまま） |

### 上の 55 件の変異の理由 code

各変異が外した検査の理由 code（`tools/reasons-k66.json`）。『試験が assert する』の列は、その code の文字列が、落ちた試験の本体（`f7e1fec1` の試験の file の該当行から次の `test(` まで）に書いてあるか（記録の作成時の突き合わせ）。例外（`[artifact]`・`[precheck]`）や値（`parentContributed`）を assert する試験は『例外・値』と書く。

| 変異 | 理由 code | 試験が assert する |
|---|---|---|
| K66-N-d-stale | `[artifact] K6/6 FR-8 (stale stamp)` | 例外・値 |
| K66-N-d-driftAtQuery | `[artifact] K6/6 FR-8 (driftAtQuery)` | 例外・値 |
| K66-N-d-prepareFailures | `[artifact] K6/6 FR-8 (prepareFailures)` | 例外・値 |
| K66-FR1-source | `FR1:source-` | はい |
| K66-a-reachedQuiet | `a:reached-quiet-false` | はい |
| K66-a-r1-self-report | `a:r1-self-report-disagrees` | はい |
| K66-b-begin-records | `b:begin-records-` | はい |
| K66-b-start-slot | `b:start-slot-ready` | はい |
| K66-b-preparesStarted | `b:prepares-started-2`, `b:prepares-started-0` | はい |
| K66-b-preparesReady | `b:prepares-ready-2`, `b:prepares-ready-0` | はい |
| K66-b-deferredReleased | `b:deferred-released-0`, `b:deferred-released-2` | はい |
| K66-b-staleReadyRetired | `b:stale-ready-retired-1` | はい |
| K66-c-unrecorded | `c:prepares-ready-unrecorded` | はい |
| K66-c-diff | `c:next-prepares-ready-diff-2`, `c:next-prepares-ready-diff-0` | はい |
| K66-c-next-undefined | `[precheck] K6/6 (c)` | 例外・値 |
| K66-FR3-ticket | `FR3:ticket-not-available` | はい |
| K66-FR3-declaration | `FR3:declaration-not-used` | はい |
| K66-FR3-not-joined | `FR3:not-joined` | はい |
| K66-FR3-revalidation | `FR3:revalidation-not-passed` | （等価） |
| K66-FR3-edge-count | `FR3:edge-count-not-integer` | はい |
| K66-FR3-stamp-other | `FR3:stamp-unavailable`, `FR3:stamp-missing` | はい |
| K66-FR4-begins | `FR4:counters-after-`, `FR4:counters-after-release-` | はい |
| K66-FR4-lateCached | `FR4:counters-after-`, `FR4:counters-after-release-` | はい |
| K66-FR4-cacheHits | `FR4:counters-after-`, `FR4:counters-after-release-` | はい |
| K66-FR4-cache-left | `FR4:cache-left-at-end` | はい |
| K66-FR4-after-block | `FR4:counters-after-` | はい |
| K66-FR4-after-release-block | `FR4:counters-after-release-` | はい |
| K66-FR5-declaration | `FR5:declaration-` | はい |
| K66-FR5-publishCount | `FR5:publish-count-2` | はい |
| K66-FR6-notice | `FR6:graph-ready-notice` | はい |
| K66-FR6-child | `FR6:child-` | はい |
| K66-FR6-ir-retry | `FR6:ir-retry-timer` | はい |
| K66-FR7-no-record | `FR7:no-contribution-record` | はい |
| K66-FR7-basis | `FR7:basis-` | はい |
| K66-FR7-unresolved | `FR7:unresolved-edges-` | はい |
| K66-FR7-no-edge | `FR7:no-edge` | はい |
| K66-FR7-expected | `FR7:no-expected-contribution` | はい |
| K66-6-contributed-outcome | `parentContributed (品質の FAIL の入口)` | 例外・値 |
| K66-6-contributed-joined | `parentContributed (等価)` | （等価） |
| K66-6-contributed-used | `parentContributed (品質の FAIL の入口)` | 例外・値 |
| K66-6-contributed-edgeCount | `parentContributed (品質の FAIL の入口)` | 例外・値 |
| K66-6-outcome-fail | `graph-contributed-parent-not-counted-as-first-render` | はい |
| K66-5-heading-rate-entry | `firstRenderOutOfWindowRate` | はい |
| K66-N9-receipt-sha | `head.k66 sha256` | 例外・値 |
| K66-N9-receipt-commit | `head.k66 freezeCommit` | 例外・値 |
| K66-N9-receipt-null-descriptor | `head.k66 freezeCommit null` | 例外・値 |
| K66-N9-receipt-required-when-formal | `head.k66 required` | 例外・値 |
| K66-N9-admission-commit | `[precheck] K6/6 freeze (commit)` | 例外・値 |
| K66-N9-admission-sha | `[precheck] K6/6 freeze (sha256)` | 例外・値 |
| K66-N9-admission-null | `[precheck] K6/6 freeze (null)` | 例外・値 |
| K66-D3d-not-latest | `d-revision-is-not-the-latest` | はい |
| K66-D3d-no-edge-hold | `d-edge-has-no-typed-revision-in-setup` | はい |
| K66-D3d-no-setup-hold | `d-revision-resolution-unavailable` | はい |
| K66-D3d-refused-skipped | `d-revision-is-not-the-latest` | 例外・値 |
| K66-D3d-prepare-skip-removed | `d-revision-is-not-the-latest` | 例外・値 |

### 追補で分かったこと・残る穴

- **N10a／N10b**：変異は上の本体でもすでに分かれていた（`K66-N-d-driftAtQuery`、`K66-N-d-prepareFailures`）。落ちる試験は 1 件（`followup.k66.test.mjs:441`）だが、その中は key ごとの `assert.throws` で、落ちた assert は変異ごとに違う（失敗の message が `Missing expected exception: driftAtQuery` と `…: prepareFailures`。結果の `failed[].error`）。
- **N12c**：親の窓が D でない場合を外す変異 `K66-FR5-window-not-D` が `followup.k66.test.mjs:491` で落ちる。`graphWindowMs === null` と `!Number.isFinite` の 2 つの guard は、`!== GRAPH_EVAL_D_MS` が同じ値（null・NaN）を拒むので、単独で外しても判定が変わらない（等価。読みによる）。変異に入れていない。
- **(c) の区切り**：hybrid arm を飛ばさない（`K66-c-next-includes-hybrid`）、phase・variant をまたぐ（`K66-c-next-across-phase`・`-variant`）、user-operation でない行を数える（`K66-c-next-includes-requery`）が、それぞれ落ちる。`nextGraphArmOf` の phase と variant の区切りは code でなく引いた `next` の値を assert する試験（`:110`）で見ている。
- **N8**：`K66-N8-schedule-check` が `followup.k66.test.mjs:587`（stamp0-missing の親だけを分母から外した samples の拒否）で落ちる。変異は `validateGraphCaseSchedule` の一致の検査そのもの（K6/4 の予定の検査を共有する）なので、N8 だけを狙う細かい変異ではない。
- **N2c〜N2f・N5**：変異は code（値）と block × key ごとに分けた。ただし試験は 1 つの `test()` の中の loop で、落ちる試験の file:行 は同じになる。落ちた code は、変異が許した値から決まる（表の『理由 code』）。
- **等価の変異**：`K66-D3-disclose-outside-expectation`（上の表）。D3 の対象は `G-08/chronicle-index-unusable` だけで、その期待は `unavailable`（`expectedContributions` 0 件）なので `expectedScenes` が空で、`!expectedScenes.has(id)` は常に真。外しても判定も開示も変わらない（読みによる）。コードは一般の形のまま残した。
- **品質判定 v2 の D3・D4 の変異**（`K66-D4-*`、`K66-D3b-*`、`K66-D3-*`）は、この追補で足した試験（`quality-verdict.test.mjs` の D4 の requeries、D3 (b)(d) の記録、D3 の開示）が落とす。v2 の確定・独立のコードレビューは未了（次の段）のまま。
- 上の本体の表の『理由 code』は、変異を当てて得た結果ではなく、変異が外した検査の code を表にしたもの（`firstRenderFails` の code は、変異した側では出ないので、結果の `failed[].error` には出ない）。『試験が assert する』の突き合わせで、code と落ちた試験を結びつけた。K6/4・K6/5 の検出力の記録は同じ候補で取り直した（`../k65-detection-2026-11-08/`）。

## 追補 2・3：品質判定 v2 のコードレビュー・再レビュー指摘への対応（DR-CP4-QV-3。48 件）

- 実行：2026-11-08T14:42:11.436Z〜2026-11-08T14:44:48.500Z（UTC）。候補 `f7e1fec1824952e3dbb03670b8a3f57029eb5aed`。Node v22.23.3、detach の worktree。baseline 変異の対象の試験 84 件 pass、陽性の対照 `positive-k66-qv3.json` ok。
- 変異 48 件（`tools/mutations-k66-qv3.json`）：条件 2 の D8 の fail を先に返す（P1-1）、D3 の空の記録・論理 ID の無い path・記録の無い子（P2-1、P3-2、§3）、`followUp.requeries`（P2-2。FR-6、N29・N32、条件 5 (a)）、D4 の hybrid の行・variantKey の無い行（C5）、D3 (d) の順序・`refusedAtSetup` の読み・fixture の順の読込み（C1）、D3 の (1)〜(6) と D2 の「子から外す」、D3 (a)(b)、D8 (b)、§0 の CLI の各検査（D7）、再レビューの 13 件（`QV3b-*`：D3 (d) の fixture の行の欠落と `refusedAtSetup` の stage、未知の `variantKey`、§0 の置き場の組・枝・`--impl-commit` の束縛・v2 の path・G-01 の診断の置き場、G-01 の診断の head の kind・必須の引数）。すべて 1 回だけ当たり（`allHitOnce`）、**47 件はその条件の試験が落ち、等価 1 件（`QV3-C1-order-empty`）は落ちない**（`exact` 48）。
- この組の `expected` は 99699dda の run のまま（行番号も変わらず、書き換えていない）。結果は `results-k66-qv3-f7e1fec1.json`。追補 2 の最初の run で生き残った 3 件（試験の穴）は `57c13dc5` で埋めた（`QV3-D2-eligible-stays-child`、`QV3-D7-cli-required`、`QV3-P22-FR6-not-list`。詳細は前の版の記録）。

| 変異 | 対応 | 変える file | 落ちた試験 |
|---|---|---|---|
| QV3-P1-notdisplayed-first | P1-1 / C8 | quality-verdict.mjs | quality-verdict.test.mjs:1276, quality-verdict.test.mjs:2012, quality-verdict.test.mjs:2105 |
| QV3-P21-empty-observed | P2-1 / C4 | quality-verdict.mjs | quality-verdict.test.mjs:1747, quality-verdict.test.mjs:2048 |
| QV3-P32a-scene-null | P3-2 / C4 | quality-verdict.mjs | quality-verdict.test.mjs:1747, quality-verdict.test.mjs:2079 |
| QV3-C3-record-missing-only-graph | §3 字義 | quality-verdict.mjs | quality-verdict.test.mjs:1747, quality-verdict.test.mjs:2048 |
| QV3-P22-requeries-N29-N32 | P2-2 / C6 | quality-verdict.mjs | quality-verdict.test.mjs:2105 |
| QV3-P22-requeries-a | P2-2 / C6 (ii) | quality-verdict.mjs | quality-verdict.test.mjs:2105 |
| QV3-P22-FR6-rows | P2-2 / C6 (i) | followup.mjs | followup.k66.test.mjs:374 |
| QV3-P22-FR6-not-list | P2-2 / C6 (i) | followup.mjs | followup.k66.test.mjs:374 |
| QV3-C5-no-variantkey | P3-2 / C5 | quality-verdict.mjs | quality-verdict.test.mjs:2157 |
| QV3-C5-hybrid-row | P3-2 / C5 | quality-verdict.mjs | quality-verdict.test.mjs:1670 |
| QV3-C1-key-order | P3-3 / C1 | quality-verdict.mjs | quality-verdict.test.mjs:1379, quality-verdict.test.mjs:1637 |
| QV3-C1-refused-any | P3-3 / C1 (iii) | quality-verdict.mjs | quality-verdict.test.mjs:1379, quality-verdict.test.mjs:1637 |
| QV3-C1-order-not-in-fixture | P3-3 / C1 | quality-verdict.mjs | quality-verdict.test.mjs:1379 |
| QV3-C1-order-empty | P3-3 / C1 | quality-verdict.mjs | （等価）試験は落ちない |
| QV3-C1-loader-order | P3-3 / C1 | quality-verdict-cli.mjs | quality-verdict.test.mjs:1379, quality-verdict.test.mjs:2048, quality-verdict.test.mjs:2079, quality-verdict.test.mjs:2286 |
| QV3-D3-3-refreshTrigger | P3-1 D3 (3) | quality-verdict.mjs | quality-verdict.test.mjs:1842, quality-verdict.test.mjs:2210 |
| QV3-D3-4-chronicle-usable | P3-1 D3 (4) | quality-verdict.mjs | quality-verdict.test.mjs:2210 |
| QV3-D3-4-ir-outcome | P3-1 D3 (4) | quality-verdict.mjs | quality-verdict.test.mjs:1842, quality-verdict.test.mjs:2210 |
| QV3-D3-5-graph-usable | P3-1 D3 (5) | quality-verdict.mjs | quality-verdict.test.mjs:1842, quality-verdict.test.mjs:2210 |
| QV3-D3-2-origin | P3-1 D3 (2) | quality-verdict.mjs | quality-verdict.test.mjs:1379 |
| QV3-D3-6-child-chronicle | P3-1 D3 (6) | quality-verdict.mjs | quality-verdict.test.mjs:1379, quality-verdict.test.mjs:1842 |
| QV3-D3-1-variant | P3-1 D3 (1) / D2 | quality-verdict.mjs | quality-verdict.test.mjs:2210 |
| QV3-D2-eligible-stays-child | D2 | quality-verdict.mjs | quality-verdict.test.mjs:1842 |
| QV3-D2-unavailable-not-d3 | D2 | quality-verdict.mjs | quality-verdict.test.mjs:1379, quality-verdict.test.mjs:1842 |
| QV3-D3a-added-list | P3-1 D3 (a) | quality-verdict.mjs | quality-verdict.test.mjs:2286 |
| QV3-D3a-blocked | P3-1 D3 (a) | quality-verdict.mjs | quality-verdict.test.mjs:2286 |
| QV3-D3b-forbidden-path | D3 (b) | quality-verdict.mjs | quality-verdict.test.mjs:1379, quality-verdict.test.mjs:1747 |
| QV3-D8b-not-displayed-differs | P3-1 D8 (b) | quality-verdict.mjs | quality-verdict.test.mjs:1327 |
| QV3-D7-not-before-equal | D7 | quality-verdict-cli.mjs | quality-verdict-first-run.test.mjs:158 |
| QV3-D7-earliest-run | D7 | quality-verdict-cli.mjs | quality-verdict-first-run.test.mjs:106, quality-verdict-first-run.test.mjs:158, quality-verdict-first-run.test.mjs:216 |
| QV3-D7-kind-empty | D7 | quality-verdict-cli.mjs | quality-verdict-first-run.test.mjs:106 |
| QV3-D7-remote-earliest | D7 | quality-verdict-cli.mjs | quality-verdict-first-run.test.mjs:158 |
| QV3-D7-source | D7 | quality-verdict-cli.mjs | quality-verdict-first-run.test.mjs:158 |
| QV3-D7-v2-bytes | D7 | quality-verdict-cli.mjs | quality-verdict-first-run.test.mjs:216 |
| QV3-D7-cli-required | D7 | quality-verdict-cli.mjs | quality-verdict-first-run.test.mjs:343 |
| QV3b-P21-unaccounted | 再レビュー P2-1 / C1 | quality-verdict.mjs | quality-verdict.test.mjs:1379 |
| QV3b-P21-refused-any-stage | 再レビュー P2-1 / C1 | quality-verdict.mjs | quality-verdict.test.mjs:1379 |
| QV3b-P33-unknown-variant | 再レビュー P3-3 / C5 | quality-verdict.mjs | quality-verdict.test.mjs:2157 |
| QV3b-P31-pair-observationPrep | 再レビュー P3-1 | quality-verdict-cli.mjs | quality-verdict-first-run.test.mjs:373 |
| QV3b-P31-pair-candidate | 再レビュー P3-1 | quality-verdict-cli.mjs | quality-verdict-first-run.test.mjs:106, quality-verdict-first-run.test.mjs:373 |
| QV3b-P32-branch | 再レビュー P3-2 | quality-verdict-cli.mjs | quality-verdict-first-run.test.mjs:406 |
| QV3b-P32-impl-bound | 再レビュー P3-2 | quality-verdict-cli.mjs | quality-verdict-first-run.test.mjs:216, quality-verdict-first-run.test.mjs:438 |
| QV3b-P32-v2-path | 再レビュー P3-2 | quality-verdict-cli.mjs | quality-verdict-first-run.test.mjs:216 |
| QV3b-P32-g01-json-dir | 再レビュー P3-1 / P1-1 | quality-verdict-cli.mjs | quality-verdict-first-run.test.mjs:216 |
| QV3b-P11-g01-head-kind | 再レビュー P1-1 | pubg16-e2e-run.mjs | pubg16-e2e-run.test.mjs:336 |
| QV3b-P11-head-kind-traces | 再レビュー P1-1 | frozen-diagnostics.mjs | pubg16-e2e-run.test.mjs:336 |
| QV3b-P11-frozen-requires-head | 再レビュー P1-1 | pubg16-e2e-run.mjs | pubg16-e2e-run.test.mjs:236 |
| QV3b-P11-dev-refuses-head | 再レビュー P1-1 | pubg16-e2e-run.mjs | pubg16-e2e-run.test.mjs:236 |

## 取り直しの規則

この候補（`f7e1fec1824952e3dbb03670b8a3f57029eb5aed`。前の版は `dda975bc`〔本体〕、`720509a7`〔追補〕、`57c13dc5`・`99699dda`〔追補 2・3〕）以後に、規則の file（`followup.mjs`、`join.mjs`、`outcome.mjs`、`availability.mjs`、`receipt.mjs`、`k64-record.mjs`、`constants.mjs`、`admission.mjs`、`frozen-k64-admission.mjs`、`frozen-diagnostics.mjs`、`diagnostic-runner.mjs`、`trace-frozen.mjs`、`trace-runner.mjs`、`quality-verdict.mjs`、`quality-verdict-cli.mjs`、`pubg16-e2e-run.mjs`、`material-revision.mjs` ほか変異の対象の file）または上の試験 file を変えた commit を S4 以後の判定に使うなら、この記録はその候補では無効で、その候補で取り直す（S2 の `r5Gate.k66DetectionRecordRule`）。

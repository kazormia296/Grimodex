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
- 検出力の記録は独立レビューを受けていない（この記録への指摘は下の追補で扱った。追補の記録は再レビュー未了）。
- `K66-N9-*` は `receipt.test.mjs`・`admission.test.mjs` の 1 件の試験が落ちる。1 件の試験が複数の検査（sha、commit、null の descriptor）を含むので、変異ごとの落ち方は同じ試験の中の別の assert（変異 id と assert の対応は目視）。
- 品質判定 v2 の D3 (d) の変異は `quality-verdict.test.mjs` の D2・D3 の試験と D3 (d) の試験で落ちる。v2 の確定・独立のコードレビューは未了（次の段）。


## 追補：レビュー指摘への対応（下位条件ごとの理由 code、N2e／N2f・N5・N8・N12c・(c) の区切り、品質判定 v2 の D3・D4）

独立のレビューが次を指摘した：(1) 記録の表は『変異 → 落ちた試験』だけで、`firstRenderFails` の理由 code が無い。(2) N8、N12c、(c) の hybrid を飛ばす経路・phase の区切りに変異が無く、N2e／N2f、N5 の block ごと、N10a／N10b は 1 つの試験を共有する。ここでその両方に答える。上の 54 件の表と結果は `dda975bc` のままで書き換えない。

- 実行：2026-11-08T09:46:38.776Z から 2026-11-08T09:47:56.353Z（UTC）。候補 `720509a7d58fc0070931ce931df3eee8ac3a053b`（tree `4de669c385de8bdaad52a3afe9d6a7bdeaabed7d`。`dda975bc` の後、レビューの指摘を直した `6342a02d` と、この追補で生き残った変異に足した試験 `720509a7`）。detach の worktree で node v22.23.3、work tree は clean。
- baseline：変異の対象の試験（`followup.k66.test.mjs`・`quality-verdict.test.mjs`）57 件 pass、全体（`scripts/quality/nir1-graph-eval/*.test.mjs`）**718 件、pass 718、fail 0**。陽性の対照（`--positive`）はこの追補では渡していない（baseline の全 pass で足りる。結果の `positiveControlsOk: false` は『渡していない』の意味）。
- **変異 28 件**：すべて 1 回だけ当たり（`allHitOnce`）、表どおり（`exact` 28 件）。等価の変異は 1 件（下）、残り 27 件はその下位条件の試験が落ちる。変異は `tools/mutations-k66-addendum.json`、理由 code は `tools/reasons-k66.json`。結果 `results-k66-addendum-720509a7.json`（sha256 `5f9f0e87b2cf847a2d4368a14d05ef3441acdb847cf2c5f16cc55fb8d0a8123a`）。
- **期待の決め方（開示）**：`expected` は最初の run（候補 `6342a02d`。期待は空）の結果を写した。最初の run で試験が落ちない変異が 2 件あった：`K66-c-next-includes-requery`（再 query の行を `nextGraphArmOf` が数える変異。試験が無かったので `720509a7` で足し、取り直した run で落ちる）と `K66-D3-disclose-outside-expectation`（等価、下）。

### 追補の変異と、落ちた試験・理由 code

`理由 code` は、その変異が外した検査が出す code（`followup.mjs` の `firstRenderOf` の `fails`、`quality-verdict.mjs` の problem の code）。N2c〜N2f は 1 つの試験の中で code ごとに assert する（`notCounted` が落ちた理由をちょうど 1 つに限り、期待の code を要求する）。変異は『その値だけを許す』ので、落ちるのはその code の assert（0 を許す変異は `-0` の、2 を許す変異は `-2` の assert）。N5 は block と key を 1 つずつ外す。

| 変異 | 対応 | 変える file | 落ちた試験 | 理由 code |
|---|---|---|---|---|
| K66-b-preparesStarted-tolerate-0 | N2c (0) | followup.mjs | followup.k66.test.mjs:221 | `b:prepares-started-0` |
| K66-b-preparesStarted-tolerate-2 | N2c (2) | followup.mjs | followup.k66.test.mjs:158, followup.k66.test.mjs:221, followup.k66.test.mjs:522 | `b:prepares-started-2` |
| K66-b-preparesReady-tolerate-0 | N2d (0) | followup.mjs | followup.k66.test.mjs:221 | `b:prepares-ready-0` |
| K66-b-preparesReady-tolerate-2 | N2d (2) | followup.mjs | followup.k66.test.mjs:221 | `b:prepares-ready-2` |
| K66-b-deferredReleased-tolerate-0 | N2e (0) | followup.mjs | followup.k66.test.mjs:221 | `b:deferred-released-0` |
| K66-b-deferredReleased-tolerate-2 | N2f (2) | followup.mjs | followup.k66.test.mjs:221 | `b:deferred-released-2` |
| K66-FR4-begins-skip-after | N5 (after, begins) | followup.mjs | followup.k66.test.mjs:317 | `FR4:counters-after-begins=…,lateCached=…,cacheHits=…（begins の差分）` |
| K66-FR4-lateCached-skip-after | N5 (after, lateCached) | followup.mjs | followup.k66.test.mjs:317 | `FR4:counters-after-begins=…,lateCached=…,cacheHits=…（lateCached の差分）` |
| K66-FR4-cacheHits-skip-after | N5 (after, cacheHits) | followup.mjs | followup.k66.test.mjs:317 | `FR4:counters-after-begins=…,lateCached=…,cacheHits=…（cacheHits の差分）` |
| K66-FR4-begins-skip-after-release | N5 (after-release, begins) | followup.mjs | followup.k66.test.mjs:317 | `FR4:counters-after-release-begins=…,lateCached=…,cacheHits=…（begins の差分）` |
| K66-FR4-lateCached-skip-after-release | N5 (after-release, lateCached) | followup.mjs | followup.k66.test.mjs:317 | `FR4:counters-after-release-begins=…,lateCached=…,cacheHits=…（lateCached の差分）` |
| K66-FR4-cacheHits-skip-after-release | N5 (after-release, cacheHits) | followup.mjs | followup.k66.test.mjs:317 | `FR4:counters-after-release-begins=…,lateCached=…,cacheHits=…（cacheHits の差分）` |
| K66-FR5-window-not-D | N12c | followup.mjs | followup.k66.test.mjs:477 | `[precheck] K6/5 変える点 6（親の窓が D でない）` |
| K66-c-next-includes-hybrid | (c) hybrid を飛ばす | followup.mjs | followup.k66.test.mjs:87, followup.k66.test.mjs:490, followup.k66.test.mjs:522, followup.k66.test.mjs:586 | `c:next-prepares-ready-diff-` |
| K66-c-next-includes-requery | (c) 再 query 行を飛ばす | followup.mjs | followup.k66.test.mjs:625 | `c:next-prepares-ready-diff-（再 query の行を next に数えない）` |
| K66-c-next-across-phase | (c) phase の区切り | followup.mjs | followup.k66.test.mjs:110 | （nextGraphArmOf の group。code でなく引いた next の値） |
| K66-c-next-across-variant | (c) variant の区切り | followup.mjs | followup.k66.test.mjs:110, followup.k66.test.mjs:490, followup.k66.test.mjs:522, followup.k66.test.mjs:586 | （nextGraphArmOf の group。code でなく引いた next の値） |
| K66-N8-schedule-check | N8 | availability.mjs | followup.k66.test.mjs:573 | `[artifact] variant/phase/repeat/arm order differs from the predeclared AB/BA schedule` |
| K66-D4-requery-rows-ignored | D4 requeries | quality-verdict.mjs | quality-verdict.test.mjs:1581 | `requery-row-forbidden-or-blocked-contribution` |
| K66-D4-requery-user-operation-counted | D4 requeries | quality-verdict.mjs | quality-verdict.test.mjs:1581 | （user-operation の行は requeries の対象外） |
| K66-D4-requery-hybrid-counted | D4 requeries | quality-verdict.mjs | quality-verdict.test.mjs:1581 | （R+IR arm の行は baseline） |
| K66-D3b-record-only-when-edges | D3 (b)(d) | quality-verdict.mjs | quality-verdict.test.mjs:1658 | `b-forbidden-path`、`d-unresolved-edges` |
| K66-D3b-null-edgecount-no-hold | D3 (b)(d) | quality-verdict.mjs | quality-verdict.test.mjs:1658 | `b-material-revision-record-missing` |
| K66-D3b-revision-resolution-always | D3 (d) | quality-verdict.mjs | quality-verdict.test.mjs:1658 | （観測が空の記録に d-revision-resolution-unavailable を出さない） |
| K66-D3-disclose-edge-count | D3 開示 | quality-verdict.mjs | quality-verdict.test.mjs:1726 | （開示 graphEdgeCount） |
| K66-D3-disclose-outside-expectation | D3 開示 | quality-verdict.mjs | （等価）試験は落ちない | （等価） |
| K66-D3-disclose-missing-conditions | D3 開示 | quality-verdict.mjs | quality-verdict.test.mjs:1726 | （開示 missingConditions） |
| K66-D3-missing-6 | D3 開示 | quality-verdict.mjs | quality-verdict.test.mjs:1365, quality-verdict.test.mjs:1726 | （開示 missingConditions [6]、D2・D3 の試験で子のまま） |

### 上の 54 件の変異の理由 code

各変異が外した検査の理由 code（`tools/reasons-k66.json`）。『試験が assert する』の列は、その code の文字列が、落ちた試験の本体（`dda975bc` の試験の file の該当行から次の `test(` まで）に書いてあるか（記録の作成時の突き合わせ）。例外（`[artifact]`・`[precheck]`）や値（`parentContributed`）を assert する試験は『例外・値』と書く。

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
| K66-b-preparesStarted | `b:prepares-started-2`、`b:prepares-started-0` | はい |
| K66-b-preparesReady | `b:prepares-ready-2`、`b:prepares-ready-0` | はい |
| K66-b-deferredReleased | `b:deferred-released-0`、`b:deferred-released-2` | はい |
| K66-b-staleReadyRetired | `b:stale-ready-retired-1` | はい |
| K66-c-unrecorded | `c:prepares-ready-unrecorded` | はい |
| K66-c-diff | `c:next-prepares-ready-diff-2`、`c:next-prepares-ready-diff-0` | はい |
| K66-c-next-undefined | `[precheck] K6/6 (c)` | 例外・値 |
| K66-FR3-ticket | `FR3:ticket-not-available` | はい |
| K66-FR3-declaration | `FR3:declaration-not-used` | はい |
| K66-FR3-not-joined | `FR3:not-joined` | はい |
| K66-FR3-revalidation | `FR3:revalidation-not-passed` | （等価） |
| K66-FR3-edge-count | `FR3:edge-count-not-integer` | はい |
| K66-FR3-stamp-other | `FR3:stamp-unavailable`、`FR3:stamp-missing` | はい |
| K66-FR4-begins | `FR4:counters-after-`、`FR4:counters-after-release-` | はい |
| K66-FR4-lateCached | `FR4:counters-after-`、`FR4:counters-after-release-` | はい |
| K66-FR4-cacheHits | `FR4:counters-after-`、`FR4:counters-after-release-` | はい |
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

### 追補で分かったこと・残る穴

- **N10a／N10b**：変異は上の 54 件でもすでに分かれていた（`K66-N-d-driftAtQuery`、`K66-N-d-prepareFailures`）。落ちる試験は 1 件（`followup.k66.test.mjs:427`）だが、その中は key ごとの `assert.throws` で、落ちた assert は変異ごとに違う（失敗の message が `Missing expected exception: driftAtQuery` と `…: prepareFailures`。結果の `failed[].error`）。
- **N12c**：親の窓が D でない場合を外す変異 `K66-FR5-window-not-D` が `followup.k66.test.mjs:477` で落ちる。`graphWindowMs === null` と `!Number.isFinite` の 2 つの guard は、`!== GRAPH_EVAL_D_MS` が同じ値（null・NaN）を拒むので、単独で外しても判定が変わらない（等価。読みによる）。変異に入れていない。
- **(c) の区切り**：hybrid arm を飛ばさない（`K66-c-next-includes-hybrid`）、phase・variant をまたぐ（`K66-c-next-across-phase`・`-variant`）、user-operation でない行を数える（`K66-c-next-includes-requery`）が、それぞれ落ちる。`nextGraphArmOf` の phase と variant の区切りは code でなく引いた `next` の値を assert する試験（`:110`）で見ている。
- **N8**：`K66-N8-schedule-check` が `followup.k66.test.mjs:573`（stamp0-missing の親だけを分母から外した samples の拒否）で落ちる。変異は `validateGraphCaseSchedule` の一致の検査そのもの（K6/4 の予定の検査を共有する）なので、N8 だけを狙う細かい変異ではない。
- **N2c〜N2f・N5**：変異は code（値）と block × key ごとに分けた。ただし試験は 1 つの `test()` の中の loop で、落ちる試験の file:行 は同じになる。落ちた code は、変異が許した値から決まる（表の『理由 code』）。
- **等価の変異**：`K66-D3-disclose-outside-expectation`（上の表）。D3 の対象は `G-08/chronicle-index-unusable` だけで、その期待は `unavailable`（`expectedContributions` 0 件）なので `expectedScenes` が空で、`!expectedScenes.has(id)` は常に真。外しても判定も開示も変わらない（読みによる）。コードは一般の形のまま残した。
- **品質判定 v2 の D3・D4 の変異**（`K66-D4-*`、`K66-D3b-*`、`K66-D3-*`）は、この追補で足した試験（`quality-verdict.test.mjs` の D4 の requeries、D3 (b)(d) の記録、D3 の開示）が落とす。v2 の確定・独立のコードレビューは未了（次の段）のまま。
- 上の 54 件の表の『理由 code』は、変異を当てて得た結果ではなく、変異が外した検査の code を表にしたもの（`firstRenderFails` の code は、変異した側では出ないので、結果の `failed[].error` には出ない）。『試験が assert する』の突き合わせで、code と落ちた試験を結びつけた。K6/4・K6/5 の検出力の記録を取り直すかは integrator の判断のまま。


## 追補 2：品質判定 v2 のコードレビュー指摘への対応（DR-CP4-QV-3。候補 `57c13dc5`）

- 実行：2026-11-08T10:19:55.764Z から 2026-11-08T10:22:31.151Z（UTC）。候補 `57c13dc5685a060612ae3c0e72737fa5f5d3b85c`（tree `f4c372d615ef6b7d7d4ce49b21ff8de2851f808a`。枝 `claude/k66-harness`。コード `bf5ec217`、試験の補強 `57c13dc5`）。Node v22.23.3、detach の worktree。
- 変異 35 件（`tools/mutations-k66-qv3.json`）：条件 2 の D8 の fail を先に返す（P1-1）、D3 の空の記録・論理 ID の無い path・記録の無い子（P2-1、P3-2、§3）、`followUp.requeries`（P2-2。FR-6、N29・N32、条件 5 (a)）、D4 の hybrid の行・variantKey の無い行（C5）、D3 (d) の順序・`refusedAtSetup` の読み・fixture の順の読込み（C1）、D3 の (1)〜(6) と D2 の「子から外す」、D3 (a)(b)、D8 (b)、§0 の CLI の各検査（D7）。すべて 1 回だけ当たり（`allHitOnce`）、**34 件はその条件の試験が落ち、等価 1 件（`QV3-C1-order-empty`）は落ちない**（理由は `equivalentReason`）。陽性の対照 11 件は baseline で ok、nir1-graph-eval の全体 731 件 pass。
- 最初の run で生き残った変異が 3 件あり（試験の穴）、`57c13dc5` で埋めた：`QV3-D2-eligible-stays-child`（D3 の対象の子を子に数えても判定が変わらなかった。D3 の開示の試験に「条件 5 (a) の違反が無い」assert を足した）、`QV3-D7-cli-required`（CLI の必須引数の試験が変異の hook を子 process に渡していなかった。`process.execArgv` を渡す）、`QV3-P22-FR6-not-list`（変異の置換が構文を壊していた。置換を直した）。
- 結果 `results-k66-qv3-57c13dc5.json`（sha256 `f919e7cc87cd3f10d3fd473c1fbc0c24267977c3eee2a58fab7ff1c93898314f`）。期待（`expected`）は最初の run の結果から写した（変異の前に決めていない）。K6/6 の bytes・手順のファイル・trace の file は変えていない。

# K6/6（改訂 3、未確認）の dev の予行 1（**非判定**）

- **位置づけ**: 非判定の dev の予行。K6/6 の threat model「dev の予行」の 4（確認の前の非判定の予行）にあたる。判定・凍結・receipt の正本ではなく、/6 の判定には使わない。
  凍結の receipt・正式 run の経路（`admitGraphCaseRun`、`--k66-commit`、`--setups` の凍結の setup）は使っていない。`admitDevPreview` の範囲（`frozen-setup-driver.mjs --dev-fixture` と `frozen-k64-run.mjs --dev-fixture`）だけを使った。
- 枝: `claude/k66-harness-proto`。push しない。実行時の HEAD: `1d1d17eb`（origin/master #827 の取込み。内容の差なし）に、この記録の commit が載る。
- fixture: 非凍結の dev fixture `dev-shape-g02`・`g03`・`g06`・`g08`（凍結の G-case の構造をまねた合成。ID と文は全部合成。E-7 の防御は変えていない）。D = 40 ms（`GRAPH_EVAL_D_MS`）。
- 生の出力: `.artifacts/k66-rehearsal-1/`（ignore されるため commit しない。場所だけ記録）。
  - `raw/` に run ごとの `receipt.json`・`validation.json`・`run-report.json` と setup の受領書。集計は `analysis-r1.json`・`analysis-r3.json`・`analysis-quality.json`（`analyze.mjs`、`analyze-quality.mjs`）。
  - 各 run の実体（cold DB、Electron の user-data 等）は `.artifacts/cp4/k66-*` にある。log は `*.log`、起動 script は `run-setup.sh`・`run-k64.sh`・`batch.sh`。

## 結論（12 行の要約と同じ）

1. **FR-7 は取れた**。窓内に合流した親 130 件の全件に `followUp.parent.contribution`（`contributionBasis: material-revision`、`materialRevision`）が記録された（予行 3。予行 1 の 14 件も記録済み）。
2. 取れたが、dev fixture に期待寄与（`expectations`）が無いと `expectedContribution` が false になり FR-7 が空になる。fixture を直して取り直した（下の「予行の回数」）。
3. FR ごとの件数、first-render・follow-up・欠落・品質 FAIL の件数は下の表。
4. **止める条件（落ちた割合が 1/30 を超える）は予行 3 の合計で超えた**（30/130）。原因は 1 つの variant（G-08/graph-recovered）の dev の形（構造的。下の「落ちた親」）。それ以外の条件では落ちた親は 0 件。

## 予行の回数（すべて）

| 回 | 内容 | 結果 |
| -- | ---- | ---- |
| 準備 a | 評価 build（`eval-native-build.mjs`、`CARGO_TARGET_DIR=/home/grimodex/cargo-targets/k66-proto`）。origin/master が HEAD の祖先でなく止まる見込みだったので、先に origin/master（#827 の merge commit。内容の差なし）を取り込んだ | 成功（約 7 分） |
| 準備 b | `node electron/scripts/build.mjs`、`pnpm napi:build`（同じ target dir。製品の `.node` を setup の author session が使う）| 成功（napi 2 分 56 秒） |
| 失敗 | `setup-driver.mjs --fixture dev-shape-g02`（`nir1-cp4-dev-fixture/1` を要り、dev-shape は `nir1-cp4-dev-graph-case/1`）| 入口の誤り。dev-shape は `frozen-setup-driver.mjs --dev-fixture` を使う（予行ではない）|
| 失敗 | `frozen-setup-driver.mjs` が product の `.node` を読めず ENOENT（準備 b の前）| 予行ではない |
| 予行 1 | G-02 の dev-shape 1 variant（`k66-reh1-setup-g02`、`k66-reh1-k64-g02`）。dev-shape の fixture に `expectations` が無かった | 測定は完了。FR-7 の記録は 30 件中窓内の 14 件すべてにあるが、`FR7:no-expected-contribution` で first-render 0 件（fixture の欠け）|
| 予行 2 | fixture 直し（`expectations.addedScene`・`pathAttachments`・`graph.status`。1 回目の直し）後、G-02・G-03・G-06・G-08 | 4 run とも k64 の入口で `[precheck] DR-CP4-N-4 … the expected edge … is carried by 0 qualified Revisions` で停止（`graph.qualifiedRevisionIds` が無かった）。測定なし |
| 予行 3 | fixture 直し（`graph.qualifiedRevisionIds` を足す。2 回目の直し）後、G-02（base）・G-03（base、frontier-exceeded）・G-06（base）・G-08（5 variant）| 測定は 4 run とも完了。以下の集計は予行 3 |

予行は **3 回**（測定が完了した予行は 1 と 3）。setup と runner の launch は予行 1 に 1+1、予行 2 に 4+4（runner は precheck で停止）、予行 3 に 4+4。

### 直したもの（harness）

`scripts/quality/nir1-graph-eval/dev-shape-fixture.mjs`: dev-shape の生成が G-01 以外の variant の `expectations` を落としていた。FR-7 の `expectedContribution` は `materialRevisionResolver` が variant の `expectations`（`addedScene`・`pathAttachments`・`graph.qualifiedRevisionIds`）から求めるため、dev-shape の予行では常に false だった。凍結の fixture の `expectations` のうち、解決器が読む部分（`graph.status`、`graph.qualifiedRevisionIds`、`addedScene.sceneId/path.edgeIds`、`pathAttachments[].sceneId/path.edgeIds`）だけを、ID を合成 ID に替えて写すようにした。
`dev-shape-g02/g03/g04/g06/g07/g08.v1.json` を再生成した（g01 は変化なし。g04・g07 は予行に使っていないが、「committed の dev fixture は生成と一致する」試験のため再生成）。`dev-shape-fixture.test.mjs`・`k66-rehearsal.test.mjs`・`frozen-setup-plan.test.mjs` は pass（17 件）。判定の規則・閾値・観測の読みは変えていない。**観測の結果に合わせて expectation を直してはいない**（下の graph-recovered を参照）。

## 結果（予行 3。非判定）

D = 40 ms、1 variant の Graph arm の measured は 30 sample。窓内に合流した親 = `classifyJoin` が inWindow の親（K6/6 の読み）。

| run / variant | measured | 窓内に合流 | FR-7 記録 | first-render | 落ちた | follow-up | 欠落（窓外）|
| ------------- | -------: | ---------: | --------: | -----------: | -----: | --------: | ----------: |
| G-02 base | 30 | 12 | 12 | 12 | 0 | 0 | 18（X5）|
| G-03 base | 30 | 30 | 30 | 30 | 0 | 0 | 0 |
| G-03 frontier-exceeded | 30 | （fallback の variant。steady の集計なし）| - | - | - | - | - |
| G-06 base | 30 | 28 | 28 | 28 | 0 | 0 | 2（X5）|
| G-08 base-usable | 30 | 30 | 30 | 30 | 0 | 0 | 0 |
| G-08 graph-recovered | 30 | 30 | 30 | **0** | **30** | 0 | 30（X3・X4・X6・F1）|
| G-08 graph-index-unusable ほか 3 | 30×3 | （unavailable の variant。steady の集計なし）| - | - | - | - | - |
| **合計** | 270（steady の Graph arm は 150）| **130** | **130（全件）** | **100** | **30** | **0** | **50** |

- 窓内に合流した親が 30 件以上: 満たした（合計 130。G-03 単独でも 30）。窓内に合流した親の FR-7 の記録: **130 件中 130 件**。
- follow-up（first-render でない表示）は全 variant で 0 件（`firstRender`／`followUp` の集計は steady の variant）。欠落 50 件のうち 20 件は Graph が D の窓内に合流しなかった（G-02 18、G-06 2。`X5`。これは first-render の候補でない）、30 件は下の graph-recovered。

### FR ごと（R-6 の (a)〜(c) と FR-1〜FR-8）の下位条件（窓内に合流した親 130 件）

| 下位条件 | 満たした | 欠いた |
| -------- | -------: | -----: |
| (a) R1（reachedQuiet と 4 項目の計算し直し）| 130 | 0 |
| (b) 親の準備が 1 回（begin `["pending"]`、`startSlot: empty`、`preparesStarted`／`preparesReady` の差分 1、`deferredReleased` 1、`staleReadyRetired` 0）| 130 | 0 |
| (c) 次の Graph arm の `preparesReady` との差が 1 | 130 | 0 |
| FR-1 worker の結果（`source: worker`、revalidation passed）| 130 | 0 |
| FR-2 | 130 | 0 |
| FR-3 stamp（`fresh` 1、`stamp0-missing` 129 のすべてで ticket available・宣言 used・graph-ready・joined）| 130 | 0 |
| FR-4 counter の差分（after と afterRelease、cache 空）| 130 | 0 |
| FR-5 宣言 used・publishCount 1 | 130 | 0 |
| FR-6 通知・子・IR の再試行が無い | 130 | 0 |
| FR-7 親の寄与（material-revision、unresolvedEdges 0、edge 1 以上、期待寄与あり）| 100 | **30**（`FR7:no-expected-contribution` 30）|
| FR-8（N-d の記録の誤り。stale・driftAtQuery・prepareFailures）| 130（`[artifact]` で止まった親 0）| 0 |

stamp の内訳（measured の Graph arm）: `stamp0-missing` が大半（G-02 29／30、G-03・G-06・G-08 は 30／30）、`fresh` は G-02 の 1 件だけ。`none` は G-08 の unavailable の 2 variant。**`stamp0-missing` が実機で出る頻度は高い**（R-7 の読みが効く場所）。

### 品質 FAIL

- receipt の `quality` は、dev の予行では全 steady variant が `hold: no-in-window-sample`、fallback の variant が `fallback-measured`。**FAIL は 0 件**。
- ただし dev の予行は `steadyState.regime` が **k62**（K6/4 の凍結が無いので k64 を選べず、regime は封印されていて呼び手が選べない）ため、receipt の `quality` は K6/2 の読み（窓内の sample の一覧）になり、/6 の品質 FAIL の規則（変える点 6。`graph-contributed-parent-not-counted-as-first-render`）は**適用されていない**。
- /6 の規則を samples に当てて数え直した（`analyze-quality.mjs`。late 混入・X9・contributed かつ first-render でない親。ほかの条件は再計算していない）: **G-08/graph-recovered が FAIL（30 sample）**、G-02・G-03・G-06・G-08/base-usable は 0 件。予行 1 の G-02 は 14 sample で FAIL（fixture の欠けによる）。

### 落ちた親（止める条件の理由）

- G-08/graph-recovered の 30 件はすべて `FR7:no-expected-contribution`（ほかの下位条件はすべて満たす）。**構造的**（dev fixture の形）で、偶発ではない。
- 理由: 観測された寄与は `path-attachment`（Scene dvs8-5、edge dvs8-10、material-revision に解決済み、unresolvedEdges 0）だが、dev の期待は `addedScene`（graph-only の Scene dvs8-5）。dev の corpus は 5 Scene で Raw が全 Scene を含む（`rawSceneIds` が 5 件）ため、graph-only で足される Scene が無く、Graph は既存の Scene への path 添付として届く。凍結の G-08 は同じ構造だが retrieval の順位で graph-only になる前提。dev fixture の形の限界で、harness の判定の誤りではない。
- 観測に合わせて期待を直せば 0 件になるが、結果を見て期待を選ぶことになるのでしなかった。予行 3 の合計では止める条件（30/130 > 1/30）に当たる。その 30 件を除けば、全下位条件で落ちた親は 0 件。

## 環境

- 待ち: 予行の前に heavy process（cargo・rustc・vitest。加えて他 lane の Electron の測定 `db-trace-run`）が無くなるまで `wait-quiet.sh`（角かっこの形の pgrep）で待った。**待った時間 1292 秒（2026-11-07T18:28:13Z から 18:49:45Z）**。その後、評価 build・napi build の間と各 run の launch の直前に再確認し、cargo・Electron は無かった。各 receipt の `windowAssessment.clean` は 9 件とも true。
- 隔離: `scripts/local-ci-xvfb.mjs` を host の namespace で、Wayland・D-Bus・proxy の変数を除き、TMPDIR を短い `/tmp/k66t` にして走らせた。
- cargo の target は `/home/grimodex/cargo-targets/k66-proto`。評価 build は `.artifacts/cp4/eval-build/`（`grimodex-node.node` の sha256 は `f755e1ef…`）。dev の Main の worker の置き場 `src-tauri/target/release/nir1-c-query-worker`（ignore された build 出力）に評価の worker が残っている（元の worker は無く、戻す対象なし）。
- `validation.json` の error は `candidate.productReceiptSha256 must be a sha256`（製品の standard build の receipt を作っていない。dev の予告の扱いは従来どおり）と、予行 3 の全 9 variant で `candidate.clean must be true`（fixture の直しを commit する前の dirty な worktree。予行 1 は clean）。

## 気づいた問題

1. **dev-shape の fixture に期待寄与が無く、FR-7 が空になる**（直した。予行 1・2）。
2. **dev の予行は regime が k62 で、/6 の品質 FAIL の規則が走らない**。receipt の `quality` が全部 `hold` になり、graph-recovered の FAIL が見えない（samples を数え直して確認）。S4 の後の予行で k64 regime（K6/4 の凍結を持つ候補）の下の `quality` を見るか、dev の予行にも k64 regime の品質を当てる入口が要る。
3. G-08/graph-recovered は dev の形では graph-only の Scene が出ず、構造的に FR-7 を満たせない。dev fixture の corpus を大きくする（Raw が全 Scene を覆わない）か、期待の読みを変えない限り、この variant は止める条件に当たる。
4. G-02 は窓内に合流する割合が 12／30（予行 1 は 14／30）で、30 件の下限は G-03 か複数 variant の合計でないと満たせない。dev の予行の下限（30 件）の数え方は run 単位か全体かを /6 の確認で決めておくとよい。
5. `fallback-measured`（unavailable の variant）の first-render は集計されない（steady の `k64` が無い）。FR ごとの件数に入らない。
6. `candidate.clean` が dirty だと validation が落ちる（予行 3 は fixture の直しを commit する前に走らせた）。commit した後の取り直しなら出ない。

## integrator の判断（予行 3 の後。予行 4・5 の前提。2026-11-08）

1. 予行 3 の 30 件（G-08/graph-recovered の `FR7:no-expected-contribution`）は、dev の fixture の形による構造的な落ちで、harness や製品の不具合ではないと判断する。確認の前の非判定の予行（dev の予行の 4）なので、dev の fixture を直して取り直す。試した全回の記録は残す（dev の予行の 1）。予行 3 の結果は消さない。
2. 30 件の下限は、K6/6 の字義どおり、予行の全体（全 variant の合計）で数える。
3. dev の予行でも、/6 の品質 FAIL の規則を走らせる。予行の集計に /6 の regime の品質の判定を足す（判定には使わない、予告の値）。
4. 製品の DB の改善 A（#829）と B′（#830）が CP-4 の候補の時間の条件を変えるので、取り直しは #830 の merge の後の master で行う。

取り直しの結果は `docs/k66-dev-rehearsal-2.md`。

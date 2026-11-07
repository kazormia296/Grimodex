# CP-4 品質の判定の段を正式の経路に置く設計（起案。2026-11-06）

> 状態：起案（判定の結果ではない）。製品・harness・S2・S4 の bytes、閾値、fixture、Gold は変えない。

## 1. 今の正式の経路と、判定が呼ばれていない事実

- 受領書の `computeRunVerdict`（`E/receipt.mjs:585`）は `recorded`／`preview-only`／`invalid`／`precheck` だけを返す。`recorded` は「正式 run として記録した」の意味で、品質の合否ではない。
- 集計は `selectReceiptsForAggregation`（`E/receipt.mjs:246`）と `decideCp4Availability`（`E/availability.mjs:1060`）で、窓外率と失効率の可用性だけを見る。S6 の script は contracts の `s6-aggregation-s5r6/scripts/` にあり、repo の外（DR-CP4-S6-3、`cp4-decisions.md:1254`）。
- `resolveCp4VariantOutcome`（`E/outcome.mjs:472`）と `compareExistingQueryGraphArm`（同 :549）は、`k64-runner.mjs` を含む非 test の経路から呼ばれていない（grep で test のみ）。`summarizeVariantQuality`（同 :441、呼び出しは `k64-runner.mjs:302`）は表示の整合の判定で、Recall／nDCG／p95 は計算しない。
- 5 条件は manifest `comparison.required` と K6/2 `:620` にあるが、判定する段は正式の経路のどこにもない。

## 2. 置き場の設計

S6 の後の独立した段にする。新 script `E/quality-verdict.mjs`（純関数）と CLI。

- **入力**：S6 の許可リストを通った受領書（`selectReceiptsForAggregation` の included と、台帳の `(s4Commit, candidate.commit)` の組）、各受領書の `samples`、manifest と variant の fixture の期待値（`expectations.metrics`、`forbiddenSceneIds`、`pathAttachments`）、受領書の `settings.setupReceipt.logicalToRuntime`（UUID から論理 ID への逆引き。未対応 1 件でも `[precheck]`）。
- **出力**：variant ごとに 5 条件の `pass`／`fail`／`hold`／`not-evaluable` と根拠の数値、全体の verdict。別 file の JSON で、受領書は書き換えない。受領書の sha256、許可リスト、procedure（`k64-procedure.v1.json`）の sha256、manifest の sha256、script 自身の sha256 を束縛する。
- **閾値**：script に数値を書かない。期待値は fixture／manifest、1e-12 の許容は K6/2 の判断の出典、65.04 は `evals/nir1-retrieval/manifest.json` の `hybridP95Limit = B+D` と `GRAPH_EVAL_D_MS`（`E/constants.mjs:10`）から読む。期待値が manifest に無い条件は `[precheck]` で止まる。
- **集約の規則**（manifest `comparison`）：blocked の variant は macro から外す。必須項目が全 variant blocked なら `unverified`。HOLD や `unverified` を PASS に読み替えない。

## 3. 5 条件ごとの入力と計算の形

| 条件 | 入力 | 判断 |
|---|---|---|
| G-01 の事前指定改善 | 揃う。R+IR 0／0 から Graph 1／0.63093（contracts `44e3aa44`、39／39 一致） | 計算する。表示された最終一覧は harness の displayed 判定（`k64AvailableQuality`）と同じ読みで作る。再計算の 2 人は `graph-late` の child の扱いが分かれたので、規則を先に固定する |
| macro 非回帰 | 揃う。ただし manifest は macro を「既存 24 件＋G-01〜G-08」と読む | G-case の 13 variant だけなら計算できる。24 件の Graph arm の受領書は無い（`not-evaluable`） |
| Hybrid p95 ≤ 65.04 ms | 部分的。P の定義は `p95(t_return − t_fetch)`、nearest-rank、24 query×30（`evals/nir1-retrieval/manifest.json:130-140`） | 依頼文の `tRawReady − tFetch` ではなく `tReturn − tFetch`。母集団が 13 variant の G-case では P と違う。母集団と定義を先に固定し、s5r6 の値を見て選ばない |
| Evidence 100％ | edge の束縛だけ（`materialRevision`、270 sample）。UTF-16 範囲、pin、Raw excerpt、追加 Scene の本文 anchor の入力は受領書に無い。`requalification: passed` は推論値（`k64-record.mjs:300`）で根拠にしない | 全体を判定できない。edge の部分は `partial` の別表 |
| 禁止寄与 0 | 3 面に分かれる。(a) 禁止 Scene・blocked 候補は計算できる（混入 0）。(b) 遅れた Graph の混入は `lateGraphInDisplay`・`publishCount` で出せる（0）。(c) 既存 24 件の Graph 出現は記録が無い | (a)(b) は判定する。(c) は `not-evaluable` |

調査メモの訂正：禁止寄与の入力が「無い」のは (c) と Graph DTO の node／path だけで、(a)(b) は受領書から出る。前提条件（`cb4-inputs` など）の判定記録も受領書には無い（recompute README の「確かめられなかったこと」）ため、blocked の判定は台帳か別の記録からの取り込みが要る。

**揃わない部分の扱い（選択肢）**
- (i) 揃わない条件を `not-evaluable` にし、判定可能な条件だけを判定する。全体は PASS にならず、`hold: unverified-required-items`。
- (ii) harness と受領書の schema に Graph の返却内容（evidence、contribution、node、path）を足す。pin 済みの file を変えるため S2 追補・S4 の再凍結・再測定が要り、新しい契約にあたりうる。
- (iii) 別の記録から取る。CP-3b の `nir1_evidence_qualify`（lease 越しの end-to-end）の記録は、正式 run では dev 診断（`cp4-harness.ts` の heldSample）だけが呼ぶので、正式の受領書とは別の根拠になる。対象の候補と束縛を合わせる必要がある。

## 4. S2・S4 との関係

pin 一覧（`scripts/quality/nir1-graph/observation-prep.mjs`、`k64-runner.mjs:341` の hash 対象）は既存 file の bytes を束縛し、新規 file は含まない。新 script は既存の pin 済み file を変えず、`outcome.mjs` などを import だけする。置き場は、E/ のディレクトリ全体を数える検査が無いことを確認したうえで E/ 内に置く。不安なら別ディレクトリにする。

- (a) 手順外の補助の記録と位置づける。S2 の bytes に触れず、ユーザーの「S2 は触らず訂正は別文書」と整合する。判定は「S2 の手順が定めた測定に、事前登録の条件を後から当てる記録」で、測定そのものの一部ではない。
- (b) S2 追補（手順の新しい版）。手順に判定の段が入るが、S4 の再凍結（6 回目）と以後の測定の停止を招く。

## 5. 規模と試験

script 約 300 行と CLI、test 約 400 行。合成 samples で 5 条件の pass／fail／`not-evaluable` を 1 例ずつ、受領書・許可リスト・procedure の sha を 1 byte 変えたときの `[precheck]`、論理 ID の未対応と期待値欠落での停止、変異（閾値の直書き、`graph-late` の混入）で落ちることを確かめる。

## 6. ユーザーに決めてほしいこと

1. **Evidence・禁止寄与（と 24 件、p95 の母集団）の入力が無い場合の扱い**：(i)／(ii)／(iii)。推奨は **(i)**（まず今ある入力だけで判定し、残りは `not-evaluable` で開示）。理由：製品・harness・S2・S4 に触れず、未測定を PASS にしない。(ii) は必要なら別 lane で確認する。
2. **判定の段の位置づけ**：(a)／(b)。推奨は **(a)**。理由：S2 を触らない決定と整合し、6 回目の S4 を避けられる。
3. **判定の対象**：s5r6 の受領書に今の候補（`cbf33077`）で当てるか、再測定の後か。推奨は **s5r6 に当てる**（read-only の offline 判定で、測定は増えない）。ただし p95 の母集団と `graph-late` の読みは、s5r6 の値を見る前に固定する。

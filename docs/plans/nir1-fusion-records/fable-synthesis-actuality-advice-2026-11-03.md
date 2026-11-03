# Fable の意見：Chronicle の合成の段の actuality の不具合の直し方（2026-11-03）

> 注（integrator）：ユーザーの依頼「1で良いとは思いますが、ちょっとFableに聞いてみましょう。」（contracts `2fa27df0`）により、Fable（effort high、read-only）に聞いた。以下は Fable の報告の本文の写し（integrator が報告から書き写した。transcript からの機械的な抽出ではない）。integrator が実物で確かめたのは、`docs/plans/chronicle-modality-boundary-acceptance.md:19`（Hypothesis の許可値は 4 種類）と `:32`（planned／dreamed は現行契約の空合成）、`src/features/chronicle/extraction/eventSynthesisFallback.ts:40-50`（4 種類以外の cluster を `unsupported-hypothesis-actuality` で落とす）、`src-tauri/crates/grimodex-db/src/narrative_extraction/disclosure_policy.rs:33`（`("chronicle.event-synthesis.prompt", "2", SYNTHESIS_DIGEST)`）と `retrieval_admission/disclosure.rs:24` の固定。ほかの主張は Fable の読み。

## 推奨

案 1（合成 prompt を 4 種の schema に合わせ、該当観測だけの cluster は `resolution:"unresolved"`, `events:[]`）。案 2 は不採用、案 3 の事前 filter も不採用。

## 理由（origin/master）

- 設計意図が「4 種以外は空合成」で一致：`docs/plans/chronicle-modality-boundary-acceptance.md:19`（Hypothesis 許可値は actual/attempted/prevented/rumored）、`:32,34`（planned/dreamed は現行契約の空合成・非昇格）、`docs/plans/chronicle-modality-gate-implementation.md:7-9`（混在 cluster は仮説単位で gate）。
- 同じ線が 4 層で引かれている：schema `src/features/chronicle/extraction/schemas.ts:36-41`、IR 型 `src/features/narrative-extraction/ir/inferences/eventHypothesis.ts:3-6`、決定的 fallback `src/features/chronicle/extraction/eventSynthesisFallback.ts:40-50`、Rust `stage_provenance.rs:605-607` と planner `proposalPlanner.ts:93-107`。既存試験 `eventSynthesis.test.ts:55`「planned／unknown へ広げない」。案 2 は全部に逆らい、`chronicleV2Production`／Native の actuality 検査・年表の意味まで動く。
- `unresolved`＋`[]` は validator を一切変えずに通る：TS は空配列を許し `eventOutput` non-null → root-success の終端出力（`runEventSynthesisTask.ts:575-590`）。Rust は `accepted_resolution` に `unresolved` を含み、`event_count==0`・`hypothesis_rows.len()==0` で整合（`stage_provenance.rs:518-528,549-552`）。coordinator の fail-closed（`extractionCoordinator.ts:1640-1650`）も維持でよい。問題は model に「空」と言う正当な出口が無かったこと。
- 事前 filter（案 3a）が不適な理由：blocking key に actuality が無く混在 cluster は普通に起きる（`eventClustering.ts:30-37`）。設計は観測 3 様態を artifact に保持し仮説単位で gate する方針で、C1 出力は complete raw observation set を digest で束ねる。事前 skip を deterministic-empty で出す案も Rust が zero-observation 限定（`stage_provenance.rs:588-596`）なので Rust 変更が要る。

## 案 1 の落とし穴と対処

1. 契約版の連鎖（実質の費用）：instruction 変更で component contract digest が変わる。`CHRONICLE_EVENT_SYNTHESIS_COMPONENT_CONTRACT_VERSION` "2"→"3"（`chroniclePromptBuilder.ts:17`）に加え、Rust に (id, version, digest) が固定：`disclosure_policy.rs:17-18,33`、`retrieval_admission/disclosure.rs:21-25`（不一致は `StaticContractUnclassified` → retrieval 不適格）、`material_roster/contracts.json`（`materialRosterReplay.test.ts:54` が byte parity）、`production-golden.json` の synthesis receipt 2 件の digest（同 test 46-50）、`docs/plans/nir1-diagnostic-disclosure-policy.md` の表（「changed contract requires new content review」＝NIR-1 開示境界に触れるので確認候補）、`evals/qualifications/narrative-current-protocol-v2.json:7` と `currentNarrativeProtocol.test.ts:24`。**旧 v2 run の互換**：Rust は 1 組しか受けないので、v2/v3 両組を受けるか v2 run の失効を受け入れるかはユーザー判断。
2. 昇格（collapse）：4 種を列挙するだけだと model が hypothetical を actual/attempted に丸める。gate の mismatch で planner が拒否し run は死なないが、`boundary-acceptance.md:45` の失敗類型そのもの。prompt に「書き換えず省く」を明記。回帰試験は `chronicle-micro-v1.yaml` の `scene-hypothetical-only`（forbidden actuality:actual）。
3. 混在 cluster：gate の規則（`hypothesisActualityGate.ts:51-55`：1 event の refs は同一 actuality、event の actuality はそれと一致）を prompt に写す。「actual と planned が同居なら actual だけで event、planned は参照しない」。rumored は仮説として許可（planner で提案抑制）、unknown は 4 種外。
4. 修復：`expectedShape` は contextSet の動的値（`runStructuredRepairTask.ts:136`）で契約 digest を変えない。ここに 4 種列挙と unresolved/[] の形を入れる。
5. unresolved の後処理：`resolution` の消費者は digest／validator 以外に見当たらず、AI 経路では fallback の `rejectedClusters` 相当の記録が残らない（無言で落ちる）。任意の追補として receipt／artifact に件数を残す。
6. 評価資産：manifest 要件は GDX-AI-AUDIT-001（`runEventSynthesisTask.ts`）と GDX-NARR-SEMANTIC-001（`schemas.ts`、`observationPromptGuidance.ts` 等）→ impact gate 必要。

## 実装の範囲

- 変更：`runEventSynthesisTask.ts`（instruction、outputShape に unresolved 例、repair の expectedShape）、`chroniclePromptBuilder.ts`（version）、`contracts.json`、`disclosure_policy.rs`、`retrieval_admission/disclosure.rs`、`nir1-diagnostic-disclosure-policy.md`、`narrative-current-protocol-v2.json`、`currentNarrativeProtocol.test.ts`、golden 再生成（synthetic fixed-response journey、LLM 費用ゼロ）。
- 無料の試験：固定応答で hypothetical-only cluster → unresolved/[] が root-success 終端になり run が完走する；混在 cluster で actual だけの event が受理される；昇格応答が gate で拒否される；repair 経路で同じ。Rust 側は既存の `unresolved`＋0 件受入れを確認する単体を 1 本。
- 費用が要るもの（分離）：`chronicleProduction.live.test.ts` 系で hypothetical-only case、『河童』Scene 1 の再抽出、Quick／impact gate。

## 確かめられなかったこと

Native が terminal の rawObservations を cluster artifact の observationRefs と照合するか；UI が cluster 単位の空結果を表示するか；Rust 統合試験の契約版固定。

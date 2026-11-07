# G-04 fixture v2（案 C）の独立期待値レビュー（2026-11-01）

**ユーザーの確認ではない**。独立期待値レビューの記録（別の agent、Opus、read-only）。対象は `evals/nir1-graph/g04-scope-exact-unknown.v2.json`。

- 入力：v1 と v2、README・manifest・schema・l6-l9・validator、補完可能な case（G-02／G-07／G-08）、設計文書の §2〜§4、候補の測定の記録と再 probe の記録。**渡さなかったもの・読ませなかったもの**：Graph runtime の出力（受領書、DTO、frame、X5 の内訳、`s6-aggregation-s5r4/`、`gold-s5r4-1/` ほか）。レビュアーは、設計文書 §1.3 の二次的な 1 文（子の辺が 0 件）を、導出と突き合わせを終えた後に読んだと申告した（導出にも判定にも使っていない）。
- 手順：レビュアーは設計 §2〜§4 を読む前に、規則と validator だけから期待値を導き（`derivation-before-design.md`）、その後に作成者の値と突き合わせた。
- **判定：(a) 受入れ可**。期待値（graph、addedScene、pathAttachments、blockedCandidates、evidence、metrics、前提条件）は、導出と全項目で一致。`graph` は v1 と同じ bytes。#4／#7 の選択は固定の順の最初の合格。validator は Node 22 と 24 で誤り 0 件。閾値・Gold・pool の変更なし。**製品の code での必須の確認**：review Scene の本文は typed Revision の準備（anchor・quote・hash）にも Evidence にも使われない（setup は本文を先に書き、prepare に渡すのは projectId／sceneId／entityIds／relationIds だけ。`frozen-setup-plan.mjs`:840・:955、`frozen-setup-driver.mjs`:1524-1544、`ipcContract.ts`:6878、`nir1_entity_relation.rs`:4412-4428、`scene_scope_projection.rs`:9-18）。Graph 側で本文を読むのは追加 Scene を判定する C-body の部分だけ（その module の中身は行を追って読んでいない）。
- 指摘は P1・P2 なし、P3（文章の正確さ）5 件（`expectation-review-g04-v2.md`）。1〜4 を、probe の対象外の 3 欄（`positive[0].rule`、`measurementBoundary.graphConnection`、`measurementBoundary.rawPrediction`）の文章だけ直した（5 は G-02／G-07／G-08 と共通の定型文で残す）。
- **最終の bytes**：sha256 `96d44ec362f30352d6cb971c208f2ab71aed944d008cab9eb65ca2ab57c218e1`（`v2-final.json`）。直す前（`ec5455a9…`、`v2-before-p3.json`。再 probe を当てた bytes）との差は上の 3 欄の文章だけで、`query`・`scenes`・`qualifiedIr`・`variants` は同一（再 probe の対象の field は不変なので、再 probe の結果はそのまま有効）。レビュアーが最終の bytes も受入れ可と確認（差分、文の事実・規則への適合、validator）。
- 限界：C-body の module の中身、`pnpm eval:fixtures` の全体（manifest・freeze・S2 を含む）は確かめていない（manifest・freeze・S2 は v1 の bytes を前提にしており、この fixture はまだ参照されていない）。

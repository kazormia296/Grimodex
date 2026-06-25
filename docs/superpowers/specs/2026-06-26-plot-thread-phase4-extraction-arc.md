# Plot Thread Phase 4 — 自動抽出ウィザード(4a) + キャラクターアーク(4b) 設計

> roadmap=`~/.claude/plans/timeline-thread-scene-scene-codex-phase-logical-stream.md` の Phase 4（束ね③）。
> Phase 1〜3 と同ブランチスタック `feat/plot-thread-phase1-visibility-filter`。
> スレッドの最大の利用障壁（手で糸を引く前提）を下げる LLM 高機能。

## スコープ（1 PR）

- **4a. 本文からのスレッド抽出ウィザード** — 既存本文を LLM 解析し、命名サブプロット＋phaseType 進行を
  一括提案 → 確認取込（**1 undo**）。「命名された糸の生成」は既存 6 エンジンの唯一の空白。
- **4b. スレッド↔Codex 親和度＝キャラクターアーク** — `sceneCodexMentions` をスレッド軸で再集約＝
  「この糸に頻出のキャラ」。Timeline Inspector 内（安価版②a のみ・LLM 不使用）。

---

## 4a. スレッド抽出ウィザード

### 再利用スタック（foreshadow chapter audit を丸ごと手本にクローン）
1. **JSON 抽出**: `extractJsonObject`（`src/prompts/shared/jsonContract.ts`・**verbatim 再利用**）+ `JSON_ONLY`。
   ルート object 必須（先頭 `{` から）→ 出力は `{"threads":[...]}` で包む（bare array 不可）。
2. **構造化 LLM 呼び出し**: `sendChatMessageWithThinking`（chatApi.ts:242・8 引数）。
   呼び出しイディオムは `auditChapter`（foreshadow/api.ts:1480-1553）を踏襲:
   `blockIfPolicyOff("analysis")` → `getProject().language` → `getPromptCatalog(lang).<key>.build...` →
   `resolveRoleSendOverride(pathId)` → `sendChatMessageWithThinking(...)` → `recordAiUsage` →
   `extractJsonObject` → `JSON.parse` → `isValid*` 型ガード filter。
3. **章/フォルダスコープ収集**: `foreshadowStore.auditChapter`（foreshadowStore.ts:1052-1113）パターン:
   **active scene を flush（saveScene）**してから `nodes.filter(scene && parentId===folderId).sort(sortOrder)`
   → `loadSceneContent`→`prosemirrorToText` → `{sceneId,title,bodyText,orderIndex}`。
   フォルダ列挙は `nodes.filter(nodeType==="folder")`（`!parentId` 制限は緩める＝ネストフォルダ可）。
4. **候補確認 UI**: `ForeshadowChapterTab.tsx`（最近接）/ `CodexCandidatesReport.tsx`（リッチ）を手本。
   MVP = フォルダ選択 → 解析（スピナー）→ 提案リスト（糸名＋各 phase マーカー）→ **一括取込**。

### AI 経路登録（2 レジストリ・両方に完全性メタテスト）
- `modelRouting.ts` `PATH_TO_ROLE`: `plot_thread_propose: "structured"` 追加（既存 structured 流用・新 role 不要）。
- `aiPathRegistry.ts` `AI_PATHS`: `{id:"plot_thread_propose", layer:"single-shot", transport:"send_chat_message",
  verifier:"js-live", testRef:SINGLE_SHOT_TEST, testName:"plot_thread_propose:"}`。
- `singleShot.live.test.ts`: `it("plot_thread_propose: ...")` を本番プロンプトビルダー + extractJsonObject で追加（キー無し CI は skip）。
- **罠**: AI_PATHS だけ追加で PATH_TO_ROLE 漏れ＝modelRouting.test.ts CI 赤 / js-live なのに testName 無し＝aiPathRegistry.test.ts 赤。

### プロンプトビルダー（ja/en 対）
- `src/prompts/ja/plotThread.ts` + `en/plotThread.ts`（新規）: `buildProposePlotThreadsPrompt{Ja,En}`。
  `buildAuditChapterPrompt` を手本: ルール（**本文の証拠のみ・捏造禁止**）/ JSON 形 literal
  `{threads:[{name,description?,markers:[{evidenceSceneId,phaseType,note?}]}]}` / JSON_ONLY /
  customInstructionLines / 既存スレッド list + scene texts。
- `src/prompts/index.ts`: JA_CATALOG / EN_CATALOG に `plotThread:{buildProposePlotThreadsPrompt}` を**両方**登録
  （PromptCatalog 型は JA 由来＝両一致必須）。

### API + bulk import（**1 undo**）
- `src/features/plot-threads/api.ts`: `proposePlotThreads(req): Promise<PlotThreadProposal[]>`（LLM 呼び出し・上記イディオム）。
- `plotThreadStore.ts`: `addThreadsBulk(proposals)` を新設。`useGlobalHistoryStore.getState().runAsTransaction({kind:"plot", label}, async fn)`
  で包み、fn 内で per-proposal に addThread → addMarker 相当を呼び**全 promise を await Promise.all**（fn 解決前に push を着地させる＝1 undo の生命線）。
  - **dedup**: `(threadId,nodeId,phaseType)` を `get().links.some(...)` で JS 重複除外（DB UNIQUE 無し）。同 batch 内重複も。
  - **phase 検証**: `phaseType ∈ PLOT_PHASE_TYPES` を create 前に JS 検証（不正は skip＝1 行で batch を壊さない）。
  - **XPROJ**: `pid=getCurrentProjectId()` を await 前に捕捉、最終 set 前に再チェック。
  - id 安定: per-row は addMarker と同型（create→optimistic set→recordPlotHistory）で同一 id undo/redo を得る。
- **罠（await-all）**: runAsTransaction は fn 解決の瞬間に batch frame を閉じる。fire-and-forget だと push が frame 外＝N 個の undo。
  `TimelineViewport.tsx:794-861` が await-all の手本。

### UI
- 新 `PlotThreadExtractWizard`（plot-threads 配下）: フォルダ picker → 解析ボタン（スピナー）→ 提案カード列 → 取込。
  起動は Timeline ヘッダのケバブ or 構造分析ドロワー。MVP は dialog/panel 埋込（新パネル登録は `validateLayoutState` 罠回避）。
- i18n ja/en。

---

## 4b. キャラクターアーク（スレッド軸再集約・LLM 不使用）

### データ事実（探索で確認・**罠回収**）
- `sceneCodexMentions`(schema.ts:1514): `sceneId/codexEntryId/source('body'|'beat'|'relation')/role('mentioned'|'actor'|'target')`。
  **PK=(sceneId,codexEntryId,source)** → 1 ペアに最大 3 行。**`role='pov'` も pov 列も無い**（matrix の "pov" は DisplayCell kind・混同禁止）。
- **POV は別軸**: `tree_nodes.pov_character_id`（scene 直 FK・treeStore `TreeNodeData.povCharacterId`）+ `scene_beat_pov_cache`（beat 上書き）。
  mention テーブルと join しない。
- role は **beat 行のみ** `actor`/`target` を持つ（body/relation は `mentioned`）。deriveCells はこのルールを守る＝踏襲。

### 集計契約（matrix と差別化＝スレッド境界ランキング）
- 新 pure fn `src/features/plot-threads/threadCharacterArc.ts`（`sceneThreadTracks.ts` の sibling）:
  `computeThreadCharacterArc(links, threadId, mentions, povByScene): RankedCharacter[]`。
  - スレッドの scene 集合 = `links.filter(threadId).map(nodeId)` **dedup**（複数 phase で 1 シーン）。
  - mention を **codexEntryId でグループ**化（matrix は sceneId::codexEntryId グリッド＝transpose）。
  - **scene 数は sceneId で dedup**（body+beat+relation の 3 行は 1 シーン＝naive COUNT(*) は 3 重計上罠）。
  - 重み: `SOURCE_PRIORITY{body:2,beat:1,relation:0}` + `ROLE_PRIORITY{actor:2,target:1,mentioned:0}`（**role は beat 行のみ採用**）
    + POV ブースト（その scene の `povCharacterId===codexEntryId`）。`deriveCells.ts` の定数を再利用。
  - 出力 = codexEntryId 別 {sceneCount, score, isPov} の降順ランキング。
- 表示は `type==='character'` 優先（main characters）。`source='relation'` は低重み/参考。

### UI（Timeline Inspector）
- `PlotMarkerInspector.tsx`: スレッド選択時（`thread` 解決済・:103）にアーク・ランキング節を追加（thread block 後 ~:327）。
  `usePlotThreadStore.links`（filter threadId）+ `useCodexStore.entries`（id→name/type）+ `useTreeStore.nodes`（povCharacterId）。
  mentions は `db.select().from(sceneCodexMentions).where(inArray(sceneId, threadNodeIds))` で thread 境界ロード、
  `bumpMatrixDataVersion`/`useMatrixDataVersionStore` 購読で invalidation（MatrixPanel:68 手本）。

---

## 検証
- tsc / lint / vitest。
- 4a: `proposePlotThreads` パーサ/型ガード単体 + `addThreadsBulk` の 1-undo・dedup・XPROJ・phase 検証 fixture。
  modelRouting.test / aiPathRegistry.test（2 完全性ゲート）green。`singleShot.live.test.ts` ライブ（キー無し skip）。
- 4b: `computeThreadCharacterArc` 単体（POV join・sceneId dedup・role=beat 限定・source 重み）。
- 出荷前 `/review-code`: 4a bulk の undo 配線（await-all）・XPROJ・phase 検証 / 4b の 3 重計上・POV 混同・role 誤読。

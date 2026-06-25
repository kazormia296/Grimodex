# Plot Thread Phase 3 — AI 文脈・injection 設計

> roadmap=`~/.claude/plans/timeline-thread-scene-scene-codex-phase-logical-stream.md` の Phase 3（束ね②）。
> Phase 1（可視化・フィルタ）/ Phase 2（構造分析パネル）に続く同ブランチスタック
> `feat/plot-thread-phase1-visibility-filter`。scene↔thread リンクを AI チャット/エージェントに食わせ、
> サブプロット粒度の推論を可能にする。

## スコープ（3 サブ機能・1 PR）

- **3a. 同じ糸の他シーンを構造注入** — scene スコープ chat で、現在シーンが属するスレッドの
  「他シーン」を意味検索でなく構造 lookup で確実に AI 文脈へ。
- **3b. スレッド focus override（非永続）** — 縦糸を主題に AI 相談。所属シーン群を一時 focus として集約注入。
- **3c. Agent スレッドツール** — `list_plot_threads` / `get_thread_scenes` を read-only ツール追加。

## 探索で確定した重要事実（recon ground-truth）

1. **chat の `related_scenes` タグ = semanticRecall（RAG）**。`PROMPT_DATA_TAGS.rag = "related_scenes"`
   で、その中身は `input.semanticRecall`（意味検索）。**スタンドアロンの「関連する過去シーン」パネル
   （`fetchRelatedPastScenes` / `selectRelatedScenes.ts`）は chat 文脈に一切入らない**（`RelatedScenesPanel.tsx`
   のみが consumer）。→ **3a の二重注入回避は chat の `fetchSemanticRecall` exclude だけで足り、
   スタンドアロン related-scenes パネルは触らない**（roadmap の「related-scenes 構築時に exclude」は
   この RAG=semanticRecall を指す）。
2. **buildSystemPrompt 呼び出しは 2 経路**:
   - `buildSceneCtx`（chatStore.ts:2452-2499）= **scene スコープ**。`semanticRecall` 入力はここ。→ **3a の置き場**。
   - refreshContextLayers 非 scene 枝（chatStore.ts:4798）= folder/project/codex/snippet + `focusSubject`。→ **3b の置き場**。
3. **データレイヤー組立（contextBuilder.ts）**: 各 layer は trim→`wrapDataLayer`→token 計上→
   `prompt`（cache 非対応 fallback）+ `volatileTail`（cache 対応・cache_control 無し）に配置。
   毎ターン変わる層（RAG/episodic）は **cacheSegments には絶対入れない**。
4. **Agent executor は `usePlotThreadStore` を使わない**。`useTreeStore.getState().projectId` で
   アクティブ project を取り Drizzle 直クエリ。store は UI ライフサイクルロードでアクティブ project と
   ずれ得る。XPROJ は executor 側で必須。

---

## 3a. 同じ糸の他シーンを構造注入

### 設計判断
- **トグル無し・自動注入**。roadmap が「確実に」と言い、上限が固定（最大 8 シーン × 800 文字）で
  バウンドしているため。スレッドを引くのは作者の明示的行為＝引いた時点で注入したいのが自然。
  Phase 1c/2 がトグルを明記したのと対照的に 3a はトグル記載が無い＝自動が意図。token コストが
  問題化したらトグルは安価な follow-up。
- **発火条件**: scene スコープ（`effectiveSceneId` 非 null）かつ現在シーンに thread peer が 1 件以上ある時のみ。
- **順序**: `computeTimelineSceneOrder`（timelineStore.axisMode）の scene index で近傍優先。
  距離 = `|idx(peer) - idx(current)|` 昇順、同距離は reading 順（=axis index 昇順）タイブレーク。上位 8 件。
  軸 index Map に無い peer（軸外）は末尾扱い。
- **excerpt**: 各 peer 本文を `loadSceneContent`→`prosemirrorToText`→先頭 800 文字。空本文はスキップ。
- **二重注入回避**: peer の sceneId を `fetchSemanticRecall` の `excludeSceneIds` に追加（chatStore.ts:2366）。
  exclude は peer を実際に注入する時のみ（=自動発火と同条件）かけるので穴は空かない。

### 新規 pure fn
`src/features/plot-threads/sceneThreadTracks.ts`（Phase 1a 純関数の隣）:
```ts
export function computeThreadPeerSceneIds(
  links: PlotThreadLinkRow[],
  sceneId: string,
): string[]
```
- `link.nodeId === sceneId` の threadId 集合 → その threadId 群に属する distinct `nodeId`（`!== sceneId`）。
- 決定的（Set で dedup・出現順安定）。`PlotThreadLinkRow` を `./api` から import type。

### contextBuilder.ts 配線（新タグ `plot_thread_scenes`）
RAG 層を手本に **全サイト** をミラー（漏れるとタグ不整合 or トークン誤差でテスト落ち）:
- `PROMPT_DATA_TAGS`: `plotThreadScenes: "plot_thread_scenes"` 追加。
- `RESERVED_TAG_RE`: `plot_thread_scenes` を alternation に追加（**値は PROMPT_DATA_TAGS と一致必須**）。
- 入力型 `BuildSystemPromptInput`: `plotThreadScenes?: Array<{ sceneTitle: string; phaseLabel?: string; excerpt: string }>`。
- 本文組立: `plotThreadText` を RAG と同型（ヘッダ + intro + 各 `### {title}` ブロック）で構築。
  **`### ` サブヘッダ形式にする**ことで trim 関数を RAG と共有できる。
- `TrimInput`: `plotThreadScenesText?: string` 追加 → `sumTokens` に加算 → `trimOrder` に挿入。
  **trim 順 = EPISODIC → RAG → PLOT_THREAD → L5 → L4 → L2 → L3 → L1**（構造＞意味検索なので RAG より後に犠牲。
  ただしユーザー明示の L1-5 より先に犠牲）。trim fn = `trimRagText` 流用（`### ` 形式前提・trimEpisodicText と同じ）。
- trim 結果抽出 → `wrapDataLayer(effectivePlotThread, PROMPT_DATA_TAGS.plotThreadScenes)`（trim/stripL4 後）。
- `hasDataLayers` 配列 / per-layer token 計上 / `layers.push({layer:"PLOT_THREAD", ...})` /
  `prompt` 配列（**L4 の後・rag の前**）/ `volatileTail`（rag の前、cacheSegments には**入れない**） / `totalTokens`。
- **totalTokens 固定要素カウント更新**: prompt 配列要素が 10→11 になるので末尾 `(reminderText ? 10 : 9)` を `(reminderText ? 11 : 10)` に。
- i18n: `chat.context.layer.PLOT_THREAD`（ja/en locale）+ chatSystem.ts（ja/en）に `headers.plotThreadScenes` /
  `plotThreadScenesIntro` / `headers.plotThreadScenesScene`。

### chatStore.ts（buildSceneCtx, ~2313-2499）
- `usePlotThreadStore.getState().links` から `computeThreadPeerSceneIds(links, sceneCtx.id)` を計算。
- peer があれば `computeTimelineSceneOrder` で軸 index 取得 → 距離ソート → 上位 8 → `loadSceneContent`+`prosemirrorToText` で
  excerpt 構築（800 文字）→ `plotThreadScenes` 入力に渡す。phaseLabel は当該 peer の link.phaseType を i18n ラベル化（任意）。
- `fetchSemanticRecall` の `excludeSceneIds` に peer ids を append（peer 注入時のみ）。
- XPROJ: `links` は project ごと eager。await を挟むので snapshot 読みは送信時点値で可（build は per-send）。

---

## 3b. スレッド focus override（非永続）

### 設計判断
- **chatScope は増やさない非永続 override**。`chatScope.ts` / `resolveScopeSessionKey` / `chat_sessions` は
  **触らない**（migration 不要）。session 保存先は下地の scene/folder/project/codex/snippet スコープのまま。
- `chatStore` に `threadFocusOverride: { threadId: string; title: string } | null` + setter/clear を追加。
- override 有効時は `effectiveSceneId` を null に強制（非 scene 枝へ）。**3 箇所すべて**（refreshContextLayers:4480 /
  sendMessage:3153 / buildPreviewPrompt:4926）で同じゲートを入れる（preview と送信の乖離防止）。
- スレッドの所属シーン（links の nodeId）を `computeTimelineSceneOrder` で順序付けし `TreeNodeData[]` 化 →
  既存 `buildAggregatedScene`（任意配列 OK・module-local）に `prefacePolicy:"folder"`・`anchorTitle=thread name` で渡す。
  → 生成された aggregatedScene.content を **`<focus_subject>` の thread arm** に載せる（L3 scene には載せない＝二重注入回避）。
- `AggregatedPrefacePolicy` は閉 union `"folder"|"project"` のまま。"thread" は足さず "folder" 意味論を流用（preface 文言は汎用）。

### contextBuilder.ts focusSubject union 拡張
```ts
focusSubject?:
  | { kind: "codex"; entry: CodexContext }
  | { kind: "snippet"; name: string; body: string }
  | { kind: "thread"; name: string; body: string };
```
- render 枝（~1245-1261）に thread arm を追加。`s.labels.contentType: Plot Thread`（i18n）・name・body。
- **新予約タグは不要**（既存 `focus_subject` を流用）。3a の `plot_thread_scenes` とは別物。

### chatStore.ts
- state field + 初期値 `threadFocusOverride: null`（store 初期 state object に必ず初期化＝zustand silent-fail 回避）。
- setter `setThreadFocusOverride` / `clearThreadFocusOverride`。
- refreshContextLayers 非 scene 枝（~4544-4592 aggregatedScene 構築 / ~4771-4796 focusSubject 構築）に thread 分岐追加。
- `contextPromptKey`（2543-2555）に `threadFocusOverride?.threadId` を join（stale prompt 検出）。
  Pick 型 + 明示 object literal（4464-4469）も更新。
- **lifecycle クリア必須**: `setChatScope`(5016) / selectSession / createNewSession / deleteSession で
  `threadFocusOverride: null`（scopeAnchor:null リセットと同所）。stale leak 防止。

### UI（src/features/chat/components/）
- `ChatPanelHeader.tsx`: scope dropdown の **隣の補助チップ**（scope tab ではない）。ContextBar の
  `scope-anchor-chip` クラスをミラー + クリア(X)ボタン。props `threadFocus` / `onClearThreadFocus` を
  `ChatPanel.tsx` から配線。
- `QuickActionStrip.tsx`: `actions` useMemo の先頭ガードで threadFocus 有効時 `PROJECT_ACTIONS` を返す（store selector 追加）。
- `ChatInput.tsx`: placeholder ternary に threadFocus 枝（streaming の次）。
- i18n: `chat.placeholderThread`（{{title}} 補間）/ チップラベル / クリア aria-label / 起動ボタンラベル（ja+en 両方必須）。

### 起動導線
- **主**: `PlotThreadAnalysisRow.tsx`（Phase 2 ドロワー行・色ドット+名前あり）に「AI で相談」アイコンボタン。
  `useChatStore.getState().setThreadFocusOverride({threadId, title}); useLayoutStore.getState().showPanel("chat")`
  （`EditorContextMenu.handleLookUpInChat` パターン流用）。
- **副**: `PlotMarkerInspector.tsx` のスレッド選択時ヘッダにも同ボタン。

---

## 3c. Agent スレッドツール（read-only）

### 新規ツール 2 種
- `list_plot_threads`（params: なし）→ 全スレッド（id/name/color/description/scene 数/phase 進捗概要）。
- `get_thread_scenes`（params: `threadId` 必須）→ スレッド名 + 所属シーン（id/title/phaseType/excerpt）を
  PLOT_PHASE_TYPES 順、+ そのスレッドに関わる branch。

### 登録サイト（**全て更新・drift が 3 方向 gate**）
1. `toolDefinitions.ts` `AGENT_TOOLS`: 2 定義追加（`get_scene` の schema 形をミラー）。
2. `toolDefinitions.ts` `READ_ONLY_TOOL_NAMES`: 2 名追加（**漏れ=サブエージェント不可視 + drift test 落ち**）。
3. `toolExecutors.ts` 2 executor fn + `READ_ONLY_EXECUTORS` に登録（Object.freeze 前）。
4. `toolExecutors.test.ts` `EXPECTED_READ_ONLY_NAMES`（**ソート位置に手挿入**）+ `ALL_READ_TOOLS`（fail-closed XPROJ）。
5. `toolDefinitions.test.ts`: getResearchSubagentTools == READ_ONLY_TOOL_NAMES（1,2 更新で自動 green）。
6. `aiLiveHarness.ts` `createMockReadOnlyExecutor` switch に 2 case（default=error 回避）。

### executor 契約（`get_scene` / `getForeshadowDetail` を手本）
- `const projectId = useTreeStore.getState().projectId; if (!projectId) return {..., summary:"No active project", tokensUsed:0}`（**fail-closed・db クエリ 0 件**）。
- XPROJ **2 段**: まず `plotThreads.id===threadId && plotThreads.projectId===projectId` で検証（無ければ "Thread not found"）。
  その後 links を threadId で取得。**`plotThreadSceneLinks` は project_id 列を持たない**（親スレッド経由で scope）→ nodeId 単独 lookup 禁止。
- branch は `plotThreadBranches.projectId === projectId` で絞る。
- 本文 excerpt: `loadSceneContent`→`prosemirrorToText`→800 文字 cap。最大 8 シーン。
- import 追加: `plotThreads, plotThreadSceneLinks, plotThreadBranches, PLOT_PHASE_TYPES`（`@/db/schema`）。
- **`usePlotThreadStore` は使わない**（store がアクティブ project とずれ得る）。Drizzle `db` 直（`db_execute` 生 SQL は使わない＝RAW_SQL_TOOLS 不要）。

---

## 検証

- `npx tsc --noEmit` / `pnpm lint:fix` / `pnpm test`（vitest 全）。
- `contextBuilder.test.ts`: 新タグの順序配列・偽装エスケープ・空レイヤー・volatileTail/cacheSegments 分配。
- `chatStore.test.ts`: threadFocusOverride が `resolveScopeSessionKey` 出力 / createSession 引数を変えないこと（session 保存先不変）。
- `sceneThreadTracks.test.ts`: `computeThreadPeerSceneIds`（複数スレッド・自己除外・dedup）。
- `toolExecutors.test.ts`: XPROJ（他 project の thread_id / fail-closed）。
- 残（実機/ライブ）: `aiLiveHarness.ts` で 3a/3b injection 経路・3c ツール（キー無し CI は skip 安全）。実機 GUI QA。

## 出荷前 /review-code 重点
- XPROJ（3c `get_thread_scenes` 2 段）。
- prompt cache / volatileTail 契約（3a が cacheSegments を汚さない）。
- 3b が `chatScope` / session 永続キーを変えていないこと。
- threadFocusOverride の lifecycle クリア漏れ（leak）。
- totalTokens 固定要素カウント（10→11）。

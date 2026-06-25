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

## 3a. 同じ糸の「構成」を構造注入（**本文なし・構造メタのみ**）

### 設計判断（2026-06-26 改訂＝本文注入を却下）
当初案「他シーン本文を最大 8 件 × 800 文字で常時注入」は過剰と判断し却下。理由:
- **トークンコスト**: 数千トークンを scene スコープで毎ターン上乗せ → budget 圧迫・他層を trim で押し出す。
- **差別化は構造であって本文ではない**: 3a の唯一の価値は「作者が明示した縦糸の*位置づけ*」。本文は RAG が
  意味的に拾うべきもの。構造で本文を先取りすると(a)RAG と食い合い exclude 配線が必要になる循環的複雑性、
  (b)相談に無関係な近傍シーン本文で文脈を埋める、の二重の損。
- **本文はオンデマンドで足りる**: Agent は同 PR の 3c `get_thread_scenes` で必要時に本文取得できる。常時注入不要。

→ **既定 = 構造メタのみ・本文ゼロ**。各糸での位置づけ＋同じ糸の他シーン（タイトル＋段階）だけを注入。
本文 excerpt は「メタでは足りない」と実機確認後の follow-up（トグル制）に回す。
- **トグル無し・自動注入**（構造メタは数十〜数百トークンと安価でバウンド）。
- **発火条件**: scene スコープで現在シーンが 1 本以上のスレッドに属する時のみ。
- **exclude 不要**: 本文を載せないので semanticRecall と食い合わない（二重注入問題が消滅）。
- **本文 I/O 不要**: `loadSceneContent` を呼ばない＝送信が軽い。全て in-memory store から導出。

### 新規 pure fn
`src/features/plot-threads/sceneThreadTracks.ts`（Phase 1a 純関数の隣）:
```ts
export interface SceneThreadMembership {
  threadId: string;
  currentPhases: PlotPhaseType[];          // 現在シーンが踏む段階（複数 link 可）
  others: { nodeId: string; phaseType: PlotPhaseType }[];  // 同じ糸の他シーン（dedup）
}
export function computeSceneThreadContext(
  links: PlotThreadLinkRow[], sceneId: string,
): SceneThreadMembership[]
```
- 自リンクは currentPhases に集約・others から除外。others は nodeId で dedup（最初の段階）。
- スレッド順・others 順とも links 走査順で安定＝決定的。

### contextBuilder.ts 配線（新タグ `plot_thread_scenes`）
RAG 層を手本に **全サイト** をミラー:
- `PROMPT_DATA_TAGS`: `plotThreadScenes: "plot_thread_scenes"` / `RESERVED_TAG_RE` に追加（値一致必須）。
- 入力型 `BuildSystemPromptInput.plotThreadScenes?: Array<{ threadName; currentPhases: string[]; markers: {title; phaseLabel}[] }>`
  （**ラベルは呼び出し側で局所化済みを渡す**＝contextBuilder は純粋）。
- 本文組立: 糸ごとに `### 糸: {threadName}` ブロック → `このシーンの位置づけ: {phases}` 行 → `- {title}: {phase}` 行。
  **糸 = `### ` ブロック**にすることで trim（trimRagText 流用）が糸単位で末尾から落とす。
- `TrimInput.plotThreadScenesText?` 追加 → `sumTokens` 加算 → `trimOrder` に挿入。
  **trim 順 = EPISODIC → RAG → PLOT_THREAD → L5 → L4 → L2 → L3 → L1**。trim fn = `trimRagText` 流用。
- wrap/hasDataLayers/token 計上/`layers.push({layer:"PLOT_THREAD"})`/`prompt`（L4 の後・rag の前）/
  `volatileTail`（rag の前・cacheSegments には**入れない**）/`totalTokens`。
- **totalTokens 固定要素カウント 10→11**（`reminderText ? 10:9` → `11:10`）。
- i18n: `chat.context.layer.PLOT_THREAD`（locale）+ chatSystem.ts（ja/en）に `headers.plotThreadScenes` /
  `headers.plotThreadScenesThread` / `plotThreadScenesIntro` / `plotThreadScenesCurrent`。

### chatStore.ts（`buildPlotThreadScenesInput` + buildSceneCtx）
- module-local `buildPlotThreadScenesInput(sceneId)`（同期・I/O なし）: `usePlotThreadStore.getState().{threads,links}` +
  `computeSceneThreadContext` → threadName（threads・空は `plotThread.unnamed`）・title（treeStore nodes）・
  phaseLabel（`plotThread.phaseType.*`）を解決。スレッド順=sortOrder、他シーンは段階順、上限 24/糸。所属無しは undefined。
- buildSystemPrompt 入力に `plotThreadScenes: buildPlotThreadScenesInput(sceneCtx.id)`。**exclude/本文 I/O は無し**。

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
- `sceneThreadTracks.test.ts`: `computeSceneThreadContext`（複数スレッド・自己除外・dedup・複数段階）。
- `contextBuilder.test.ts`: `plot_thread_scenes` が prompt+volatileTail に乗り cacheSegments には乗らない・偽装エスケープ。
- `toolExecutors.test.ts`: XPROJ（他 project の thread_id / fail-closed）。
- 残（実機/ライブ）: `aiLiveHarness.ts` で 3a/3b injection 経路・3c ツール（キー無し CI は skip 安全）。実機 GUI QA。

## 出荷前 /review-code 重点
- XPROJ（3c `get_thread_scenes` 2 段）。
- prompt cache / volatileTail 契約（3a が cacheSegments を汚さない）。
- 3b が `chatScope` / session 永続キーを変えていないこと。
- threadFocusOverride の lifecycle クリア漏れ（leak）。
- totalTokens 固定要素カウント（10→11）。

# Plot Thread Phase 2 — 構造分析パネル 設計書

親ロードマップ: `~/.claude/plans/timeline-thread-scene-scene-codex-phase-logical-stream.md`（Phase 2 節）。
前段: Phase 1 spec=`docs/superpowers/specs/2026-06-25-plot-thread-phase1-visibility-filter.md`（branch `feat/plot-thread-phase1-visibility-filter`・未merge）。
ブランチ: `feat/plot-thread-phase2-structure-analysis`（**Phase 1 を `/ship-branch` で merge 後に master から分岐**。後述「ブランチ前提」参照）。

## 目的

スレッド（`plotThreads` + `plotThreadSceneLinks` + `plotThreadBranches`）の **読み取り専用の構造分析** を
Timeline パネルに足し、「糸を引いて維持する」動機を強化する。新テーブル/Rust/migration ゼロ・**純関数中心**・同データ。

- **2a 休眠スレッド検出**: 今いる地点から各糸が何シーン放置か（=再登場させ忘れの炙り出し）。
- **2b 起承転結バランスメーター**: 各糸が `introduce..resolve` のどこまで踏んだか＋型抜け（climax 無しで resolve 等）を 5 段ステッパー表示。各段の「書けた」（status=complete/final）も重畳。
- **2c プロット構成 Markdown 書き出し**: 手で組んだ thread/link/branch を Markdown 整形してクリップボードへ（AI 相談・編集者共有）。**死蔵 `description`/`note` を初活性化**。

## 配置（決定）— Timeline 下部ドロワー

> ユーザー決定（2026-06-26）: 3 機能を **Timeline パネル下部の折りたたみドロワー** に置く。新パネル登録はしない。

```
┌─ Timeline ─────────────── [axis][⋮]┐  ⋮ = TimelineHeader ケバブ
│  ●───●────●   (subway lanes)        │  └ display 群に showStructureAnalysis 追加
│  ●──────●───●                       │
│  …(viewport: flex-1, 既存 row)…     │
├─ ▼ 構造分析             [⧉ コピー] ┤  ← 新 PlotStructureAnalysis（全幅ドロワー）
│ ● 主人公の復讐  休眠 +4  ◆◆◇◇◇ 3/5│
│ ● 恋愛サブ      休眠 今  ◆◆◆◆◇ 2/5│
│ ● 王国の陰謀  ⚠climax抜 ◆◆◇◆◇ 4/5│
└─────────────────────────────────────┘
```

- **新パネル登録は不採用**: `panelIds.ts` / `PANEL_COMPONENT_MAP`（`src/features/layout/panelComponents.tsx:26-48`）に足すと
  `stripUnknownPanels`（`layoutStateUtils.ts:105-138`）＋ 5 プリセット（`layoutPresets.ts` の `BUILTIN_PRESET_IDS`）全更新が必須になる
  **罠**（参照: memory `grimodex-writing-stats-panel`）。**埋込で回避**。
- **DOM 構造**: `TimelinePanel.tsx` の外枠を **縦 flex** に: `TimelineHeader`（top）→ 既存の `[viewport + Splitter + inspector]` row（`flex-1`）→
  **新 `<PlotStructureAnalysis>`（bottom・`display.showStructureAnalysis` 時のみ）**。row はそのまま温存し、ドロワーを兄弟として下に足すだけ（最小改変）。
- **高さ**: ドロワーは `max-h-[40%]` 程度 + `overflow-y-auto`（糸が多くてもスクロール）。viewport（`flex-1`）が縮む。**リサイズ可能 Splitter は follow-up**。
- **トグル**: `TimelineHeader.tsx` のケバブ（`EllipsisVertical`・既存 `showTitles`/`showPhasePins`/`showThreadGaps`/`plotSubwaySort` の並び）に
  `DropdownMenuCheckboxItem` を 1 つ追加。ドロワー左肩の `▼` シェブロン（`ChevronDown`/`ChevronUp`・`PlotMarkerInspector.tsx:70-71` の `threadExpanded` パターン流用）も同じ `showStructureAnalysis` を false にする（=隠す）。**MVP は表示/非表示のみ**（ヘッダーストリップだけ残す collapse は follow-up）。
- `showThreads`（subway オーバーレイ）には**非依存**。糸が 0 件なら**ドロワー内に空状態メッセージ**。

## 探索で確定した現状（正確・recon 済）

### 軸（scene order）
- Timeline の scene 並びは `TimelinePanel.tsx:78-125` の `useMemo` に**インライン**。3 軸:
  - `reading` → `computeGlobalSceneOrder(nodes)`（`src/features/codex/phaseResolver.ts:19-59`・`Map<sceneId,index>`）。
  - `story` → `storyTimeOrder!==null` を `cmpKeys` でソート→未スケジュールを reading 順で後置（`scheduledCount` 境界）。
  - `write` → `createdAt.localeCompare`（ISO8601 文字列比較）。
- `AxisMode = "reading"|"story"|"write"`（`timelineStore.ts:5`・既定 `reading`）。**`phaseStore.resolutionMode`（reading/story/auto）とは別概念**（混同禁止）。
- `colOf(nodeId)=scenes.findIndex(...)`（`TimelinePanel.tsx:286-291`）が軸 index の正体。**scene 列にいない nodeId は -1**（archived/note 等）。
- `buildPlotLaneModel` が受ける `sceneX: Map<string,number>` は TimelinePanel が scenes 配列から作る。
- `treeStore.activeSceneId`（`treeStore.ts:240`）は **UI 状態のみ**で軸順序に非関与。「今いるシーンの軸 index」は `indexById.get(activeSceneId)` で引く。

### スレッドデータ
- `PLOT_PHASE_TYPES = ["introduce","develop","turn","climax","resolve"]`（`src/db/schema.ts:1261-1267`・凍結順序）。`PHASE_ORDER`（index 化）は `plotThreadLaneModel.ts:77-83` 内部・**未 export**。
- `PlotThreadRow`（`api.ts:11-23`）: `id,projectId,name,color(null),description(null・死蔵),sortOrder,startNodeId(null),endNodeId(null),…`。
- `PlotThreadLinkRow`（`api.ts:25-34`）: `id,threadId,nodeId,phaseType,note(null・未活用),sortOrder(null),…`。
- `PlotThreadBranchRow`（`api.ts:296-305`）: `from/toThreadId,atNodeId,kind("branch"|"merge")`。
- `usePlotThreadStore`（`plotThreadStore.ts`）: `{threads,links,branches}` **eager load 済**（`reloadProjectData.ts:43`）→ Timeline 未オープンでも参照可。
- `plotThreadLaneModel.ts` の `PlotLane.gapCols`（Phase 1c で追加）は**生存 run 内の抜け列**。2a は links から直接距離を出すので **gapCols 非依存**（lane model に結合しない・テスト容易）。

### tree status / title
- `SceneStatus = "outline"|"draft"|"complete"|"revision"|"final"`（`treeStore.ts:28-33`・schema 既定 `outline`・`TreeNodeData.status` は nullable）。「書けた」= **complete | final**。
- `NodeType = "folder"|"scene"|"note"`。`getNodeById` selector は無い → `Map(nodes.map(n=>[n.id,n]))` を一度構築し title 解決（`node.title`）。

### 小バー UI / 埋込パターン
- `WritingStatsPanel.tsx:18-226` がサブコンポーネント埋込（`DailyGoalProgress`/`FinishLinePacemaker`）の手本・`isActive===false` で effect bail・空状態は muted text。
- 細バー = `h-1.5 w-full rounded-full bg-muted` + inner `div h-full bg-primary/70 transition-all`（`DailyGoalProgress.tsx`）。`computeGoalProgress(current,goal)`（`deriveStats.ts:285-308`）。
- **`computeFinishLineProgress`（`finishLine.ts:72-156`）は流用不可**（target/deadline/pace の時間ベース）→ 2b は phase index ベースで新規。

### Markdown / clipboard
- `exportAttributionMarkdown`（`src/features/attribution/exportReport.ts`）: `const lines=[]` → `lines.join("\n")` ＋ `mdCell()` でテーブルセル escape。
- clipboard: `navigator.clipboard.writeText`（`ExportDialog.tsx` `handleCopy` = `writeText`→`setIsCopied(true)`→`1500ms` リセット→失敗 `toast.error`・sonner）。アイコン `ClipboardCopy`/`Check`（lucide）。
- i18n `plotThread.phaseType.{introduce,develop,turn,climax,resolve}` は**既存**。`src/locales/ja.json` + `en.json` 両方必須（fallback 文字列だけは不可・i18n 監査教訓）。

---

## 2a. 休眠スレッド検出

### 距離原点（確定）
**原点 = `treeStore.activeSceneId` の軸 index `currentIndex`**（=今開いているシーン）。`activeSceneId` が scene 列に無い（note/archived/未選択）→ `currentIndex = tailIndex`（末尾＝今が最新地点とみなす）。

### 軸抽出の正本化（**生命線**）
**新 `src/features/timeline/timelineSceneOrder.ts`**:
```ts
export interface TimelineSceneOrder {
  orderedScenes: TreeNodeData[];   // 軸順（story は scheduled→unscheduled）
  indexById: Map<string, number>;  // sceneId -> 0-based 軸 index
  scheduledCount: number;          // story の scheduled 数（他軸では orderedScenes.length）
}
export function computeTimelineSceneOrder(nodes: TreeNodeData[], axisMode: AxisMode): TimelineSceneOrder
```
- `TimelinePanel.tsx:78-125` のインライン順序ロジックを **そのまま移設**（reading=`computeGlobalSceneOrder`、story=`cmpKeys(storyTimeOrder)` + reading 後置、write=`createdAt.localeCompare`）。
- **TimelinePanel は本 fn を消費に切替**（weights/spacing 計算は panel に残置可・順序だけ正本化）。**2a の dormancy と Timeline 描画が同一順序を共有**＝1c gap と同じ「軸一致」原則。二重実装禁止。
- `createdAt` 欠落/不正は**末尾扱い**（既存挙動踏襲・テストで固定）。`storyTimeOrder` は **`cmpKeys` 必須**（素の文字列比較禁止）。

### 純関数
**`src/features/plot-threads/plotThreadAnalysis.ts`**:
```ts
type DormancyState = "active" | "dormant" | "upcoming" | "unplaced";
interface ThreadDormancy {
  threadId: string;
  state: DormancyState;
  scenesSinceLast: number | null;   // 主指標: current - 直近の(<=current)マーカー。0=active
  scenesUntilNext: number | null;   // upcoming/補助: 次マーカー - current
  distanceFromTail: number | null;  // 補助(小・灰): tailIndex - 最終マーカー
  lastMarkerIndex: number | null;
  nextMarkerIndex: number | null;
}
function computeThreadDormancy(
  links: PlotThreadLinkRow[], threadId: string,
  indexById: Map<string, number>, currentIndex: number, tailIndex: number
): ThreadDormancy
```
- markerIndices = thread の links のうち `indexById` に在るもの（**-1/不在はスキップ**＝archived/note）。
- 判定:
  - `<=current` のマーカーあり: `lastBefore=max`、`scenesSinceLast=current-lastBefore`。`=current`→`active`（"今"）/ else `dormant`（"+N"）。
  - すべて `>current`: `upcoming`（"未登場"）+ `scenesUntilNext`。
  - マーカー 0: `unplaced`（"未配置"）。
- `distanceFromTail = tailIndex - max(markerIndices)`（最終マーカーが末尾から何シーン手前か＝「立ち消え」検出の補助）。
- **軸追従**: dormancy は active な `axisMode` 順で算出（ユーザーが見ている Timeline と一致）。`phase_resolution_mode` 不使用。

### 表示（行内チップ）
`休眠 +4` / `休眠 今`（active）/ `未登場`（upcoming・`次 +K` 併記可）/ `未配置`。補助 `末尾 -M` を小さく灰で併記（トグル不要・参考値）。

---

## 2b. 起承転結バランスメーター

### 純関数（同 `plotThreadAnalysis.ts`）
```ts
type PhaseCell = "absent" | "drafted" | "written";
interface ThreadPhaseProgress {
  threadId: string;
  cells: Record<PlotPhaseType, PhaseCell>;
  phasesPresent: number;            // present(drafted|written) の段数
  maxPhaseReached: PlotPhaseType | null;
  anomalies: PlotPhaseType[];       // 「後段あり・前段欠」の欠落前段（型抜け）
  linkedSceneCount: number;         // 重複 nodeId 除外
  writtenSceneCount: number;        // status=complete|final の nodeId 数
}
function computeThreadPhaseProgress(
  links: PlotThreadLinkRow[], threadId: string,
  statusByNodeId: Map<string, SceneStatus | null>
): ThreadPhaseProgress
```
- 各 `PlotPhaseType` について該当 link が在れば present。`cells`:
  - `absent`（link 無し）/ `drafted`（present だが complete/final な scene 無し）/ `written`（present かつ link 先 scene に complete|final が 1 つ以上）。
  - **同一 scene に複数 phase** は各 phase 独立に評価（占有=その phase に link が在るか）。
- `anomalies`: `PLOT_PHASE_TYPES` index i の phase が present で、index j<i の phase が absent なら j を欠落として収集（古典例「climax 抜けで resolve」を一般化）。`PHASE_ORDER` は本 fn 内で `PLOT_PHASE_TYPES` から導出（lane model の private を export しない・重複定義を許容）。
- `written*`: thread の link 先 nodeId（dedup）と、その status が complete|final の数。

### 表示（5 段ステッパー `PhaseStepper.tsx`）
- 5 ダイヤ: `absent`=薄い `◇` / `drafted`=輪郭 `◆`（薄塗り） / `written`=`thread.color` 実塗り `◆`。色は `thread.color ?? var(--primary)`（Timeline/1a と一致）。
- 末尾 `N/5`（=`phasesPresent`）。`anomalies` あり→`⚠ <最古の欠落 phase>抜`（`t('plotThread.phaseType.X')`）。
- 「書けた」は**ダイヤ塗りに内包**（written=実塗り）。冗長な別バーは出さない（行を 1 行に保つ）。Timeline カプセルへのリング重畳は follow-up。

---

## 2c. プロット構成 Markdown 書き出し

### 純関数（**新 `src/features/plot-threads/plotThreadMarkdown.ts`**）
```ts
function buildPlotThreadsMarkdown(input: {
  threads: PlotThreadRow[]; links: PlotThreadLinkRow[]; branches: PlotThreadBranchRow[];
  titleByNodeId: Map<string, string>;
  indexByNodeId: Map<string, number>;     // 行を軸順に並べる
  phaseLabel: (p: PlotPhaseType) => string;
  branchKindLabel: (k: "branch" | "merge") => string;
  projectName?: string;
}): string
```
- builder は `exportReport.ts` 同型（`lines:[]` + `join("\n")` + `mdCell()` でセル escape）。**i18n ラベルは fn 注入**（builder を純粋に保ちテスト可能化）。
- 構成:
  ```
  # プロット構成: <projectName>

  ## <thread.name>
  <description（空ならスキップ）>

  | 段階 | シーン | メモ |
  | --- | --- | --- |
  | 導入 | <title> | <note 空ならセル空> |
  …（thread の links を indexByNodeId 昇順）

  ## 分岐・合流
  - 分岐: <from name> → <to name> @ <title>
  - 合流: …
  ```
- thread は `sortOrder`（`cmpKeys`）順。**空 `description`/`note` はスキップ**（フォーマット崩れ防止）。未知 nodeId は `t('plotThread.export.unknownScene')` フォールバック。
- branches セクションはプロジェクト単位（from/to thread 名 + scene title + kind）。

### コピー UI（ドロワーヘッダー右肩）
`ExportDialog.handleCopy` 流用: `await navigator.clipboard.writeText(md)` → `setCopied(true)` → `1500ms` リセット / catch → `toast.error(t('plotThread.export.clipboardFailed'))`。アイコン `ClipboardCopy`→`Check`（copied 時）。**ExportDialog タブ同梱より「パネルのコピーボタン」が最安（S）**。file download は follow-up。

---

## コンポーネント / store 配線

### 新規ファイル
- 純関数: `src/features/timeline/timelineSceneOrder.ts` / `src/features/plot-threads/plotThreadAnalysis.ts` / `src/features/plot-threads/plotThreadMarkdown.ts`。
- UI: `src/features/plot-threads/PlotStructureAnalysis.tsx`（ドロワー container）/ `PlotThreadAnalysisRow.tsx`（1 行）/ `PhaseStepper.tsx`（5 ダイヤ）。各 1 ファイル 1 コンポーネント。

### `PlotStructureAnalysis.tsx`（データ集約・**N×M 回避の肝**）
- 購読: `usePlotThreadStore`→`{threads,links,branches}`、`useTreeStore`→`{nodes,activeSceneId}`、`useTimelineStore`→`axisMode`。**selector は shallow/個別**（行内で store 全体購読禁止）。
- **Map を 1 度だけ構築**（`useMemo`・links/threads/nodes 変化時のみ）:
  - `order = computeTimelineSceneOrder(nodes, axisMode)` → `indexById`。
  - `statusByNodeId = Map(nodes.filter(scene).map(n=>[n.id,n.status]))`。
  - `titleByNodeId = Map(nodes.map(n=>[n.id,n.title]))`。
  - `currentIndex = indexById.get(activeSceneId) ?? (order.orderedScenes.length-1)`、`tailIndex = order.orderedScenes.length-1`。
- 各 thread（`sortOrder` 順）に `computeThreadDormancy` / `computeThreadPhaseProgress` を回し `PlotThreadAnalysisRow` に prop で渡す（**行内で `links.filter` 禁止**＝Phase 1a と同じ規律）。
- ヘッダー: `▼ 構造分析` + `⧉ コピー`（`buildPlotThreadsMarkdown` を構築 Map で生成）。糸 0 件→空状態。

### `timelineStore.ts`
- `TimelineSettings`（display 群）に `showStructureAnalysis: boolean`（既定 **false**）+ state + `toggleStructureAnalysis`/setter。
- `snapshotPersistent`/`loadFromSettings` に追加（**永続**・`showThreadGaps` と完全同型）。**`buildDefaultLayoutState` 既定に必ず初期化**（未初期化フィールドへの toggle は Zustand で silent fail＝recon trap）。

### `TimelineHeader.tsx`
- ケバブ display 群に `DropdownMenuCheckboxItem`（`checked={display.showStructureAnalysis}` / `onCheckedChange={toggleStructureAnalysis}` / `t('timeline.toggleStructureAnalysis')`）。

### `TimelinePanel.tsx`
- 外枠を縦 flex 化し既存 row を `flex-1` で包む → 下に `{display.showStructureAnalysis && <PlotStructureAnalysis />}`。
- scenes `useMemo` を `computeTimelineSceneOrder` 消費へリファクタ（順序の正本一本化）。weights/`scheduledCount`/`sceneX` は `order` から導出。

---

## i18n（ja + en 両方必須・キー実在）

- `timeline.toggleStructureAnalysis`
- `plotThread.structure.{title, empty, active("今"), dormant("休眠 {{n}}"), upcoming("未登場"), nextHint("次 +{{n}}"), unplaced("未配置"), tailDistance("末尾 -{{n}}"), phasesReached("{{n}}/5"), gap("{{phase}}抜け")}`
- `plotThread.structure.written`（任意・本文では塗りに内包だが tooltip 用に `"{{written}}/{{total}} 書けた"`）
- `plotThread.export.{copy, copied, clipboardFailed, heading("プロット構成"), branchSection("分岐・合流"), colPhase, colScene, colNote, unknownScene}` + `branchKind.{branch, merge}`
- 既存 `plotThread.phaseType.*` を再利用。

---

## TDD / テスト（純関数を gate）

- `timelineSceneOrder.test.ts`: reading/story/write の順序 fixture。`cmpKeys(storyTimeOrder)`、`createdAt` 欠落=末尾、`scheduledCount` 境界。**移設前後で TimelinePanel 順序不変**（既存 timeline テストが回帰 gate）。
- `plotThreadAnalysis.test.ts`:
  - dormancy: active(=current にマーカー)/dormant(+N)/upcoming/unplaced、`distanceFromTail`、`activeSceneId` null→tail フォールバック、`indexById` 外マーカー除外。
  - phase progress: cells(absent/drafted/written)、`anomalies`（climax 抜け含む）、同一 scene 複数 phase、written ratio（complete/final のみ）。
- `plotThreadMarkdown.test.ts`: `mdCell` escape、空 description/note スキップ、branch セクション、未知 nodeId フォールバック、軸順並び、ラベル注入。
- `PlotStructureAnalysis.test.tsx`（happy-dom）: 空状態 / 行描画 / コピー（`navigator.clipboard.writeText` mock 呼び出し + 失敗時 `toast.error`）/ `showStructureAnalysis` gating。
- `timelineStore` toggle + 永続 roundtrip（`snapshotPersistent`→`loadFromSettings`）。
- 検証: `npx tsc --noEmit` / `pnpm lint:fix` / `pnpm test`。
- **browser test 不要**: ドロワーは flex リスト（flex/grid 実寸 invariant 無し）。ステッパー整列が load-bearing 化したら `*.browser.test.tsx` 追加（CI gate・本環境 Chromium 無）。

---

## ブランチ前提 / PR 方針

- **推奨**: 先に Phase 1 を `/ship-branch`（push+PR+merge）→ 更新 master から `feat/plot-thread-phase2-structure-analysis` を分岐。stacked branch を避け PR を清潔に保つ。
  - Phase 2 は TimelinePanel/timelineStore を Phase 1 と同じ領域で触る（1c の `showThreadGaps` display 群へ `showStructureAnalysis` を隣接追加）→ master 直分岐が rebase 最小。
- Phase 1 を今 ship できない場合のみ: Phase 2 を Phase 1 ブランチ上に stack し、Phase 1 merge 後に rebase。
- `git add` は明示パス（`-A` 禁止）。1 Phase = 1 branch+PR。

## 敵対レビュー重点（出荷前 `/review-code`）

- **軸一致**: dormancy/tail/Markdown 行順が `computeTimelineSceneOrder(axisMode)` 単一正本に追従し、TimelinePanel 描画と divergence しない（移設リファクタの回帰）。
- **N×M perf**: `indexById`/`statusByNodeId`/`titleByNodeId` を container で 1 度構築。行内 `links.filter`/`useMemo` 禁止。Zustand selector は shallow。
- **Markdown**: `mdCell` で name/note/title escape、空スキップ、未知 nodeId フォールバック。clipboard 失敗 toast。
- **i18n**: ja+en 両方に実キー。phase/branch ラベルは t() 経由。
- **layout 罠**: 新パネル**未登録**（埋込のみ）＝`validateLayoutState`/5 プリセット非影響。
- **activeSceneId エッジ**: 削除/note/未選択→tail フォールバックで graceful。`createdAt` 欠落=末尾。
- **store**: `showStructureAnalysis` を default state に初期化（未初期化 toggle の silent fail 回避）・永続 roundtrip。

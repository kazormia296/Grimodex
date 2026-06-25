# Plot Thread Phase 1 — 可視化・フィルタ 設計書

親ロードマップ: `~/.claude/plans/timeline-thread-scene-scene-codex-phase-logical-stream.md`（Phase 1 節）。
ブランチ: `feat/plot-thread-phase1-visibility-filter`（master = PR#182 subway 統合済みから分岐）。

## 目的
Plot Thread の scene↔thread リンク（`plotThreadSceneLinks`）を「表示専用」から
「ナビ・執筆補助」に変える最安の土台。新テーブル/Rust/migration ゼロ。

- **1a**: Scenes パネル各行にスレッド所属の色ドット（どのサブプロットの中か一目で）。
- **1b**: スレッドでツリーを絞り込み（特定サブプロットのシーンだけ表示）。
- **1c**: Timeline でスレッドの「抜けシーン」（マーカー無し列）を薄く可視化。

## 探索で確定した現状（正確）
- `plotThreadStore.load(projectId)` は **project ロード時に `reloadProjectData.ts:43` で実行済**
  → Timeline 未オープンでも Scenes 側で threads/links 参照可。
- `usePlotThreadStore`: `threads: PlotThreadRow[]`（id,name,color(nullable),sortOrder…）/
  `links: PlotThreadLinkRow[]`（threadId,nodeId,phaseType,note…）。
- 色の正本: Timeline は一貫して **`thread.color ?? "var(--primary)"`**（render 時パレット割当は無い）。
  text-on-fill は `contrastTextColor`（`@/lib/resolveCodexColors`）。**ドット/ギャップも同じ解決でレーンと一致させる**。
- Tree は **仮想化していない**（再帰 JSX・prop drilling）。各 `TreeNodeItem` は memo 済。
- `LabelDots`（`src/features/labels/LabelDots.tsx`）= ドット雛形。実寸 **`h-1.5 w-1.5 rounded-full`**、
  `MAX_DOTS=4`、超過 `+N`（`text-[9px]`）、container `ml-1 flex items-center gap-0.5 flex-shrink-0`。
  store から O(1)（`nodeLabels[nodeId]`）で引く。
- `treeVisibility.isNodeVisible/flattenVisible`: `labelFilter`（OR・フォルダ無条件通過）+ `nodeLabels` を受ける。
  `threadFilter`/`nodeThreadIds` も同型で追加可。
- フィルタ条件は status AND label の積（各 filter を全通過で表示）→ thread も AND 段として足す。
- treeStore は **persist 無し**（show* / *Filter は in-memory）。
- Timeline 太バンド（`lane.lineSegments`）は **`axisMode === "reading"` のみ描画**（line ~1535）。
  レーン背景線は全 mode。`gapCols` 描画は **band と同じ reading-only ゲート**にする。
- 正本モデルは `plotThreadLaneModel.ts` の `buildPlotLaneModel`（`subwayModel.ts` は #182 で削除済）。

---

## 1a. ThreadMembershipDots（Scenes 行ドット）

- 新 `src/features/plot-threads/ThreadMembershipDots.tsx`。props `{ threads: PlotThreadRow[] }`（解決済・dedup・`sortOrder` 昇順）。
  空なら `null`。`LabelDots` を雛形に **同寸 `h-1.5 w-1.5`**、`MAX_DOTS=4`、`+N`、`title={thread.name}`、
  `backgroundColor: thread.color ?? "var(--primary)"`。クリック挙動なし（LabelDots と同様）。
- `TreeNodeItem.tsx`: `LabelDots`（~438行）直後に
  `{showPlotThreadDots && node.nodeType === "scene" && !isEditing && <ThreadMembershipDots threads={threadsForNode} />}`。
  props 追加: `showPlotThreadDots: boolean` と `threadsForNode?: PlotThreadRow[]`（drill）。
- **メンバーシップ Map（1a/1b 共通・一度だけ構築）**: `ScenesPanel` で
  `nodeThreadIds: Record<nodeId, string[]>`（links から・dedup）と `threadsById: Map<id,PlotThreadRow>` を `useMemo`。
  TreeRenderer 経由で drill。行で `threadsForNode = (nodeThreadIds[id] ?? []).map(i=>threadsById.get(i)).filter(Boolean)`。
  **行内で `links.filter` 禁止**（N×M 回避）。
- treeStore: `showPlotThreadDots`（default **true**・no-thread 時は自動で null 描画なので無害）+ `setShowPlotThreadDots`。
- PanelMenu: 表示トグル群に `showPlotThreadDots` チェック追加。

## 1b. スレッドフィルタ

- treeStore: `threadFilter: string[]`（default `[]`）+ `toggleThreadFilter/setThreadFilter/clearThreadFilter`（labelFilter 完全同型）。
- `treeVisibility.ts`: `isNodeVisible`/`flattenVisible` に `threadFilter?: string[]`, `nodeThreadIds?: Record<nodeId,string[]>` を追加。
  scene/note のみ対象・OR・フォルダ通過。status/label と AND。
- `useScenesDerivedData` / `ScenesPanel` / TreeRenderer に `threadFilter` + `nodeThreadIds` を糸通し（labelFilter の通り道に追従）。
- `ScenesFilterBar`: thread の active チップ（color ドット + name・クリックで解除）。props に `threadFilter/toggleThreadFilter/clearThreadFilter/allThreads`。「全クリア」に threadFilter も含める。
- `PanelMenu`: thread フィルタ submenu（`allThreads` を checkbox・`threadFilter.includes` で checked）。
- `allThreads` は `usePlotThreadStore(s=>s.threads)` を ScenesPanel から ScenesFilterBar/PanelMenu へ。
- スコープ: hide 方式・OR のみ・Scenes パネル限定。dim/AND/phaseType 絞り/Timeline 同期は follow-up。

## 1c. 抜けシーン検出（gapCols）— Timeline

- `plotThreadLaneModel.ts`:
  - `PlotLane` に `gapCols: number[]` 追加。
  - 算出は `runs` 確定直後（markerCols/enterCols/leaveCols が同スコープに在る位置）。各 run `{start,end}` について
    `for c in [start,end]`、`!markerCols.has(c) && !enterCols?.has(c) && !leaveCols.has(c)` を gap として push。昇順。
  - `!living` レーンは `gapCols: []`。
  - **これで「生存区間内・離脱列除外」が runs と同一判定で自動整合（生命線）**。`phase_resolution_mode` は不使用。
- `timelineStore.ts`: `TimelineSettings.showThreadGaps: boolean`（default **false**）+ state + setter +
  `snapshotPersistent`/`loadFromSettings` に追加（永続）。
- `TimelineViewport.tsx`: 太バンド描画ブロック（`axisMode==="reading" && lane.lineSegments…`）と同じゲート内で、
  `showThreadGaps` 時に `lane.gapCols.map(c => <小さな薄い目印 at xOf(c), y=lane.y, color=thread.color ?? var(--primary)>)`。
  低 opacity（例 0.25）の短い縦 tick か小円。`data-testid` を付ける。
- 表示トグル: TimelineHeader のケバブ（display 群: showTitles/showChapterNumbers/showPhasePins の並び）に `showThreadGaps` 追加。
- フォロー: gap run 連続長で警告色 / クリックでジャンプ。

---

## TDD / テスト
- **1c（純モデル）**: `plotThreadLaneModel.test.ts` に `gapCols` ケース追加（既存 `thread()/link()/branch()/serialize()` 流用）。
  検証: マーカー間の gap / branch 離脱区間は gap 除外 / merge from 列除外 / enter 列除外 / 単独マーカーは gap 無し / 非 living は []。
- **1b（純ロジック）**: `treeVisibility` に threadFilter ケース（OR・フォルダ通過・status/label との AND・keyboard nav 用 flatten）。
- **1a**: `ThreadMembershipDots` の component test（dedup/上限+N/空 null/色 fallback）。
- treeStore actions（toggle/clear threadFilter, setShowPlotThreadDots）。
- 検証コマンド: `npx tsc --noEmit` / `pnpm lint:fix` / `pnpm test`。
  1c 描画（SVG レイヤ追加）は happy-dom viewport test で gap 要素出現を確認＋必要なら `*.browser.test.tsx`（CI gate・本環境 Chromium 無）。

## i18n（ja + en 両方必須）
- `scenes.showPlotThreadDots`, scenes 側 thread フィルタ見出し/チップ。
- `timeline.showThreadGaps`（or `plotThread.*`）。
- t() のキーは locale ファイルに実在させる（fallback 文字列だけにしない＝i18n 監査教訓）。

## PR 方針
- 1a+1b（tree）と 1c（timeline）はファイル完全独立。レビュー容易さのため出荷時に 2 PR 分割も可。
- 出荷前 `/review-code`（敵対）→ XPROJ なし（read のみ）/ 行レンダ N×M / 永続キー / i18n 漏れ を重点。

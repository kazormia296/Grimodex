# Map ギャラクシービュー（3D 全体グラフ）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Map パネル内に Obsidian グラフビュー風の 3D force-directed 全体グラフ「ギャラクシー」ビューを追加する。

**Architecture:** `MapPanel` に `viewKind: "board" | "galaxy"` の分岐を追加し、galaxy 側は `React.lazy` で遅延ロードする `MapGalaxyView`（自前ヘッダ＋3D キャンバス＋フィルタパネル）。グラフ構築とフィルタは純関数モジュール `galaxyGraph.ts` に隔離して unit test で gate。データ取得は既存 API（crossReference / codexRelations / chronicle / plot-threads / treeStore）のみで、Rust/DB 変更なし。

**Tech Stack:** react-force-graph-3d（three + d3-force-3d）、three（bloom 用直接 import）、zustand（mapStore 拡張）、Vitest。

## Global Constraints

- spec: `docs/superpowers/specs/2026-07-04-map-galaxy-view-design.md`
- 2 スペースインデント、TypeScript strict、ES modules。
- コンポーネントは 1 ファイル 1 コンポーネント、200 行超えたら分割。
- i18n は `src/locales/ja.json` と `en.json` の両方に追加（キーは `map.galaxy.*` と `map.view.*`）。
- Reduced Motion: `prefers-reduced-motion` 時は自動回転なし・カメラ移動即時。
- 3D チャンクを起動バンドルに含めない（`React.lazy` + dynamic import 境界）。
- コミットは細かく、`git add` は明示パス。

---

### Task 1: 依存追加 + ライセンス再生成

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml`
- Modify: `THIRD_PARTY_LICENSES.md`, `public/THIRD_PARTY_LICENSES.md`（スクリプト生成）

**Interfaces:**
- Produces: `react-force-graph-3d`（`ForceGraph3D` React コンポーネント）、`three`（`UnrealBloomPass`）が import 可能になる。

- [ ] **Step 1: 依存を追加**

```bash
pnpm add react-force-graph-3d three
```

- [ ] **Step 2: three の重複がないか確認**

Run: `pnpm why three | head -30`
Expected: three が単一バージョンに解決されている（react-force-graph-3d 系と直接依存が同じ実体を共有）。バージョンが分裂していたら、直接依存の three を react-force-graph-3d 側が解決するバージョンに合わせて pin する。

- [ ] **Step 3: ライセンス一覧を再生成**

```bash
pnpm generate:licenses
```

Expected: `THIRD_PARTY_LICENSES.md`（root + public/）に three / react-force-graph-3d 系（MIT）が追加される。

- [ ] **Step 4: 型チェックが通ることを確認**

Run: `npx tsc --noEmit`
Expected: PASS（既存コード無変更なのでエラーなし）

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml THIRD_PARTY_LICENSES.md public/THIRD_PARTY_LICENSES.md
git commit -m "chore(map): three + react-force-graph-3d 追加（ギャラクシービュー用）+ ライセンス再生成"
```

---

### Task 2: 型とストア拡張（viewKind / galaxyFilters の永続化）

**Files:**
- Modify: `src/features/map/types.ts`
- Modify: `src/features/map/mapStore.ts`
- Test: `src/features/map/mapStore.test.ts`（既存に追記）

**Interfaces:**
- Produces:
  - `type MapViewKind = "board" | "galaxy"`
  - `interface GalaxyFilters { nodes: { scenes; codex; events; threads: boolean }; edges: { mention; relation; sequence; eventLink; participant; thread: boolean }; hideOrphans: boolean }`
  - `DEFAULT_GALAXY_FILTERS: GalaxyFilters`
  - mapStore: `viewKind: MapViewKind` / `setViewKind(kind)` / `galaxyFilters: GalaxyFilters` / `setGalaxyFilters(partial: Partial<GalaxyFilters>)`（nodes/edges はマージ）
  - `MapPersistentState` に `viewKind` と `galaxyFilters` を追加（global settings `map` 節へ相乗り）

- [ ] **Step 1: 失敗するテストを書く**（`mapStore.test.ts` に追記。既存テストのパターン＝ store を直接操作して snapshot/loadFromSettings を検証する形に合わせる）

```ts
describe("galaxy view persistence", () => {
  it("viewKind と galaxyFilters が loadFromSettings で復元される", () => {
    useMapStore.getState().loadFromSettings({
      map: {
        activeBoardId: null,
        gridSnap: false,
        minimapVisible: false,
        visualTheme: "default",
        viewKind: "galaxy",
        galaxyFilters: {
          ...DEFAULT_GALAXY_FILTERS,
          hideOrphans: true,
          edges: { ...DEFAULT_GALAXY_FILTERS.edges, sequence: false },
        },
      },
    } as unknown as GlobalSettings);
    const s = useMapStore.getState();
    expect(s.viewKind).toBe("galaxy");
    expect(s.galaxyFilters.hideOrphans).toBe(true);
    expect(s.galaxyFilters.edges.sequence).toBe(false);
    expect(s.galaxyFilters.edges.mention).toBe(true);
  });

  it("旧設定（galaxy キーなし）はデフォルトへフォールバックする", () => {
    useMapStore.getState().loadFromSettings({
      map: {
        activeBoardId: null,
        gridSnap: false,
        minimapVisible: false,
        visualTheme: "default",
      },
    } as unknown as GlobalSettings);
    const s = useMapStore.getState();
    expect(s.viewKind).toBe("board");
    expect(s.galaxyFilters).toEqual(DEFAULT_GALAXY_FILTERS);
  });

  it("setGalaxyFilters は nodes/edges を部分マージする", () => {
    useMapStore.getState().setGalaxyFilters({
      nodes: { scenes: false } as Partial<GalaxyFilters["nodes"]> as GalaxyFilters["nodes"],
    });
    const s = useMapStore.getState();
    expect(s.galaxyFilters.nodes.scenes).toBe(false);
    expect(s.galaxyFilters.nodes.codex).toBe(true);
  });
});
```

（`setGalaxyFilters` の部分マージ型は実装時に `{ nodes?: Partial<...>; edges?: Partial<...>; hideOrphans?: boolean }` の専用 Patch 型にして、テスト側のキャストを外すこと）

- [ ] **Step 2: テストが落ちることを確認**

Run: `pnpm test --run src/features/map/mapStore.test.ts`
Expected: FAIL（`viewKind` / `DEFAULT_GALAXY_FILTERS` 未定義）

- [ ] **Step 3: types.ts に型を追加**

```ts
export type MapViewKind = "board" | "galaxy";

export interface GalaxyNodeFlags {
  scenes: boolean;
  codex: boolean;
  events: boolean;
  threads: boolean;
}

export interface GalaxyEdgeFlags {
  mention: boolean;
  relation: boolean;
  sequence: boolean;
  eventLink: boolean;
  participant: boolean;
  thread: boolean;
}

export interface GalaxyFilters {
  nodes: GalaxyNodeFlags;
  edges: GalaxyEdgeFlags;
  hideOrphans: boolean;
}

export interface GalaxyFiltersPatch {
  nodes?: Partial<GalaxyNodeFlags>;
  edges?: Partial<GalaxyEdgeFlags>;
  hideOrphans?: boolean;
}

export const DEFAULT_GALAXY_FILTERS: GalaxyFilters = {
  nodes: { scenes: true, codex: true, events: true, threads: true },
  edges: {
    mention: true,
    relation: true,
    sequence: true,
    eventLink: true,
    participant: true,
    thread: true,
  },
  hideOrphans: false,
};
```

`MapPersistentState` に追加:

```ts
export interface MapPersistentState {
  activeBoardId: string | null;
  gridSnap: boolean;
  minimapVisible: boolean;
  visualTheme: VisualTheme;
  viewKind: MapViewKind;
  galaxyFilters: GalaxyFilters;
}
```

- [ ] **Step 4: mapStore.ts を拡張**

state 初期値 `viewKind: "board"`, `galaxyFilters: DEFAULT_GALAXY_FILTERS`。setter:

```ts
setViewKind: (kind) => set({ viewKind: kind }),
setGalaxyFilters: (patch) =>
  set((s) => ({
    galaxyFilters: {
      nodes: { ...s.galaxyFilters.nodes, ...patch.nodes },
      edges: { ...s.galaxyFilters.edges, ...patch.edges },
      hideOrphans: patch.hideOrphans ?? s.galaxyFilters.hideOrphans,
    },
  })),
```

`loadFromSettings` に（deep merge でデフォルト補完）:

```ts
viewKind: saved.viewKind ?? "board",
galaxyFilters: saved.galaxyFilters
  ? {
      nodes: { ...DEFAULT_GALAXY_FILTERS.nodes, ...saved.galaxyFilters.nodes },
      edges: { ...DEFAULT_GALAXY_FILTERS.edges, ...saved.galaxyFilters.edges },
      hideOrphans:
        saved.galaxyFilters.hideOrphans ?? DEFAULT_GALAXY_FILTERS.hideOrphans,
    }
  : DEFAULT_GALAXY_FILTERS,
```

`snapshotPersistent` に `viewKind: s.viewKind, galaxyFilters: s.galaxyFilters` を追加。

- [ ] **Step 5: テストが通ることを確認**

Run: `pnpm test --run src/features/map/mapStore.test.ts`
Expected: PASS（既存テストも含め全緑。既存テストが `MapPersistentState` リテラルを直書きしていたら新フィールドを補う）

- [ ] **Step 6: Commit**

```bash
git add src/features/map/types.ts src/features/map/mapStore.ts src/features/map/mapStore.test.ts
git commit -m "feat(map): viewKind/galaxyFilters を mapStore に追加（global settings 永続化）"
```

---

### Task 3: i18n キー追加

**Files:**
- Modify: `src/locales/ja.json`（`map` セクション内に `view` と `galaxy` サブキー追加）
- Modify: `src/locales/en.json`（同上）

**Interfaces:**
- Produces: 後続タスクが `t("map.galaxy.…")` / `t("map.view.…")` を参照できる。

- [ ] **Step 1: ja.json の `map` セクションに追加**

```json
"view": {
  "board": "ボード",
  "galaxy": "ギャラクシー",
  "switchToGalaxy": "ギャラクシービューへ切替",
  "switchToBoard": "ボードビューへ切替"
},
"galaxy": {
  "title": "ギャラクシー",
  "refresh": "更新",
  "filters": "フィルタ",
  "loading": "銀河を構築中…",
  "empty": "まだ星がありません。書き始めると銀河が生まれます。",
  "loadError": "グラフデータの読み込みに失敗しました",
  "noWebgl": "この環境では 3D 表示を利用できません",
  "hideOrphans": "孤立ノードを隠す",
  "nodeSection": "ノード",
  "edgeSection": "つながり",
  "nodes": {
    "scenes": "シーン",
    "codex": "Codex",
    "events": "出来事",
    "threads": "プロットスレッド"
  },
  "edges": {
    "mention": "言及",
    "relation": "関係",
    "sequence": "シーン連結",
    "eventLink": "出来事リンク",
    "participant": "参加者",
    "thread": "スレッド"
  },
  "openHint": "ダブルクリックで開く"
}
```

- [ ] **Step 2: en.json の `map` セクションに追加**

```json
"view": {
  "board": "Board",
  "galaxy": "Galaxy",
  "switchToGalaxy": "Switch to galaxy view",
  "switchToBoard": "Switch to board view"
},
"galaxy": {
  "title": "Galaxy",
  "refresh": "Refresh",
  "filters": "Filters",
  "loading": "Building the galaxy…",
  "empty": "No stars yet. Start writing and a galaxy will be born.",
  "loadError": "Failed to load graph data",
  "noWebgl": "3D view is not available in this environment",
  "hideOrphans": "Hide orphan nodes",
  "nodeSection": "Nodes",
  "edgeSection": "Links",
  "nodes": {
    "scenes": "Scenes",
    "codex": "Codex",
    "events": "Events",
    "threads": "Plot threads"
  },
  "edges": {
    "mention": "Mentions",
    "relation": "Relations",
    "sequence": "Scene order",
    "eventLink": "Event links",
    "participant": "Participants",
    "thread": "Threads"
  },
  "openHint": "Double-click to open"
}
```

- [ ] **Step 3: JSON が壊れていないか確認**

Run: `npx tsc --noEmit && node -e "JSON.parse(require('fs').readFileSync('src/locales/ja.json','utf8')); JSON.parse(require('fs').readFileSync('src/locales/en.json','utf8')); console.log('ok')"`
Expected: `ok`

- [ ] **Step 4: Commit**

```bash
git add src/locales/ja.json src/locales/en.json
git commit -m "feat(map): ギャラクシービューの i18n キー追加 (ja/en)"
```

---

### Task 4: 純関数モジュール galaxyGraph.ts（TDD）

**Files:**
- Create: `src/features/map/galaxyGraph.ts`
- Test: `src/features/map/galaxyGraph.test.ts`

**Interfaces:**
- Consumes: `GalaxyFilters`（Task 2）、`TreeNodeData`（`@/features/tree/treeStore`）、`CrossReferenceEntry`（`@/features/codex/crossReference`）、`CodexRelationRow`（`@/features/codex/codexRelationApi`）、`EventRow`/`SceneEventRow`/`ParticipantRow`（`@/features/chronicle/api`）、`PlotThreadRow`/`PlotThreadLinkRow`（`@/features/plot-threads/api`）、`computeGlobalSceneOrder`（`@/features/codex/phaseResolver`）
- Produces:

```ts
export type GalaxyNodeKind = "scene" | "codex" | "event" | "thread";
export type GalaxyEdgeKind =
  | "mention" | "relation" | "sequence" | "eventLink" | "participant" | "thread";

export interface GalaxyNode {
  id: string;            // "scene:<id>" | "codex:<id>" | "event:<id>" | "thread:<id>"
  kind: GalaxyNodeKind;
  refId: string;         // 元エンティティの生 id
  label: string;
  typeSlug: string | null;   // codex のみ type slug、他は null
  color: string | null;      // thread のみ PlotThreadRow.color、他は null（描画側で解決）
  val: number;               // ノードサイズ（1 + degree、applyGalaxyFilters が再計算）
}

export interface GalaxyLink {
  source: string;        // GalaxyNode.id
  target: string;
  kind: GalaxyEdgeKind;
  label: string | null;  // relation のみ label、他は null
}

export interface GalaxyGraph {
  nodes: GalaxyNode[];
  links: GalaxyLink[];
}

export interface GalaxyGraphInput {
  treeNodes: TreeNodeData[];             // フォルダ含む全ノード（読み順 DFS 用）
  crossReference: CrossReferenceEntry[]; // 全 codex エントリ（言及 0 も含む）
  relations: CodexRelationRow[];
  events: EventRow[];
  sceneEvents: SceneEventRow[];
  participants: ParticipantRow[];
  threads: PlotThreadRow[];
  threadLinks: PlotThreadLinkRow[];
}

export function buildGalaxyGraph(input: GalaxyGraphInput): GalaxyGraph;
export function applyGalaxyFilters(graph: GalaxyGraph, filters: GalaxyFilters): GalaxyGraph;
```

**構築ルール:**
- scene ノード: `treeNodes` の `nodeType === "scene"`。`label = title`。順序は `computeGlobalSceneOrder`。
- codex ノード: `crossReference` の各 entry（`entryId/entryName/entryType`）。
- event ノード: `events`（`label = title`）。thread ノード: `threads`（`label = name`, `color`）。
- mention エッジ: `crossReference[].scenes[]` → `scene:<sceneId>` ⇄ `codex:<entryId>`。
- relation エッジ: `relations` の `fromCodexId`/`toCodexId`/`label`。
- sequence エッジ: 読み順で隣接するシーン同士を連結。
- eventLink エッジ: `sceneEvents` の `sceneId`/`eventId`。
- participant エッジ: `participants` の `eventId`/`codexEntryId`。
- thread エッジ: `threadLinks` の `threadId`/`nodeId`（nodeId = シーン treeNodeId）。
- **両端のノードが存在しないエッジは捨てる**（削除済みエントリ参照等の防御）。
- **重複エッジは (kind, source, target) の無向正規化キーで dedup**。
- `applyGalaxyFilters`: ノード種別 OFF → そのノードと接続エッジを除去。エッジ種別 OFF → エッジのみ除去。`hideOrphans` → フィルタ後に次数 0 のノードを除去。最後に `val = 1 + Math.sqrt(degree)` を再計算（元 graph は破壊しない）。

- [ ] **Step 1: 失敗するテストを書く**（`galaxyGraph.test.ts`。fixture は最小手書き。`TreeNodeData` 等は必要フィールドだけ埋めて `as` キャストでよい — 既存 map テストの流儀に合わせる）

テストケース（それぞれ実装すること）:

```ts
import { describe, it, expect } from "vitest";
import { buildGalaxyGraph, applyGalaxyFilters } from "./galaxyGraph";
import { DEFAULT_GALAXY_FILTERS } from "./types";

// fixture: シーン s1→s2（読み順）、codex c1(character)/c2、event e1、thread t1
// mention: s1-c1, s2-c1, s2-c2 / relation: c1-c2 "宿敵"
// eventLink: s1-e1 / participant: e1-c1 / thread: t1-s1, t1-s2

describe("buildGalaxyGraph", () => {
  it("全種別のノードを namespaced id で生成する", ...);
  it("読み順で隣接シーンに sequence エッジを張る", ...);
  it("mention/relation/eventLink/participant/thread エッジを張り、relation は label を保持する", ...);
  it("片端が存在しないエッジは捨てる", ...);   // relations に未知 id を混ぜる
  it("重複する mention は 1 本に dedup される", ...); // 同一ペアを2回入れる
  it("言及ゼロの codex エントリもノードになる", ...); // scenes: [] の entry
});

describe("applyGalaxyFilters", () => {
  it("ノード種別 OFF でノードと接続エッジが消える", ...);  // codex OFF → mention/relation/participant 消滅
  it("エッジ種別 OFF でエッジだけ消える", ...);            // sequence OFF、シーンは残る
  it("hideOrphans でフィルタ後次数 0 のノードが消える", ...);
  it("val は 1 + sqrt(degree) で再計算される", ...);
  it("入力 graph を変異させない", ...);
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `pnpm test --run src/features/map/galaxyGraph.test.ts`
Expected: FAIL（モジュール未作成）

- [ ] **Step 3: galaxyGraph.ts を実装**（上記構築ルール通り。実装の骨子）

```ts
export function buildGalaxyGraph(input: GalaxyGraphInput): GalaxyGraph {
  const nodes: GalaxyNode[] = [];
  const nodeIds = new Set<string>();
  const push = (n: GalaxyNode) => {
    if (nodeIds.has(n.id)) return;
    nodeIds.add(n.id);
    nodes.push(n);
  };

  const order = computeGlobalSceneOrder(input.treeNodes);
  const scenes = input.treeNodes
    .filter((n) => n.nodeType === "scene")
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  for (const s of scenes)
    push({ id: `scene:${s.id}`, kind: "scene", refId: s.id, label: s.title,
           typeSlug: null, color: null, val: 1 });
  // …codex/event/thread も同様…

  const links: GalaxyLink[] = [];
  const linkKeys = new Set<string>();
  const addLink = (kind: GalaxyEdgeKind, a: string, b: string, label: string | null = null) => {
    if (!nodeIds.has(a) || !nodeIds.has(b) || a === b) return;
    const [s, t] = a < b ? [a, b] : [b, a];
    const key = `${kind}|${s}|${t}`;
    if (linkKeys.has(key)) return;
    linkKeys.add(key);
    links.push({ source: a, target: b, kind, label });
  };
  for (let i = 0; i + 1 < scenes.length; i++)
    addLink("sequence", `scene:${scenes[i].id}`, `scene:${scenes[i + 1].id}`);
  // …mention/relation/eventLink/participant/thread も同様…

  return { nodes, links };
}
```

`applyGalaxyFilters` は kind→flag の lookup でノード/エッジを filter → orphan 除去 → degree 集計 → `val` を付け替えた新オブジェクトを返す。

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm test --run src/features/map/galaxyGraph.test.ts`
Expected: PASS（全ケース）

- [ ] **Step 5: Commit**

```bash
git add src/features/map/galaxyGraph.ts src/features/map/galaxyGraph.test.ts
git commit -m "feat(map): ギャラクシーグラフ構築・フィルタの純関数モジュール"
```

---

### Task 5: データローダ galaxyData.ts

**Files:**
- Create: `src/features/map/galaxyData.ts`

**Interfaces:**
- Consumes: `buildCrossReferenceReportForProject`（`@/features/codex/crossReference`）、`listCodexRelations`（`@/features/codex/codexRelationApi`）、`listEvents` / `listSceneEventsForProject` / `listEventParticipantsForProject`（`@/features/chronicle/api`）、`listPlotThreads` / `listPlotThreadLinks`（`@/features/plot-threads/api`）、`useTreeStore.getState().nodes`＋`loadTree`（`@/features/tree/treeStore`）
- Produces: `export async function loadGalaxyGraphInput(projectId: string): Promise<GalaxyGraphInput>`

- [ ] **Step 1: 実装**（薄い I/O 集約。ロジックなしなので unit test は張らない — ロジックは Task 4 が gate）

```ts
import { buildCrossReferenceReportForProject } from "@/features/codex/crossReference";
import { listCodexRelations } from "@/features/codex/codexRelationApi";
import {
  listEvents,
  listSceneEventsForProject,
  listEventParticipantsForProject,
} from "@/features/chronicle/api";
import { listPlotThreads, listPlotThreadLinks } from "@/features/plot-threads/api";
import { useTreeStore } from "@/features/tree/treeStore";
import type { GalaxyGraphInput } from "./galaxyGraph";

/**
 * ギャラクシーグラフの入力データを既存 API から一括取得する。
 * crossReference（Rust matcher で全シーン本文を走査）が支配的コスト。
 */
export async function loadGalaxyGraphInput(
  projectId: string,
): Promise<GalaxyGraphInput> {
  let treeNodes = useTreeStore.getState().nodes;
  if (treeNodes.length === 0) {
    await useTreeStore.getState().loadTree(projectId);
    treeNodes = useTreeStore.getState().nodes;
  }
  const [
    crossReference,
    relations,
    events,
    sceneEvents,
    participants,
    threads,
    threadLinks,
  ] = await Promise.all([
    buildCrossReferenceReportForProject(projectId),
    listCodexRelations(projectId),
    listEvents(projectId),
    listSceneEventsForProject(projectId),
    listEventParticipantsForProject(projectId),
    listPlotThreads(projectId),
    listPlotThreadLinks(projectId),
  ]);
  return {
    treeNodes,
    crossReference,
    relations,
    events,
    sceneEvents,
    participants,
    threads,
    threadLinks,
  };
}
```

（`useTreeStore` の `nodes` / `loadTree` のシグネチャは実装時に treeStore.ts で確認し、名前が違えば合わせる。）

- [ ] **Step 2: 型チェック**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/features/map/galaxyData.ts
git commit -m "feat(map): ギャラクシーグラフ入力データローダ"
```

---

### Task 6: 3D キャンバス GalaxyCanvas.tsx

**Files:**
- Create: `src/features/map/galaxy/GalaxyCanvas.tsx`

**Interfaces:**
- Consumes: `react-force-graph-3d` の `ForceGraph3D`、`three/examples/jsm/postprocessing/UnrealBloomPass.js`、`GalaxyGraph`/`GalaxyNode`（Task 4）、`useCodexHighlightStore`（typeColorMap）
- Produces:

```ts
interface GalaxyCanvasProps {
  graph: GalaxyGraph;
  onOpenNode: (node: GalaxyNode) => void; // ダブルクリック時（scene/codex のみ呼ぶ判断は親）
}
export function GalaxyCanvas(props: GalaxyCanvasProps): JSX.Element;
```

**実装要点（このタスクは WebGL 依存のため自動テストなし。tsc + 実機確認で gate）:**

- コンテナ `div` に `ResizeObserver` を張り、`width`/`height` を state で `ForceGraph3D` に渡す（0 の間は描画しない）。
- ノード色: `kind === "codex"` → `useCodexHighlightStore` の typeColorMap（`typeSlug` で引く、なければ `#8b7fe8`）/ `scene` → `#cfe8ff` / `event` → `#f5b04d` / `thread` → `node.color ?? "#e86fb4"`。
- `nodeVal={(n) => n.val}`、`nodeLabel={(n) => n.label}`、`backgroundColor="#05060f"`、`showNavInfo={false}`。
- エッジ: `linkColor` は kind 別の低彩度色、`linkOpacity={0.35}`。hover 中は隣接判定で強調（下記）。
- hover ハイライト: `onNodeHover` で hover ノードと隣接集合（graph.links から前計算した adjacency Map）を ref に保持し、`nodeColor`/`linkColor`/`linkWidth` のアクセサ内で減光/発光を分岐。アクセサ再評価は hover 変更時に `fgRef.current.refresh()`（react-force-graph の再描画 API。なければアクセサを useCallback で作り直して props 更新）。
- click: `fgRef.current.cameraPosition({...ノードへ寄る座標}, node, reducedMotion ? 0 : 800)`。
- double-click: `onNodeClick` のタイムスタンプ比較（350ms 以内の同一ノード再クリック）で `props.onOpenNode(node)`（`react-force-graph-3d` に onNodeDblClick は無いため）。
- bloom: マウント後に

```ts
const composer = fgRef.current?.postProcessingComposer?.();
if (composer) {
  const bloom = new UnrealBloomPass(new Vector2(width, height), 1.2, 0.6, 0.1);
  composer.addPass(bloom);
}
```

- 自動回転: `controlType="orbit"`、`fgRef.current.controls().autoRotate = !reducedMotion`（`autoRotateSpeed = 0.35`）。`controls().addEventListener("start", ...)` で最初のユーザー操作時に `autoRotate = false`。
- reduced-motion 判定: `window.matchMedia("(prefers-reduced-motion: reduce)").matches`（既存の慣行があれば `src/lib/animation.ts` 周辺のヘルパを使う）。
- warmup: `warmupTicks={80}` + `cooldownTime={reducedMotion ? 0 : 3000}` で表示時にほぼ収束済みにする。
- アンマウント時に controls listener を解除。

- [ ] **Step 1: 実装**（上記要点をすべて満たす。200 行を超えそうなら hover ハイライトの adjacency 計算を `galaxyAdjacency.ts` に切り出す）

- [ ] **Step 2: 型チェックと lint**

Run: `npx tsc --noEmit && pnpm lint:fix`
Expected: PASS / autofix のみ

- [ ] **Step 3: Commit**

```bash
git add src/features/map/galaxy/GalaxyCanvas.tsx
git commit -m "feat(map): ギャラクシー 3D キャンバス（bloom/hover ハイライト/カメラフォーカス）"
```

---

### Task 7: フィルタパネル GalaxyFilterPanel.tsx

**Files:**
- Create: `src/features/map/galaxy/GalaxyFilterPanel.tsx`

**Interfaces:**
- Consumes: `GalaxyFilters` / `GalaxyFiltersPatch`（Task 2）、i18n キー `map.galaxy.*`（Task 3）
- Produces:

```ts
interface GalaxyFilterPanelProps {
  filters: GalaxyFilters;
  onChange: (patch: GalaxyFiltersPatch) => void;
}
export function GalaxyFilterPanel(props: GalaxyFilterPanelProps): JSX.Element;
```

- [ ] **Step 1: 実装**

- 右上フローティングの半透明カード（`position: absolute; top/right 12px`、`bg-background/80 backdrop-blur`、既存パネルのトーンに合わせる）。
- セクション「ノード」（`map.galaxy.nodeSection`）: scenes/codex/events/threads のチェックボックス（既存の checkbox コンポーネント `@/components/ui/checkbox` があればそれ、なければ MapHeader の show トグルと同じ部品を流用）。
- セクション「つながり」（`map.galaxy.edgeSection`）: 6 エッジ種別のチェックボックス。
- 最下段に `hideOrphans` トグル。
- 各ラベルは `t("map.galaxy.nodes.scenes")` 等。`onChange({ nodes: { scenes: v } })` 形式で patch を上げる。

- [ ] **Step 2: 型チェックと lint**

Run: `npx tsc --noEmit && pnpm lint:fix`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/features/map/galaxy/GalaxyFilterPanel.tsx
git commit -m "feat(map): ギャラクシーフィルタパネル"
```

---

### Task 8: コンテナ MapGalaxyView.tsx（状態管理・ジャンプ・遅延ロード境界）

**Files:**
- Create: `src/features/map/galaxy/MapGalaxyView.tsx`
- Test: `src/features/map/galaxy/MapGalaxyView.test.tsx`

**Interfaces:**
- Consumes: `loadGalaxyGraphInput`（Task 5）、`buildGalaxyGraph`/`applyGalaxyFilters`（Task 4）、`GalaxyCanvas`（Task 6）、`GalaxyFilterPanel`（Task 7）、`useMapStore`（viewKind/galaxyFilters、Task 2）、`useEnsureCodexTypeColors`（`@/features/codex/useEnsureCodexTypeColors`）、`useTabStore().openPinned`（`@/features/editor/tabStore`）、`useCodexStore().requestSelectEntry`（`@/features/codex/codexStore`）、`useCurrentProjectId`
- Produces: `export function MapGalaxyView(): JSX.Element`（default export も付ける — lazy 用に `export default MapGalaxyView`）

- [ ] **Step 1: 失敗するテストを書く**（happy-dom。`GalaxyCanvas` は three を引き込むので **必ず vi.mock** する。`galaxyData` / tauri invoke も mock。browser-test-mock-esm の教訓どおり import 経路を網羅的に mock すること）

```tsx
vi.mock("./GalaxyCanvas", () => ({
  GalaxyCanvas: ({ graph }: { graph: { nodes: unknown[] } }) => (
    <div data-testid="galaxy-canvas" data-node-count={graph.nodes.length} />
  ),
}));
vi.mock("../galaxyData", () => ({ loadGalaxyGraphInput: vi.fn() }));

describe("MapGalaxyView", () => {
  it("ロード中はローディング表示、完了でキャンバスを描画する", async () => { ... });
  it("ノード 0 件なら空状態メッセージを出す", async () => { ... });      // map.galaxy.empty
  it("ロード失敗でエラーメッセージを出す", async () => { ... });          // map.galaxy.loadError
  it("フィルタ変更で表示グラフが絞り込まれる", async () => { ... });      // hideOrphans トグル→ node-count 減
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `pnpm test --run src/features/map/galaxy/MapGalaxyView.test.tsx`
Expected: FAIL（モジュール未作成）

- [ ] **Step 3: 実装**

構成:

```
<div class="relative h-full w-full">           ← MapPanel 側のヘッダ下スロットに入る
  {loading && <Spinner + t("map.galaxy.loading")>}
  {error && <p>t("map.galaxy.loadError")</p>}
  {empty && <p>t("map.galaxy.empty")</p>}
  {!webglAvailable && <p>t("map.galaxy.noWebgl")</p>}
  {graph && <GalaxyCanvas graph={filtered} onOpenNode={handleOpen} />}
  <GalaxyFilterPanel filters={galaxyFilters} onChange={setGalaxyFilters} />
  （左上に更新ボタン: RefreshCw アイコン、t("map.galaxy.refresh")）
</div>
```

- マウント時と更新ボタンで `loadGalaxyGraphInput(projectId)` → `buildGalaxyGraph` を実行し raw graph を state に保持。`applyGalaxyFilters(raw, galaxyFilters)` は `useMemo`。
- `useEnsureCodexTypeColors()` を呼ぶ（typeColorMap を埋める）。
- WebGL 判定: `!!document.createElement("canvas").getContext("webgl2")`（false なら Canvas を描画せずメッセージ。test 環境の happy-dom は getContext が null を返すため、テストでは `vi.stubGlobal` か canvas mock で true にする）。
- `handleOpen(node)`: `kind === "scene"` → `useTabStore.getState().openPinned(node.refId)` / `kind === "codex"` → `useCodexStore.getState().requestSelectEntry(node.refId)`。event/thread は無視。
- ロード中に unmount された場合の setState を `cancelled` フラグで防ぐ。

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm test --run src/features/map/galaxy/MapGalaxyView.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/features/map/galaxy/MapGalaxyView.tsx src/features/map/galaxy/MapGalaxyView.test.tsx
git commit -m "feat(map): MapGalaxyView コンテナ（ロード/空/エラー状態・ジャンプ・フィルタ配線）"
```

---

### Task 9: MapPanel 分岐 + MapHeader 切替ボタン

**Files:**
- Modify: `src/features/map/MapPanel.tsx`
- Modify: `src/features/map/MapHeader.tsx`

**Interfaces:**
- Consumes: `useMapStore` の `viewKind`/`setViewKind`（Task 2）、`MapGalaxyView`（Task 8）

- [ ] **Step 1: MapPanel.tsx にビュー分岐と lazy 境界を追加**

```tsx
import { lazy, Suspense } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { MapHeader } from "./MapHeader";
import { MapCanvas } from "./MapCanvas";
import { useMapStore } from "./mapStore";

// three 系をギャラクシー初回表示まで起動バンドルから外す
const MapGalaxyView = lazy(() => import("./galaxy/MapGalaxyView"));

export function MapPanel() {
  const viewKind = useMapStore((s) => s.viewKind);
  return (
    <div className="flex h-full w-full flex-col bg-background">
      <MapHeader />
      <div className="min-h-0 flex-1">
        {viewKind === "galaxy" ? (
          <Suspense fallback={null}>
            <MapGalaxyView />
          </Suspense>
        ) : (
          <ReactFlowProvider>
            <MapCanvas />
          </ReactFlowProvider>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: MapHeader.tsx に切替トグルを追加し、galaxy 中はボード専用ツールを隠す**

- `viewKind` / `setViewKind` を `useMapStore` から取得。
- タイトル直後（board selector の前）に 2 値セグメントトグル（`Button` 2 個組 or 既存のセグメント部品）: `t("map.view.board")` / `t("map.view.galaxy")`、アイコンは `MapIcon` / `Orbit`（lucide）。`title` 属性に `map.view.switchToGalaxy` / `switchToBoard`。
- `viewKind === "galaxy"` のときは board selector・モード・整列・パレット・エクスポート等のボード専用 UI を **レンダリングしない**（`{viewKind === "board" && (…既存ツールバー…)}` で包む）。ヘッダ自体（`data-panel-header` の div、タイトル、切替トグル）は常時表示。

- [ ] **Step 3: 型チェック・lint・map 関連テスト**

Run: `npx tsc --noEmit && pnpm lint:fix && pnpm test --run src/features/map`
Expected: 全 PASS（MapHeader 既存テストが壊れたらトグル追加に合わせて更新）

- [ ] **Step 4: Commit**

```bash
git add src/features/map/MapPanel.tsx src/features/map/MapHeader.tsx
git commit -m "feat(map): ボード/ギャラクシーのビュー切替（galaxy は lazy チャンク）"
```

---

### Task 10: 全体検証

- [ ] **Step 1: 全テスト**

Run: `pnpm test --run`
Expected: 全 PASS

- [ ] **Step 2: 型・lint・ビルド確認**

Run: `npx tsc --noEmit && pnpm lint:fix && pnpm build`
Expected: PASS。`pnpm build` の出力で three 系が別チャンク（`MapGalaxyView-*.js` 等）に分離されていることを確認。

- [ ] **Step 3: Commit（残変更があれば）**

```bash
git status --short
# 変更が残っていれば明示パスで add して commit
```

**実機確認（ユーザー向けメモ、CI 外）:** `pnpm tauri dev` → Map パネル → ギャラクシー切替。確認項目: 銀河が表示される / hover で隣接発光 / クリックでカメラ寄り / ダブルクリックでシーン・Codex が開く / フィルタが効き再起動後も保持 / ボードに戻れる / reduced-motion で自動回転しない。

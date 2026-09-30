// @vitest-environment happy-dom
/**
 * VirtualTree と TreeNodeItem の描画コストの契約 gate:
 *   (1) フィルタ非表示ノードは TreeNodeItem を mount しない
 *       (旧実装は全 hook を回してから return null していた)
 *   (2) TreeNodeItem は memo 化され、無関係な行は親の再レンダーで再レンダー
 *       されない (選択変更で flips した行だけが render する)
 *   (3) dropIndicator は React state でなく DOM 直書き — drag over で行が
 *       1 つも再レンダーされず、対象行に data 属性だけが付く
 * render 回数は perfLog の recordMark("treeNodeItem.render") を捕捉して数える
 * (ChatPanel.virtualization.test.tsx と同じ手法)。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { useRef } from "react";
import { DndContext, useDndContext } from "@dnd-kit/core";
import type { DragMoveEvent, DragEndEvent } from "@dnd-kit/core";

const perfCapture = vi.hoisted(() => ({ marks: [] as string[] }));
vi.mock("@/lib/perfLog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/perfLog")>()),
  recordMark: (name: string) => {
    perfCapture.marks.push(name);
  },
}));

// These small fixtures fit in one viewport. Keep the virtualizer identity
// stable, as in production, so measureElement does not invalidate row memo.
// VirtualTree.test.tsx and VirtualTree.browser.test.tsx cover windowing.
vi.mock("@tanstack/react-virtual", () => {
  type Options = {
    count: number;
    getItemKey: (index: number) => string | number;
  };
  let options: Options;
  const virtualizer = {
    getTotalSize: () => options.count * 28,
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        key: options.getItemKey(index),
        start: index * 28,
        size: 28,
      })),
    measureElement: vi.fn(),
    scrollToIndex: vi.fn(),
  };
  return {
    useVirtualizer: (nextOptions: Options) => {
      options = nextOptions;
      return virtualizer;
    },
  };
});

import { VirtualTree } from "./VirtualTree";
import { buildTreeIndex } from "./treeIndex";
import { deriveVisibleTreeRows } from "./treeVisibility";
import { useScenesDnd } from "./useScenesDnd";
import { useTreeStore } from "./treeStore";
import type { TreeNodeData } from "./treeStore";

function makeNode(
  id: string,
  nodeType: "scene" | "folder",
  parentId: string | null,
  sortOrder: string,
  title = `題名${id}`,
): TreeNodeData {
  return {
    id,
    parentId,
    nodeType,
    title,
    sortOrder,
    status: "draft",
    synopsis: null,
    charCount: 0,
    updatedAt: "2026-06-10T00:00:00Z",
  } as unknown as TreeNodeData;
}

function rowRenderCount(): number {
  return perfCapture.marks.filter((m) => m === "treeNodeItem.render").length;
}

// 安定参照の共有 fixture (memo を破らないようモジュールレベル const)
const EMPTY_IDS: string[] = [];
const baseTreeProps = {
  scrollElement: null,
  activeSceneId: "",
  viewMode: "tree",
  showWordCounts: false,
  showStatusDots: false,
  showLabelDots: false,
  showPlotThreadTrack: false,
  showAiAttribution: false,
  draggingId: null,
  autoRevealActiveScene: false,
  pendingRevealId: null,
  onPendingRevealHandled: () => {},
  autoExpandFolders: false,
} as const;

beforeEach(() => {
  perfCapture.marks.length = 0;
  useTreeStore.setState({
    charCounts: {},
    aiRatios: {},
    pendingRenameId: null,
    selectedIds: [],
  });
});

describe("VirtualTree: フィルタ非表示ノードの mount スキップ", () => {
  const f1 = makeNode("f1", "folder", null, "a1");
  const s1 = makeNode("s1", "scene", "f1", "a1", "りんごのシーン");
  const s2 = makeNode("s2", "scene", "f1", "a2", "ばななのシーン");
  const expanded = ["f1"];
  const rows = deriveVisibleTreeRows(buildTreeIndex([f1, s1, s2]), {
    expandedIds: expanded,
    query: "りんご",
  });
  const flat = rows.map((row) => row.node);

  // 「render 自体が走ったか」は recordMark では判別できない (旧実装の
  // return null は recordMark より前)。hooks が走った確かな痕跡として
  // dnd-kit への droppable 登録 (useDroppable) を probe で観測する。
  const ctxHolder: { droppableIds: Set<string> } = {
    droppableIds: new Set(),
  };
  function DndProbe() {
    const ctx = useDndContext();
    ctxHolder.droppableIds = new Set(
      Array.from(ctx.droppableContainers.keys?.() ?? []).map(String),
    );
    return null;
  }

  function Harness() {
    const orderedNodesRef = useRef(flat);
    return (
      <DndContext>
        <DndProbe />
        <VirtualTree
          {...baseTreeProps}
          rows={rows}
          selectedIds={EMPTY_IDS}
          expandedIds={expanded}
          orderedNodesRef={orderedNodesRef}
        />
      </DndContext>
    );
  }

  it("クエリに合致しないノードは hooks (droppable 登録) ごとスキップされる", () => {
    const { container } = render(<Harness />);

    // 可視 = f1 (子孫マッチ) + s1 のみ。旧実装は s2 も全 hook を回してから
    // null を返すため drop-s2 が登録されてしまう。
    expect(ctxHolder.droppableIds.has("drop-s1")).toBe(true);
    expect(ctxHolder.droppableIds.has("drop-s2")).toBe(false);
    expect(container.querySelector('[data-node-id="s1"]')).not.toBeNull();
    expect(container.querySelector('[data-node-id="s2"]')).toBeNull();
  });
});

describe("TreeNodeItem: memo による再レンダー範囲の限定", () => {
  const s1 = makeNode("s1", "scene", null, "a1");
  const s2 = makeNode("s2", "scene", null, "a2");
  const s3 = makeNode("s3", "scene", null, "a3");
  const flat = [s1, s2, s3];
  const rows = flat.map((node) => ({ node, depth: 0 }));

  function Harness({ selectedIds }: { selectedIds: string[] }) {
    const orderedNodesRef = useRef(flat);
    return (
      <DndContext>
        <VirtualTree
          {...baseTreeProps}
          rows={rows}
          selectedIds={selectedIds}
          expandedIds={EMPTY_IDS}
          orderedNodesRef={orderedNodesRef}
        />
      </DndContext>
    );
  }

  it("選択変更ではフラグが変わった行だけが再レンダーされる", () => {
    // 初期 mount は dnd-kit の droppable 登録で 2 パス目が走るため
    // 件数を assert しない。settle 後の rerender だけを計測する。
    const { rerender } = render(<Harness selectedIds={EMPTY_IDS} />);

    perfCapture.marks.length = 0;
    rerender(<Harness selectedIds={["s2"]} />);

    // isSelected が flip した s2 のみ。memo が無いと 3 行全部が再レンダー。
    expect(rowRenderCount()).toBe(1);
  });

  it("updatedAtだけの更新では行全体を再レンダーしない", () => {
    useTreeStore.setState({ nodes: flat });
    render(<Harness selectedIds={EMPTY_IDS} />);

    perfCapture.marks.length = 0;
    act(() => {
      useTreeStore.setState({
        nodes: flat.map((node) =>
          node.id === "s2"
            ? { ...node, updatedAt: "2026-06-10T00:00:01Z" }
            : node,
        ),
      });
    });

    expect(rowRenderCount()).toBe(0);
  });
});

describe("dropIndicator: DOM 直書き (drag over で React 再レンダー無し)", () => {
  const f1 = makeNode("f1", "folder", null, "a1");
  const s1 = makeNode("s1", "scene", null, "a2");
  const s2 = makeNode("s2", "scene", null, "a3");
  const nodeMap = { f1, s1, s2 };
  const childMap = { root: ["f1", "s1", "s2"] };
  const flat = [f1, s1, s2];
  const rows = flat.map((node) => ({ node, depth: 0 }));

  // pointerYRef は初期値 0 のまま使う (useScenesDnd.test.ts と同じ手法)。
  // leaf: top=-30,h=40 → relY=30 ≥ 20 → "after"
  const afterRect = {
    top: -30,
    left: 0,
    right: 100,
    bottom: 10,
    width: 100,
    height: 40,
  };
  // folder: top=-20,h=40 → relY=20 ∈ (10, 30) → "inside"
  const insideRect = {
    top: -20,
    left: 0,
    right: 100,
    bottom: 20,
    width: 100,
    height: 40,
  };

  type DndApi = ReturnType<typeof useScenesDnd>;
  const holder: { dnd: DndApi | null } = { dnd: null };

  function Harness() {
    const containerRef = useRef<HTMLDivElement>(null);
    const orderedNodesRef = useRef(flat);
    const dnd = useScenesDnd({
      nodeMap,
      childMap,
      flatNodes: flat,
      moveNode: vi.fn().mockResolvedValue(undefined),
      containerRef,
    });
    holder.dnd = dnd;
    return (
      <DndContext sensors={dnd.sensors}>
        <div ref={containerRef}>
          <VirtualTree
            {...baseTreeProps}
            rows={rows}
            selectedIds={EMPTY_IDS}
            expandedIds={EMPTY_IDS}
            orderedNodesRef={orderedNodesRef}
            draggingId={dnd.draggingId}
          />
        </div>
      </DndContext>
    );
  }

  function dragOver(activeId: string, overId: string, rect: object) {
    act(() => {
      holder.dnd!.onDragOver({
        active: { id: activeId },
        over: { id: `drop-${overId}`, rect },
      } as unknown as DragMoveEvent);
    });
  }

  it("over 対象の行に data 属性が付き、行は再レンダーされない", () => {
    const { container } = render(<Harness />);
    perfCapture.marks.length = 0;

    // leaf の after ゾーン
    dragOver("s1", "s2", afterRect);
    const s2Li = container.querySelector('[data-node-id="s2"]');
    expect(s2Li?.getAttribute("data-drop-after")).toBe("true");
    expect(rowRenderCount()).toBe(0);

    // folder の inside ゾーンへ移動 → 前の指示が消え、行 div に inside が付く
    dragOver("s1", "f1", insideRect);
    expect(s2Li?.hasAttribute("data-drop-after")).toBe(false);
    const f1Row = container.querySelector('[data-node-row="f1"]');
    expect(f1Row?.getAttribute("data-drop-inside")).toBe("true");
    expect(rowRenderCount()).toBe(0);
  });

  it("drag 終了/キャンセルで指示が消える", () => {
    const { container } = render(<Harness />);

    dragOver("s1", "s2", afterRect);
    expect(
      container
        .querySelector('[data-node-id="s2"]')
        ?.getAttribute("data-drop-after"),
    ).toBe("true");

    act(() => {
      holder.dnd!.onDragEnd({
        active: { id: "s1" },
        over: null,
      } as unknown as DragEndEvent);
    });
    expect(
      container
        .querySelector('[data-node-id="s2"]')
        ?.hasAttribute("data-drop-after"),
    ).toBe(false);

    // キャンセル経路でも残骸が残らない
    dragOver("s1", "f1", insideRect);
    act(() => {
      holder.dnd!.onDragCancel();
    });
    expect(
      container
        .querySelector('[data-node-row="f1"]')
        ?.hasAttribute("data-drop-inside"),
    ).toBe(false);
  });
});

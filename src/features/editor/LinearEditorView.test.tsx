// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { useTreeStore, type TreeNodeData } from "@/features/tree/treeStore";

// LinearSceneBlock は TipTap / API / 多数の hooks に依存して mount コストが高い。
// scenes memo (DFS pre-order) の DOM 順だけ assert したいので、`data-scene-id`
// 付きの軽い div に差し替える。LinearEditorView 側の `<div key>` ラッパは
// querySelectorAll('[data-scene-id]') が無視する。
vi.mock("./LinearSceneBlock", () => ({
  LinearSceneBlock: ({ sceneId }: { sceneId: string }) => (
    <div data-scene-id={sceneId} data-testid={`scene-${sceneId}`} />
  ),
}));

vi.mock("@/features/editor/Toolbar", () => ({
  Toolbar: ({ editor }: { editor: unknown }) => (
    <div data-testid="toolbar" data-has-editor={editor ? "true" : "false"} />
  ),
}));
vi.mock("@/features/editor/FindReplaceBar", () => ({
  FindReplaceBar: () => null,
}));
vi.mock("@/features/editor/CodexPopover", () => ({
  CodexPopover: () => null,
}));
vi.mock("@/features/editor/EditorContextMenu", () => ({
  EditorContextMenu: () => null,
}));
const settingsOverride = vi.hoisted(
  () => ({ current: {} }) as { current: Record<string, unknown> },
);
vi.mock("@/features/settings/hooks/useEditorSettings", () => ({
  useEditorSettings: () => ({
    maxContentWidth: 800,
    sceneMetaPanelOpen: false,
    sceneMetaPanelWidth: 25,
    ...settingsOverride.current,
  }),
}));
vi.mock("@/features/editor/SceneMetaPanel", () => ({
  SceneMetaPanel: ({ sceneId }: { sceneId: string }) => (
    <div data-testid="scene-meta-panel" data-scene={sceneId} />
  ),
}));
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ResizablePanel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ResizableHandle: () => null,
}));

// happy-dom には IntersectionObserver / ResizeObserver が無いので minimal stub
class StubIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("IntersectionObserver", StubIntersectionObserver);
vi.stubGlobal("ResizeObserver", StubResizeObserver);

import { LinearEditorView } from "./LinearEditorView";
import { useLinearEditorStore } from "./linearEditorStore";
import { useSlashCommandStore } from "./inlineAi/slashCommandStore";
import type { Editor } from "@tiptap/core";

const NODE_DEFAULTS = {
  projectId: "p",
  parentId: null as string | null,
  synopsis: null,

  intent: null,
  status: null,
  storyTimeOrder: null,
  storyTimeLabel: null,
  povCharacterId: null,
  locationId: null,
  charCount: 0,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
} as const;

function makeNode(
  overrides: Partial<TreeNodeData> & { id: string },
): TreeNodeData {
  return {
    ...NODE_DEFAULTS,
    nodeType: "scene",
    title: overrides.id,
    sortOrder: "a0",
    ...overrides,
  };
}

beforeEach(() => {
  useTreeStore.setState({ nodes: [], activeSceneId: "" });
  useLinearEditorStore.setState({
    focusedEditor: null,
    focusedSceneId: null,
    pendingScrollToId: null,
    editorsById: {},
  });
  settingsOverride.current = {};
});

describe("LinearEditorView — scene ordering", () => {
  it("複数フォルダのシーンを DFS pre-order で並べる (per-parent fractional sort)", () => {
    // 構造:
    //   Folder A (sortOrder='a0')
    //     ├ A1 (sortOrder='a0')
    //     └ A2 (sortOrder='a1')
    //   Folder B (sortOrder='a1')
    //     ├ B1 (sortOrder='a0')   ← フラット sort だと A1 と衝突する
    //     └ B2 (sortOrder='a1')   ← フラット sort だと A2 と衝突する
    //   R1 (root scene, sortOrder='a2')
    useTreeStore.setState({
      nodes: [
        makeNode({ id: "folderA", nodeType: "folder", sortOrder: "a0" }),
        makeNode({ id: "folderB", nodeType: "folder", sortOrder: "a1" }),
        makeNode({ id: "B1", parentId: "folderB", sortOrder: "a0" }),
        makeNode({ id: "A2", parentId: "folderA", sortOrder: "a1" }),
        makeNode({ id: "A1", parentId: "folderA", sortOrder: "a0" }),
        makeNode({ id: "R1", parentId: null, sortOrder: "a2" }),
        makeNode({ id: "B2", parentId: "folderB", sortOrder: "a1" }),
      ],
    });

    const { container } = render(<LinearEditorView />);
    const order = Array.from(container.querySelectorAll("[data-scene-id]")).map(
      (el) => (el as HTMLElement).dataset.sceneId,
    );

    expect(order).toEqual(["A1", "A2", "B1", "B2", "R1"]);
  });

  it("ネストしたフォルダも pre-order で flatten される", () => {
    //   Folder Outer (a0)
    //     ├ Outer-S1 (a0)
    //     └ Folder Inner (a1)
    //         ├ Inner-S1 (a0)
    //         └ Inner-S2 (a1)
    //   Root-S (a1)
    useTreeStore.setState({
      nodes: [
        makeNode({ id: "outer", nodeType: "folder", sortOrder: "a0" }),
        makeNode({
          id: "inner",
          nodeType: "folder",
          parentId: "outer",
          sortOrder: "a1",
        }),
        makeNode({ id: "Inner-S2", parentId: "inner", sortOrder: "a1" }),
        makeNode({ id: "Inner-S1", parentId: "inner", sortOrder: "a0" }),
        makeNode({ id: "Outer-S1", parentId: "outer", sortOrder: "a0" }),
        makeNode({ id: "Root-S", parentId: null, sortOrder: "a1" }),
      ],
    });

    const { container } = render(<LinearEditorView />);
    const order = Array.from(container.querySelectorAll("[data-scene-id]")).map(
      (el) => (el as HTMLElement).dataset.sceneId,
    );

    expect(order).toEqual(["Outer-S1", "Inner-S1", "Inner-S2", "Root-S"]);
  });

  it("note ノードは linear に含めない (現状仕様)", () => {
    useTreeStore.setState({
      nodes: [
        makeNode({ id: "S1", sortOrder: "a0" }),
        makeNode({ id: "N1", nodeType: "note", sortOrder: "a1" }),
        makeNode({ id: "S2", sortOrder: "a2" }),
      ],
    });
    const { container } = render(<LinearEditorView />);
    const order = Array.from(container.querySelectorAll("[data-scene-id]")).map(
      (el) => (el as HTMLElement).dataset.sceneId,
    );
    expect(order).toEqual(["S1", "S2"]);
  });

  it("空のフォルダは出力をスキップする", () => {
    useTreeStore.setState({
      nodes: [
        makeNode({ id: "emptyFolder", nodeType: "folder", sortOrder: "a0" }),
        makeNode({ id: "S1", sortOrder: "a1" }),
      ],
    });
    const { container } = render(<LinearEditorView />);
    const order = Array.from(container.querySelectorAll("[data-scene-id]")).map(
      (el) => (el as HTMLElement).dataset.sceneId,
    );
    expect(order).toEqual(["S1"]);
  });

  it("孤児 scene (parentId が消失/循環) も末尾に必ず出力する", () => {
    // 旧フラット sort は無条件で全 scene を render していたので、DFS で
    // 到達できない scene を落とすと「missing documents」の新たな経路に
    // なる。orphan は append して出力本数を保つ。
    useTreeStore.setState({
      nodes: [
        makeNode({ id: "folderA", nodeType: "folder", sortOrder: "a0" }),
        makeNode({ id: "A1", parentId: "folderA", sortOrder: "a0" }),
        // parentId が存在しない folder を指す orphan
        makeNode({ id: "ghost-orphan", parentId: "ghost", sortOrder: "a0" }),
        // 親同士で循環している (folder cyc1 ↔ cyc2)。中の scene も孤児扱い。
        makeNode({
          id: "cyc1",
          nodeType: "folder",
          parentId: "cyc2",
          sortOrder: "a0",
        }),
        makeNode({
          id: "cyc2",
          nodeType: "folder",
          parentId: "cyc1",
          sortOrder: "a0",
        }),
        makeNode({ id: "cyc-scene", parentId: "cyc1", sortOrder: "a0" }),
      ],
    });

    const { container } = render(<LinearEditorView />);
    const order = Array.from(container.querySelectorAll("[data-scene-id]")).map(
      (el) => (el as HTMLElement).dataset.sceneId,
    );

    // walk(null) で到達: A1
    // orphan: ghost-orphan, cyc-scene (sortOrder 順)
    expect(order).toContain("A1");
    expect(order).toContain("ghost-orphan");
    expect(order).toContain("cyc-scene");
    expect(order[0]).toBe("A1");
    expect(order).toHaveLength(3);
  });
});

describe("LinearEditorView — scene meta panel", () => {
  it("sceneMetaPanelOpen=true かつ active シーンがあれば詳細パネルを出す", () => {
    settingsOverride.current = { sceneMetaPanelOpen: true };
    useTreeStore.setState({
      nodes: [makeNode({ id: "S1" })],
      activeSceneId: "S1",
    });

    const { container } = render(<LinearEditorView />);
    const panel = container.querySelector("[data-testid='scene-meta-panel']");
    expect(panel).not.toBeNull();
    expect((panel as HTMLElement).dataset.scene).toBe("S1");
  });

  it("sceneMetaPanelOpen=false ならパネルを出さない", () => {
    useTreeStore.setState({
      nodes: [makeNode({ id: "S1" })],
      activeSceneId: "S1",
    });

    const { container } = render(<LinearEditorView />);
    expect(
      container.querySelector("[data-testid='scene-meta-panel']"),
    ).toBeNull();
  });
});

describe("LinearEditorView — toolbar editor 供給", () => {
  it("フォーカス無しでも active シーンの editor が Toolbar に渡る", () => {
    useTreeStore.setState({
      nodes: [makeNode({ id: "S1" })],
      activeSceneId: "S1",
    });
    useLinearEditorStore.getState().registerEditor("S1", {} as Editor);

    const { container } = render(<LinearEditorView />);
    expect(
      container
        .querySelector("[data-testid='toolbar']")
        ?.getAttribute("data-has-editor"),
    ).toBe("true");
  });

  it("active シーンの editor が未登録なら focusedEditor にフォールバックする", () => {
    useTreeStore.setState({
      nodes: [makeNode({ id: "S1" })],
      activeSceneId: "S1",
    });

    const { container } = render(<LinearEditorView />);
    expect(
      container
        .querySelector("[data-testid='toolbar']")
        ?.getAttribute("data-has-editor"),
    ).toBe("false");
  });
});

// B1 回帰ガード: SlashCommandPopup は EditorPane にしかマウントされておらず、
// リニアモード (SceneEditor が LinearEditorView だけを描画) では
// SlashCommandExtension が store.open しても描画するコンポーネントが無く、
// サジェストが一切出なかった。
describe("LinearEditorView — スラッシュコマンドポップアップ", () => {
  it("slashCommandStore が open になるとサジェストが描画される", () => {
    useTreeStore.setState({ nodes: [makeNode({ id: "S1" })] });
    render(<LinearEditorView />);

    expect(document.body.textContent).not.toContain("/continue");

    act(() => {
      useSlashCommandStore.getState().open({
        items: [
          {
            id: "continue",
            label: "続きを書く",
            description: "",
            mode: "insert",
            needsSelection: false,
          } as never,
        ],
        query: "",
        rect: { top: 0, left: 0, bottom: 20 },
        commandFn: () => {},
      });
    });

    // Popup は document.body へ portal される
    expect(document.body.textContent).toContain("/continue");

    act(() => {
      useSlashCommandStore.getState().close();
    });
  });
});

// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GalaxyGraphInput } from "../galaxyGraph";

// Suppress global-settings persistence (mapStore subscribe)
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue({}),
}));

// three を引き込む 3D 描画層は必ず mock する（happy-dom では WebGL 不可）。
// onSelectNode の配線検証用に、ノードごとの選択ボタンを生やす。
vi.mock("./GalaxyCanvas", () => ({
  GalaxyCanvas: ({
    graph,
    onSelectNode,
  }: {
    graph: { nodes: Array<{ id: string }> };
    onSelectNode: (node: { id: string }) => void;
  }) => (
    <div data-testid="galaxy-canvas" data-node-count={graph.nodes.length}>
      {graph.nodes.map((n) => (
        <button
          key={n.id}
          data-testid={`select-${n.id}`}
          onClick={() => onSelectNode(n)}
        />
      ))}
    </div>
  ),
}));

// 2D 描画層も同様に mock（切替検証用に testid を分ける）
vi.mock("./Galaxy2DCanvas", () => ({
  Galaxy2DCanvas: ({ graph }: { graph: { nodes: unknown[] } }) => (
    <div data-testid="galaxy-canvas-2d" data-node-count={graph.nodes.length} />
  ),
}));

const loadGalaxyGraphInput = vi.fn();
vi.mock("../galaxyData", () => ({
  loadGalaxyGraphInput: (...a: unknown[]) => loadGalaxyGraphInput(...a),
}));

vi.mock("@/features/project/projectStore", () => ({
  useCurrentProjectId: () => "p1",
  getCurrentProjectId: () => "p1",
}));

// invoke 依存の色ロードを isolate
vi.mock("@/features/codex/useEnsureCodexTypeColors", () => ({
  useEnsureCodexTypeColors: () => {},
}));

const openPinned = vi.fn();
vi.mock("@/features/editor/tabStore", () => ({
  useTabStore: { getState: () => ({ openPinned }) },
}));
const requestSelectEntry = vi.fn();
vi.mock("@/features/codex/codexStore", () => ({
  useCodexStore: { getState: () => ({ requestSelectEntry }) },
}));
const setActiveScene = vi.fn();
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: { getState: () => ({ setActiveScene }) },
}));
const setSelectedEventId = vi.fn();
vi.mock("@/features/chronicle/chronicleStore", () => ({
  useChronicleStore: { getState: () => ({ setSelectedEventId }) },
}));
const setSelectedPlotThreadId = vi.fn();
vi.mock("@/features/timeline/timelineStore", () => ({
  useTimelineStore: { getState: () => ({ setSelectedPlotThreadId }) },
}));

import { MapGalaxyView } from "./MapGalaxyView";
import { useMapStore } from "../mapStore";
import { DEFAULT_GALAXY_FILTERS } from "../types";

// happy-dom の canvas.getContext は null → WebGL 判定を通す
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    {} as unknown as ReturnType<HTMLCanvasElement["getContext"]>,
  );
  useMapStore.setState({
    galaxyFilters: DEFAULT_GALAXY_FILTERS,
    galaxyDimension: "3d",
  });
  loadGalaxyGraphInput.mockReset();
});

/** 全 4 種のノード各 1 つ（すべて孤立、エッジなし）の入力 */
function fixtureInput(): GalaxyGraphInput {
  return {
    treeNodes: [
      {
        id: "s1",
        parentId: null,
        nodeType: "scene",
        title: "シーン1",
        sortOrder: "a",
      },
    ] as GalaxyGraphInput["treeNodes"],
    crossReference: [
      {
        entryId: "c1",
        entryName: "アリス",
        entryType: "character",
        scenes: [],
      },
    ],
    relations: [],
    events: [{ id: "e1", title: "開戦" }] as GalaxyGraphInput["events"],
    sceneEvents: [],
    participants: [],
    threads: [
      { id: "t1", name: "主軸", color: "#f00" },
    ] as GalaxyGraphInput["threads"],
    threadLinks: [],
  };
}

function emptyInput(): GalaxyGraphInput {
  return {
    treeNodes: [],
    crossReference: [],
    relations: [],
    events: [],
    sceneEvents: [],
    participants: [],
    threads: [],
    threadLinks: [],
  };
}

describe("MapGalaxyView", () => {
  it("ロード中はローディング表示、完了でキャンバスを描画する", async () => {
    let resolve!: (v: GalaxyGraphInput) => void;
    loadGalaxyGraphInput.mockReturnValue(
      new Promise<GalaxyGraphInput>((r) => {
        resolve = r;
      }),
    );
    render(<MapGalaxyView />);
    expect(screen.getByText("グラフを構築中…")).toBeTruthy();
    resolve(fixtureInput());
    const canvas = await screen.findByTestId("galaxy-canvas");
    expect(canvas.getAttribute("data-node-count")).toBe("4");
  });

  it("ノード 0 件なら空状態メッセージを出す", async () => {
    loadGalaxyGraphInput.mockResolvedValue(emptyInput());
    render(<MapGalaxyView />);
    await screen.findByText(/まだノードがありません/);
    expect(screen.queryByTestId("galaxy-canvas")).toBeNull();
  });

  it("ロード失敗でエラーメッセージを出す", async () => {
    loadGalaxyGraphInput.mockRejectedValue(new Error("boom"));
    render(<MapGalaxyView />);
    await screen.findByText("グラフデータの読み込みに失敗しました");
  });

  it("2D/3D トグルで描画層が切り替わり store に反映される", async () => {
    loadGalaxyGraphInput.mockResolvedValue(fixtureInput());
    render(<MapGalaxyView />);
    await screen.findByTestId("galaxy-canvas");
    expect(screen.queryByTestId("galaxy-canvas-2d")).toBeNull();

    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByTitle("2D 表示"));

    const canvas2d = await screen.findByTestId("galaxy-canvas-2d");
    expect(canvas2d.getAttribute("data-node-count")).toBe("4");
    expect(screen.queryByTestId("galaxy-canvas")).toBeNull();
    expect(useMapStore.getState().galaxyDimension).toBe("2d");
  });

  it("WebGL 不可では 3D のみブロックし、2D 切替で描画できる", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    loadGalaxyGraphInput.mockResolvedValue(fixtureInput());
    render(<MapGalaxyView />);
    await screen.findByText("この環境では 3D 表示を利用できません");
    expect(screen.queryByTestId("galaxy-canvas")).toBeNull();

    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByTitle("2D 表示"));
    await screen.findByTestId("galaxy-canvas-2d");
  });

  it("ノードクリックで対応エンティティが選択される", async () => {
    loadGalaxyGraphInput.mockResolvedValue(fixtureInput());
    render(<MapGalaxyView />);
    await screen.findByTestId("galaxy-canvas");
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await user.click(screen.getByTestId("select-scene:s1"));
    expect(setActiveScene).toHaveBeenCalledWith("s1");

    await user.click(screen.getByTestId("select-codex:c1"));
    expect(requestSelectEntry).toHaveBeenCalledWith("c1");

    await user.click(screen.getByTestId("select-event:e1"));
    expect(setSelectedEventId).toHaveBeenCalledWith("e1");

    await user.click(screen.getByTestId("select-thread:t1"));
    expect(setSelectedPlotThreadId).toHaveBeenCalledWith("t1");
  });

  it("フィルタ変更（孤立ノードを隠す）で表示グラフが絞り込まれる", async () => {
    loadGalaxyGraphInput.mockResolvedValue(fixtureInput());
    render(<MapGalaxyView />);
    const canvas = await screen.findByTestId("galaxy-canvas");
    expect(canvas.getAttribute("data-node-count")).toBe("4");

    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByText("孤立ノードを隠す"));

    await waitFor(() => {
      expect(
        screen.getByTestId("galaxy-canvas").getAttribute("data-node-count"),
      ).toBe("0");
    });
  });
});

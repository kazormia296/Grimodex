// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GalaxyGraphInput } from "../galaxyGraph";

// Suppress global-settings persistence (mapStore subscribe)
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue({}),
}));

// three を引き込む 3D 描画層は必ず mock する（happy-dom では WebGL 不可）
vi.mock("./GalaxyCanvas", () => ({
  GalaxyCanvas: ({ graph }: { graph: { nodes: unknown[] } }) => (
    <div data-testid="galaxy-canvas" data-node-count={graph.nodes.length} />
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

import { MapGalaxyView } from "./MapGalaxyView";
import { useMapStore } from "../mapStore";
import { DEFAULT_GALAXY_FILTERS } from "../types";

// happy-dom の canvas.getContext は null → WebGL 判定を通す
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    {} as unknown as ReturnType<HTMLCanvasElement["getContext"]>,
  );
  useMapStore.setState({ galaxyFilters: DEFAULT_GALAXY_FILTERS });
  loadGalaxyGraphInput.mockReset();
});

/** シーン1つ + 孤立 codex 1つ（エッジなし）の入力 */
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
    events: [],
    sceneEvents: [],
    participants: [],
    threads: [],
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
    expect(screen.getByText("銀河を構築中…")).toBeTruthy();
    resolve(fixtureInput());
    const canvas = await screen.findByTestId("galaxy-canvas");
    expect(canvas.getAttribute("data-node-count")).toBe("2");
  });

  it("ノード 0 件なら空状態メッセージを出す", async () => {
    loadGalaxyGraphInput.mockResolvedValue(emptyInput());
    render(<MapGalaxyView />);
    await screen.findByText(/まだ星がありません/);
    expect(screen.queryByTestId("galaxy-canvas")).toBeNull();
  });

  it("ロード失敗でエラーメッセージを出す", async () => {
    loadGalaxyGraphInput.mockRejectedValue(new Error("boom"));
    render(<MapGalaxyView />);
    await screen.findByText("グラフデータの読み込みに失敗しました");
  });

  it("フィルタ変更（孤立ノードを隠す）で表示グラフが絞り込まれる", async () => {
    loadGalaxyGraphInput.mockResolvedValue(fixtureInput());
    render(<MapGalaxyView />);
    const canvas = await screen.findByTestId("galaxy-canvas");
    expect(canvas.getAttribute("data-node-count")).toBe("2");

    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByText("孤立ノードを隠す"));

    await waitFor(() => {
      expect(
        screen.getByTestId("galaxy-canvas").getAttribute("data-node-count"),
      ).toBe("0");
    });
  });
});

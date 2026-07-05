// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { KouetsuScopeBar } from "./KouetsuScopeBar";
import { useKouetsuStore } from "./kouetsuStore";
import { useTreeStore, type TreeNodeData } from "@/features/tree/treeStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { useTabStore } from "@/features/editor/tabStore";

// ScopeTreePicker.test.tsx の nodes fixture と同型（act > chapter > scene）。
const sceneFixtureNodes: TreeNodeData[] = [
  {
    id: "act1",
    parentId: null,
    nodeType: "folder",
    title: "第一幕",
    sortOrder: "a",
  },
  {
    id: "s1",
    parentId: "act1",
    nodeType: "scene",
    title: "冒頭",
    sortOrder: "a",
  },
] as unknown as TreeNodeData[];

beforeEach(() => {
  useKouetsuStore.setState({ scope: { type: "scene" }, statusFilter: "open" });
  // activeSceneId は string 既定("")。null は型に合わない(実 treeStore 確認済み)。
  useTreeStore.setState({ nodes: [], activeSceneId: "" });
});

describe("KouetsuScopeBar", () => {
  it("トリガにスコープラベルが出る（scene 既定）", () => {
    render(<KouetsuScopeBar />);
    expect(
      screen.getByRole("button", { name: /現在シーン/ }),
    ).toBeInTheDocument();
  });

  it("トリガクリックで ScopeTreePickerList が開き、プロジェクト選択で store が変わる", () => {
    render(<KouetsuScopeBar />);
    fireEvent.click(screen.getByRole("button", { name: /現在シーン/ }));
    // ScopeTreePickerList のプロジェクト行は chat.scope.project = "プロジェクト全体"
    fireEvent.click(screen.getByText("プロジェクト全体"));
    expect(useKouetsuStore.getState().scope).toEqual({ type: "project" });
  });

  it("ステータスフィルタ chips: 除外クリックで statusFilter='dismissed'", () => {
    render(<KouetsuScopeBar />);
    fireEvent.click(screen.getByRole("button", { name: "除外" }));
    expect(useKouetsuStore.getState().statusFilter).toBe("dismissed");
    // aria-pressed で状態を表現する
    expect(screen.getByRole("button", { name: "除外" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  // KouetsuScopeBar.openSceneInEditor は ChatPanel.selectSceneFromChat の複製
  // (KouetsuScopeBar.tsx 内コメント参照)。onPickScene ハンドラ経由でシーン行を
  // クリックする経路をここで実際に踏み、複製が乖離していないことを検知する。
  it("シーン行クリックで scope が scene になり、エディタ移動経路(setActiveScene/openPinned/showPanel)が呼ばれる", () => {
    const originalOpenPinned = useTabStore.getState().openPinned;
    const originalShowPanel = useLayoutStore.getState().showPanel;
    const originalEditorOpen =
      useLayoutStore.getState().layout.center.editorOpen;

    const openPinned = vi.fn();
    const showPanel = vi.fn();
    useTabStore.setState({ openPinned });
    useLayoutStore.setState({ showPanel });
    // editor パネルが可視のときだけ openPinned/showPanel を呼ぶ経路を通す
    // (ChatPanel.selectSceneFromChat と同挙動)。
    useLayoutStore.setState((s) => ({
      layout: {
        ...s.layout,
        center: { ...s.layout.center, editorOpen: true },
      },
    }));
    useTreeStore.setState({ nodes: sceneFixtureNodes, activeSceneId: "" });

    try {
      render(<KouetsuScopeBar />);
      fireEvent.click(screen.getByRole("button", { name: /現在シーン/ }));
      fireEvent.click(screen.getByText("冒頭"));

      expect(useKouetsuStore.getState().scope).toEqual({ type: "scene" });
      expect(useTreeStore.getState().activeSceneId).toBe("s1");
      expect(openPinned).toHaveBeenCalledWith("s1");
      expect(showPanel).toHaveBeenCalledWith("editor");
    } finally {
      useTabStore.setState({ openPinned: originalOpenPinned });
      useLayoutStore.setState({ showPanel: originalShowPanel });
      useLayoutStore.setState((s) => ({
        layout: {
          ...s.layout,
          center: { ...s.layout.center, editorOpen: originalEditorOpen },
        },
      }));
    }
  });
});

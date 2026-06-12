import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useLayoutStore } from "./layoutStore";
import { buildDefaultLayoutState } from "./layoutStateUtils";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@/lib/tauri";
const mockInvoke = vi.mocked(invoke);

function resetStore() {
  useLayoutStore.setState({
    layout: buildDefaultLayoutState({ allInactive: true }),
    layoutLocked: false,
    draggingPanel: null,
    dragOverTarget: null,
    panelDragSource: null,
    activePresetId: null,
    customPresets: [],
    builtinPresetOverrides: {},
    initialized: false,
    hiddenStripePanels: new Set(),
    maximizedPanelId: null,
  });
}

describe("toggleMaximizePanel", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("表示中の tool panel を zoom 対象にできる", () => {
    useLayoutStore.getState().togglePanel("scenes");
    useLayoutStore.getState().toggleMaximizePanel("scenes");
    expect(useLayoutStore.getState().maximizedPanelId).toBe("scenes");
  });

  it("再トグルで解除する", () => {
    useLayoutStore.getState().togglePanel("scenes");
    useLayoutStore.getState().toggleMaximizePanel("scenes");
    useLayoutStore.getState().toggleMaximizePanel("scenes");
    expect(useLayoutStore.getState().maximizedPanelId).toBeNull();
  });

  it("折りたたみ中（非表示）の tool panel は no-op", () => {
    // allInactive: 全 slot の activePanel は null
    useLayoutStore.getState().toggleMaximizePanel("scenes");
    expect(useLayoutStore.getState().maximizedPanelId).toBeNull();
  });

  it("editor は editorOpen のときのみ zoom できる", () => {
    expect(useLayoutStore.getState().layout.center.editorOpen).toBe(true);
    useLayoutStore.getState().toggleMaximizePanel("editor");
    expect(useLayoutStore.getState().maximizedPanelId).toBe("editor");

    useLayoutStore.getState().toggleMaximizePanel("editor");
    useLayoutStore.getState().setEditorOpen(false);
    useLayoutStore.getState().toggleMaximizePanel("editor");
    expect(useLayoutStore.getState().maximizedPanelId).toBeNull();
  });

  it("別の表示中パネルへ zoom 対象を切り替えられる", () => {
    useLayoutStore.getState().togglePanel("scenes");
    useLayoutStore.getState().togglePanel("chat");
    useLayoutStore.getState().toggleMaximizePanel("scenes");
    useLayoutStore.getState().toggleMaximizePanel("chat");
    expect(useLayoutStore.getState().maximizedPanelId).toBe("chat");
  });

  it("clearMaximize で解除する（未設定時は no-op）", () => {
    useLayoutStore.getState().clearMaximize();
    expect(useLayoutStore.getState().maximizedPanelId).toBeNull();

    useLayoutStore.getState().togglePanel("scenes");
    useLayoutStore.getState().toggleMaximizePanel("scenes");
    useLayoutStore.getState().clearMaximize();
    expect(useLayoutStore.getState().maximizedPanelId).toBeNull();
  });

  describe("レイアウト変更での自動解除", () => {
    function maximizeScenes() {
      useLayoutStore.getState().togglePanel("scenes");
      useLayoutStore.getState().toggleMaximizePanel("scenes");
      expect(useLayoutStore.getState().maximizedPanelId).toBe("scenes");
    }

    it("togglePanel（別パネルの開閉）で解除される", () => {
      maximizeScenes();
      useLayoutStore.getState().togglePanel("codex");
      expect(useLayoutStore.getState().maximizedPanelId).toBeNull();
    });

    it("setEditorOpen で解除される", () => {
      maximizeScenes();
      useLayoutStore.getState().setEditorOpen(false);
      expect(useLayoutStore.getState().maximizedPanelId).toBeNull();
    });

    it("applyPreset で解除される", () => {
      maximizeScenes();
      useLayoutStore.getState().applyPreset("builtin:plan");
      expect(useLayoutStore.getState().maximizedPanelId).toBeNull();
    });

    it("nudgeRegionSize で解除される", () => {
      maximizeScenes();
      useLayoutStore.getState().nudgeRegionSize("right", 24, {
        width: 1200,
        height: 800,
      });
      expect(useLayoutStore.getState().maximizedPanelId).toBeNull();
    });

    it("movePanelToNewSlot で解除される", () => {
      maximizeScenes();
      useLayoutStore.getState().movePanelToNewSlot("codex", "right", 0);
      expect(useLayoutStore.getState().maximizedPanelId).toBeNull();
    });

    it("resetToDefaultLayout で解除される", () => {
      maximizeScenes();
      useLayoutStore.getState().resetToDefaultLayout();
      expect(useLayoutStore.getState().maximizedPanelId).toBeNull();
    });

    it("layout を変更しない操作（no-op / lock 系）では解除されない", () => {
      maximizeScenes();

      // locked 中の setRegionSize は no-op（layout 参照不変）
      useLayoutStore.getState().toggleLayoutLock();
      useLayoutStore.getState().setRegionSize("right", 400, {
        width: 1200,
        height: 800,
      });
      expect(useLayoutStore.getState().maximizedPanelId).toBe("scenes");

      // ドラッグのトランジェント状態も layout を触らない
      useLayoutStore.getState().toggleLayoutLock();
      useLayoutStore.getState().setDragOverTarget(null);
      expect(useLayoutStore.getState().maximizedPanelId).toBe("scenes");
    });
  });

  it("maximizedPanelId は永続化されない", async () => {
    vi.useFakeTimers();
    useLayoutStore.getState().togglePanel("scenes");
    useLayoutStore.getState().toggleMaximizePanel("scenes");
    await vi.runAllTimersAsync();

    const saves = mockInvoke.mock.calls.filter(
      ([cmd]) => cmd === "save_global_settings",
    );
    expect(saves.length).toBeGreaterThan(0);
    for (const [, args] of saves) {
      expect(JSON.stringify(args)).not.toContain("maximizedPanelId");
    }
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import { useMapStore } from "./mapStore";

// Suppress global-settings persistence in unit tests
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue({}),
}));

describe("useMapStore", () => {
  beforeEach(() => {
    useMapStore.setState({
      activeBoardId: null,
      mode: "free",
      viewport: { x: 0, y: 0, zoom: 1 },
      show: {
        scenes: true,
        codex: true,
        snippets: false,
        notes: false,
        stickies: true,
        aiBranch: false,
        derivedEdges: true,
        userEdges: false,
        frames: true,
      },
      gridSnap: false,
      minimapVisible: false,
      colorBy: "none",
      visualTheme: "default",
      searchVisible: false,
      pendingAutoArrange: null,
      focusedNodeId: null,
      pendingExport: null,
    } as Parameters<typeof useMapStore.setState>[0]);
  });

  it("初期状態が free モードである", () => {
    expect(useMapStore.getState().mode).toBe("free");
  });

  it("setMode で theme モードに切り替わる", () => {
    useMapStore.getState().setMode("theme");
    expect(useMapStore.getState().mode).toBe("theme");
  });

  it("setPendingAutoArrange でオートアレンジリクエストをセットできる", () => {
    useMapStore.getState().setPendingAutoArrange("reading-order");
    expect(useMapStore.getState().pendingAutoArrange).toBe("reading-order");
    useMapStore.getState().setPendingAutoArrange(null);
    expect(useMapStore.getState().pendingAutoArrange).toBeNull();
  });

  it("setViewport でビューポートを更新できる", () => {
    useMapStore.getState().setViewport({ x: 100, y: 200, zoom: 1.5 });
    const { viewport } = useMapStore.getState();
    expect(viewport.x).toBe(100);
    expect(viewport.y).toBe(200);
    expect(viewport.zoom).toBe(1.5);
  });

  it("setShow で部分的に show フラグを更新できる", () => {
    useMapStore.getState().setShow({ scenes: false });
    expect(useMapStore.getState().show.scenes).toBe(false);
    expect(useMapStore.getState().show.codex).toBe(true);
  });

  it("show に stickies / aiBranch フラグが存在する", () => {
    const { show } = useMapStore.getState();
    expect("stickies" in show).toBe(true);
    expect("aiBranch" in show).toBe(true);
  });

  it("setGridSnap でグリッドスナップを切り替えられる", () => {
    useMapStore.getState().setGridSnap(true);
    expect(useMapStore.getState().gridSnap).toBe(true);
  });

  it("setMinimapVisible でミニマップ表示を切り替えられる", () => {
    useMapStore.getState().setMinimapVisible(true);
    expect(useMapStore.getState().minimapVisible).toBe(true);
  });

  it("初期 colorBy は none", () => {
    expect(useMapStore.getState().colorBy).toBe("none");
  });

  it("setColorBy で colorBy を変更できる", () => {
    useMapStore.getState().setColorBy("status");
    expect(useMapStore.getState().colorBy).toBe("status");
  });

  it("初期 visualTheme は default", () => {
    expect(useMapStore.getState().visualTheme).toBe("default");
  });

  it("setVisualTheme で visualTheme を変更できる", () => {
    useMapStore.getState().setVisualTheme("corkboard");
    expect(useMapStore.getState().visualTheme).toBe("corkboard");
  });

  it("setActiveBoardId でアクティブボードを設定できる", () => {
    useMapStore.getState().setActiveBoardId("board-1");
    expect(useMapStore.getState().activeBoardId).toBe("board-1");
  });

  it("loadFromSettings で map が undefined の場合はデフォルトを維持する", () => {
    const fakeSettings = {
      recentWorkspaces: [],
      lastActiveWorkspace: null,
      theme: "system",
      uiLanguage: "ja",
      uiScale: 100,
      showLauncherOnStartup: false,
    };

    useMapStore.getState().loadFromSettings(fakeSettings);

    expect(useMapStore.getState().mode).toBe("free");
    expect(useMapStore.getState().colorBy).toBe("none");
    expect(useMapStore.getState().visualTheme).toBe("default");
  });

  it("loadFromSettings で gridSnap/minimapVisible を復元できる", () => {
    const fakeSettings = {
      recentWorkspaces: [],
      lastActiveWorkspace: null,
      theme: "system",
      uiLanguage: "ja",
      uiScale: 100,
      showLauncherOnStartup: false,
      map: {
        activeBoardId: "b1",
        gridSnap: true,
        minimapVisible: true,
        visualTheme: "corkboard" as const,
      },
    };

    useMapStore.getState().loadFromSettings(fakeSettings);

    const s = useMapStore.getState();
    expect(s.gridSnap).toBe(true);
    expect(s.minimapVisible).toBe(true);
    expect(s.visualTheme).toBe("corkboard");
    expect(s.activeBoardId).toBe("b1");
    expect(s.colorBy).toBe("none");
  });

  it("hydrateFromBoard で mode/viewport/show/colorBy を復元する", () => {
    useMapStore.getState().hydrateFromBoard({
      id: "b1",
      projectId: "p1",
      title: "Main",
      sortOrder: 0,
      mode: "theme",
      viewportX: 120,
      viewportY: 80,
      viewportZoom: 1.25,
      showConfig: JSON.stringify({ scenes: false, codex: true }),
      colorBy: "status",
      createdAt: "",
      updatedAt: "",
    });

    const s = useMapStore.getState();
    expect(s.mode).toBe("theme");
    expect(s.viewport).toEqual({ x: 120, y: 80, zoom: 1.25 });
    expect(s.show.scenes).toBe(false);
    expect(s.show.codex).toBe(true);
    expect(s.colorBy).toBe("status");
  });
});

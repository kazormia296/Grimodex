import { describe, it, expect, beforeEach, vi } from "vitest";
import { useMapStore } from "./mapStore";

// Suppress global-settings persistence in unit tests
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue({}),
}));

describe("useMapStore", () => {
  beforeEach(() => {
    useMapStore.setState({
      mode: "free",
      viewport: { x: 0, y: 0, zoom: 1 },
      show: {
        scenes: true,
        codex: true,
        derivedEdges: true,
        userEdges: false,
        frames: true,
      },
      gridSnap: false,
      minimapVisible: false,
    });
  });

  it("初期状態が free モードである", () => {
    expect(useMapStore.getState().mode).toBe("free");
  });

  it("setMode でモードを変更できる", () => {
    useMapStore.getState().setMode("time");
    expect(useMapStore.getState().mode).toBe("time");
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

  it("setGridSnap でグリッドスナップを切り替えられる", () => {
    useMapStore.getState().setGridSnap(true);
    expect(useMapStore.getState().gridSnap).toBe(true);
  });

  it("setMinimapVisible でミニマップ表示を切り替えられる", () => {
    useMapStore.getState().setMinimapVisible(true);
    expect(useMapStore.getState().minimapVisible).toBe(true);
  });

  it("loadFromSettings でグローバル設定から復元できる", () => {
    const fakeSettings = {
      recentWorkspaces: [],
      lastActiveWorkspace: null,
      theme: "system",
      uiLanguage: "ja",
      uiScale: 100,
      showLauncherOnStartup: false,
      map: {
        mode: "theme" as const,
        viewport: { x: 50, y: 60, zoom: 2 },
        show: {
          scenes: false,
          codex: true,
          derivedEdges: false,
          userEdges: true,
          frames: false,
        },
        gridSnap: true,
        minimapVisible: true,
      },
    };

    useMapStore.getState().loadFromSettings(fakeSettings);

    const s = useMapStore.getState();
    expect(s.mode).toBe("theme");
    expect(s.viewport.zoom).toBe(2);
    expect(s.show.scenes).toBe(false);
    expect(s.gridSnap).toBe(true);
    expect(s.minimapVisible).toBe(true);
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
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import { useMapStore } from "./mapStore";

// Suppress global-settings persistence in unit tests
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue({}),
}));

const DEFAULT_STATE = {
  mode: "free" as const,
  viewport: { x: 0, y: 0, zoom: 1 },
  show: {
    scenes: true,
    codex: true,
    notes: false,
    ai: false,
    derivedEdges: true,
    userEdges: false,
    frames: true,
  },
  gridSnap: false,
  minimapVisible: false,
  sceneDisplayByMode: {
    free: "auto",
    time: "auto",
    theme: "auto",
    pov: "auto",
    place: "auto",
  },
  colorBy: "none" as const,
  corkboardFeel: false,
};

describe("useMapStore", () => {
  beforeEach(() => {
    useMapStore.setState(
      DEFAULT_STATE as Parameters<typeof useMapStore.setState>[0],
    );
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

  it("show に notes / ai フラグが存在する", () => {
    const { show } = useMapStore.getState();
    expect("notes" in show).toBe(true);
    expect("ai" in show).toBe(true);
  });

  it("setGridSnap でグリッドスナップを切り替えられる", () => {
    useMapStore.getState().setGridSnap(true);
    expect(useMapStore.getState().gridSnap).toBe(true);
  });

  it("setMinimapVisible でミニマップ表示を切り替えられる", () => {
    useMapStore.getState().setMinimapVisible(true);
    expect(useMapStore.getState().minimapVisible).toBe(true);
  });

  // ── sceneDisplayByMode ───────────────────────────────────────────────────

  it("初期 sceneDisplayByMode は全モード auto", () => {
    const { sceneDisplayByMode } = useMapStore.getState();
    expect(sceneDisplayByMode.free).toBe("auto");
    expect(sceneDisplayByMode.time).toBe("auto");
    expect(sceneDisplayByMode.theme).toBe("auto");
  });

  it("setSceneDisplayForMode で特定モードのバリアントを変更できる", () => {
    useMapStore.getState().setSceneDisplayForMode("free", "card");
    expect(useMapStore.getState().sceneDisplayByMode.free).toBe("card");
    expect(useMapStore.getState().sceneDisplayByMode.time).toBe("auto");
  });

  it("effectiveSceneVariant: auto + free → card", () => {
    useMapStore.getState().setSceneDisplayForMode("free", "auto");
    expect(useMapStore.getState().effectiveSceneVariant("free")).toBe("card");
  });

  it("effectiveSceneVariant: auto + time → compact", () => {
    useMapStore.getState().setSceneDisplayForMode("time", "auto");
    expect(useMapStore.getState().effectiveSceneVariant("time")).toBe(
      "compact",
    );
  });

  it("effectiveSceneVariant: explicit card overrides mode default", () => {
    useMapStore.getState().setSceneDisplayForMode("time", "card");
    expect(useMapStore.getState().effectiveSceneVariant("time")).toBe("card");
  });

  // ── colorBy ─────────────────────────────────────────────────────────────

  it("初期 colorBy は none", () => {
    expect(useMapStore.getState().colorBy).toBe("none");
  });

  it("setColorBy で colorBy を変更できる", () => {
    useMapStore.getState().setColorBy("status");
    expect(useMapStore.getState().colorBy).toBe("status");
  });

  // ── corkboardFeel ────────────────────────────────────────────────────────

  it("初期 corkboardFeel は false", () => {
    expect(useMapStore.getState().corkboardFeel).toBe(false);
  });

  it("setCorkboardFeel で切り替えられる", () => {
    useMapStore.getState().setCorkboardFeel(true);
    expect(useMapStore.getState().corkboardFeel).toBe(true);
  });

  // ── loadFromSettings ─────────────────────────────────────────────────────

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
          notes: false,
          ai: false,
          derivedEdges: false,
          userEdges: true,
          frames: false,
        },
        gridSnap: true,
        minimapVisible: true,
        sceneDisplayByMode: {
          free: "card",
          time: "compact",
          theme: "auto",
          pov: "auto",
          place: "auto",
        },
        colorBy: "status" as const,
        corkboardFeel: true,
      },
    };

    useMapStore.getState().loadFromSettings(fakeSettings);

    const s = useMapStore.getState();
    expect(s.mode).toBe("theme");
    expect(s.viewport.zoom).toBe(2);
    expect(s.show.scenes).toBe(false);
    expect(s.gridSnap).toBe(true);
    expect(s.minimapVisible).toBe(true);
    expect(s.sceneDisplayByMode.free).toBe("card");
    expect(s.colorBy).toBe("status");
    expect(s.corkboardFeel).toBe(true);
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
    expect(useMapStore.getState().corkboardFeel).toBe(false);
  });
});

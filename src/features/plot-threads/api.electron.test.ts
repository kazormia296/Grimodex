// @vitest-environment happy-dom
/**
 * plot-threads api の Electron 分岐（Electron 移行 Phase 3 バッチ1）。
 *
 * 従来 `isTauri()` 単独ゲートだったため Electron は renderer 直 Drizzle 分岐に
 * 落ち、link_create / link_update の XPROJ ガードを素通ししていた。ゲートを
 * `isTauri() || isElectron()` へ広げた結果、Electron では napi コマンドへ invoke
 * するようになる（= サーバサイドの XPROJ / phase_type 検証が効く）ことを gate する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invoke = vi.fn();
vi.mock("@/lib/tauri", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  isTauri: () => false,
}));

import {
  createPlotThread,
  createPlotThreadLink,
  listPlotThreads,
  deletePlotThread,
} from "./api";

beforeEach(() => {
  invoke.mockReset();
  // Electron マーカー（nativeBackend の inline "grimodex" in window 判定）。
  // isTauri()=false のため、これで invoke（napi）パスに載る。
  (window as unknown as Record<string, unknown>).grimodex = {
    shell: "electron",
  };
});
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).grimodex;
});

describe("plot-threads api は Electron でネイティブ backend (napi) へ invoke する", () => {
  it("createPlotThread は plot_thread_create を invoke（Drizzle 分岐に落ちない）", async () => {
    invoke.mockResolvedValue({
      id: "pt1",
      project_id: "p1",
      name: "糸",
      sort_order: "a0",
    });
    const row = await createPlotThread({
      projectId: "p1",
      name: "糸",
      sortOrder: "a0",
    });
    expect(invoke).toHaveBeenCalledWith("plot_thread_create", {
      payload: {
        projectId: "p1",
        name: "糸",
        color: null,
        description: null,
        sortOrder: "a0",
      },
    });
    // 生行 snake_case を normalize して返す。
    expect(row.projectId).toBe("p1");
  });

  it("createPlotThreadLink は XPROJ ガードの効く plot_thread_link_create を invoke", async () => {
    invoke.mockResolvedValue({
      id: "pl1",
      thread_id: "t1",
      node_id: "s1",
      phase_type: "introduce",
    });
    await createPlotThreadLink({
      threadId: "t1",
      nodeId: "s1",
      phaseType: "introduce",
    });
    expect(invoke).toHaveBeenCalledWith("plot_thread_link_create", {
      payload: {
        threadId: "t1",
        nodeId: "s1",
        phaseType: "introduce",
        note: null,
        sortOrder: null,
      },
    });
  });

  it("listPlotThreads は plot_thread_list を invoke し normalize する", async () => {
    invoke.mockResolvedValue([
      { id: "pt1", project_id: "p1", name: "糸", sort_order: "a0" },
    ]);
    const rows = await listPlotThreads("p1");
    expect(invoke).toHaveBeenCalledWith("plot_thread_list", {
      projectId: "p1",
    });
    expect(rows[0].projectId).toBe("p1");
  });

  it("deletePlotThread は plot_thread_delete を invoke する", async () => {
    invoke.mockResolvedValue(null);
    await deletePlotThread("pt1");
    expect(invoke).toHaveBeenCalledWith("plot_thread_delete", { id: "pt1" });
  });
});

// @vitest-environment happy-dom
/**
 * foreshadow api の Electron 分岐（Electron 移行 Phase 3 バッチ1）。
 *
 * 従来 api.ts / saveAnchors.ts の LOCAL `isTauriRuntime()` は
 * `__TAURI_INTERNALS__` のみを見ていたため、Electron は renderer 直 Drizzle
 * 分岐に落ちてサーバサイド検証（load_bearing 等）を素通ししていた。ゲートに
 * isElectron 相当（`"grimodex" in window`）を足した結果、Electron でも napi
 * コマンドへ invoke するようになる（= napi 経由でグリモデックス backend に載る）
 * ことを gate する。
 *
 * api.tauri.test.ts は `window.__TAURI_INTERNALS__` を立てて同じ invoke パスを
 * 通す。本テストは代わりに `window.grimodex`（Electron マーカー）を立てて、
 * 広げたゲートが Electron を invoke パスへ載せることを確認する。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));

vi.mock("@/lib/tauri", () => ({ invoke: mockInvoke }));
vi.mock("@/features/chat/chatApi", () => ({
  sendChatMessageWithThinking: vi.fn(),
}));

import { createForeshadow, getSceneForeshadowInfo } from "./api";

describe("foreshadow api は Electron でネイティブ backend (napi) へ invoke する", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    // Electron マーカー（isElectron 相当 = "grimodex" in window）。
    // __TAURI_INTERNALS__ は立てない = 純 Electron 判定のみで invoke に載ることを検証。
    (globalThis as unknown as { window?: Record<string, unknown> }).window = {
      grimodex: { shell: "electron" },
    };
  });

  it("createForeshadow は foreshadow_create を invoke（Drizzle 分岐に落ちない）", async () => {
    mockInvoke.mockResolvedValue({
      id: "f1",
      project_id: "p1",
      title: "伏線A",
      intent: null,
      load_bearing: "critical",
      created_at: 1714000000000,
      updated_at: 1714000001000,
    });

    const result = await createForeshadow({
      id: "local-id", // FE 型都合。Rust 側が id を採番するため payload には載らない。
      projectId: "p1",
      title: "伏線A",
      intent: null,
      loadBearing: "critical",
    });

    expect(mockInvoke).toHaveBeenCalledWith("foreshadow_create", {
      payload: {
        projectId: "p1",
        title: "伏線A",
        intent: null,
        loadBearing: "critical",
      },
    });
    expect(result.projectId).toBe("p1");
  });

  it("getSceneForeshadowInfo は foreshadow_get_scene_info を invoke する", async () => {
    mockInvoke.mockResolvedValue({
      setupForeshadowIds: ["f1"],
      payoffForeshadowIds: [],
    });

    const info = await getSceneForeshadowInfo("scene-1");

    expect(mockInvoke).toHaveBeenCalledWith("foreshadow_get_scene_info", {
      sceneId: "scene-1",
    });
    expect(info.setupForeshadowIds).toEqual(["f1"]);
  });
});

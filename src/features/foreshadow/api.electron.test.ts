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

const { mockInvoke, recordChangeEventMock } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  recordChangeEventMock: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({ invoke: mockInvoke }));
vi.mock("@/features/chat/chatApi", () => ({
  sendChatMessageWithThinking: vi.fn(),
}));
vi.mock("@/features/timelapse/recorder", () => ({
  getRecorderSessionId: () => "foreshadow-test-session",
  recordChangeEvent: recordChangeEventMock,
}));

import { createForeshadow, getSceneForeshadowInfo } from "./api";
import { getCreateResultMetadata } from "@/lib/createResultMetadata";

describe("foreshadow api は Electron でネイティブ backend (napi) へ invoke する", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    recordChangeEventMock.mockReset();
    // Electron マーカー（isElectron 相当 = "grimodex" in window）。
    // __TAURI_INTERNALS__ は立てない = 純 Electron 判定のみで invoke に載ることを検証。
    (globalThis as unknown as { window?: Record<string, unknown> }).window = {
      grimodex: { shell: "electron" },
    };
  });

  it("createForeshadow は foreshadow_create を invoke（Drizzle 分岐に落ちない）", async () => {
    mockInvoke.mockResolvedValue({
      id: "local-id",
      project_id: "p1",
      title: "伏線A",
      intent: null,
      notes: "全行復元",
      payoff_scene_id: "scene-1",
      payoff_from_pos: 3,
      payoff_to_pos: 9,
      payoff_confirmed: 1,
      abandoned: 1,
      secret: 0,
      load_bearing: "critical",
      codex_link_dirty_at: 1713999999000,
      created_at: 1714000000000,
      updated_at: 1714000001000,
    });

    const result = await createForeshadow({
      id: "local-id",
      projectId: "p1",
      title: "伏線A",
      intent: null,
      notes: "全行復元",
      payoffSceneId: "scene-1",
      payoffFromPos: 3,
      payoffToPos: 9,
      payoffConfirmed: true,
      abandoned: true,
      secret: false,
      loadBearing: "critical",
      codexLinkDirtyAt: new Date(1713999999000),
    });

    expect(mockInvoke).toHaveBeenCalledWith("foreshadow_create", {
      payload: {
        id: "local-id",
        requestId: "local-id",
        sessionId: "foreshadow-test-session",
        eventUid: "local-id",
        origin: "human",
        authorityRoute: "human-direct",
        caller: "human-ui",
        controls: [
          "runtime-policy",
          "actor-context",
          "typed-writer",
          "occ",
          "change-event",
          "change-feed",
        ],
        provenance: null,
        writesAuthorityProtectedField: false,
        originalTransactionId: null,
        projectId: "p1",
        title: "伏線A",
        intent: null,
        notes: "全行復元",
        payoffSceneId: "scene-1",
        payoffFromPos: 3,
        payoffToPos: 9,
        payoffConfirmed: true,
        abandoned: true,
        secret: false,
        loadBearing: "critical",
        codexLinkDirtyAt: 1713999999000,
      },
    });
    expect(result.projectId).toBe("p1");
    expect(result.id).toBe("local-id");
    expect(result).toMatchObject({
      notes: "全行復元",
      payoffSceneId: "scene-1",
      payoffFromPos: 3,
      payoffToPos: 9,
      payoffConfirmed: true,
      abandoned: true,
      secret: false,
      codexLinkDirtyAt: new Date(1713999999000),
    });
    expect(recordChangeEventMock).not.toHaveBeenCalled();
  });

  it("deliberate restore requestId と削除済み replay metadata を保持する", async () => {
    mockInvoke.mockResolvedValue({
      id: "local-id",
      __idempotency: { replayed: true, entityPresent: false },
    });

    const result = await createForeshadow(
      {
        id: "local-id",
        projectId: "p1",
        title: "伏線A",
        intent: null,
        loadBearing: "critical",
      },
      { requestId: "history-restore-1" },
    );

    expect(mockInvoke).toHaveBeenCalledWith("foreshadow_create", {
      payload: expect.objectContaining({
        id: "local-id",
        requestId: "history-restore-1",
      }),
    });
    expect(getCreateResultMetadata(result)).toEqual({
      replayed: true,
      entityPresent: false,
    });
    expect(recordChangeEventMock).not.toHaveBeenCalled();
  });

  it("id 省略時も renderer が entity/request identity を一度だけ materialize する", async () => {
    mockInvoke.mockImplementation(
      (_command: string, args: { payload: Record<string, unknown> }) => ({
        id: args.payload.id,
        project_id: args.payload.projectId,
        title: args.payload.title,
        created_at: 1714000000000,
        updated_at: 1714000000000,
      }),
    );

    await createForeshadow({
      projectId: "p1",
      title: "renderer identity",
    });

    const payload = mockInvoke.mock.calls[0][1].payload as Record<
      string,
      unknown
    >;
    expect(payload.id).toEqual(expect.any(String));
    expect(payload.requestId).toBe(payload.id);
  });

  it("存在中の replay でも timelapse create event を重複記録しない", async () => {
    mockInvoke.mockResolvedValue({
      id: "local-id",
      project_id: "p1",
      title: "伏線A",
      intent: null,
      load_bearing: "critical",
      created_at: 1714000000000,
      updated_at: 1714000001000,
      __idempotency: { replayed: true, entityPresent: true },
    });

    const result = await createForeshadow({
      id: "local-id",
      projectId: "p1",
      title: "伏線A",
      intent: null,
      loadBearing: "critical",
    });

    expect(getCreateResultMetadata(result)).toEqual({
      replayed: true,
      entityPresent: true,
    });
    expect(recordChangeEventMock).not.toHaveBeenCalled();
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

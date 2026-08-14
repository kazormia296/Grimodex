// @vitest-environment happy-dom
/**
 * Electron シェルでの trash_bin API ゲート（起動時ゴミ箱エラー修正の一部）:
 * create/delete/clearAll/prune の実行可否は __TAURI_INTERNALS__ 直見ではなく
 * supportsTrashBin（= isTauri || isElectron）で判定する。これが欠けると
 * Electron では文字屑キャプチャ（create）・削除（delete）が全て no-op / throw
 * になり、napi 垂直スライスの trash_bin 実装が dead code になる。
 *
 * isTauri / isElectron は mock せず実体を使い、window への
 * `__TAURI_INTERNALS__` / `grimodex` 注入で環境を切り替える
 * （panelWindow.electron.test.ts と同じ作法）。invoke だけを部分 factory で
 * mock する（isTauri は importOriginal で実体を残す）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  invoke: invokeMock,
}));

import {
  clearAllTrashItems,
  createTrashItem,
  deleteTrashItem,
  pruneTrashItems,
  restoreStructuralTrashItem,
  supportsTrashBin,
} from "./api";
import type { TrashItemInput } from "./types";
import { getCreateResultMetadata } from "@/lib/createResultMetadata";

type AnyWindow = Record<string, unknown>;

function installElectronBridge() {
  (window as unknown as AnyWindow).grimodex = { shell: "electron" };
}

const input: TrashItemInput = {
  projectId: "p1",
  kind: "text-fragment",
  subKind: "text-fragment",
  originSceneId: null,
  originCodexId: null,
  previewText: "消した文字屑",
  previewMeta: null,
  payload: { text: "消した文字屑", spans: [] },
};

beforeEach(() => {
  invokeMock.mockReset();
});

afterEach(() => {
  delete (window as unknown as AnyWindow).__TAURI_INTERNALS__;
  delete (window as unknown as AnyWindow).grimodex;
});

describe("supportsTrashBin", () => {
  it("plain browser（Tauri でも Electron でもない）は false", () => {
    expect(supportsTrashBin()).toBe(false);
  });
  it("Tauri（__TAURI_INTERNALS__ あり）は true", () => {
    (window as unknown as AnyWindow).__TAURI_INTERNALS__ = {};
    expect(supportsTrashBin()).toBe(true);
  });
  it("Electron（window.grimodex あり）は true", () => {
    installElectronBridge();
    expect(supportsTrashBin()).toBe(true);
  });
});

describe("trash_bin API（Electron シェル）", () => {
  it("createTrashItem が invoke(trash_bin_create) に到達する（throw で dead code にならない）", async () => {
    installElectronBridge();
    invokeMock.mockResolvedValue({
      id: "t1",
      project_id: "p1",
      kind: "text-fragment",
      sub_kind: "text-fragment",
      preview_text: "消した文字屑",
      payload: '{"text":"消した文字屑","spans":[]}',
      char_count: 6,
      is_interesting: 0,
      deleted_at: "2026-07-10T00:00:00.000Z",
    });
    const created = await createTrashItem(input, {
      charCount: 6,
      isInteresting: false,
      deletedAt: "2026-07-10T00:00:00.000Z",
      id: "trash-request-1",
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = invokeMock.mock.calls[0] as [
      string,
      { payload: Record<string, unknown> },
    ];
    expect(cmd).toBe("trash_bin_create");
    // struct 内は camelCase のまま、payload / previewMeta は JSON 文字列化済み
    expect(args.payload).toMatchObject({
      id: "trash-request-1",
      projectId: "p1",
      previewText: "消した文字屑",
      payload: JSON.stringify(input.payload),
      previewMeta: null,
      charCount: 6,
      isInteresting: false,
      deletedAt: "2026-07-10T00:00:00.000Z",
    });
    // snake_case の生行（napi/Tauri とも SELECT * を返す）が正規化される
    expect(created.previewText).toBe("消した文字屑");
    expect(created.isInteresting).toBe(false);
  });

  it("deletedAt 省略を native に保ち、削除済み replay metadata を正規化後も保持する", async () => {
    installElectronBridge();
    invokeMock.mockResolvedValue({
      id: "trash-request-omitted-time",
      deleted_at: "2026-07-10T00:00:00.000Z",
      __idempotency: { replayed: true, entityPresent: false },
    });

    const created = await createTrashItem(input, {
      charCount: 6,
      isInteresting: false,
      id: "trash-request-omitted-time",
    });

    const [, args] = invokeMock.mock.calls[0] as [
      string,
      { payload: Record<string, unknown> },
    ];
    expect(args.payload).not.toHaveProperty("deletedAt");
    expect(getCreateResultMetadata(created)).toEqual({
      replayed: true,
      entityPresent: false,
    });
  });

  it("構造復元を安定requestIdとproject/session identity付きNative commandへ送る", async () => {
    installElectronBridge();
    invokeMock.mockResolvedValue({
      newId: "restored-scene:t1",
      brokenLinks: ["folder"],
    });
    const item = {
      id: "t1",
      projectId: "p1",
      kind: "structure-item" as const,
      subKind: "scene" as const,
      originSceneId: null,
      originCodexId: null,
      previewText: "Scene",
      previewMeta: null,
      payload: {
        originalId: "old-scene",
        title: "Scene",
        body: "{}",
        beats: "[]",
        povCharacterId: null,
        folderHintId: null,
        folderHintName: null,
        metadata: {
          synopsis: null,
          status: null,
          nodeType: "scene" as const,
          locationId: null,
          sortOrder: "a0",
          storyTimeOrder: null,
          storyTimeLabel: null,
        },
        charCount: 0,
      },
      charCount: 5,
      isInteresting: true,
      deletedAt: "2026-08-13T00:00:00.000Z",
    };

    await expect(
      restoreStructuralTrashItem(item, { dropX: 10, dropY: 20 }),
    ).resolves.toEqual({
      newId: "restored-scene:t1",
      brokenLinks: ["folder"],
    });
    expect(invokeMock).toHaveBeenCalledWith("trash_bin_restore", {
      payload: {
        requestId: "trash-restore:t1",
        sessionId: expect.any(String),
        projectId: "p1",
        itemId: "t1",
        boardIdOverride: null,
        dropX: 10,
        dropY: 20,
      },
    });
  });

  it("deleteTrashItem / clearAllTrashItems が no-op にならず invoke する", async () => {
    installElectronBridge();
    invokeMock.mockResolvedValue(null);
    await deleteTrashItem("t1");
    await clearAllTrashItems("p1");
    expect(invokeMock.mock.calls).toEqual([
      ["trash_bin_delete", { id: "t1" }],
      ["trash_bin_clear_all", { projectId: "p1" }],
    ]);
  });

  it("pruneTrashItems が {projectId, retentionDays, maxCount} で invoke し残件数を返す", async () => {
    installElectronBridge();
    invokeMock.mockResolvedValue(2);
    await expect(pruneTrashItems("p1", 60, 10_000)).resolves.toBe(2);
    expect(invokeMock).toHaveBeenCalledWith("trash_bin_prune", {
      projectId: "p1",
      retentionDays: 60,
      maxCount: 10_000,
    });
  });
});

describe("trash_bin API（plain browser フォールバック — 従来挙動の保存）", () => {
  it("createTrashItem は throw、delete/clearAll は no-op、prune は 0", async () => {
    await expect(
      createTrashItem(input, { charCount: 6, isInteresting: false }),
    ).rejects.toThrow(/native shell/);
    await deleteTrashItem("t1");
    await clearAllTrashItems("p1");
    await expect(pruneTrashItems("p1")).resolves.toBe(0);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

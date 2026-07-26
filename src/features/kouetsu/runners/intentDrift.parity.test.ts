// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * runners/intentDrift.parity.test.ts — intent_drift scene パスの特性テスト。
 *
 * issue #283 の特性テスト（CurrentSceneIntentDriftView.test.tsx）を CurrentScene
 * ビュー削除に伴い runner 直叩きへ移植（期待値は旧テストから無変更）。
 * 旧テストに request 全フィールド固定の expectation は無く、runner 経路の
 * flush → payload build 順（editorSaveRegistry 実物経由）のみを移植する。
 * UI 挙動（実行中表示の再マウント永続）のテストは移植対象外。
 */

const h = vi.hoisted(() => ({
  buildIntentDriftPayload: vi.fn(),
  runPostEffect: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));
vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: () => false,
}));
vi.mock("@/features/license/gate", () => ({
  blockIfUnlicensed: () => false,
}));
vi.mock("@/features/tree/treeStore", () => {
  const state = {
    projectId: "p1",
    nodes: [{ id: "scene-1", intent: "主人公の孤独を際立たせる" }],
  };
  return {
    useTreeStore: Object.assign(
      (selector: (s: typeof state) => unknown) => selector(state),
      { getState: () => state },
    ),
  };
});
vi.mock("@/features/chat/store", () => ({
  useAiSettingsStore: {
    getState: () => ({
      settings: { model: "test-model" },
      loadSettings: vi.fn(),
    }),
  },
}));
vi.mock("@/features/settings/settingsStore", () => ({
  useSettingsStore: {
    getState: () => ({ get: (_key: string, fallback: string) => fallback }),
  },
}));
vi.mock("@/prompts/index", () => ({
  getPromptCatalog: () => ({ postEffect: { intentDriftSystem: "SYSTEM" } }),
}));
vi.mock("@/features/post-effect/intentDriftPayloadBuilder", () => ({
  buildIntentDriftPayload: h.buildIntentDriftPayload,
  INTENT_DRIFT_PROMPT_VERSION: "test-v",
}));
// flushPendingSceneSaves は実装のまま（editorSaveRegistry 経由の flush を検証する）
vi.mock("@/features/post-effect/api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/post-effect/api")>();
  return {
    ...actual,
    runPostEffect: h.runPostEffect,
  };
});

import { runIntentDriftCheck } from "./intentDrift";
import {
  registerSaveHandler,
  unregisterSaveHandler,
} from "@/features/editor/editorSaveRegistry";

const SCENE_ID = "scene-1";

describe("runIntentDriftCheck (scene) run の flush", () => {
  beforeEach(() => {
    h.buildIntentDriftPayload.mockReset();
    h.runPostEffect.mockReset();
    h.runPostEffect.mockImplementation(
      async (_req: unknown, callbacks: { onDone?: (e: unknown) => void }) => {
        callbacks.onDone?.({
          run_id: "r1",
          annotation_count: 0,
          from_cache: false,
        });
        return { runId: "r1", cleanup: () => {} };
      },
    );
  });

  afterEach(() => {
    unregisterSaveHandler(SCENE_ID);
  });

  it("デバウンス中の編集を flush してから本文 payload を組む", async () => {
    const order: string[] = [];
    registerSaveHandler(SCENE_ID, async () => {
      order.push("flush");
    });
    h.buildIntentDriftPayload.mockImplementation(async () => {
      order.push("build");
      return { inputHash: "hash-1", sceneText: "最新本文" };
    });

    await runIntentDriftCheck({ type: "scene", sceneId: SCENE_ID });

    expect(order).toEqual(["flush", "build"]);
  });

  it("シーンを開いていない（save handler 未登録）でも run は実行できる", async () => {
    h.buildIntentDriftPayload.mockResolvedValue({
      inputHash: "hash-1",
      sceneText: "本文",
    });

    await runIntentDriftCheck({ type: "scene", sceneId: SCENE_ID });

    expect(h.buildIntentDriftPayload).toHaveBeenCalledTimes(1);
  });
});

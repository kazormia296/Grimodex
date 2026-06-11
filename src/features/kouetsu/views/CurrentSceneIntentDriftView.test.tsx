// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";

const h = vi.hoisted(() => ({
  buildIntentDriftPayload: vi.fn(),
  runPostEffect: vi.fn(),
  listAnnotationsForScene: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));
vi.mock("@/features/ai-policy/useAiGate", () => ({
  useAiGate: () => ({ presentation: "enabled", tooltip: undefined }),
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
vi.mock("@/features/post-effect/annotationStore", () => {
  const setAnnotations = vi.fn();
  return { useAnnotationStore: () => ({ setAnnotations }) };
});
vi.mock("@/features/editor/editorStore", () => ({
  useEditorStore: { getState: () => ({ editor: null }) },
}));
vi.mock("@/features/post-effect/applyAnnotationsToEditor", () => ({
  applyAnnotationsToEditor: vi.fn(),
}));
vi.mock("@/prompts/index", () => ({
  getPromptCatalog: () => ({ postEffect: { intentDriftSystem: "SYSTEM" } }),
}));
vi.mock("@/features/post-effect/intentDriftPayloadBuilder", () => ({
  buildIntentDriftPayload: h.buildIntentDriftPayload,
  INTENT_DRIFT_PROMPT_VERSION: "test-v",
}));
vi.mock("@/features/post-effect/PostEffectAnnotationPanel", () => ({
  PostEffectAnnotationPanel: () => null,
  INTENT_DRIFT_FILTER: [],
}));
// flushPendingSceneSaves は実装のまま（editorSaveRegistry 経由の flush を検証する）
vi.mock("@/features/post-effect/api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/post-effect/api")>();
  return {
    ...actual,
    runPostEffect: h.runPostEffect,
    listAnnotationsForScene: h.listAnnotationsForScene,
  };
});

import { CurrentSceneIntentDriftView } from "./CurrentSceneIntentDriftView";
import {
  registerSaveHandler,
  unregisterSaveHandler,
} from "@/features/editor/editorSaveRegistry";

const SCENE_ID = "scene-1";

describe("CurrentSceneIntentDriftView run の flush", () => {
  beforeEach(() => {
    h.buildIntentDriftPayload.mockReset();
    h.runPostEffect.mockReset();
    h.listAnnotationsForScene.mockReset();
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
    h.listAnnotationsForScene.mockResolvedValue({ annotations: [] });
  });

  afterEach(() => {
    cleanup();
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

    render(<CurrentSceneIntentDriftView sceneId={SCENE_ID} />);
    fireEvent.click(screen.getByRole("button", { name: "狙いズレ診断" }));

    await waitFor(() =>
      expect(h.listAnnotationsForScene).toHaveBeenCalledTimes(1),
    );
    expect(order).toEqual(["flush", "build"]);
  });

  it("シーンを開いていない（save handler 未登録）でも run は実行できる", async () => {
    h.buildIntentDriftPayload.mockResolvedValue({
      inputHash: "hash-1",
      sceneText: "本文",
    });

    render(<CurrentSceneIntentDriftView sceneId={SCENE_ID} />);
    fireEvent.click(screen.getByRole("button", { name: "狙いズレ診断" }));

    await waitFor(() =>
      expect(h.buildIntentDriftPayload).toHaveBeenCalledTimes(1),
    );
  });
});

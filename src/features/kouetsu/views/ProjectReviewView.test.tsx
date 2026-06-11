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
  buildMultiPayload: vi.fn(),
  runPostEffectMulti: vi.fn(),
  listAnnotationsForProject: vi.fn(),
  dirtyTabIds: new Set<string>(),
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
    scenes: [],
    nodes: [{ id: "scene-1", nodeType: "scene" }],
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
  getPromptCatalog: () => ({ postEffect: { reviewSystem: "SYSTEM" } }),
}));
vi.mock("@/features/post-effect/consistencyPayloadBuilder", () => ({
  buildMultiPayload: h.buildMultiPayload,
  getSceneIdsForScope: () => ["scene-1", "scene-2"],
}));
vi.mock("@/features/post-effect/reviewPayloadBuilder", () => ({
  REVIEW_PROMPT_VERSION: "test-v",
}));
vi.mock("@/features/post-effect/PostEffectAnnotationPanel", () => ({
  AnnotationItem: () => null,
}));
vi.mock("@/features/editor/tabStore", () => ({
  useTabStore: { getState: () => ({ dirtyTabIds: h.dirtyTabIds }) },
}));
// flushPendingSceneSaves は実装のまま（dirty タブ全 flush を検証する）
vi.mock("@/features/post-effect/api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/post-effect/api")>();
  return {
    ...actual,
    runPostEffectMulti: h.runPostEffectMulti,
    listAnnotationsForProject: h.listAnnotationsForProject,
  };
});

import { ProjectReviewView } from "./ProjectReviewView";
import {
  registerSaveHandler,
  unregisterSaveHandler,
} from "@/features/editor/editorSaveRegistry";

describe("ProjectReviewView runAll の flush", () => {
  beforeEach(() => {
    h.buildMultiPayload.mockReset();
    h.runPostEffectMulti.mockReset();
    h.listAnnotationsForProject.mockReset();
    h.runPostEffectMulti.mockImplementation(
      async (_req: unknown, callbacks: { onDone?: (e: unknown) => void }) => {
        callbacks.onDone?.({
          run_id: "r1",
          annotation_count: 0,
          from_cache: false,
        });
        return { runId: "r1", cleanup: () => {} };
      },
    );
    h.listAnnotationsForProject.mockResolvedValue({ annotations: [] });
  });

  afterEach(() => {
    cleanup();
    unregisterSaveHandler("scene-1");
    unregisterSaveHandler("scene-2");
    h.dirtyTabIds.clear();
  });

  it("開いている dirty タブを全て flush してから multi payload を組む", async () => {
    const order: string[] = [];
    registerSaveHandler("scene-1", async () => {
      order.push("flush:scene-1");
    });
    registerSaveHandler("scene-2", async () => {
      order.push("flush:scene-2");
    });
    h.dirtyTabIds.add("scene-1");
    h.dirtyTabIds.add("scene-2");
    h.buildMultiPayload.mockImplementation(async () => {
      order.push("build");
      return {
        inputHash: "hash-1",
        scenes: [{ scene_id: "scene-1", scene_text: "本文" }],
      };
    });

    render(<ProjectReviewView />);
    fireEvent.click(screen.getByRole("button", { name: "AIレビュー" }));

    await waitFor(() => expect(h.buildMultiPayload).toHaveBeenCalledTimes(1));
    expect(order.slice(0, 2).sort()).toEqual([
      "flush:scene-1",
      "flush:scene-2",
    ]);
    expect(order[2]).toBe("build");
  });

  it("dirty タブが無ければ flush なしで run が進む", async () => {
    const save = vi.fn(async () => {});
    registerSaveHandler("scene-1", save);
    h.buildMultiPayload.mockResolvedValue({
      inputHash: "hash-1",
      scenes: [{ scene_id: "scene-1", scene_text: "本文" }],
    });

    render(<ProjectReviewView />);
    fireEvent.click(screen.getByRole("button", { name: "AIレビュー" }));

    await waitFor(() => expect(h.buildMultiPayload).toHaveBeenCalledTimes(1));
    expect(save).not.toHaveBeenCalled();
  });
});

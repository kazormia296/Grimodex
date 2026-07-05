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
  getSceneIdsForScope: vi.fn(),
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
  getSceneIdsForScope: h.getSceneIdsForScope,
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
import { useKouetsuStore } from "@/features/kouetsu/kouetsuStore";
import { usePostEffectRunStore } from "@/features/post-effect/runStore";
import {
  registerSaveHandler,
  unregisterSaveHandler,
} from "@/features/editor/editorSaveRegistry";

describe("ProjectReviewView runAll の flush", () => {
  beforeEach(() => {
    h.buildMultiPayload.mockReset();
    h.runPostEffectMulti.mockReset();
    h.listAnnotationsForProject.mockReset();
    h.getSceneIdsForScope.mockReset();
    h.getSceneIdsForScope.mockReturnValue(["scene-1", "scene-2"]);
    useKouetsuStore.setState({ scope: { type: "scene" } });
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

describe("ProjectReviewView folder スコープ", () => {
  beforeEach(() => {
    h.buildMultiPayload.mockReset();
    h.runPostEffectMulti.mockReset();
    h.listAnnotationsForProject.mockReset();
    h.getSceneIdsForScope.mockReset();
    h.getSceneIdsForScope.mockReturnValue(["scene-1", "scene-2"]);
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
    useKouetsuStore.setState({ scope: { type: "folder", anchorId: "ch1" } });
  });

  afterEach(() => {
    cleanup();
    h.dirtyTabIds.clear();
    useKouetsuStore.setState({ scope: { type: "scene" } });
  });

  it("folder スコープでは subtree 外シーンの annotation を表示しない", async () => {
    // subtree = [scene-1] のみ。外側 outside-scene は隠れるべき。
    h.getSceneIdsForScope.mockReturnValue(["scene-1"]);
    h.listAnnotationsForProject.mockResolvedValue({
      annotations: [
        { id: "a1", sceneId: "scene-1", category: "review" },
        { id: "a2", sceneId: "outside-scene", category: "review" },
      ],
    });

    render(<ProjectReviewView />);
    // グループ見出しは sceneTitle(sceneId) = sceneId (scenes が空のため)。
    await screen.findByText("scene-1");
    expect(screen.queryByText("outside-scene")).toBeNull();
  });

  it("folder スコープの実行は scope_type='folder' + scope_target_id を multi へ渡す", async () => {
    h.getSceneIdsForScope.mockReturnValue(["scene-1"]);
    h.buildMultiPayload.mockResolvedValue({
      inputHash: "hash-1",
      scenes: [{ scene_id: "scene-1", scene_text: "本文" }],
    });

    render(<ProjectReviewView />);
    fireEvent.click(screen.getByRole("button", { name: "AIレビュー" }));

    await waitFor(() => expect(h.runPostEffectMulti).toHaveBeenCalled());
    const req = h.runPostEffectMulti.mock.calls[0][0] as {
      scope_type: string;
      scope_target_id: string | null;
    };
    expect(req.scope_type).toBe("folder");
    expect(req.scope_target_id).toBe("ch1");
    expect(h.buildMultiPayload).toHaveBeenCalledWith(
      "p1",
      "folder",
      "ch1",
      expect.anything(),
      "review",
      expect.anything(),
      expect.anything(),
    );
  });
});

describe("ProjectReviewView 実行中表示の scope 一致", () => {
  beforeEach(() => {
    h.getSceneIdsForScope.mockReset();
    h.getSceneIdsForScope.mockReturnValue(["scene-1"]);
    useKouetsuStore.setState({ scope: { type: "folder", anchorId: "ch1" } });
  });

  afterEach(() => {
    cleanup();
    useKouetsuStore.setState({ scope: { type: "scene" } });
    usePostEffectRunStore.setState({ runs: {} });
  });

  it("folder スコープで実行中の run があれば、unmount→remount しても実行ボタンが disabled のまま", () => {
    // 実障害: useIsPostEffectRunning("review", "project") が scope 固定だと
    // folder run（scopeType:"folder"）を拾えず、unmount→remount で
    // ボタンが再有効化 → 二重起動を許してしまう。
    usePostEffectRunStore.getState().begin({
      runId: "r1",
      projectId: "p1",
      effectType: "review",
      scopeType: "folder",
      scopeTargetId: "ch1",
    });

    const { unmount } = render(<ProjectReviewView />);
    expect(screen.getByRole("button", { name: "AIレビュー" })).toBeDisabled();

    unmount();
    render(<ProjectReviewView />);
    expect(screen.getByRole("button", { name: "AIレビュー" })).toBeDisabled();
  });
});

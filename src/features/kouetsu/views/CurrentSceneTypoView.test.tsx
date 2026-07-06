// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { toast } from "sonner";

/**
 * CurrentSceneTypoView の起動経路の特性テスト（issue #283）。
 *
 * runPostEffect へ渡る request を全フィールド toEqual で固定し、
 * 起動コードを runners の scene パスへ委譲しても byte 同等であることを
 * このテスト無改修 green でゲートする。
 */

const h = vi.hoisted(() => ({
  buildTypoPayload: vi.fn(),
  runPostEffect: vi.fn(),
  listAnnotationsForScene: vi.fn(),
  setAnnotations: vi.fn(),
}));

const CUSTOM = "カスタム校閲指示：固有名詞は変更しない";
const TYPO_SYSTEM =
  "誤字脱字チェック指示。\n以下の形式の JSON オブジェクトだけを返してください: {}";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
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
    nodes: [{ id: "scene-1", nodeType: "scene", parentId: null }],
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
      settings: { model: "base-model" },
      loadSettings: vi.fn(),
    }),
  },
}));
vi.mock("@/features/settings/settingsStore", () => ({
  useSettingsStore: {
    getState: () => ({
      get: (key: string, fallback: string) =>
        key === "aiPrompt.custom.kouetsu"
          ? "カスタム校閲指示：固有名詞は変更しない"
          : fallback,
    }),
  },
}));
vi.mock("@/features/post-effect/annotationStore", () => {
  const state = {
    setAnnotations: h.setAnnotations,
    annotationsByScene: new Map(),
    focusedAnnotationId: null,
    setFocusedAnnotationId: vi.fn(),
  };
  return {
    useAnnotationStore: Object.assign(
      (selector?: (s: typeof state) => unknown) =>
        selector ? selector(state) : state,
      { getState: () => state },
    ),
  };
});
vi.mock("@/features/editor/editorStore", () => {
  const state = { editor: null };
  return {
    useEditorStore: Object.assign(
      (selector?: (s: typeof state) => unknown) =>
        selector ? selector(state) : state,
      { getState: () => state },
    ),
  };
});
vi.mock("@/features/post-effect/applyAnnotationsToEditor", () => ({
  applyAnnotationsToEditor: vi.fn(),
}));
vi.mock("@/prompts/index", () => ({
  getPromptCatalog: () => ({
    postEffect: {
      typoSystem:
        "誤字脱字チェック指示。\n以下の形式の JSON オブジェクトだけを返してください: {}",
      reviewSystem: "REVIEW",
      consistencySystem: "CONS",
      intraSystem: "INTRA",
      metaStructureSystem: "META",
      timelineConsistencySystem: "TIMELINE",
      intentDriftSystem: "INTENT",
    },
  }),
}));
vi.mock("@/features/post-effect/typoPayloadBuilder", () => ({
  buildTypoPayload: h.buildTypoPayload,
  TYPO_PROMPT_VERSION: "typo-v",
}));
vi.mock("@/features/post-effect/consistencyPayloadBuilder", () => ({
  buildMultiPayload: vi.fn(),
  buildConsistencyPayload: vi.fn(),
  buildIntraPayload: vi.fn(),
  getSceneIdsForScope: vi.fn(() => ["scene-1"]),
  CONSISTENCY_PROMPT_VERSION: "cons-v",
  INTRA_CONSISTENCY_PROMPT_VERSION: "intra-v",
}));
vi.mock("@/features/post-effect/reviewPayloadBuilder", () => ({
  buildReviewPayload: vi.fn(),
  REVIEW_PROMPT_VERSION: "review-v",
}));
vi.mock("@/features/post-effect/metaStructurePayloadBuilder", () => ({
  buildMetaStructurePayload: vi.fn(),
  META_STRUCTURE_PROMPT_VERSION: "meta-v",
}));
vi.mock("@/features/post-effect/timelinePayloadBuilder", () => ({
  buildTimelinePayload: vi.fn(),
  TIMELINE_CONSISTENCY_PROMPT_VERSION: "timeline-v",
}));
vi.mock("@/features/post-effect/intentDriftPayloadBuilder", () => ({
  buildIntentDriftPayload: vi.fn(),
  INTENT_DRIFT_PROMPT_VERSION: "intent-v",
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

import { CurrentSceneTypoView } from "./CurrentSceneTypoView";
import { appendKouetsuGuidance } from "@/features/post-effect/customInstruction";
import {
  registerSaveHandler,
  unregisterSaveHandler,
} from "@/features/editor/editorSaveRegistry";

const SCENE_ID = "scene-1";

function mockDone(e: { annotation_count?: number; from_cache?: boolean }) {
  h.runPostEffect.mockImplementation(
    async (_req: unknown, cb: { onDone?: (e: unknown) => void }) => {
      cb.onDone?.({
        run_id: "r1",
        annotation_count: e.annotation_count ?? 0,
        from_cache: e.from_cache ?? false,
      });
      return { runId: "r1", cleanup: () => {} };
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.buildTypoPayload.mockResolvedValue({
    inputHash: "hash-1",
    sceneText: "本文テキスト",
  });
  h.listAnnotationsForScene.mockResolvedValue({ annotations: [] });
  mockDone({ annotation_count: 1 });
});

afterEach(() => {
  cleanup();
  unregisterSaveHandler(SCENE_ID);
});

async function clickRun() {
  render(<CurrentSceneTypoView sceneId={SCENE_ID} />);
  fireEvent.click(screen.getByRole("button", { name: "AIチェック" }));
  await waitFor(() =>
    expect(h.listAnnotationsForScene).toHaveBeenCalledTimes(1),
  );
}

describe("CurrentSceneTypoView 起動 request のバイト同等性", () => {
  it("単発 typo run を全フィールド固定の request で起動する", async () => {
    await clickRun();
    expect(h.runPostEffect).toHaveBeenCalledTimes(1);
    expect(h.runPostEffect.mock.calls[0][0]).toEqual({
      project_id: "p1",
      effect_type: "typo_detection",
      scope_type: "scene",
      scope_target_id: SCENE_ID,
      model: "base-model",
      prompt_version: "typo-v",
      input_hash: "hash-1",
      codex_payload_json: "[]",
      scene_text: "本文テキスト",
      system_prompt: appendKouetsuGuidance(TYPO_SYSTEM, CUSTOM),
    });
  });

  it("payload builder へ sceneId / model / custom を渡す", async () => {
    await clickRun();
    expect(h.buildTypoPayload).toHaveBeenCalledWith(
      SCENE_ID,
      "base-model",
      CUSTOM,
    );
  });

  it("デバウンス中の編集を flush してから payload を組む", async () => {
    const order: string[] = [];
    registerSaveHandler(SCENE_ID, async () => {
      order.push("flush");
    });
    h.buildTypoPayload.mockImplementation(async () => {
      order.push("build");
      return { inputHash: "hash-1", sceneText: "最新本文" };
    });
    await clickRun();
    expect(order).toEqual(["flush", "build"]);
  });
});

describe("CurrentSceneTypoView 完了後の反映とトースト", () => {
  it("完了後に注釈を再取得して store へ反映する", async () => {
    const anns = [{ id: "a1", status: "open" }];
    h.listAnnotationsForScene.mockResolvedValue({ annotations: anns });
    await clickRun();
    expect(h.listAnnotationsForScene).toHaveBeenCalledWith({
      projectId: "p1",
      sceneId: SCENE_ID,
    });
    expect(h.setAnnotations).toHaveBeenCalledWith(SCENE_ID, anns);
  });

  it("from_cache 完了はキャッシュトーストを出す", async () => {
    mockDone({ annotation_count: 2, from_cache: true });
    await clickRun();
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        "前回と同じ内容のためキャッシュから読み込みました",
        expect.objectContaining({ description: "AI には送信していません" }),
      ),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("指摘 0 件の実実行は noIssues トーストを出す", async () => {
    mockDone({ annotation_count: 0, from_cache: false });
    await clickRun();
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "誤字脱字は見つかりませんでした",
      ),
    );
  });

  it("run 失敗は checkFailed トーストを出し、注釈は再取得する", async () => {
    h.runPostEffect.mockImplementation(
      async (_req: unknown, cb: { onError?: (e: unknown) => void }) => {
        cb.onError?.({ run_id: "r1", error: "boom" });
        return { runId: "r1", cleanup: () => {} };
      },
    );
    await clickRun();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "誤字脱字チェックに失敗しました",
        expect.objectContaining({ description: "boom" }),
      ),
    );
    expect(h.listAnnotationsForScene).toHaveBeenCalledTimes(1);
  });
});

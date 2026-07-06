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
 * CurrentSceneReviewView の起動経路の特性テスト（issue #283）。
 *
 * review ロールのモデル/プロバイダ override と storyContext 注入を含め、
 * runPostEffect へ渡る request を全フィールド toEqual で固定する。
 * 起動コードを runners の scene パスへ委譲しても byte 同等であることを
 * このテスト無改修 green でゲートする。
 */

const h = vi.hoisted(() => ({
  buildReviewPayload: vi.fn(),
  runPostEffect: vi.fn(),
  listAnnotationsForScene: vi.fn(),
  setAnnotations: vi.fn(),
  resolveRoleSendOverride: vi.fn(),
}));

const CUSTOM = "カスタム校閲指示：固有名詞は変更しない";
const REVIEW_SYSTEM =
  "批評指示。\n以下の形式の JSON オブジェクトだけを返してください: {}";

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
    nodes: [
      {
        id: "scene-1",
        nodeType: "scene",
        parentId: "folder-1",
        synopsis: "シーン概要メモ",
      },
      {
        id: "folder-1",
        nodeType: "folder",
        parentId: null,
        synopsis: "章概要メモ",
      },
    ],
  };
  return {
    useTreeStore: Object.assign(
      (selector: (s: typeof state) => unknown) => selector(state),
      { getState: () => state },
    ),
  };
});
vi.mock("@/features/chat/modelRouting", () => ({
  resolveRoleSendOverride: h.resolveRoleSendOverride,
}));
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
      typoSystem: "TYPO",
      reviewSystem:
        "批評指示。\n以下の形式の JSON オブジェクトだけを返してください: {}",
      consistencySystem: "CONS",
      intraSystem: "INTRA",
      metaStructureSystem: "META",
      timelineConsistencySystem: "TIMELINE",
      intentDriftSystem: "INTENT",
    },
  }),
}));
vi.mock("@/features/post-effect/typoPayloadBuilder", () => ({
  buildTypoPayload: vi.fn(),
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
  buildReviewPayload: h.buildReviewPayload,
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
vi.mock("@/features/post-effect/PostEffectAnnotationPanel", () => ({
  PostEffectAnnotationPanel: () => null,
  REVIEW_FILTER: [],
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

import { CurrentSceneReviewView } from "./CurrentSceneReviewView";
import {
  appendKouetsuGuidance,
  appendStoryContextGuidance,
} from "@/features/post-effect/customInstruction";

const SCENE_ID = "scene-1";
const STORY_CONTEXT = { synopsis: "シーン概要メモ", outline: "章概要メモ" };

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
  h.resolveRoleSendOverride.mockReturnValue({
    model: "role-model",
    provider: "openrouter",
    apiVariant: "chat",
    endpointId: "ep-1",
  });
  h.buildReviewPayload.mockResolvedValue({
    inputHash: "hash-1",
    sceneText: "本文テキスト",
  });
  h.listAnnotationsForScene.mockResolvedValue({ annotations: [] });
  mockDone({ annotation_count: 1 });
});

afterEach(() => {
  cleanup();
});

async function clickRun() {
  render(<CurrentSceneReviewView sceneId={SCENE_ID} />);
  fireEvent.click(screen.getByRole("button", { name: "AIレビュー" }));
  await waitFor(() =>
    expect(h.listAnnotationsForScene).toHaveBeenCalledTimes(1),
  );
}

describe("CurrentSceneReviewView 起動 request のバイト同等性", () => {
  it("review ロール override + storyContext 込みの request で起動する", async () => {
    await clickRun();
    expect(h.resolveRoleSendOverride).toHaveBeenCalledWith(
      "post_effect_review",
    );
    expect(h.runPostEffect).toHaveBeenCalledTimes(1);
    expect(h.runPostEffect.mock.calls[0][0]).toEqual({
      project_id: "p1",
      effect_type: "review",
      scope_type: "scene",
      scope_target_id: SCENE_ID,
      model: "role-model",
      model_override: "role-model",
      provider_override: "openrouter",
      api_variant_override: "chat",
      endpoint_id_override: "ep-1",
      prompt_version: "review-v",
      input_hash: "hash-1",
      codex_payload_json: "[]",
      scene_text: "本文テキスト",
      system_prompt: appendStoryContextGuidance(
        appendKouetsuGuidance(REVIEW_SYSTEM, CUSTOM),
        STORY_CONTEXT,
      ),
    });
  });

  it("payload builder へ sceneId / roleモデル / custom / storyContext / route を渡す", async () => {
    await clickRun();
    expect(h.buildReviewPayload).toHaveBeenCalledWith(
      SCENE_ID,
      "role-model",
      CUSTOM,
      STORY_CONTEXT,
      { provider: "openrouter", endpointId: "ep-1" },
    );
  });

  it("override 未設定時は基底チャットモデルへフォールバックする", async () => {
    h.resolveRoleSendOverride.mockReturnValue({
      model: undefined,
      provider: undefined,
      apiVariant: undefined,
      endpointId: undefined,
    });
    await clickRun();
    const req = h.runPostEffect.mock.calls[0][0] as {
      model: string;
      model_override?: string;
      provider_override?: string;
    };
    expect(req.model).toBe("base-model");
    expect(req.model_override).toBeUndefined();
    expect(req.provider_override).toBeUndefined();
    expect(h.buildReviewPayload).toHaveBeenCalledWith(
      SCENE_ID,
      "base-model",
      CUSTOM,
      STORY_CONTEXT,
      { provider: undefined, endpointId: undefined },
    );
  });
});

describe("CurrentSceneReviewView 完了後の反映とトースト", () => {
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
  });

  it("指摘 0 件の実実行は noFindings トーストを出す", async () => {
    mockDone({ annotation_count: 0, from_cache: false });
    await clickRun();
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("指摘はありませんでした"),
    );
  });

  it("run 失敗は executionFailed トーストを出し、注釈は再取得する", async () => {
    h.runPostEffect.mockImplementation(
      async (_req: unknown, cb: { onError?: (e: unknown) => void }) => {
        cb.onError?.({ run_id: "r1", error: "boom" });
        return { runId: "r1", cleanup: () => {} };
      },
    );
    await clickRun();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "批評の実行に失敗しました",
        expect.objectContaining({ description: "boom" }),
      ),
    );
    expect(h.listAnnotationsForScene).toHaveBeenCalledTimes(1);
  });
});

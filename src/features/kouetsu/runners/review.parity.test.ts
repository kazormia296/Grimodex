// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * runners/review.parity.test.ts — review の起動 request パリティゲート。
 *
 * issue #283 の特性テスト（CurrentSceneReviewView.test.tsx）を CurrentScene
 * ビュー削除に伴い runner 直叩きへ移植（期待値は旧テストから無変更）。
 * review ロールのモデル/プロバイダ override と storyContext 注入を含め、
 * runPostEffect へ渡る request を全フィールド toEqual で固定する。
 * folder(multi) 起動 request の固定 expectation（ProjectReviewView.test.tsx
 * 由来）も同様に移植している。
 */

const h = vi.hoisted(() => ({
  buildReviewPayload: vi.fn(),
  buildMultiPayload: vi.fn(),
  getSceneIdsForScope: vi.fn(() => ["scene-1"]),
  runPostEffect: vi.fn(),
  runPostEffectMulti: vi.fn(),
  resolveRoleSendOverride: vi.fn(),
  dirtyTabIds: new Set<string>(),
}));

const CUSTOM = "カスタム校閲指示：固有名詞は変更しない";
const REVIEW_SYSTEM =
  "批評指示。\n以下の形式の JSON オブジェクトだけを返してください: {}";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
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
vi.mock("@/features/post-effect/reviewPayloadBuilder", () => ({
  buildReviewPayload: h.buildReviewPayload,
  REVIEW_PROMPT_VERSION: "review-v",
}));
vi.mock("@/features/post-effect/consistencyPayloadBuilder", () => ({
  buildMultiPayload: h.buildMultiPayload,
  buildConsistencyPayload: vi.fn(),
  buildIntraPayload: vi.fn(),
  getSceneIdsForScope: h.getSceneIdsForScope,
  CONSISTENCY_PROMPT_VERSION: "cons-v",
  INTRA_CONSISTENCY_PROMPT_VERSION: "intra-v",
}));
// multi パスの flushPendingSceneSaves() が dirty タブ一覧を読むため、
// layoutStore/i18n を引き込む実 tabStore の代わりに移植元と同じ形でモックする。
vi.mock("@/features/editor/tabStore", () => ({
  useTabStore: { getState: () => ({ dirtyTabIds: h.dirtyTabIds }) },
}));
// flushPendingSceneSaves は実装のまま（editorSaveRegistry 経由の flush を検証する）
vi.mock("@/features/post-effect/api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/post-effect/api")>();
  return {
    ...actual,
    runPostEffect: h.runPostEffect,
    runPostEffectMulti: h.runPostEffectMulti,
  };
});

import { runReviewCheck } from "./review";
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
  h.getSceneIdsForScope.mockReturnValue(["scene-1"]);
  mockDone({ annotation_count: 1 });
});

describe("runReviewCheck (scene) 起動 request のバイト同等性", () => {
  it("review ロール override + storyContext 込みの request で起動する", async () => {
    await runReviewCheck({ type: "scene", sceneId: SCENE_ID });
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
    await runReviewCheck({ type: "scene", sceneId: SCENE_ID });
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
    await runReviewCheck({ type: "scene", sceneId: SCENE_ID });
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

describe("runReviewCheck (folder) multi 起動 request", () => {
  beforeEach(() => {
    // 移植元（ProjectReviewView.test.tsx）は modelRouting を実物で通しており
    // override は付かない。同じ環境になるよう未設定へ倒す。
    h.resolveRoleSendOverride.mockReturnValue({
      model: undefined,
      provider: undefined,
      apiVariant: undefined,
      endpointId: undefined,
    });
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
  });

  it("folder スコープの実行は scope_type='folder' + scope_target_id を multi へ渡す", async () => {
    h.getSceneIdsForScope.mockReturnValue(["scene-1"]);
    h.buildMultiPayload.mockResolvedValue({
      inputHash: "hash-1",
      scenes: [{ scene_id: "scene-1", scene_text: "本文" }],
    });

    await runReviewCheck({ type: "folder", anchorId: "ch1" });

    expect(h.runPostEffectMulti).toHaveBeenCalled();
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

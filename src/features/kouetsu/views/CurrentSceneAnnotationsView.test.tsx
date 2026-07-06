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
 * CurrentSceneAnnotationsView（整合性）の起動経路の特性テスト（issue #283）。
 *
 * consistency（review ロール override 対象）と intra_scene_consistency
 * （基底モデルのまま）の 2 run を並行起動する経路について、runPostEffect へ
 * 渡る request を全フィールド toEqual で固定する。起動コードを runners の
 * scene パスへ委譲しても byte 同等であることをこのテスト無改修 green で
 * ゲートする。
 */

const h = vi.hoisted(() => ({
  buildConsistencyPayload: vi.fn(),
  buildIntraPayload: vi.fn(),
  runPostEffect: vi.fn(),
  listAnnotationsForScene: vi.fn(),
  setAnnotations: vi.fn(),
  resolveRoleSendOverride: vi.fn(),
}));

const CUSTOM = "カスタム校閲指示：固有名詞は変更しない";
const CONS_SYSTEM =
  "整合性指示。\n以下の形式の JSON オブジェクトだけを返してください: {}";
const INTRA_SYSTEM =
  "シーン内矛盾指示。\n以下の形式の JSON オブジェクトだけを返してください: {}";

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
      reviewSystem: "REVIEW",
      consistencySystem:
        "整合性指示。\n以下の形式の JSON オブジェクトだけを返してください: {}",
      intraSystem:
        "シーン内矛盾指示。\n以下の形式の JSON オブジェクトだけを返してください: {}",
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
  buildConsistencyPayload: h.buildConsistencyPayload,
  buildIntraPayload: h.buildIntraPayload,
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

import { CurrentSceneAnnotationsView } from "./CurrentSceneAnnotationsView";
import { appendKouetsuGuidance } from "@/features/post-effect/customInstruction";

const SCENE_ID = "scene-1";

interface RunRequest {
  effect_type: string;
  [key: string]: unknown;
}

/** effect_type ごとに done / error を出し分ける runPostEffect モック。 */
function mockRuns(
  spec: Partial<
    Record<
      "consistency" | "intra_scene_consistency",
      { annotation_count?: number; from_cache?: boolean } | { error: string }
    >
  >,
) {
  h.runPostEffect.mockImplementation(
    async (
      req: RunRequest,
      cb: {
        onDone?: (e: unknown) => void;
        onError?: (e: unknown) => void;
      },
    ) => {
      const s = spec[req.effect_type as keyof typeof spec] ?? {};
      if ("error" in s) {
        cb.onError?.({ run_id: `r-${req.effect_type}`, error: s.error });
      } else {
        cb.onDone?.({
          run_id: `r-${req.effect_type}`,
          annotation_count: s.annotation_count ?? 0,
          from_cache: s.from_cache ?? false,
        });
      }
      return { runId: `r-${req.effect_type}`, cleanup: () => {} };
    },
  );
}

function reqOf(effectType: string): RunRequest {
  const call = h.runPostEffect.mock.calls.find(
    (c) => (c[0] as RunRequest).effect_type === effectType,
  );
  expect(call).toBeDefined();
  return call![0] as RunRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.resolveRoleSendOverride.mockReturnValue({
    model: "role-model",
    provider: "openrouter",
    apiVariant: "chat",
    endpointId: "ep-1",
  });
  h.buildConsistencyPayload.mockResolvedValue({
    inputHash: "hash-c",
    codexPayloadJson: '[{"name":"人物A"}]',
    sceneText: "本文テキスト",
  });
  h.buildIntraPayload.mockResolvedValue({
    inputHash: "hash-i",
    sceneText: "本文テキスト",
  });
  h.listAnnotationsForScene.mockResolvedValue({ annotations: [] });
  mockRuns({
    consistency: { annotation_count: 1 },
    intra_scene_consistency: { annotation_count: 1 },
  });
});

afterEach(() => {
  cleanup();
});

async function clickRun() {
  render(<CurrentSceneAnnotationsView sceneId={SCENE_ID} />);
  fireEvent.click(screen.getByRole("button", { name: "AIチェック" }));
  await waitFor(() =>
    expect(h.listAnnotationsForScene).toHaveBeenCalledTimes(1),
  );
}

describe("CurrentSceneAnnotationsView 起動 request のバイト同等性", () => {
  it("consistency と intra を並行起動し、consistency のみ role override を反映する", async () => {
    await clickRun();
    expect(h.resolveRoleSendOverride).toHaveBeenCalledWith(
      "post_effect_consistency",
    );
    expect(h.runPostEffect).toHaveBeenCalledTimes(2);
    expect(reqOf("consistency")).toEqual({
      project_id: "p1",
      effect_type: "consistency",
      scope_type: "scene",
      scope_target_id: SCENE_ID,
      model: "role-model",
      model_override: "role-model",
      provider_override: "openrouter",
      api_variant_override: "chat",
      endpoint_id_override: "ep-1",
      prompt_version: "cons-v",
      input_hash: "hash-c",
      codex_payload_json: '[{"name":"人物A"}]',
      scene_text: "本文テキスト",
      system_prompt: appendKouetsuGuidance(CONS_SYSTEM, CUSTOM),
    });
    expect(reqOf("intra_scene_consistency")).toEqual({
      project_id: "p1",
      effect_type: "intra_scene_consistency",
      scope_type: "scene",
      scope_target_id: SCENE_ID,
      model: "base-model",
      prompt_version: "intra-v",
      input_hash: "hash-i",
      codex_payload_json: "[]",
      scene_text: "本文テキスト",
      system_prompt: appendKouetsuGuidance(INTRA_SYSTEM, CUSTOM),
    });
  });

  it("payload builder へ役割別モデルと custom / route を渡す", async () => {
    await clickRun();
    expect(h.buildConsistencyPayload).toHaveBeenCalledWith(
      "p1",
      SCENE_ID,
      "role-model",
      CUSTOM,
      { provider: "openrouter", endpointId: "ep-1" },
    );
    expect(h.buildIntraPayload).toHaveBeenCalledWith(
      SCENE_ID,
      "base-model",
      CUSTOM,
    );
  });
});

describe("CurrentSceneAnnotationsView 完了後の反映とトースト", () => {
  it("完了後に注釈を再取得して store へ反映する", async () => {
    const anns = [{ id: "a1", status: "open", metadata: "{}" }];
    h.listAnnotationsForScene.mockResolvedValue({ annotations: anns });
    await clickRun();
    expect(h.listAnnotationsForScene).toHaveBeenCalledWith({
      projectId: "p1",
      sceneId: SCENE_ID,
    });
    expect(h.setAnnotations).toHaveBeenCalledWith(SCENE_ID, anns);
  });

  it("両方 from_cache ならキャッシュトーストを出す", async () => {
    mockRuns({
      consistency: { annotation_count: 1, from_cache: true },
      intra_scene_consistency: { annotation_count: 0, from_cache: true },
    });
    await clickRun();
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        "前回と同じ内容のためキャッシュから読み込みました",
        expect.objectContaining({ description: "AI には送信していません" }),
      ),
    );
  });

  it("両方 0 件の実実行は noIssues トーストを出す", async () => {
    mockRuns({
      consistency: { annotation_count: 0 },
      intra_scene_consistency: { annotation_count: 0 },
    });
    await clickRun();
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("矛盾は見つかりませんでした"),
    );
  });

  it("片側失敗は partialError トーストを出す（成功分は反映済み）", async () => {
    mockRuns({
      consistency: { error: "boom" },
      intra_scene_consistency: { annotation_count: 2 },
    });
    await clickRun();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "整合性チェック (Codex整合性) に失敗しました",
        expect.objectContaining({ description: "boom" }),
      ),
    );
    expect(h.setAnnotations).toHaveBeenCalled();
  });

  it("両方失敗は checkError トーストへ両エラーを併記する", async () => {
    mockRuns({
      consistency: { error: "boom1" },
      intra_scene_consistency: { error: "boom2" },
    });
    await clickRun();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "整合性チェックに失敗しました",
        expect.objectContaining({
          description: "Codex整合性: boom1 / シーン内矛盾: boom2",
        }),
      ),
    );
  });

  it("今回モデル以外で検出された open 指摘があれば別モデル警告を出す", async () => {
    h.listAnnotationsForScene.mockResolvedValue({
      annotations: [
        {
          id: "a1",
          status: "open",
          metadata: JSON.stringify({
            codex_ref: { detected_by_model: "other-model" },
          }),
        },
        {
          id: "a2",
          status: "open",
          metadata: JSON.stringify({
            codex_ref: { detected_by_model: "role-model" },
          }),
        },
        {
          id: "a3",
          status: "open",
          metadata: JSON.stringify({
            codex_ref: { detected_by_model: "base-model" },
          }),
        },
        {
          id: "a4",
          status: "dismissed",
          metadata: JSON.stringify({
            codex_ref: { detected_by_model: "other-model" },
          }),
        },
      ],
    });
    await clickRun();
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        "1 件は別モデルで検出された指摘です",
        expect.objectContaining({ description: "other-model: 1件" }),
      ),
    );
  });
});

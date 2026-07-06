// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * runners/consistency.parity.test.ts — 整合性チェック起動 request のパリティゲート。
 *
 * issue #283 の特性テスト（CurrentSceneAnnotationsView.test.tsx）を CurrentScene
 * ビュー削除に伴い runner 直叩きへ移植（期待値は旧テストから無変更）。
 * consistency（review ロール override 対象）と intra_scene_consistency
 * （基底モデルのまま）の 2 run を並行起動する経路について、runPostEffect へ
 * 渡る request を全フィールド toEqual で固定する。
 */

const h = vi.hoisted(() => ({
  buildConsistencyPayload: vi.fn(),
  buildIntraPayload: vi.fn(),
  runPostEffect: vi.fn(),
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
vi.mock("@/features/post-effect/consistencyPayloadBuilder", () => ({
  buildMultiPayload: vi.fn(),
  buildConsistencyPayload: h.buildConsistencyPayload,
  buildIntraPayload: h.buildIntraPayload,
  getSceneIdsForScope: vi.fn(() => ["scene-1"]),
  CONSISTENCY_PROMPT_VERSION: "cons-v",
  INTRA_CONSISTENCY_PROMPT_VERSION: "intra-v",
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

import { runConsistencyCheck } from "./consistency";
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
  mockRuns({
    consistency: { annotation_count: 1 },
    intra_scene_consistency: { annotation_count: 1 },
  });
});

describe("runConsistencyCheck (scene) 起動 request のバイト同等性", () => {
  it("consistency と intra を並行起動し、consistency のみ role override を反映する", async () => {
    await runConsistencyCheck({ type: "scene", sceneId: SCENE_ID });
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
    await runConsistencyCheck({ type: "scene", sceneId: SCENE_ID });
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

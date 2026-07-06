// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * runners/typo.parity.test.ts — typo_detection scene パスのパリティゲート。
 *
 * issue #283 の特性テスト（CurrentSceneTypoView.test.tsx）を CurrentScene
 * ビュー削除に伴い runner 直叩きへ移植（期待値は旧テストから無変更）。
 * runPostEffect へ渡る request を全フィールド toEqual で固定し、
 * プロンプト合成順・model 導出・flush → build 順の回帰をゲートする。
 */

const h = vi.hoisted(() => ({
  buildTypoPayload: vi.fn(),
  runPostEffect: vi.fn(),
}));

const CUSTOM = "カスタム校閲指示：固有名詞は変更しない";
const TYPO_SYSTEM =
  "誤字脱字チェック指示。\n以下の形式の JSON オブジェクトだけを返してください: {}";

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
// flushPendingSceneSaves は実装のまま（editorSaveRegistry 経由の flush を検証する）
vi.mock("@/features/post-effect/api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/post-effect/api")>();
  return {
    ...actual,
    runPostEffect: h.runPostEffect,
  };
});

import { runTypoCheck } from "./typo";
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
  mockDone({ annotation_count: 1 });
});

afterEach(() => {
  unregisterSaveHandler(SCENE_ID);
});

describe("runTypoCheck (scene) 起動 request のバイト同等性", () => {
  it("単発 typo run を全フィールド固定の request で起動する", async () => {
    await runTypoCheck({ type: "scene", sceneId: SCENE_ID });
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
    await runTypoCheck({ type: "scene", sceneId: SCENE_ID });
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
    await runTypoCheck({ type: "scene", sceneId: SCENE_ID });
    expect(order).toEqual(["flush", "build"]);
  });
});

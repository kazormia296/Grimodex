// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * runners.ts — 校閲チェック起動ロジックの単体テスト。
 * payload builder / runPostEffect(Multi) / ガードを vi.mock し、runner が
 *  ガード → flush → payload build → run 起動 → outcome 正規化
 * を正しく行うことを検証する。トースト・一覧再取得はビュー責務なので対象外。
 */

const h = vi.hoisted(() => ({
  blockIfPolicyOff: vi.fn(() => false),
  blockIfUnlicensed: vi.fn(() => false),
  getSceneIdsForScope: vi.fn(() => ["s1"]),
  buildMultiPayload: vi.fn(),
  buildConsistencyPayload: vi.fn(),
  buildIntraPayload: vi.fn(),
  buildTypoPayload: vi.fn(),
  buildReviewPayload: vi.fn(),
  buildMetaStructurePayload: vi.fn(),
  buildTimelinePayload: vi.fn(),
  buildIntentDriftPayload: vi.fn(),
  runPostEffect: vi.fn(),
  runPostEffectMulti: vi.fn(),
  flushPendingSceneSaves: vi.fn(() => Promise.resolve()),
  resolveRoleSendOverride: vi.fn(
    (): {
      model?: string;
      provider?: string;
      apiVariant?: string;
      endpointId?: string;
    } => ({
      model: undefined,
      provider: undefined,
      apiVariant: undefined,
      endpointId: undefined,
    }),
  ),
  nodes: [{ id: "s1", nodeType: "scene", parentId: null }] as {
    id: string;
    nodeType: string;
    parentId: string | null;
    intent?: string;
  }[],
}));

vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: h.blockIfPolicyOff,
}));
vi.mock("@/features/license/gate", () => ({
  blockIfUnlicensed: h.blockIfUnlicensed,
}));
vi.mock("@/features/tree/treeStore", () => {
  const state = { projectId: "p1", nodes: h.nodes };
  return {
    useTreeStore: Object.assign(
      (sel: (s: typeof state) => unknown) => sel(state),
      { getState: () => ({ projectId: "p1", nodes: h.nodes }) },
    ),
  };
});
vi.mock("@/features/chat/store", () => ({
  useAiSettingsStore: { getState: () => ({ settings: { model: "m" } }) },
}));
vi.mock("@/features/settings/settingsStore", () => ({
  useSettingsStore: {
    getState: () => ({ get: (_k: string, fb: string) => fb }),
  },
}));
vi.mock("@/features/chat/modelRouting", () => ({
  resolveRoleSendOverride: h.resolveRoleSendOverride,
}));
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectLanguage: () => "ja",
}));
vi.mock("@/prompts/index", () => ({
  getPromptCatalog: () => ({
    postEffect: {
      typoSystem: "TYPO",
      reviewSystem: "REVIEW",
      consistencySystem: "CONS",
      intraSystem: "INTRA",
      metaStructureSystem: "META",
      timelineConsistencySystem: "TIMELINE",
      intentDriftSystem: "INTENT",
    },
  }),
}));
vi.mock("@/features/post-effect/customInstruction", () => ({
  appendKouetsuGuidance: (s: string) => s,
  appendStoryContextGuidance: (s: string) => s,
  appendTimelineGuidance: (s: string) => s,
  appendIntentGuidance: (s: string) => s,
}));
vi.mock("@/features/post-effect/storyContext", () => ({
  selectStoryContext: () => ({}),
}));
vi.mock("@/features/post-effect/consistencyPayloadBuilder", () => ({
  buildMultiPayload: h.buildMultiPayload,
  buildConsistencyPayload: h.buildConsistencyPayload,
  buildIntraPayload: h.buildIntraPayload,
  getSceneIdsForScope: h.getSceneIdsForScope,
  CONSISTENCY_PROMPT_VERSION: "cons-v",
  INTRA_CONSISTENCY_PROMPT_VERSION: "intra-v",
}));
vi.mock("@/features/post-effect/typoPayloadBuilder", () => ({
  buildTypoPayload: h.buildTypoPayload,
  TYPO_PROMPT_VERSION: "typo-v",
}));
vi.mock("@/features/post-effect/reviewPayloadBuilder", () => ({
  buildReviewPayload: h.buildReviewPayload,
  REVIEW_PROMPT_VERSION: "review-v",
}));
vi.mock("@/features/post-effect/metaStructurePayloadBuilder", () => ({
  buildMetaStructurePayload: h.buildMetaStructurePayload,
  META_STRUCTURE_PROMPT_VERSION: "meta-v",
}));
vi.mock("@/features/post-effect/timelinePayloadBuilder", () => ({
  buildTimelinePayload: h.buildTimelinePayload,
  TIMELINE_CONSISTENCY_PROMPT_VERSION: "timeline-v",
}));
vi.mock("@/features/post-effect/intentDriftPayloadBuilder", () => ({
  buildIntentDriftPayload: h.buildIntentDriftPayload,
  INTENT_DRIFT_PROMPT_VERSION: "intent-v",
}));
vi.mock("@/features/post-effect/api", () => ({
  runPostEffect: h.runPostEffect,
  runPostEffectMulti: h.runPostEffectMulti,
  flushPendingSceneSaves: h.flushPendingSceneSaves,
}));

import {
  runTypoCheck,
  runReviewCheck,
  runConsistencyCheck,
  runMetaStructureCheck,
  runTimelineCheck,
  runIntentDriftCheck,
} from "./runners";

/** onDone を同期で呼ぶ multi モック。 */
function multiDone(e: {
  annotation_count?: number;
  from_cache?: boolean;
  summary?: string;
}) {
  return (
    _req: unknown,
    cb: { onDone?: (e: unknown) => void; onError?: (e: unknown) => void },
  ) => {
    cb.onDone?.({
      run_id: "r1",
      annotation_count: e.annotation_count ?? 0,
      from_cache: e.from_cache ?? false,
      summary: e.summary,
    });
    return Promise.resolve({ runId: "r1", cleanup: () => {} });
  };
}
function singleDone(e: { annotation_count?: number; from_cache?: boolean }) {
  return (
    _req: unknown,
    cb: { onDone?: (e: unknown) => void; onError?: (e: unknown) => void },
  ) => {
    cb.onDone?.({
      run_id: "r1",
      annotation_count: e.annotation_count ?? 0,
      from_cache: e.from_cache ?? false,
    });
    return Promise.resolve({ runId: "r1", cleanup: () => {} });
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.blockIfPolicyOff.mockReturnValue(false);
  h.blockIfUnlicensed.mockReturnValue(false);
  h.getSceneIdsForScope.mockReturnValue(["s1"]);
  h.flushPendingSceneSaves.mockResolvedValue(undefined);
  h.resolveRoleSendOverride.mockReturnValue({
    model: undefined,
    provider: undefined,
    apiVariant: undefined,
    endpointId: undefined,
  });
  h.buildMultiPayload.mockResolvedValue({
    scenes: [{ scene_id: "s1", codex_payload_json: "[]", scene_text: "t" }],
    inputHash: "h",
  });
  h.buildTypoPayload.mockResolvedValue({ sceneText: "t", inputHash: "h" });
  h.buildReviewPayload.mockResolvedValue({ sceneText: "t", inputHash: "h" });
  h.buildMetaStructurePayload.mockResolvedValue({
    sceneText: "t",
    inputHash: "h",
  });
  h.buildTimelinePayload.mockResolvedValue({
    scenes: [{ scene_id: "s1", codex_payload_json: "[]", scene_text: "t" }],
    timelineContext: "ctx",
    inputHash: "h",
  });
  h.buildIntentDriftPayload.mockResolvedValue({
    sceneText: "t",
    inputHash: "h",
  });
});

describe("runTypoCheck", () => {
  it("project は multi を project スコープで起動し outcome を正規化する", async () => {
    h.runPostEffectMulti.mockImplementation(
      multiDone({ annotation_count: 3, from_cache: false }),
    );
    const out = await runTypoCheck({ type: "project" });
    expect(out).toEqual({ ok: true, fromCache: false, count: 3 });
    const req = h.runPostEffectMulti.mock.calls[0][0] as {
      effect_type: string;
      scope_type: string;
      scope_target_id: string | null;
    };
    expect(req.effect_type).toBe("typo_detection");
    expect(req.scope_type).toBe("project");
    expect(req.scope_target_id).toBeNull();
    // flush は build より前
    expect(h.flushPendingSceneSaves).toHaveBeenCalled();
  });

  it("folder は buildMultiPayload に folder/anchor を渡す", async () => {
    h.runPostEffectMulti.mockImplementation(multiDone({ annotation_count: 0 }));
    await runTypoCheck({ type: "folder", anchorId: "ch1" });
    expect(h.buildMultiPayload).toHaveBeenCalledWith(
      "p1",
      "folder",
      "ch1",
      expect.anything(),
      "typo_detection",
      expect.anything(),
    );
    const req = h.runPostEffectMulti.mock.calls[0][0] as {
      scope_type: string;
      scope_target_id: string | null;
    };
    expect(req.scope_type).toBe("folder");
    expect(req.scope_target_id).toBe("ch1");
  });

  it("scene は単発 run を起動する", async () => {
    h.runPostEffect.mockImplementation(
      singleDone({ annotation_count: 2, from_cache: false }),
    );
    const out = await runTypoCheck({ type: "scene", sceneId: "s1" });
    expect(out).toEqual({ ok: true, fromCache: false, count: 2 });
    expect(h.runPostEffectMulti).not.toHaveBeenCalled();
    const req = h.runPostEffect.mock.calls[0][0] as {
      scope_type: string;
      scope_target_id: string | null;
      scene_text: string;
    };
    expect(req.scope_type).toBe("scene");
    expect(req.scope_target_id).toBe("s1");
    expect(req.scene_text).toBe("t");
    expect(h.flushPendingSceneSaves).toHaveBeenCalledWith("s1");
  });

  it("対象シーン 0 件 (payload empty) は skipped を返し invoke しない", async () => {
    h.buildMultiPayload.mockResolvedValue({ scenes: [], inputHash: "h" });
    const out = await runTypoCheck({ type: "project" });
    expect(out).toEqual({ ok: true, skipped: true });
    expect(h.runPostEffectMulti).not.toHaveBeenCalled();
  });

  it("スコープ内シーン 0 件 (getSceneIds empty) は skipped を返し build しない", async () => {
    h.getSceneIdsForScope.mockReturnValue([]);
    const out = await runTypoCheck({ type: "project" });
    expect(out).toEqual({ ok: true, skipped: true });
    expect(h.buildMultiPayload).not.toHaveBeenCalled();
    expect(h.runPostEffectMulti).not.toHaveBeenCalled();
  });

  it("onError は ok:false へ正規化される", async () => {
    h.runPostEffectMulti.mockImplementation((_req, cb) => {
      (cb as { onError?: (e: unknown) => void }).onError?.({
        run_id: "r1",
        error: "boom",
      });
      return Promise.resolve({ runId: "r1", cleanup: () => {} });
    });
    const out = await runTypoCheck({ type: "project" });
    expect(out).toEqual({ ok: false, error: "boom" });
  });

  it("起動 reject も ok:false へ正規化される", async () => {
    h.runPostEffectMulti.mockRejectedValue(new Error("launch fail"));
    const out = await runTypoCheck({ type: "project" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("launch fail");
  });

  it("policy ガードでブロックされると blocked を返し何も起動しない", async () => {
    h.blockIfPolicyOff.mockReturnValue(true);
    const out = await runTypoCheck({ type: "project" });
    expect(out).toEqual({ ok: true, blocked: true });
    expect(h.flushPendingSceneSaves).not.toHaveBeenCalled();
    expect(h.runPostEffectMulti).not.toHaveBeenCalled();
  });

  it("license ガードでブロックされると blocked を返す", async () => {
    h.blockIfUnlicensed.mockReturnValue(true);
    const out = await runTypoCheck({ type: "project" });
    expect(out).toEqual({ ok: true, blocked: true });
  });
});

describe("runReviewCheck", () => {
  it("folder は buildMultiPayload に folder/anchor + review + route を渡す", async () => {
    h.runPostEffectMulti.mockImplementation(multiDone({ annotation_count: 0 }));
    await runReviewCheck({ type: "folder", anchorId: "ch1" });
    expect(h.buildMultiPayload).toHaveBeenCalledWith(
      "p1",
      "folder",
      "ch1",
      expect.anything(),
      "review",
      expect.anything(),
      expect.anything(),
    );
    const req = h.runPostEffectMulti.mock.calls[0][0] as {
      effect_type: string;
      scope_type: string;
    };
    expect(req.effect_type).toBe("review");
    expect(req.scope_type).toBe("folder");
  });

  it("scene は単発 run を review スコープで起動する", async () => {
    h.runPostEffect.mockImplementation(singleDone({ annotation_count: 1 }));
    const out = await runReviewCheck({ type: "scene", sceneId: "s1" });
    expect(out).toEqual({ ok: true, fromCache: false, count: 1 });
    const req = h.runPostEffect.mock.calls[0][0] as {
      effect_type: string;
      scope_type: string;
    };
    expect(req.effect_type).toBe("review");
    expect(req.scope_type).toBe("scene");
  });
});

describe("runConsistencyCheck", () => {
  it("project は consistency と intra を両方起動し {codex, intra} を返す", async () => {
    h.runPostEffectMulti.mockImplementation(
      multiDone({ annotation_count: 2, from_cache: false }),
    );
    const out = await runConsistencyCheck({ type: "project" });
    expect(out.codex).toEqual({ ok: true, fromCache: false, count: 2 });
    expect(out.intra).toEqual({ ok: true, fromCache: false, count: 2 });
    const effects = h.runPostEffectMulti.mock.calls.map(
      (c) => (c[0] as { effect_type: string }).effect_type,
    );
    expect(effects).toContain("consistency");
    expect(effects).toContain("intra_scene_consistency");
  });

  it("スコープ内 0 件は両方 skipped を返し build しない", async () => {
    h.getSceneIdsForScope.mockReturnValue([]);
    const out = await runConsistencyCheck({ type: "project" });
    expect(out.codex).toEqual({ ok: true, skipped: true });
    expect(out.intra).toEqual({ ok: true, skipped: true });
    expect(h.buildMultiPayload).not.toHaveBeenCalled();
  });

  it("ブロック時は両方 blocked を返す", async () => {
    h.blockIfPolicyOff.mockReturnValue(true);
    const out = await runConsistencyCheck({ type: "project" });
    expect(out.codex).toEqual({ ok: true, blocked: true });
    expect(out.intra).toEqual({ ok: true, blocked: true });
  });

  it("scene は consistency/intra を単発 run で起動する", async () => {
    h.buildConsistencyPayload.mockResolvedValue({
      codexPayloadJson: "[{}]",
      sceneText: "t",
      inputHash: "h",
    });
    h.buildIntraPayload.mockResolvedValue({ sceneText: "t", inputHash: "h" });
    h.runPostEffect.mockImplementation(singleDone({ annotation_count: 1 }));
    const out = await runConsistencyCheck({ type: "scene", sceneId: "s1" });
    expect(out.codex).toEqual({ ok: true, fromCache: false, count: 1 });
    expect(out.intra).toEqual({ ok: true, fromCache: false, count: 1 });
    const scopes = h.runPostEffect.mock.calls.map(
      (c) => (c[0] as { scope_type: string }).scope_type,
    );
    expect(scopes).toEqual(["scene", "scene"]);
    expect(h.runPostEffectMulti).not.toHaveBeenCalled();
  });

  it("実際に使ったモデルを models で返す（codex=roleロール override / intra=基底）", async () => {
    h.resolveRoleSendOverride.mockReturnValue({
      model: "role-model",
      provider: undefined,
      apiVariant: undefined,
      endpointId: undefined,
    });
    h.buildConsistencyPayload.mockResolvedValue({
      codexPayloadJson: "[{}]",
      sceneText: "t",
      inputHash: "h",
    });
    h.buildIntraPayload.mockResolvedValue({ sceneText: "t", inputHash: "h" });
    h.runPostEffect.mockImplementation(singleDone({ annotation_count: 0 }));
    const out = await runConsistencyCheck({ type: "scene", sceneId: "s1" });
    expect(out.models).toEqual({ codex: "role-model", intra: "m" });
  });

  it("ブロック時は models を返さない", async () => {
    h.blockIfPolicyOff.mockReturnValue(true);
    const out = await runConsistencyCheck({ type: "scene", sceneId: "s1" });
    expect(out.models).toBeUndefined();
  });

  it("scene で片側の payload build が失敗しても、もう片側の outcome は返る", async () => {
    h.buildConsistencyPayload.mockRejectedValue(new Error("db read fail"));
    h.buildIntraPayload.mockResolvedValue({ sceneText: "t", inputHash: "h" });
    h.runPostEffect.mockImplementation(singleDone({ annotation_count: 2 }));
    const out = await runConsistencyCheck({ type: "scene", sceneId: "s1" });
    expect(out.codex.ok).toBe(false);
    if (!out.codex.ok) expect(out.codex.error).toContain("db read fail");
    expect(out.intra).toEqual({ ok: true, fromCache: false, count: 2 });
    // intra 側の単発 run は起動されている（consistency の build 失敗で巻き込まれない）。
    expect(h.runPostEffect).toHaveBeenCalledTimes(1);
    expect(
      (h.runPostEffect.mock.calls[0][0] as { effect_type: string }).effect_type,
    ).toBe("intra_scene_consistency");
  });
});

describe("runMetaStructureCheck", () => {
  it("scene は単発 meta_structure run を起動する", async () => {
    h.runPostEffect.mockImplementation(singleDone({ annotation_count: 0 }));
    const out = await runMetaStructureCheck({ type: "scene", sceneId: "s1" });
    expect(out).toEqual({ ok: true, fromCache: false, count: 0 });
    const req = h.runPostEffect.mock.calls[0][0] as {
      effect_type: string;
      scope_type: string;
    };
    expect(req.effect_type).toBe("meta_structure");
    expect(req.scope_type).toBe("scene");
  });

  it("project は multi meta_structure を起動する", async () => {
    h.runPostEffectMulti.mockImplementation(
      multiDone({ annotation_count: 0, summary: "1件失敗" }),
    );
    const out = await runMetaStructureCheck({ type: "project" });
    expect(out).toEqual({
      ok: true,
      fromCache: false,
      count: 0,
      summary: "1件失敗",
    });
    const req = h.runPostEffectMulti.mock.calls[0][0] as {
      effect_type: string;
    };
    expect(req.effect_type).toBe("meta_structure");
  });
});

describe("runTimelineCheck", () => {
  it("常に project multi を timeline スコープで起動する", async () => {
    h.runPostEffectMulti.mockImplementation(multiDone({ annotation_count: 4 }));
    const out = await runTimelineCheck();
    expect(out).toEqual({ ok: true, fromCache: false, count: 4 });
    const req = h.runPostEffectMulti.mock.calls[0][0] as {
      effect_type: string;
      scope_type: string;
      scope_target_id: string | null;
    };
    expect(req.effect_type).toBe("timeline_consistency");
    expect(req.scope_type).toBe("project");
    expect(req.scope_target_id).toBeNull();
    expect(h.buildTimelinePayload).toHaveBeenCalled();
  });

  it("配置済シーン 0 件は skipped を返し invoke しない", async () => {
    h.buildTimelinePayload.mockResolvedValue({
      scenes: [],
      timelineContext: "",
      inputHash: "h",
    });
    const out = await runTimelineCheck();
    expect(out).toEqual({ ok: true, skipped: true });
    expect(h.runPostEffectMulti).not.toHaveBeenCalled();
  });

  it("ブロック時は blocked を返す", async () => {
    h.blockIfUnlicensed.mockReturnValue(true);
    const out = await runTimelineCheck();
    expect(out).toEqual({ ok: true, blocked: true });
  });
});

describe("runIntentDriftCheck", () => {
  /** intent 付き 2 シーンを列挙する既定セットアップ。 */
  function setNodes(s2Intent: string) {
    h.getSceneIdsForScope.mockReturnValue(["s1", "s2"]);
    h.nodes.length = 0;
    h.nodes.push(
      { id: "s1", nodeType: "scene", parentId: null, intent: "緊張感" },
      { id: "s2", nodeType: "scene", parentId: null, intent: s2Intent },
    );
    h.runPostEffect.mockImplementation(singleDone({ annotation_count: 1 }));
  }

  it("intent 未設定のシーンはスキップし、intent ありだけ直列に単発 run する", async () => {
    setNodes(""); // s2 は intent 空 → スキップ
    const out = await runIntentDriftCheck({ type: "project" });
    expect(h.runPostEffect).toHaveBeenCalledTimes(1);
    const req = h.runPostEffect.mock.calls[0][0] as {
      effect_type: string;
      scope_type: string;
      scope_target_id: string;
    };
    expect(req.effect_type).toBe("intent_drift");
    expect(req.scope_type).toBe("scene");
    expect(req.scope_target_id).toBe("s1");
    expect(out).toEqual({ ok: true, fromCache: false, count: 1 });
    expect(h.runPostEffectMulti).not.toHaveBeenCalled();
  });

  it("空白のみの intent もスキップする", async () => {
    setNodes("   ");
    await runIntentDriftCheck({ type: "project" });
    expect(h.runPostEffect).toHaveBeenCalledTimes(1);
    expect(
      (h.runPostEffect.mock.calls[0][0] as { scope_target_id: string })
        .scope_target_id,
    ).toBe("s1");
  });

  it("intent ありの複数シーンを直列に起動し count を合算する", async () => {
    setNodes("静けさ");
    const out = await runIntentDriftCheck({ type: "project" });
    expect(h.runPostEffect).toHaveBeenCalledTimes(2);
    const ids = h.runPostEffect.mock.calls.map(
      (c) => (c[0] as { scope_target_id: string }).scope_target_id,
    );
    expect(ids).toEqual(["s1", "s2"]);
    expect(out).toEqual({ ok: true, fromCache: false, count: 2 });
  });

  it("scene スコープは対象シーンのみ起動する", async () => {
    h.nodes.length = 0;
    h.nodes.push({
      id: "sx",
      nodeType: "scene",
      parentId: null,
      intent: "決意",
    });
    h.runPostEffect.mockImplementation(singleDone({ annotation_count: 3 }));
    const out = await runIntentDriftCheck({ type: "scene", sceneId: "sx" });
    expect(h.getSceneIdsForScope).not.toHaveBeenCalled();
    expect(h.runPostEffect).toHaveBeenCalledTimes(1);
    expect(
      (h.runPostEffect.mock.calls[0][0] as { scope_target_id: string })
        .scope_target_id,
    ).toBe("sx");
    expect(out).toEqual({ ok: true, fromCache: false, count: 3 });
  });

  it("isCancelled が true を返したら残りシーンを起動しない", async () => {
    setNodes("静けさ"); // 2 シーンとも intent あり
    let calls = 0;
    await runIntentDriftCheck(
      { type: "project" },
      { isCancelled: () => calls++ >= 1 },
    );
    expect(h.runPostEffect.mock.calls.length).toBeLessThanOrEqual(1);
    expect(h.runPostEffect).toHaveBeenCalledTimes(1);
  });

  it("intent 付きシーンが 0 件なら skipped を返し起動しない", async () => {
    setNodes("");
    h.nodes[0].intent = ""; // s1 も空にする
    const out = await runIntentDriftCheck({ type: "project" });
    expect(out).toEqual({ ok: true, skipped: true });
    expect(h.runPostEffect).not.toHaveBeenCalled();
  });

  it("onSceneProgress に done/total を通知する", async () => {
    setNodes("静けさ");
    const progress: [number, number][] = [];
    await runIntentDriftCheck(
      { type: "project" },
      { onSceneProgress: (done, total) => progress.push([done, total]) },
    );
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it("一部シーンが失敗しても成功分の count を返し summary を付ける", async () => {
    setNodes("静けさ");
    h.runPostEffect
      .mockImplementationOnce(singleDone({ annotation_count: 2 }))
      .mockImplementationOnce((_req, cb) => {
        (cb as { onError?: (e: unknown) => void }).onError?.({
          run_id: "r2",
          error: "boom",
        });
        return Promise.resolve({ runId: "r2", cleanup: () => {} });
      });
    const out = await runIntentDriftCheck({ type: "project" });
    expect(out.ok).toBe(true);
    if (out.ok && "count" in out) {
      expect(out.count).toBe(2);
      expect(out.summary).toBeTruthy();
    }
  });

  it("全シーンが失敗したら ok:false を返す", async () => {
    setNodes("静けさ");
    h.runPostEffect.mockImplementation((_req, cb) => {
      (cb as { onError?: (e: unknown) => void }).onError?.({
        run_id: "r1",
        error: "boom",
      });
      return Promise.resolve({ runId: "r1", cleanup: () => {} });
    });
    const out = await runIntentDriftCheck({ type: "project" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("boom");
  });

  it("ブロック時は blocked を返し何も起動しない", async () => {
    setNodes("静けさ");
    h.blockIfPolicyOff.mockReturnValue(true);
    const out = await runIntentDriftCheck({ type: "project" });
    expect(out).toEqual({ ok: true, blocked: true });
    expect(h.runPostEffect).not.toHaveBeenCalled();
  });
});

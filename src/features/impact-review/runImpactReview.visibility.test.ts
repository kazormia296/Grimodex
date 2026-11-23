/**
 * 影響確認（runImpactReview）の Codex の hidden の門の特性試験（DR-MP4-44）。
 *
 * 影響確認は、Codex の項目が AI に渡さない設定（base の contextMode が
 * `current-mention` を満たさない、または Phase の override が 1 つでも満たさない）
 * のとき、候補絞りも AI も呼ばずに run 全体を止める。この門と、その周り
 * （再検査・baseline の前進・削除された Phase の tombstone）は挙動を変えず、
 * この試験で固定する。
 *
 * mock の seam は runImpactReview.test.ts と同じ（buildCodexSnapshot・getBaseline・
 * narrowCandidateScenes・runPostEffectMulti）。ここでは contextMode と
 * hasRestrictedPhases を必ず明示する。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CodexSnapshot } from "./diff";
import type { CodexSnapshotResult } from "./snapshot";

// --- module mocks ---------------------------------------------------------
vi.mock("./snapshot", () => ({ buildCodexSnapshot: vi.fn() }));
vi.mock("./baseline", () => ({ getBaseline: vi.fn(), saveBaseline: vi.fn() }));
vi.mock("./narrowing", () => ({ narrowCandidateScenes: vi.fn() }));
vi.mock("@/features/post-effect/api", () => ({ runPostEffectMulti: vi.fn() }));
vi.mock("@/features/post-effect/consistencyPayloadBuilder", () => ({
  IMPACT_REVIEW_PROMPT_VERSION: "impact_review_v1.1",
}));
vi.mock("@/prompts/index", () => ({
  getPromptCatalog: () => ({ postEffect: { impactReviewSystem: "SYS" } }),
}));
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectLanguage: () => "ja",
}));
vi.mock("@/features/chat/store", () => ({
  useAiSettingsStore: { getState: () => ({ settings: { model: "m1" } }) },
}));
vi.mock("@/lib/prosemirror", () => ({
  prosemirrorToText: () => "scene body text",
}));
const dbWhere = vi.fn(() =>
  Promise.resolve([
    { id: "s2", content: "{}" },
    { id: "s1", content: "{}" },
  ]),
);
vi.mock("@/db/client", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => dbWhere(),
      }),
    }),
  },
}));

import { runImpactReview } from "./runImpactReview";
import { buildCodexSnapshot } from "./snapshot";
import { getBaseline, saveBaseline } from "./baseline";
import { narrowCandidateScenes } from "./narrowing";
import { runPostEffectMulti } from "@/features/post-effect/api";
import {
  canIncludeResolvedCodexContext,
  isCodexContextModeHiddenFromAi,
} from "@/features/codex/context/codexVisibilityPolicy";

const SECRET = "ここは作者が非公開にした Phase の本文";
const OLD_SECRET = "ここは削除された Phase の旧本文";

const baseSnap: CodexSnapshot = {
  name: "アリス",
  aliases: ["アリー"],
  summary: "15歳。",
  contentPlain: "町に住む。",
  details: [{ name: "年齢", value: "15" }],
};
/** baseSnap との差が detail「年齢」12 → 15 の 1 件だけになる baseline。 */
const baselineAge12: CodexSnapshot = {
  ...baseSnap,
  details: [{ name: "年齢", value: "12" }],
};

const sourceRevision = {
  kind: "sqlite_write_clock_v1" as const,
  expected_lineage: "5c469be051e34f31a95e0bf457806c56",
  expected_seq: "10",
};

function built(
  overrides: Partial<CodexSnapshotResult> = {},
): CodexSnapshotResult {
  return {
    snapshot: baseSnap,
    projectId: "p1",
    entryType: "character",
    entryName: "アリス",
    sourceRevision,
    contextMode: "mentioned",
    hasRestrictedPhases: false,
    ...overrides,
  };
}

/** Phase p1 の override を持つ現在の snapshot（本文は SECRET）。 */
function snapWithPhase(restricted: boolean): CodexSnapshot {
  return {
    ...baseSnap,
    phases: [
      {
        phaseId: "p1",
        label: "秘密期",
        summary: SECRET,
        contentPlain: null,
        details: [],
      },
    ],
    visibilityProvenanceVersion: 1,
    allPhaseIds: ["p1"],
    restrictedPhaseIds: restricted ? ["p1"] : [],
  };
}

function expectNothingSentToAi(): void {
  expect(narrowCandidateScenes).not.toHaveBeenCalled();
  expect(runPostEffectMulti).not.toHaveBeenCalled();
}

function requestOf(): { scenes: Array<{ codex_payload_json: string }> } {
  const [req] = vi.mocked(runPostEffectMulti).mock.calls[0];
  return req as unknown as { scenes: Array<{ codex_payload_json: string }> };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(buildCodexSnapshot).mockReset();
  vi.mocked(getBaseline).mockReset();
  vi.mocked(saveBaseline).mockReset();
  vi.mocked(narrowCandidateScenes).mockReset();
  vi.mocked(runPostEffectMulti).mockReset();
  vi.mocked(buildCodexSnapshot).mockResolvedValue(built());
  vi.mocked(narrowCandidateScenes).mockResolvedValue([
    { sceneId: "s1", score: 1, matchedBy: ["dense"] },
    { sceneId: "s2", score: 0.5, matchedBy: ["sparse"] },
  ]);
  vi.mocked(runPostEffectMulti).mockResolvedValue({
    runId: "r1",
    cleanup: () => {},
  });
});

describe("base の contextMode の門", () => {
  it.each(["hidden", "suppress", "unknown-mode", ""])(
    "contextMode=%j は差分があっても AI も候補絞りも呼ばず no-candidates で止まる（baseline は進めない）",
    async (contextMode) => {
      vi.mocked(getBaseline).mockResolvedValue(baselineAge12);
      vi.mocked(buildCodexSnapshot).mockResolvedValue(built({ contextMode }));

      const res = await runImpactReview("e1");

      expect(res.status).toBe("no-candidates");
      expect(res.changeCount).toBe(1);
      expect(res.candidateSceneCount).toBe(0);
      expectNothingSentToAi();
      expect(saveBaseline).not.toHaveBeenCalled();
      expect(buildCodexSnapshot).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["mentioned", "always"])(
    "contextMode=%s は門を通り、候補絞りと AI の run に進む",
    async (contextMode) => {
      vi.mocked(getBaseline).mockResolvedValue(baselineAge12);
      vi.mocked(buildCodexSnapshot).mockResolvedValue(built({ contextMode }));

      const res = await runImpactReview("e1");

      expect(res.status).toBe("started");
      expect(narrowCandidateScenes).toHaveBeenCalledTimes(1);
      expect(runPostEffectMulti).toHaveBeenCalledTimes(1);
    },
  );

  it("差分が 0 件なら、hidden でも何も送らず no-change（baseline は進めない）", async () => {
    vi.mocked(getBaseline).mockResolvedValue({ ...baseSnap });
    vi.mocked(buildCodexSnapshot).mockResolvedValue(
      built({ contextMode: "hidden" }),
    );

    const res = await runImpactReview("e1");

    expect(res.status).toBe("no-change");
    expectNothingSentToAi();
    expect(saveBaseline).not.toHaveBeenCalled();
  });
});

describe("Phase の制限の門（1 つでも非公開なら run 全体を止める）", () => {
  it("hasRestrictedPhases の旗だけが立っていても止まる（tombstone の書き込みも無い）", async () => {
    vi.mocked(getBaseline).mockResolvedValue(baselineAge12);
    vi.mocked(buildCodexSnapshot).mockResolvedValue(
      built({ hasRestrictedPhases: true }),
    );

    const res = await runImpactReview("e1");

    expect(res.status).toBe("no-candidates");
    expect(res.changeCount).toBe(1);
    expectNothingSentToAi();
    expect(saveBaseline).not.toHaveBeenCalled();
  });

  it("snapshot.restrictedPhaseIds だけが非空（旗は偽）でも止まる。tombstone 済みなら baseline は書かない", async () => {
    vi.mocked(getBaseline).mockResolvedValue({
      ...baselineAge12,
      allPhaseIds: ["p1"],
      restrictedPhaseIds: ["p1"],
    });
    vi.mocked(buildCodexSnapshot).mockResolvedValue(
      built({ snapshot: snapWithPhase(true), hasRestrictedPhases: false }),
    );

    const res = await runImpactReview("e1");

    expect(res.status).toBe("no-candidates");
    // 非公開の Phase の変更は changes に数えない（base の 1 件だけ）。
    expect(res.changeCount).toBe(1);
    expectNothingSentToAi();
    expect(saveBaseline).not.toHaveBeenCalled();
  });

  it("tombstone が未済なら、gate の前に制限の印だけを書く。現在の Phase の本文は書かない", async () => {
    vi.mocked(getBaseline).mockResolvedValue(baselineAge12);
    vi.mocked(buildCodexSnapshot).mockResolvedValue(
      built({ snapshot: snapWithPhase(true), hasRestrictedPhases: true }),
    );

    const res = await runImpactReview("e1");

    expect(res.status).toBe("no-candidates");
    expectNothingSentToAi();
    expect(saveBaseline).toHaveBeenCalledTimes(1);
    const args = vi.mocked(saveBaseline).mock.calls[0];
    expect(args[0]).toBe("p1");
    expect(args[1]).toBe("e1");
    expect(args[2]).toEqual({
      ...baselineAge12,
      allPhaseIds: ["p1"],
      restrictedPhaseIds: ["p1"],
    });
    expect(JSON.stringify(args[2])).not.toContain(SECRET);
    // 現在の snapshot（Phase の本文入り）を baseline として前進させていない。
    expect(args[2]).not.toEqual(snapWithPhase(true));
  });

  it("baseline が無く tombstone が未済なら、空の baseline に制限の印だけを書く", async () => {
    vi.mocked(getBaseline).mockResolvedValue(null);
    vi.mocked(buildCodexSnapshot).mockResolvedValue(
      built({ snapshot: snapWithPhase(true), hasRestrictedPhases: true }),
    );

    const res = await runImpactReview("e1");

    expect(res.status).toBe("no-candidates");
    expectNothingSentToAi();
    expect(saveBaseline).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveBaseline).mock.calls[0][2]).toEqual({
      name: "",
      aliases: [],
      summary: "",
      contentPlain: "",
      details: [],
      phases: [],
      visibilityProvenanceVersion: 1,
      allPhaseIds: ["p1"],
      restrictedPhaseIds: ["p1"],
    });
    expect(
      JSON.stringify(vi.mocked(saveBaseline).mock.calls[0][2]),
    ).not.toContain(SECRET);
  });

  it("非公開の Phase の変更だけなら no-change（AI にも候補絞りにも出さず、baseline は進めない）", async () => {
    vi.mocked(getBaseline).mockResolvedValue({
      ...baseSnap,
      phases: [
        {
          phaseId: "p1",
          label: "秘密期",
          summary: "旧い秘密期の要約",
          contentPlain: null,
          details: [],
        },
      ],
      allPhaseIds: ["p1"],
      restrictedPhaseIds: ["p1"],
    });
    vi.mocked(buildCodexSnapshot).mockResolvedValue(
      built({ snapshot: snapWithPhase(true), hasRestrictedPhases: true }),
    );

    const res = await runImpactReview("e1");

    expect(res.status).toBe("no-change");
    expect(res.changeCount).toBe(0);
    expectNothingSentToAi();
    expect(saveBaseline).not.toHaveBeenCalled();
  });
});

describe("非制限の run（AI に渡る payload の固定）", () => {
  it("base の差分だけを payload にし、request 全体が固定される", async () => {
    vi.mocked(getBaseline).mockResolvedValue(baselineAge12);

    const res = await runImpactReview("e1");

    expect(res.status).toBe("started");
    expect(res.candidateSceneCount).toBe(2);
    expect(saveBaseline).not.toHaveBeenCalled();
    expect(runPostEffectMulti).toHaveBeenCalledTimes(1);
    const [req] = vi.mocked(runPostEffectMulti).mock.calls[0];
    const payloads = requestOf().scenes.map((s) => s.codex_payload_json);
    expect(new Set(payloads).size).toBe(1);
    const payload = JSON.parse(payloads[0]);
    expect(payload.changes).toEqual([
      { field: "detail", name: "年齢", old: "12", new: "15" },
    ]);
    expect(Object.keys(payload).sort()).toEqual([
      "change_id",
      "change_summary",
      "changes",
      "entry_id",
      "entry_name",
      "entry_type",
    ]);
    // 契約の固定（値は変えない）：request 全体。
    expect(req).toEqual({
      project_id: "p1",
      effect_type: "impact_review",
      scope_type: "project",
      scope_target_id: null,
      model: "m1",
      model_override: null,
      provider_override: null,
      api_variant_override: null,
      endpoint_id_override: null,
      prompt_version: "impact_review_v1.1",
      input_hash:
        "3d9e7c18ac75a685886549e14febdc22d937a4255b4c74350019f3fc54cae3eb",
      source_guard: sourceRevision,
      scenes: [
        {
          scene_id: "s1",
          codex_payload_json: payloads[0],
          scene_text: "scene body text",
        },
        {
          scene_id: "s2",
          codex_payload_json: payloads[0],
          scene_text: "scene body text",
        },
      ],
      system_prompt: "SYS",
    });
    expect(payloads[0]).toBe(
      JSON.stringify({
        change_id: "c905e153",
        entry_id: "e1",
        entry_name: "アリス",
        entry_type: "character",
        change_summary: "年齢: 12 → 15",
        changes: [{ field: "detail", name: "年齢", old: "12", new: "15" }],
      }),
    );
  });

  it("公開の Phase の override は、変更の payload に入る（場面の時点は問わない）", async () => {
    vi.mocked(getBaseline).mockResolvedValue({ ...baseSnap });
    vi.mocked(buildCodexSnapshot).mockResolvedValue(
      built({ snapshot: snapWithPhase(false), hasRestrictedPhases: false }),
    );

    const res = await runImpactReview("e1");

    expect(res.status).toBe("started");
    const payload = JSON.parse(requestOf().scenes[0].codex_payload_json);
    expect(payload.changes).toEqual([
      {
        field: "phase_summary",
        name: null,
        phase: "秘密期",
        old: "",
        new: SECRET,
      },
    ]);
  });
});

describe("削除された Phase の tombstone（旧本文を old → 空の差分に再構成しない）", () => {
  /** 現在は Phase が無く、baseline に p1 の旧本文がある。base の差分（年齢）は 1 件。 */
  function baselineWithDeletedPhase(
    extra: Partial<CodexSnapshot>,
  ): CodexSnapshot {
    return {
      ...baselineAge12,
      phases: [
        {
          phaseId: "p1",
          label: "旧 Phase",
          summary: OLD_SECRET,
          contentPlain: null,
          details: [],
        },
      ],
      allPhaseIds: ["p1"],
      ...extra,
    };
  }

  it("公開中の削除だと証明できない Phase（legacy の baseline）は fail-closed：旧本文は差分に出ない", async () => {
    vi.mocked(getBaseline).mockResolvedValue(baselineWithDeletedPhase({}));
    vi.mocked(buildCodexSnapshot).mockResolvedValue(
      built({ snapshot: { ...baseSnap, allPhaseIds: [], phases: [] } }),
    );

    const res = await runImpactReview("e1");

    expect(res.status).toBe("started");
    const sent = requestOf().scenes[0].codex_payload_json;
    expect(sent).not.toContain(OLD_SECRET);
    expect(JSON.parse(sent).changes).toEqual([
      { field: "detail", name: "年齢", old: "12", new: "15" },
    ]);
  });

  it("baseline が制限の印を持つ Phase の削除も、旧本文は差分に出ない", async () => {
    vi.mocked(getBaseline).mockResolvedValue(
      baselineWithDeletedPhase({ restrictedPhaseIds: ["p1"] }),
    );
    vi.mocked(buildCodexSnapshot).mockResolvedValue(
      built({ snapshot: { ...baseSnap, allPhaseIds: [], phases: [] } }),
    );

    const res = await runImpactReview("e1");

    expect(res.status).toBe("started");
    const sent = requestOf().scenes[0].codex_payload_json;
    expect(sent).not.toContain(OLD_SECRET);
    expect(JSON.parse(sent).changes).toHaveLength(1);
  });

  it("制限の印と『公開中に削除した』の記録が両方あるときは、制限の印が勝つ（fail-closed の優先）", async () => {
    vi.mocked(getBaseline).mockResolvedValue(
      baselineWithDeletedPhase({
        restrictedPhaseIds: ["p1"],
        visibleDeletedPhaseIds: ["p1"],
      }),
    );
    vi.mocked(buildCodexSnapshot).mockResolvedValue(
      built({ snapshot: { ...baseSnap, allPhaseIds: [], phases: [] } }),
    );

    const res = await runImpactReview("e1");

    expect(res.status).toBe("started");
    const sent = requestOf().scenes[0].codex_payload_json;
    expect(sent).not.toContain(OLD_SECRET);
    expect(JSON.parse(sent).changes).toHaveLength(1);
  });

  it("書き込み API が『公開中に削除した』と証明した Phase だけは、old → 空の差分に出る", async () => {
    vi.mocked(getBaseline).mockResolvedValue(
      baselineWithDeletedPhase({ visibleDeletedPhaseIds: ["p1"] }),
    );
    vi.mocked(buildCodexSnapshot).mockResolvedValue(
      built({ snapshot: { ...baseSnap, allPhaseIds: [], phases: [] } }),
    );

    const res = await runImpactReview("e1");

    expect(res.status).toBe("started");
    const changes = JSON.parse(
      requestOf().scenes[0].codex_payload_json,
    ).changes;
    expect(changes).toContainEqual({
      field: "phase_summary",
      name: null,
      phase: "旧 Phase",
      old: OLD_SECRET,
      new: "",
    });
  });
});

describe("dispatch 直前の再検査", () => {
  it.each([
    ["作者が dispatch 直前に base を hidden にした", { contextMode: "hidden" }],
    [
      "作者が dispatch 直前に base を suppress にした",
      { contextMode: "suppress" },
    ],
    [
      "dispatch 直前に Phase の制限が立った",
      { hasRestrictedPhases: true, snapshot: snapWithPhase(true) },
    ],
  ] as const)(
    "%s → source-changed（run は始めず、baseline も進めない）",
    async (_label, changed) => {
      vi.mocked(getBaseline).mockResolvedValue(baselineAge12);
      vi.mocked(buildCodexSnapshot)
        .mockResolvedValueOnce(built())
        .mockResolvedValueOnce(built({ ...changed }));
      const dispatch = vi.fn();
      vi.mocked(runPostEffectMulti).mockImplementation(
        async (_req, callbacks) => {
          await callbacks.beforeStart?.();
          dispatch();
          return { runId: "r1", cleanup: () => {} };
        },
      );

      const res = await runImpactReview("e1");

      // 注：source の指紋が contextMode・hasRestrictedPhases を含むので、
      // `captureValidatedImpactInputs` の個別の 2 条件は指紋の後ろでは到達しない
      // （防御の二重化）。固定するのは結果（dispatch しない）だけ。
      expect(res.status).toBe("source-changed");
      expect(dispatch).not.toHaveBeenCalled();
      expect(saveBaseline).not.toHaveBeenCalled();
    },
  );
});

describe("baseline の前進", () => {
  async function startAndCaptureOnDone(): Promise<
    (e: {
      run_id: string;
      annotation_count: number;
      summary?: string;
    }) => Promise<void>
  > {
    let captured: ((e: unknown) => void | Promise<void>) | undefined;
    vi.mocked(runPostEffectMulti).mockImplementation(async (_req, cbs) => {
      captured = cbs.onDone as typeof captured;
      return { runId: "r1", cleanup: () => {} };
    });
    const res = await runImpactReview("e1");
    expect(res.status).toBe("started");
    expect(saveBaseline).not.toHaveBeenCalled();
    return async (e) => {
      await captured?.(e);
    };
  }

  it("完了（summary なし）で、現在の snapshot へ前進する", async () => {
    vi.mocked(getBaseline).mockResolvedValue(baselineAge12);
    const done = await startAndCaptureOnDone();

    await done({ run_id: "r1", annotation_count: 1 });

    expect(saveBaseline).toHaveBeenCalledTimes(1);
    expect(saveBaseline).toHaveBeenCalledWith(
      "p1",
      "e1",
      baseSnap,
      undefined,
      sourceRevision,
    );
  });

  it("部分失敗（summary あり）では前進させない（失敗した場面を再チェックできるように据え置く）", async () => {
    vi.mocked(getBaseline).mockResolvedValue(baselineAge12);
    const done = await startAndCaptureOnDone();

    await done({ run_id: "r1", annotation_count: 1, summary: "1 件失敗" });

    expect(saveBaseline).not.toHaveBeenCalled();
  });
});

describe("差分が 0 件のときの掃除（tombstone の解除）", () => {
  const tombstoned: CodexSnapshot = {
    ...baseSnap,
    allPhaseIds: ["p1"],
    restrictedPhaseIds: ["p1"],
  };

  it("制限が解け（Phase は削除済み）、base が公開なら、現在の snapshot へ前進する", async () => {
    vi.mocked(getBaseline).mockResolvedValue(tombstoned);
    vi.mocked(buildCodexSnapshot).mockResolvedValue(
      built({ snapshot: { ...baseSnap, allPhaseIds: [], phases: [] } }),
    );

    const res = await runImpactReview("e1");

    expect(res.status).toBe("no-change");
    expectNothingSentToAi();
    expect(saveBaseline).toHaveBeenCalledTimes(1);
    expect(saveBaseline).toHaveBeenCalledWith(
      "p1",
      "e1",
      { ...baseSnap, allPhaseIds: [], phases: [] },
      undefined,
      undefined,
    );
  });

  it("現在も制限があるなら前進しない", async () => {
    vi.mocked(getBaseline).mockResolvedValue(tombstoned);
    vi.mocked(buildCodexSnapshot).mockResolvedValue(
      built({
        snapshot: {
          ...baseSnap,
          allPhaseIds: ["p1"],
          restrictedPhaseIds: ["p1"],
          phases: [],
        },
        hasRestrictedPhases: true,
      }),
    );

    const res = await runImpactReview("e1");

    expect(res.status).toBe("no-change");
    expect(saveBaseline).not.toHaveBeenCalled();
  });

  it("base が hidden のときも前進しない", async () => {
    vi.mocked(getBaseline).mockResolvedValue(tombstoned);
    vi.mocked(buildCodexSnapshot).mockResolvedValue(
      built({
        snapshot: { ...baseSnap, allPhaseIds: [], phases: [] },
        contextMode: "hidden",
      }),
    );

    const res = await runImpactReview("e1");

    expect(res.status).toBe("no-change");
    expect(saveBaseline).not.toHaveBeenCalled();
  });
});

describe("影響確認が止める集合と DR-MP4-41 の hidden の集合の関係", () => {
  // 影響確認の門は `current-mention` で判定するので、hidden（explicit-pin でも
  // 出ない）に加えて suppress も止める。包含は同じ matrix から導かれる定義上の
  // 恒真だが、suppress だけが差になる、という具体を表で固定する。
  it.each([
    ["hidden", true, true],
    ["suppress", false, true],
    ["mentioned", false, false],
    ["always", false, false],
    ["unknown-mode", true, true],
    ["", true, true],
  ] as const)(
    "mode=%j：hidden=%s、影響確認が止める=%s",
    (mode, hidden, blockedByGate) => {
      expect(isCodexContextModeHiddenFromAi(mode)).toBe(hidden);
      expect(!canIncludeResolvedCodexContext(mode, "current-mention")).toBe(
        blockedByGate,
      );
      if (hidden) expect(blockedByGate).toBe(true);
    },
  );
});

describe("contextMode の欠落を公開として補わない（型を必須にした後の runtime。DR-MP4-44）", () => {
  // CodexSnapshotResult.contextMode は必須。producer（buildCodexSnapshot）は常に値を返すので
  // 実害は無いが、将来の producer が省いたときに「公開」へ倒れない（今までの
  // `?? "mentioned"` は fail-open だった）ことを固定する。型の検査は tsc の担当
  // （この試験は runtime の形だけ）。hasRestrictedPhases の欠落は runtime では補わず、
  // 型だけで止める（runtime の挙動は変えない。DR に記録）。
  it("contextMode が欠けた source は、差分があっても AI にも候補絞りにも出さず no-candidates で止まる", async () => {
    vi.mocked(getBaseline).mockResolvedValue(baselineAge12);
    const source = built();
    Reflect.deleteProperty(source, "contextMode");
    vi.mocked(buildCodexSnapshot).mockResolvedValue(source);

    const res = await runImpactReview("e1");

    expect(res.status).toBe("no-candidates");
    expect(res.changeCount).toBe(1);
    expectNothingSentToAi();
    expect(saveBaseline).not.toHaveBeenCalled();
  });
});

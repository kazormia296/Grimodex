import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CodexSnapshot } from "./diff";

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
  prosemirrorToText: (value: string) =>
    value === "__changed__" ? "changed scene body" : "scene body text",
}));
const dbWhere = vi.fn(() =>
  Promise.resolve([
    { id: "s2", content: "{}" },
    { id: "s1", content: "{}" },
  ]),
);
const dbSelect = vi.fn(() => ({
  from: () => ({
    where: dbWhere,
  }),
}));
vi.mock("@/db/client", () => ({
  db: {
    select: (...args: unknown[]) => dbSelect(...(args as [])),
  },
}));

import { runImpactReview } from "./runImpactReview";
import { buildCodexSnapshot } from "./snapshot";
import { getBaseline, saveBaseline } from "./baseline";
import { narrowCandidateScenes } from "./narrowing";
import { runPostEffectMulti } from "@/features/post-effect/api";

const snap: CodexSnapshot = {
  name: "アリス",
  aliases: ["アリー"],
  summary: "15歳。",
  contentPlain: "町に住む。",
  details: [{ name: "年齢", value: "15" }],
};

const sourceRevision = {
  kind: "sqlite_revision_v1" as const,
  expected_connection_epoch: "5c469be0-51e3-4f31-95e0-9bf457806c56",
  expected_total_changes: "10",
  expected_data_version: "3",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(buildCodexSnapshot).mockResolvedValue({
    snapshot: snap,
    projectId: "p1",
    entryType: "character",
    entryName: "アリス",
    sourceRevision,
  });
});

describe("runImpactReview", () => {
  it("returns no-change and does NOT run when baseline equals current", async () => {
    vi.mocked(getBaseline).mockResolvedValue({ ...snap });
    const res = await runImpactReview("e1");
    expect(res.status).toBe("no-change");
    expect(res.changeCount).toBe(0);
    expect(runPostEffectMulti).not.toHaveBeenCalled();
    expect(saveBaseline).not.toHaveBeenCalled();
  });

  it("returns no-candidates and advances baseline when diff exists but no scenes match", async () => {
    vi.mocked(getBaseline).mockResolvedValue({
      ...snap,
      details: [{ name: "年齢", value: "12" }],
    });
    vi.mocked(narrowCandidateScenes).mockResolvedValue([]);
    const res = await runImpactReview("e1");
    expect(res.status).toBe("no-candidates");
    expect(res.changeCount).toBeGreaterThan(0);
    expect(runPostEffectMulti).not.toHaveBeenCalled();
    expect(saveBaseline).toHaveBeenCalledWith(
      "p1",
      "e1",
      snap,
      undefined,
      sourceRevision,
    );
  });

  it("passes the changed entry id so narrowing can load semantic-linked scenes", async () => {
    vi.mocked(getBaseline).mockResolvedValue({
      ...snap,
      details: [{ name: "年齢", value: "12" }],
    });
    vi.mocked(narrowCandidateScenes).mockResolvedValue([]);

    await runImpactReview("e1");

    expect(narrowCandidateScenes).toHaveBeenCalledWith(
      "p1",
      "e1",
      expect.any(String),
      ["アリス", "アリー"],
      { limit: 30 },
    );
  });

  it("starts a run with impact_review payload when candidates exist", async () => {
    vi.mocked(getBaseline).mockResolvedValue({
      ...snap,
      details: [{ name: "年齢", value: "12" }],
    });
    vi.mocked(narrowCandidateScenes).mockResolvedValue([
      { sceneId: "s1", score: 1, matchedBy: ["dense"] },
      { sceneId: "s2", score: 0.5, matchedBy: ["sparse"] },
    ]);
    vi.mocked(runPostEffectMulti).mockResolvedValue({
      runId: "r1",
      cleanup: () => {},
    });

    const res = await runImpactReview("e1");
    expect(res.status).toBe("started");
    expect(res.candidateSceneCount).toBe(2);
    expect(res.runId).toBe("r1");

    const [req] = vi.mocked(runPostEffectMulti).mock.calls[0];
    expect(req.effect_type).toBe("impact_review");
    expect(req.prompt_version).toBe("impact_review_v1.1");
    expect(req.source_guard).toEqual(sourceRevision);
    expect(req.scenes).toHaveLength(2);
    const payload = JSON.parse(req.scenes[0].codex_payload_json);
    expect(payload.entry_id).toBe("e1");
    expect(payload.entry_name).toBe("アリス");
    expect(payload.change_id).toBeTruthy();
    expect(
      payload.changes.some((c: { name: string }) => c.name === "年齢"),
    ).toBe(true);
    // baseline only advances AFTER the run completes (onDone)
    expect(saveBaseline).not.toHaveBeenCalled();
  });

  it("fetches scene texts in a single batched query, preserving candidate order", async () => {
    vi.mocked(getBaseline).mockResolvedValue({
      ...snap,
      details: [{ name: "年齢", value: "12" }],
    });
    vi.mocked(narrowCandidateScenes).mockResolvedValue([
      { sceneId: "s1", score: 1, matchedBy: ["dense"] },
      { sceneId: "s2", score: 0.5, matchedBy: ["sparse"] },
    ]);
    vi.mocked(runPostEffectMulti).mockResolvedValue({
      runId: "r1",
      cleanup: () => {},
    });

    await runImpactReview("e1");
    expect(dbSelect).toHaveBeenCalledTimes(1); // per-candidate ではなく一括 SELECT
    const [req] = vi.mocked(runPostEffectMulti).mock.calls[0];
    // DB が s2, s1 の順で返しても candidates の順序を維持する
    expect(req.scenes.map((s) => s.scene_id)).toEqual(["s1", "s2"]);
  });

  it("advances the baseline when the run completes (onDone wrapper)", async () => {
    vi.mocked(getBaseline).mockResolvedValue({
      ...snap,
      details: [{ name: "年齢", value: "12" }],
    });
    vi.mocked(narrowCandidateScenes).mockResolvedValue([
      { sceneId: "s1", score: 1, matchedBy: ["dense"] },
    ]);
    let captured: ((e: unknown) => void | Promise<void>) | undefined;
    vi.mocked(runPostEffectMulti).mockImplementation(async (_req, cbs) => {
      captured = cbs.onDone as typeof captured;
      return { runId: "r1", cleanup: () => {} };
    });
    const onDone = vi.fn();

    await runImpactReview("e1", { onDone });
    expect(saveBaseline).not.toHaveBeenCalled();
    await captured?.({ run_id: "r1", annotation_count: 3 });
    expect(saveBaseline).toHaveBeenCalledWith(
      "p1",
      "e1",
      snap,
      undefined,
      sourceRevision,
    );
    expect(onDone).toHaveBeenCalled(); // user callback still fires
  });

  it("aborts before dispatch when beforeStart observes a changed final snapshot", async () => {
    const initial = {
      snapshot: snap,
      projectId: "p1",
      entryType: "character",
      entryName: "アリス",
      sourceRevision,
    };
    const changed = {
      ...initial,
      snapshot: { ...snap, summary: "16歳。" },
    };
    vi.mocked(buildCodexSnapshot)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(changed);
    vi.mocked(getBaseline).mockResolvedValue({
      ...snap,
      details: [{ name: "年齢", value: "12" }],
    });
    vi.mocked(narrowCandidateScenes).mockResolvedValue([
      { sceneId: "s1", score: 1, matchedBy: ["dense"] },
    ]);
    const dispatch = vi.fn(async () => ({
      run_id: "r1",
      from_cache: false,
    }));
    vi.mocked(runPostEffectMulti).mockImplementation(
      async (_req, callbacks) => {
        await callbacks.beforeStart?.();
        const result = await dispatch();
        return { runId: result.run_id, cleanup: () => {} };
      },
    );

    const result = await runImpactReview("e1");

    expect(result.status).toBe("source-changed");
    expect(result.candidateSceneCount).toBe(1);
    expect(buildCodexSnapshot).toHaveBeenCalledTimes(2);
    expect(dispatch).not.toHaveBeenCalled();
    expect(saveBaseline).not.toHaveBeenCalled();
  });

  it("rebases the guard after unrelated writes when the exact source payload is unchanged", async () => {
    const changedRevision = {
      ...sourceRevision,
      expected_total_changes: "11",
    };
    const initial = {
      snapshot: snap,
      projectId: "p1",
      entryType: "character",
      entryName: "アリス",
      sourceRevision,
    };
    vi.mocked(buildCodexSnapshot)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce({
        ...initial,
        sourceRevision: changedRevision,
      });
    vi.mocked(getBaseline).mockResolvedValue({
      ...snap,
      details: [{ name: "年齢", value: "12" }],
    });
    vi.mocked(narrowCandidateScenes).mockResolvedValue([
      { sceneId: "s1", score: 1, matchedBy: ["dense"] },
    ]);
    vi.mocked(runPostEffectMulti).mockImplementation(async (req, callbacks) => {
      await callbacks.beforeStart?.();
      expect(req.source_guard).toEqual(changedRevision);
      return { runId: "r1", cleanup: () => {} };
    });

    const result = await runImpactReview("e1");

    expect(result.status).toBe("started");
    expect(buildCodexSnapshot).toHaveBeenCalledTimes(2);
    expect(dbWhere).toHaveBeenCalledTimes(2);
  });

  it("aborts when candidate membership changes before the final source guard", async () => {
    vi.mocked(getBaseline).mockResolvedValue({
      ...snap,
      details: [{ name: "年齢", value: "12" }],
    });
    vi.mocked(narrowCandidateScenes)
      .mockResolvedValueOnce([
        { sceneId: "s1", score: 1, matchedBy: ["dense"] },
      ])
      .mockResolvedValueOnce([
        { sceneId: "s1", score: 1, matchedBy: ["dense"] },
        { sceneId: "s2", score: 1, matchedBy: ["semantic"] },
      ]);
    const dispatch = vi.fn();
    vi.mocked(runPostEffectMulti).mockImplementation(
      async (_req, callbacks) => {
        await callbacks.beforeStart?.();
        dispatch();
        return { runId: "r1", cleanup: () => {} };
      },
    );

    const result = await runImpactReview("e1");

    expect(result.status).toBe("source-changed");
    expect(dispatch).not.toHaveBeenCalled();
    expect(saveBaseline).not.toHaveBeenCalled();
  });

  it("aborts when another review advances the baseline before dispatch", async () => {
    const initialBaseline = {
      ...snap,
      details: [{ name: "年齢", value: "12" }],
    };
    vi.mocked(getBaseline)
      .mockResolvedValueOnce(initialBaseline)
      .mockResolvedValueOnce({
        ...initialBaseline,
        details: [{ name: "年齢", value: "13" }],
      });
    vi.mocked(narrowCandidateScenes).mockResolvedValue([
      { sceneId: "s1", score: 1, matchedBy: ["dense"] },
    ]);
    const dispatch = vi.fn();
    vi.mocked(runPostEffectMulti).mockImplementation(
      async (_req, callbacks) => {
        await callbacks.beforeStart?.();
        dispatch();
        return { runId: "r1", cleanup: () => {} };
      },
    );

    const result = await runImpactReview("e1");

    expect(result.status).toBe("source-changed");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects a changed baseline payload even when its stored hash is unchanged", async () => {
    const contentHashSymbol = Symbol.for(
      "grimodex.impactReviewBaseline.contentHash",
    );
    const initialBaseline = {
      ...snap,
      details: [{ name: "年齢", value: "12" }],
    };
    const changedBaseline = {
      ...initialBaseline,
      details: [{ name: "年齢", value: "13" }],
    };
    Object.defineProperty(initialBaseline, contentHashSymbol, {
      value: "deadbeef",
    });
    Object.defineProperty(changedBaseline, contentHashSymbol, {
      value: "deadbeef",
    });
    vi.mocked(getBaseline)
      .mockResolvedValueOnce(initialBaseline)
      .mockResolvedValueOnce(changedBaseline);
    vi.mocked(narrowCandidateScenes).mockResolvedValue([
      { sceneId: "s1", score: 1, matchedBy: ["dense"] },
    ]);
    const dispatch = vi.fn();
    vi.mocked(runPostEffectMulti).mockImplementation(
      async (_req, callbacks) => {
        await callbacks.beforeStart?.();
        dispatch();
        return { runId: "r1", cleanup: () => {} };
      },
    );

    const result = await runImpactReview("e1");

    expect(result.status).toBe("source-changed");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not advance a zero-candidate baseline when a semantic candidate appears", async () => {
    vi.mocked(getBaseline).mockResolvedValue({
      ...snap,
      details: [{ name: "年齢", value: "12" }],
    });
    vi.mocked(narrowCandidateScenes)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { sceneId: "s1", score: 1, matchedBy: ["semantic"] },
      ]);

    const result = await runImpactReview("e1");

    expect(result.status).toBe("source-changed");
    expect(saveBaseline).not.toHaveBeenCalled();
    expect(runPostEffectMulti).not.toHaveBeenCalled();
  });

  it("aborts when a selected scene changed before the final source guard", async () => {
    vi.mocked(getBaseline).mockResolvedValue({
      ...snap,
      details: [{ name: "年齢", value: "12" }],
    });
    vi.mocked(narrowCandidateScenes).mockResolvedValue([
      { sceneId: "s1", score: 1, matchedBy: ["dense"] },
    ]);
    dbWhere
      .mockResolvedValueOnce([{ id: "s1", content: "{}" }])
      .mockResolvedValueOnce([
        {
          id: "s1",
          content: "__changed__",
        },
      ]);
    const dispatch = vi.fn();
    vi.mocked(runPostEffectMulti).mockImplementation(
      async (_req, callbacks) => {
        await callbacks.beforeStart?.();
        dispatch();
        return { runId: "r1", cleanup: () => {} };
      },
    );

    const result = await runImpactReview("e1");

    expect(result.status).toBe("source-changed");
    expect(result.candidateSceneCount).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("maps an atomic backend source mismatch to retryable source-changed without advancing baseline", async () => {
    vi.mocked(getBaseline).mockResolvedValue({
      ...snap,
      details: [{ name: "年齢", value: "12" }],
    });
    vi.mocked(narrowCandidateScenes).mockResolvedValue([
      { sceneId: "s1", score: 1, matchedBy: ["dense"] },
    ]);
    vi.mocked(runPostEffectMulti).mockRejectedValue(
      new Error("IMPACT_SOURCE_CHANGED: sqlite revision mismatch"),
    );

    const result = await runImpactReview("e1");

    expect(result.status).toBe("source-changed");
    expect(result.candidateSceneCount).toBe(1);
    expect(saveBaseline).not.toHaveBeenCalled();
  });
});

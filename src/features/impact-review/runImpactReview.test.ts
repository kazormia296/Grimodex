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
  prosemirrorToText: () => "scene body text",
}));
vi.mock("@/db/client", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => Promise.resolve([{ content: "{}" }]) }),
    }),
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(buildCodexSnapshot).mockResolvedValue({
    snapshot: snap,
    projectId: "p1",
    entryType: "character",
    entryName: "アリス",
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
    expect(saveBaseline).toHaveBeenCalledWith("p1", "e1", snap);
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
    expect(saveBaseline).toHaveBeenCalledWith("p1", "e1", snap);
    expect(onDone).toHaveBeenCalled(); // user callback still fires
  });
});

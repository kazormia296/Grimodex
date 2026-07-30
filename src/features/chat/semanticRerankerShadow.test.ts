import { describe, expect, it, vi } from "vitest";

import type { SemanticSearchHit } from "../semantic-search/api";
import {
  buildSemanticRerankerShadowComparison,
  createSemanticRerankerShadowCoordinator,
  type SemanticRerankerScoreResult,
  type SemanticRerankerShadowInput,
  type SemanticRerankerShadowRecord,
} from "./semanticRerankerShadow";

function hit(
  sceneId: string,
  score: number,
  charStart: number,
): SemanticSearchHit {
  return {
    sceneId,
    sceneTitle: `Scene ${sceneId}`,
    chunkText: `chunk-${sceneId}-${charStart}`,
    charStart,
    charEnd: charStart + 10,
    score,
    dialogueRatio: 0,
  };
}

const a = hit("scene-a", 0.92, 0);
const b = hit("scene-b", 0.89, 10);
const c = hit("scene-c", 0.86, 20);

function scoreResult(
  order: readonly SemanticSearchHit[] = [b, a, c],
): SemanticRerankerScoreResult {
  return {
    schemaVersion: 1,
    language: "ja",
    modelId: "hotchpotch/japanese-reranker-xsmall-v2",
    modelRevision: "de99fd2f16c7b5df1df1bcc1d9ad2c16d88ce93a",
    manifestSha256:
      "8d4ad4f8d50496941fd5e6b4960df3dccdfc8aa1811c7cff68a5f470f9e1c24f",
    queryHash: "query-hash",
    candidateSetHash: "candidate-set-hash",
    latencyMs: 120,
    modelLoadMs: 0,
    modelWasCold: false,
    scores: order.map((candidate, index) => ({
      candidateId: `${candidate.sceneId}:${candidate.charStart}:${candidate.charEnd}`,
      candidateHash: `hash-${candidate.sceneId}-${candidate.charStart}`,
      score: 3 - index,
      tokenization: {
        queryTokensBefore: 420,
        queryTokensAfter: 210,
        candidateTokensBefore: 380,
        candidateTokensAfter: 299,
        queryTruncated: true,
        candidateTruncated: true,
        userMessageTokensKept: 80,
        sceneTailTokensKept: 129,
      },
    })),
  };
}

function input(
  overrides: Partial<SemanticRerankerShadowInput> = {},
): SemanticRerankerShadowInput {
  return {
    requestId: "request-1",
    scope: {
      workspaceKey: "workspace-1",
      workspaceOpenRevision: 7,
      projectId: "project-1",
    },
    language: "ja",
    query: {
      userMessage: "灯台の約束を思い出して",
      sceneTail: "海霧の向こうで鐘が鳴った。",
    },
    denseHits: [a, b, c],
    sparseSceneIds: ["scene-a", "scene-b"],
    excludeSceneIds: [],
    baselineInjectedHits: [a, b, c],
    hybrid: true,
    minScore: 0.8,
    gateScore: 0.85,
    rescueMargin: 0.05,
    maxChunks: 3,
    maxChunkChars: 600,
    retrievalStartedAtMs: 10,
    retrievalLatencyMs: 8,
    localInferenceExpected: false,
    ...overrides,
  };
}

describe("buildSemanticRerankerShadowComparison", () => {
  it("keeps admission fixed and distinguishes set changes from order-only changes", () => {
    const comparison = buildSemanticRerankerShadowComparison(
      input(),
      scoreResult(),
    );

    expect(comparison.baselineInjectedSceneIds).toEqual([
      "scene-a",
      "scene-b",
      "scene-c",
    ]);
    expect(comparison.counterfactualInjectedSceneIds).toEqual([
      "scene-b",
      "scene-a",
      "scene-c",
    ]);
    expect(comparison.injectedSetChanged).toBe(false);
    expect(comparison.injectedOrderChanged).toBe(true);
    expect(comparison.firstPresentedChanged).toBe(true);
    expect(comparison.ranking[0]).toMatchObject({
      candidateHash: "hash-scene-b-10",
      rerankedRank: 1,
      denseScore: 0.89,
    });
  });

  it("does not admit a reranker winner that fails the existing dense floor", () => {
    const belowFloor = hit("scene-low", 0.72, 30);
    const result = scoreResult([belowFloor, a, b, c]);
    const comparison = buildSemanticRerankerShadowComparison(
      input({
        denseHits: [a, b, c, belowFloor],
        baselineInjectedHits: [a, b, c],
      }),
      result,
    );

    expect(comparison.rerankedSceneOrder[0]).toBe("scene-low");
    expect(comparison.counterfactualInjectedSceneIds).toEqual([
      "scene-a",
      "scene-b",
      "scene-c",
    ]);
  });
});

describe("SemanticRerankerShadowCoordinator", () => {
  it("defers scoring so the current chat path never awaits the shadow job", async () => {
    const deferred: Array<() => void> = [];
    const score = vi.fn().mockResolvedValue(scoreResult());
    const record = vi.fn().mockResolvedValue(undefined);
    const coordinator = createSemanticRerankerShadowCoordinator({
      enabled: () => true,
      isReindexing: () => false,
      isScopeCurrent: () => true,
      score,
      record,
      now: () => 100,
      createRunId: () => "run-1",
      defer: (task) => deferred.push(task),
    });

    expect(coordinator.schedule(input())).toBeUndefined();
    expect(score).not.toHaveBeenCalled();

    deferred.shift()?.();
    await coordinator.whenIdleForTests();
    expect(score).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed", runId: "run-1" }),
    );
  });

  it("runs one job at a time, keeps only the latest pending query, and drops the superseded result", async () => {
    let finishFirst!: (value: SemanticRerankerScoreResult) => void;
    const first = new Promise<SemanticRerankerScoreResult>((resolve) => {
      finishFirst = resolve;
    });
    const score = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(scoreResult());
    const records: SemanticRerankerShadowRecord[] = [];
    const coordinator = createSemanticRerankerShadowCoordinator({
      enabled: () => true,
      isReindexing: () => false,
      isScopeCurrent: () => true,
      score,
      record: async (record) => {
        records.push(record);
      },
      now: () => 100,
      createRunId: vi
        .fn()
        .mockReturnValueOnce("run-1")
        .mockReturnValueOnce("run-2"),
      defer: (task) => task(),
    });

    coordinator.schedule(input({ requestId: "request-1" }));
    coordinator.schedule(input({ requestId: "request-2" }));
    coordinator.schedule(input({ requestId: "request-3" }));
    expect(score).toHaveBeenCalledTimes(1);

    finishFirst(scoreResult());
    await coordinator.whenIdleForTests();

    expect(score).toHaveBeenCalledTimes(2);
    expect(score.mock.calls[1][0]).toMatchObject({
      requestId: "request-3",
    });
    expect(
      records.map((record) => [record.status, record.staleReason]),
    ).toEqual([
      ["stale", "superseded"],
      ["completed", undefined],
    ]);
  });

  it("suppresses scoring during reindex and records only metadata", async () => {
    const score = vi.fn();
    const record = vi.fn().mockResolvedValue(undefined);
    const coordinator = createSemanticRerankerShadowCoordinator({
      enabled: () => true,
      isReindexing: () => true,
      isScopeCurrent: () => true,
      score,
      record,
      now: () => 100,
      createRunId: () => "run-1",
      defer: (task) => task(),
    });

    coordinator.schedule(input());
    await coordinator.whenIdleForTests();

    expect(score).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "suppressed",
        staleReason: "reindex-running",
      }),
    );
  });

  it("never records a comparison after the workspace authority changes", async () => {
    const score = vi.fn().mockResolvedValue(scoreResult());
    const record = vi.fn().mockResolvedValue(undefined);
    const coordinator = createSemanticRerankerShadowCoordinator({
      enabled: () => true,
      isReindexing: () => false,
      isScopeCurrent: () => false,
      score,
      record,
      now: () => 100,
      createRunId: () => "run-1",
      defer: (task) => task(),
    });

    coordinator.schedule(input());
    await coordinator.whenIdleForTests();

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "stale",
        staleReason: "workspace-scope-changed",
        comparison: undefined,
      }),
    );
  });
});

import { describe, expect, it, vi } from "vitest";

import { IpcInvokeError } from "@/lib/tauri";
import type { SemanticSearchHit } from "../semantic-search/api";
import {
  createSemanticRerankerApplyCoordinator,
  SEMANTIC_RERANKER_CALLER_WAIT_TIMEOUT_MS,
} from "./semanticRerankerApply";
import type {
  SemanticRerankerScoreResult,
  SemanticRerankerShadowInput,
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
        queryTokensBefore: 20,
        queryTokensAfter: 20,
        candidateTokensBefore: 40,
        candidateTokensAfter: 40,
        queryTruncated: false,
        candidateTruncated: false,
        userMessageTokensKept: 12,
        sceneTailTokensKept: 7,
      },
    })),
  };
}

function input(
  overrides: Partial<SemanticRerankerShadowInput> = {},
): SemanticRerankerShadowInput {
  return {
    requestId: "request-1",
    sessionId: "session-1",
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
    sparseSceneIds: ["scene-a", "scene-b", "scene-c"],
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

function coordinator(
  overrides: Partial<{
    score: (
      request: Record<string, unknown>,
    ) => Promise<SemanticRerankerScoreResult>;
    isReindexing: () => boolean;
    isScopeCurrent: (scope: SemanticRerankerShadowInput["scope"]) => boolean;
    timeoutMs: number;
  }> = {},
) {
  return createSemanticRerankerApplyCoordinator({
    score: overrides.score ?? vi.fn().mockResolvedValue(scoreResult()),
    isReindexing: overrides.isReindexing ?? (() => false),
    isScopeCurrent: overrides.isScopeCurrent ?? (() => true),
    timeoutMs: overrides.timeoutMs,
  });
}

describe("SemanticRerankerApplyCoordinator", () => {
  it("uses the fixed 2.5 second caller-wait timeout", () => {
    expect(SEMANTIC_RERANKER_CALLER_WAIT_TIMEOUT_MS).toBe(2_500);
  });

  it("applies reranker order only after production admission", async () => {
    const low = hit("scene-low", 0.7, 30);
    const score = vi.fn().mockResolvedValue(scoreResult([low, b, a, c]));
    const result = await coordinator({ score }).apply(
      input({
        denseHits: [a, b, c, low],
        baselineInjectedHits: [a, b, c],
      }),
    );

    expect(result.status).toBe("applied");
    expect(result.hits.map((candidate) => candidate.sceneId)).toEqual([
      "scene-b",
      "scene-a",
      "scene-c",
    ]);
    expect(result.hits).not.toContainEqual(
      expect.objectContaining({ sceneId: "scene-low" }),
    );
    expect(score).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "request-1",
        candidates: expect.arrayContaining([
          expect.objectContaining({ candidateId: "scene-low:30:40" }),
        ]),
      }),
    );
  });

  it("returns the exact baseline on inference failure", async () => {
    const baseline = [a, b, c];
    const result = await coordinator({
      score: vi.fn().mockRejectedValue(new Error("model missing")),
    }).apply(input({ baselineInjectedHits: baseline }));

    expect(result).toEqual({
      status: "fallback",
      reason: "score-failed",
      hits: baseline,
    });
  });

  it("classifies native lane contention as busy without opening the session circuit", async () => {
    const score = vi
      .fn()
      .mockRejectedValueOnce(
        new IpcInvokeError("semantic_reranker_shadow_score", {
          code: "RERANKER_BUSY",
          message: "RERANKER_BUSY: semantic reranker lane is occupied",
          retryable: true,
          outcome: "failed",
        }),
      )
      .mockResolvedValue(scoreResult());
    const apply = coordinator({ score });

    await expect(apply.apply(input())).resolves.toEqual({
      status: "fallback",
      reason: "busy",
      hits: [a, b, c],
    });
    await expect(
      apply.apply(input({ requestId: "request-after-busy" })),
    ).resolves.toMatchObject({ status: "applied" });
    expect(score).toHaveBeenCalledTimes(2);
  });

  it("opens a session circuit after caller timeout while native scoring settles", async () => {
    vi.useFakeTimers();
    try {
      let resolveFirst!: (value: SemanticRerankerScoreResult) => void;
      const first = new Promise<SemanticRerankerScoreResult>((resolve) => {
        resolveFirst = resolve;
      });
      const score = vi
        .fn()
        .mockReturnValueOnce(first)
        .mockResolvedValue(scoreResult());
      const apply = coordinator({ score });

      const firstRun = apply.apply(
        input({
          requestId: "request-1",
          localInferenceExpected: true,
        }),
      );
      await vi.advanceTimersByTimeAsync(
        SEMANTIC_RERANKER_CALLER_WAIT_TIMEOUT_MS,
      );
      await expect(firstRun).resolves.toEqual({
        status: "fallback",
        reason: "timeout",
        hits: [a, b, c],
        timedOutButStillRunning: true,
      });

      await expect(
        apply.apply(
          input({
            requestId: "request-2",
            localInferenceExpected: true,
          }),
        ),
      ).resolves.toEqual({
        status: "fallback",
        reason: "circuit-open",
        hits: [a, b, c],
        circuitBreakerOpen: true,
      });
      expect(score).toHaveBeenCalledTimes(1);

      resolveFirst(scoreResult());
      await vi.runAllTimersAsync();
      await Promise.resolve();

      await expect(
        apply.apply(
          input({
            requestId: "request-3",
            localInferenceExpected: true,
          }),
        ),
      ).resolves.toEqual({
        status: "fallback",
        reason: "circuit-open",
        hits: [a, b, c],
        circuitBreakerOpen: true,
      });
      expect(score).toHaveBeenCalledTimes(1);

      await expect(
        apply.apply(
          input({
            requestId: "request-new-session",
            sessionId: "session-2",
          }),
        ),
      ).resolves.toMatchObject({ status: "applied" });
      expect(score).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards a completed score after workspace authority changes", async () => {
    const isScopeCurrent = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const result = await coordinator({ isScopeCurrent }).apply(input());

    expect(result).toEqual({
      status: "fallback",
      reason: "scope-stale",
      hits: [a, b, c],
    });
  });

  it("discards a completed score when a newer query generation supersedes it", async () => {
    let resolveFirst!: (value: SemanticRerankerScoreResult) => void;
    const first = new Promise<SemanticRerankerScoreResult>((resolve) => {
      resolveFirst = resolve;
    });
    const apply = coordinator({
      score: vi.fn().mockReturnValue(first),
      timeoutMs: 10_000,
    });

    const firstRun = apply.apply(input({ requestId: "request-1" }));
    await expect(
      apply.apply(input({ requestId: "request-2" })),
    ).resolves.toMatchObject({
      status: "fallback",
      reason: "busy",
    });
    resolveFirst(scoreResult());

    await expect(firstRun).resolves.toEqual({
      status: "fallback",
      reason: "superseded",
      hits: [a, b, c],
    });
  });

  it("does not start or apply scoring while semantic reindexing is active", async () => {
    const score = vi.fn().mockResolvedValue(scoreResult());
    const result = await coordinator({
      score,
      isReindexing: () => true,
    }).apply(input());

    expect(score).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "fallback",
      reason: "reindexing",
      hits: [a, b, c],
    });
  });
});

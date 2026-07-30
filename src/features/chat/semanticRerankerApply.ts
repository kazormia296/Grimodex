import { useReindexProgressStore } from "@/features/semantic-search/reindexProgressStore";
import type { SemanticSearchHit } from "@/features/semantic-search/api";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { invoke } from "@/lib/tauri";
import { isCurrentRuntimeProjectId } from "@/runtime/projectIdentity";
import { isCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import {
  buildSemanticRerankerAppliedHits,
  semanticRerankerCandidateId,
  snapshotSemanticRerankerInput,
  type SemanticRerankerScoreRequest,
  type SemanticRerankerScoreResult,
  type SemanticRerankerShadowInput,
  type SemanticRerankerShadowScope,
} from "./semanticRerankerShadow";

export const SEMANTIC_RERANKER_APPLY_TIMEOUT_MS = 2_500;

export type SemanticRerankerFallbackReason =
  | "busy"
  | "empty-candidate-set"
  | "reindexing"
  | "scope-stale"
  | "score-failed"
  | "superseded"
  | "timeout";

export type SemanticRerankerApplyResult =
  | { status: "applied"; hits: SemanticSearchHit[] }
  | {
      status: "fallback";
      reason: SemanticRerankerFallbackReason;
      hits: SemanticSearchHit[];
    };

export interface SemanticRerankerApplyCoordinatorDeps {
  isReindexing: () => boolean;
  isScopeCurrent: (scope: SemanticRerankerShadowScope) => boolean;
  score: (
    request: SemanticRerankerScoreRequest,
  ) => Promise<SemanticRerankerScoreResult>;
  timeoutMs?: number;
}

const TIMEOUT = Symbol("semantic-reranker-timeout");

class SemanticRerankerApplyCoordinator {
  private generation = 0;
  private activeToken: symbol | null = null;

  constructor(private readonly deps: SemanticRerankerApplyCoordinatorDeps) {}

  async apply(
    input: SemanticRerankerShadowInput,
  ): Promise<SemanticRerankerApplyResult> {
    const generation = ++this.generation;
    const baseline = input.baselineInjectedHits;
    const fallback = (
      reason: SemanticRerankerFallbackReason,
    ): SemanticRerankerApplyResult => ({
      status: "fallback",
      reason,
      hits: baseline,
    });

    if (this.deps.isReindexing()) return fallback("reindexing");
    if (!this.deps.isScopeCurrent(input.scope)) return fallback("scope-stale");
    if (this.activeToken) return fallback("busy");

    const snapshot = snapshotSemanticRerankerInput(input);
    const excluded = new Set(snapshot.excludeSceneIds);
    const candidates = snapshot.denseHits
      .filter((hit) => !excluded.has(hit.sceneId))
      .slice(0, 30)
      .map((hit) => ({
        candidateId: semanticRerankerCandidateId(hit),
        text: hit.chunkText,
      }));
    if (candidates.length === 0) return fallback("empty-candidate-set");

    const token = Symbol("semantic-reranker-apply");
    this.activeToken = token;
    const scorePromise = Promise.resolve().then(() =>
      this.deps.score({
        requestId: snapshot.requestId,
        language: snapshot.language,
        userMessage: snapshot.query.userMessage,
        sceneTail: snapshot.query.sceneTail,
        candidates,
      }),
    );
    void scorePromise.then(
      () => this.release(token),
      () => this.release(token),
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutMs = this.deps.timeoutMs ?? SEMANTIC_RERANKER_APPLY_TIMEOUT_MS;
    const timeoutPromise = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
    });

    let result: SemanticRerankerScoreResult | typeof TIMEOUT;
    try {
      result = await Promise.race([scorePromise, timeoutPromise]);
    } catch (error) {
      if (generation !== this.generation) return fallback("superseded");
      debugLog.warn(
        "SemanticRerankerApply",
        "scoring failed; keeping baseline order",
        errorDetail(error),
      );
      return fallback("score-failed");
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (result === TIMEOUT) {
      debugLog.warn(
        "SemanticRerankerApply",
        `hard timeout after ${timeoutMs}ms; keeping baseline order`,
      );
      return fallback("timeout");
    }
    if (generation !== this.generation) return fallback("superseded");
    if (this.deps.isReindexing()) return fallback("reindexing");
    if (!this.deps.isScopeCurrent(snapshot.scope)) {
      return fallback("scope-stale");
    }

    try {
      return {
        status: "applied",
        hits: buildSemanticRerankerAppliedHits(snapshot, result),
      };
    } catch (error) {
      debugLog.warn(
        "SemanticRerankerApply",
        "invalid score result; keeping baseline order",
        errorDetail(error),
      );
      return fallback("score-failed");
    }
  }

  private release(token: symbol): void {
    if (this.activeToken === token) this.activeToken = null;
  }
}

export function createSemanticRerankerApplyCoordinator(
  deps: SemanticRerankerApplyCoordinatorDeps,
): SemanticRerankerApplyCoordinator {
  return new SemanticRerankerApplyCoordinator(deps);
}

function currentScopeMatches(scope: SemanticRerankerShadowScope): boolean {
  return (
    isCurrentWorkspaceIdentity({
      path: scope.workspaceKey,
      openRevision: scope.workspaceOpenRevision,
    }) && isCurrentRuntimeProjectId(scope.projectId)
  );
}

const productionCoordinator = createSemanticRerankerApplyCoordinator({
  isReindexing: () => useReindexProgressStore.getState().running,
  isScopeCurrent: currentScopeMatches,
  score: (request) =>
    invoke<SemanticRerankerScoreResult>(
      "semantic_reranker_shadow_score",
      request,
    ),
});

export function applySemanticReranker(
  input: SemanticRerankerShadowInput,
): Promise<SemanticRerankerApplyResult> {
  return productionCoordinator.apply(input);
}

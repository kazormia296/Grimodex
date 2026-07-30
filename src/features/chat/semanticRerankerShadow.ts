import { useReindexProgressStore } from "@/features/semantic-search/reindexProgressStore";
import type { SemanticSearchHit } from "@/features/semantic-search/api";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { invoke } from "@/lib/tauri";
import { isCurrentRuntimeProjectId } from "@/runtime/projectIdentity";
import { isCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";

export type SemanticRerankerShadowLanguage = "ja" | "en";

export interface SemanticRerankerShadowScope {
  workspaceKey: string;
  workspaceOpenRevision: number;
  projectId: string;
}

export interface SemanticRerankerTokenizationStats {
  queryTokensBefore: number;
  queryTokensAfter: number;
  candidateTokensBefore: number;
  candidateTokensAfter: number;
  queryTruncated: boolean;
  candidateTruncated: boolean;
  userMessageTokensKept: number;
  sceneTailTokensKept: number;
}

export interface SemanticRerankerCandidateScore {
  candidateId: string;
  candidateHash: string;
  score: number;
  tokenization: SemanticRerankerTokenizationStats;
}

export interface SemanticRerankerScoreResult {
  schemaVersion: 1;
  language: SemanticRerankerShadowLanguage;
  modelId: string;
  modelRevision: string;
  manifestSha256: string;
  queryHash: string;
  candidateSetHash: string;
  latencyMs: number;
  modelLoadMs: number;
  modelWasCold: boolean;
  scores: SemanticRerankerCandidateScore[];
}

export interface SemanticRerankerShadowInput {
  requestId: string;
  scope: SemanticRerankerShadowScope;
  language: SemanticRerankerShadowLanguage;
  query: {
    userMessage: string;
    sceneTail: string;
  };
  denseHits: SemanticSearchHit[];
  sparseSceneIds: string[];
  excludeSceneIds: string[];
  baselineInjectedHits: SemanticSearchHit[];
  hybrid: boolean;
  minScore: number;
  gateScore: number;
  rescueMargin: number;
  maxChunks: number;
  maxChunkChars: number;
  rrfK?: number;
  retrievalStartedAtMs: number;
  retrievalLatencyMs: number;
  localInferenceExpected: boolean;
  /** Optional local-only labels used by fixture/private replay harnesses. */
  expectedSceneIds?: string[];
}

export interface SemanticRerankerShadowRanking {
  candidateHash: string;
  sceneId: string;
  currentRank: number;
  rerankedRank: number;
  denseScore: number;
  rerankerScore: number;
  tokenization: SemanticRerankerTokenizationStats;
}

export interface SemanticRerankerShadowComparison {
  baselineSceneOrder: string[];
  rerankedSceneOrder: string[];
  baselineInjectedSceneIds: string[];
  counterfactualInjectedSceneIds: string[];
  baselineInjectedCandidateHashes: string[];
  counterfactualInjectedCandidateHashes: string[];
  injectedSetChanged: boolean;
  injectedOrderChanged: boolean;
  firstPresentedChanged: boolean;
  goldCandidatePresent: boolean | null;
  baselineGoldPosition: number | null;
  counterfactualGoldPosition: number | null;
  baselineGoldInjectionMrr: number | null;
  counterfactualGoldInjectionMrr: number | null;
  isNoMatch: boolean | null;
  failureLayer?: "candidate-generation" | "ranking" | "admission" | "none";
  ranking: SemanticRerankerShadowRanking[];
}

export interface SemanticRerankerShadowRecord {
  schemaVersion: 1;
  status: "completed" | "stale" | "suppressed" | "failed";
  runId: string;
  generation: number;
  requestId: string;
  workspaceKey: string;
  workspaceOpenRevision: number;
  projectId: string;
  language: SemanticRerankerShadowLanguage;
  localInferenceExpected: boolean;
  staleReason?:
    | "superseded"
    | "workspace-scope-changed"
    | "reindex-running"
    | "reindex-started"
    | "empty-candidate-set";
  errorCode?: string;
  queryHash?: string;
  candidateSetHash?: string;
  modelId?: string;
  modelRevision?: string;
  manifestSha256?: string;
  candidateCount?: number;
  retrievalLatencyMs?: number;
  queueLatencyMs?: number;
  ipcRoundTripMs?: number;
  nativeLatencyMs?: number;
  endToEndLatencyMs?: number;
  modelLoadMs?: number;
  modelWasCold?: boolean;
  comparison?: SemanticRerankerShadowComparison;
}

interface ScoreRequest extends Record<string, unknown> {
  requestId: string;
  language: SemanticRerankerShadowLanguage;
  userMessage: string;
  sceneTail: string;
  candidates: Array<{ candidateId: string; text: string }>;
}

export interface SemanticRerankerShadowCoordinatorDeps {
  enabled: () => boolean;
  isReindexing: () => boolean;
  isScopeCurrent: (scope: SemanticRerankerShadowScope) => boolean;
  score: (request: ScoreRequest) => Promise<SemanticRerankerScoreResult>;
  record: (record: SemanticRerankerShadowRecord) => Promise<void>;
  now: () => number;
  createRunId: () => string;
  defer: (task: () => void) => void;
}

interface QueuedJob {
  generation: number;
  queuedAtMs: number;
  input: SemanticRerankerShadowInput;
}

function snapshotShadowInput(
  input: SemanticRerankerShadowInput,
): SemanticRerankerShadowInput {
  const copyHit = (hit: SemanticSearchHit): SemanticSearchHit => ({ ...hit });
  const denseHits = input.denseHits.slice(0, 30).map(copyHit);
  const frozenCandidateIds = new Set(
    denseHits.map(semanticRerankerCandidateId),
  );
  return {
    ...input,
    scope: { ...input.scope },
    query: { ...input.query },
    denseHits,
    sparseSceneIds: [...input.sparseSceneIds],
    excludeSceneIds: [...input.excludeSceneIds],
    baselineInjectedHits: input.baselineInjectedHits
      .filter((hit) => frozenCandidateIds.has(semanticRerankerCandidateId(hit)))
      .map(copyHit),
    ...(input.expectedSceneIds
      ? { expectedSceneIds: [...input.expectedSceneIds] }
      : {}),
  };
}

export function semanticRerankerCandidateId(hit: SemanticSearchHit): string {
  return `${hit.sceneId}:${hit.charStart}:${hit.charEnd}`;
}

function uniqueSceneOrder(hits: readonly SemanticSearchHit[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const hit of hits) {
    if (seen.has(hit.sceneId)) continue;
    seen.add(hit.sceneId);
    order.push(hit.sceneId);
  }
  return order;
}

function sameOrderedValues(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameValueSet(left: readonly string[], right: readonly string[]) {
  return sameOrderedValues([...left].sort(), [...right].sort());
}

function currentCandidateRanking(
  input: SemanticRerankerShadowInput,
): SemanticSearchHit[] {
  const excluded = new Set(input.excludeSceneIds);
  const hits = input.denseHits
    .filter((hit) => !excluded.has(hit.sceneId))
    .sort((left, right) => right.score - left.score);
  if (!input.hybrid || input.sparseSceneIds.length === 0) {
    return hits;
  }

  const sparseRank = new Map<string, number>();
  for (const sceneId of input.sparseSceneIds) {
    if (!excluded.has(sceneId) && !sparseRank.has(sceneId)) {
      sparseRank.set(sceneId, sparseRank.size);
    }
  }

  // Match the production hybrid selector and the Gate 2 candidate freezer:
  // rank each scene's best dense chunk with RRF, then append remaining chunks
  // in dense order. Candidate-level RRF would incorrectly reward every chunk
  // from a sparse-matched scene and make the logged baseline non-authoritative.
  const bestByScene = new Map<string, SemanticSearchHit>();
  const leftovers: SemanticSearchHit[] = [];
  for (const hit of hits) {
    if (bestByScene.has(hit.sceneId)) leftovers.push(hit);
    else bestByScene.set(hit.sceneId, hit);
  }
  const denseScenes = [...bestByScene.values()];
  const denseRank = new Map(
    denseScenes.map((hit, index) => [hit.sceneId, index] as const),
  );
  const rrfK = input.rrfK ?? 60;
  const distinct = denseScenes.sort((left, right) => {
    const score = (hit: SemanticSearchHit) => {
      const dense = denseRank.get(hit.sceneId) ?? 0;
      const sparse = sparseRank.get(hit.sceneId);
      return (
        1 / (rrfK + dense) + (sparse === undefined ? 0 : 1 / (rrfK + sparse))
      );
    };
    return (
      score(right) - score(left) ||
      right.score - left.score ||
      left.sceneId.localeCompare(right.sceneId)
    );
  });
  return [...distinct, ...leftovers];
}

function rerankedCandidates(
  input: SemanticRerankerShadowInput,
  result: SemanticRerankerScoreResult,
): {
  ranking: SemanticSearchHit[];
  scoreByCandidateId: Map<string, SemanticRerankerCandidateScore>;
} {
  const excluded = new Set(input.excludeSceneIds);
  const hits = input.denseHits.filter((hit) => !excluded.has(hit.sceneId));
  const scoreByCandidateId = new Map(
    result.scores.map((score) => [score.candidateId, score] as const),
  );
  if (scoreByCandidateId.size !== result.scores.length) {
    throw new Error("semantic reranker returned duplicate candidate IDs");
  }
  for (const hit of hits) {
    if (!scoreByCandidateId.has(semanticRerankerCandidateId(hit))) {
      throw new Error("semantic reranker omitted a frozen candidate");
    }
  }
  const currentRank = new Map(
    currentCandidateRanking(input).map(
      (hit, index) => [semanticRerankerCandidateId(hit), index] as const,
    ),
  );
  const ranking = [...hits].sort((left, right) => {
    const leftId = semanticRerankerCandidateId(left);
    const rightId = semanticRerankerCandidateId(right);
    return (
      (scoreByCandidateId.get(rightId)?.score ?? Number.NEGATIVE_INFINITY) -
        (scoreByCandidateId.get(leftId)?.score ?? Number.NEGATIVE_INFINITY) ||
      (currentRank.get(leftId) ?? Number.MAX_SAFE_INTEGER) -
        (currentRank.get(rightId) ?? Number.MAX_SAFE_INTEGER) ||
      leftId.localeCompare(rightId)
    );
  });
  return { ranking, scoreByCandidateId };
}

function counterfactualInjection(
  input: SemanticRerankerShadowInput,
  ranking: readonly SemanticSearchHit[],
): SemanticSearchHit[] {
  if (input.maxChunks <= 0 || ranking.length === 0) return [];
  const densePass =
    Math.max(...ranking.map((hit) => hit.score)) >= input.gateScore;
  const sparseScenes = new Set(input.sparseSceneIds);
  const rescueFloor = input.minScore - input.rescueMargin;
  const eligible = ranking.filter((hit) => {
    const denseConfident = hit.score >= input.minScore;
    const sparseRescue =
      input.hybrid && sparseScenes.has(hit.sceneId) && hit.score >= rescueFloor;
    return sparseRescue || (densePass && denseConfident);
  });
  if (eligible.length === 0) return [];

  const seenScenes = new Set<string>();
  const distinct: SemanticSearchHit[] = [];
  const backfill: SemanticSearchHit[] = [];
  for (const hit of eligible) {
    if (seenScenes.has(hit.sceneId)) backfill.push(hit);
    else {
      seenScenes.add(hit.sceneId);
      distinct.push(hit);
    }
  }
  return [...distinct, ...backfill].slice(0, input.maxChunks);
}

function goldPosition(
  hits: readonly SemanticSearchHit[],
  expectedSceneIds: ReadonlySet<string>,
): number | null {
  const index = hits.findIndex((hit) => expectedSceneIds.has(hit.sceneId));
  return index < 0 ? null : index + 1;
}

export function buildSemanticRerankerShadowComparison(
  input: SemanticRerankerShadowInput,
  result: SemanticRerankerScoreResult,
): SemanticRerankerShadowComparison {
  const baselineRanking = currentCandidateRanking(input);
  const { ranking: reranked, scoreByCandidateId } = rerankedCandidates(
    input,
    result,
  );
  const counterfactual = counterfactualInjection(input, reranked);
  const hashFor = (hit: SemanticSearchHit) => {
    const candidateId = semanticRerankerCandidateId(hit);
    const score = scoreByCandidateId.get(candidateId);
    if (!score) throw new Error(`missing reranker hash for ${candidateId}`);
    return score.candidateHash;
  };
  const baselineHashes = input.baselineInjectedHits.map(hashFor);
  const counterfactualHashes = counterfactual.map(hashFor);
  const baselineRankById = new Map(
    baselineRanking.map(
      (hit, index) => [semanticRerankerCandidateId(hit), index + 1] as const,
    ),
  );
  const rerankedRankById = new Map(
    reranked.map(
      (hit, index) => [semanticRerankerCandidateId(hit), index + 1] as const,
    ),
  );
  const ranking = reranked.map((hit) => {
    const candidateId = semanticRerankerCandidateId(hit);
    const score = scoreByCandidateId.get(candidateId);
    if (!score) throw new Error(`missing reranker score for ${candidateId}`);
    return {
      candidateHash: score.candidateHash,
      sceneId: hit.sceneId,
      currentRank: baselineRankById.get(candidateId) ?? 0,
      rerankedRank: rerankedRankById.get(candidateId) ?? 0,
      denseScore: hit.score,
      rerankerScore: score.score,
      tokenization: score.tokenization,
    };
  });

  const expected = input.expectedSceneIds;
  const isNoMatch = expected === undefined ? null : expected.length === 0;
  const expectedSet = new Set(expected ?? []);
  const excludedScenes = new Set(input.excludeSceneIds);
  const goldCandidatePresent =
    expected === undefined || expected.length === 0
      ? null
      : input.denseHits.some(
          (hit) =>
            !excludedScenes.has(hit.sceneId) && expectedSet.has(hit.sceneId),
        );
  const baselineGoldPosition =
    expectedSet.size === 0
      ? null
      : goldPosition(input.baselineInjectedHits, expectedSet);
  const counterfactualGoldPosition =
    expectedSet.size === 0 ? null : goldPosition(counterfactual, expectedSet);
  let failureLayer: SemanticRerankerShadowComparison["failureLayer"];
  if (expectedSet.size > 0) {
    if (!goldCandidatePresent) failureLayer = "candidate-generation";
    else if (counterfactualGoldPosition !== null) failureLayer = "none";
    else {
      const rerankedGoldPosition = goldPosition(reranked, expectedSet);
      failureLayer =
        rerankedGoldPosition !== null && rerankedGoldPosition <= input.maxChunks
          ? "admission"
          : "ranking";
    }
  }

  return {
    baselineSceneOrder: uniqueSceneOrder(baselineRanking),
    rerankedSceneOrder: uniqueSceneOrder(reranked),
    baselineInjectedSceneIds: input.baselineInjectedHits.map(
      (hit) => hit.sceneId,
    ),
    counterfactualInjectedSceneIds: counterfactual.map((hit) => hit.sceneId),
    baselineInjectedCandidateHashes: baselineHashes,
    counterfactualInjectedCandidateHashes: counterfactualHashes,
    injectedSetChanged: !sameValueSet(baselineHashes, counterfactualHashes),
    injectedOrderChanged: !sameOrderedValues(
      baselineHashes,
      counterfactualHashes,
    ),
    firstPresentedChanged: baselineHashes[0] !== counterfactualHashes[0],
    goldCandidatePresent,
    baselineGoldPosition,
    counterfactualGoldPosition,
    baselineGoldInjectionMrr:
      baselineGoldPosition === null ? null : 1 / baselineGoldPosition,
    counterfactualGoldInjectionMrr:
      counterfactualGoldPosition === null
        ? null
        : 1 / counterfactualGoldPosition,
    isNoMatch,
    ...(failureLayer ? { failureLayer } : {}),
    ranking,
  };
}

function shadowErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/resource|model|manifest|hash|tokenizer|ONNX|ORT/i.test(message)) {
    return "RERANKER_RESOURCE_OR_RUNTIME_FAILED";
  }
  if (/IPC timeout/i.test(message)) return "RERANKER_IPC_TIMEOUT";
  return "RERANKER_SHADOW_FAILED";
}

class SemanticRerankerShadowCoordinator {
  private generation = 0;
  private latestGeneration = 0;
  private active = false;
  private scheduled = false;
  private pending: QueuedJob | null = null;
  private detached = new Set<Promise<void>>();
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly deps: SemanticRerankerShadowCoordinatorDeps) {}

  schedule(input: SemanticRerankerShadowInput): void {
    if (!this.deps.enabled()) return;
    const generation = ++this.generation;
    this.latestGeneration = generation;
    const job: QueuedJob = {
      generation,
      queuedAtMs: this.deps.now(),
      input: snapshotShadowInput(input),
    };
    if (this.deps.isReindexing()) {
      const runId = this.deps.createRunId();
      this.trackDetached(
        this.safeRecord(
          this.baseRecord(job, runId, "suppressed", {
            staleReason: "reindex-running",
          }),
        ),
      );
      return;
    }
    this.pending = job;
    if (this.active || this.scheduled) return;
    this.scheduled = true;
    this.deps.defer(() => {
      this.scheduled = false;
      void this.drain();
    });
  }

  async whenIdleForTests(): Promise<void> {
    if (this.isIdle()) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private async drain(): Promise<void> {
    if (this.active) return;
    const job = this.pending;
    this.pending = null;
    if (!job) {
      this.notifyIdle();
      return;
    }
    this.active = true;
    try {
      await this.run(job);
    } finally {
      this.active = false;
      if (this.pending) await this.drain();
      else this.notifyIdle();
    }
  }

  private async run(job: QueuedJob): Promise<void> {
    const runId = this.deps.createRunId();
    if (!this.deps.isScopeCurrent(job.input.scope)) {
      await this.safeRecord(
        this.baseRecord(job, runId, "stale", {
          staleReason: "workspace-scope-changed",
        }),
      );
      return;
    }
    if (this.deps.isReindexing()) {
      await this.safeRecord(
        this.baseRecord(job, runId, "suppressed", {
          staleReason: "reindex-running",
        }),
      );
      return;
    }

    const excluded = new Set(job.input.excludeSceneIds);
    const candidates = job.input.denseHits
      .filter((hit) => !excluded.has(hit.sceneId))
      .slice(0, 30)
      .map((hit) => ({
        candidateId: semanticRerankerCandidateId(hit),
        text: hit.chunkText,
      }));
    if (candidates.length === 0) {
      await this.safeRecord(
        this.baseRecord(job, runId, "suppressed", {
          staleReason: "empty-candidate-set",
        }),
      );
      return;
    }

    const queueLatencyMs = Math.max(0, this.deps.now() - job.queuedAtMs);
    const scoreStartedAt = this.deps.now();
    let result: SemanticRerankerScoreResult;
    try {
      result = await this.deps.score({
        requestId: job.input.requestId,
        language: job.input.language,
        userMessage: job.input.query.userMessage,
        sceneTail: job.input.query.sceneTail,
        candidates,
      });
    } catch (error) {
      if (job.generation !== this.latestGeneration) {
        await this.safeRecord(
          this.baseRecord(job, runId, "stale", {
            staleReason: "superseded",
            queueLatencyMs,
          }),
        );
        return;
      }
      await this.safeRecord(
        this.baseRecord(job, runId, "failed", {
          errorCode: shadowErrorCode(error),
          queueLatencyMs,
          ipcRoundTripMs: Math.max(0, this.deps.now() - scoreStartedAt),
        }),
      );
      debugLog.warn(
        "SemanticRerankerShadow",
        "shadow scoring failed",
        errorDetail(error),
      );
      return;
    }
    const finishedAt = this.deps.now();
    const ipcRoundTripMs = Math.max(0, finishedAt - scoreStartedAt);
    const resultFields = {
      queryHash: result.queryHash,
      candidateSetHash: result.candidateSetHash,
      modelId: result.modelId,
      modelRevision: result.modelRevision,
      manifestSha256: result.manifestSha256,
      candidateCount: candidates.length,
      queueLatencyMs,
      ipcRoundTripMs,
      nativeLatencyMs: result.latencyMs,
      endToEndLatencyMs: Math.max(
        0,
        finishedAt - job.input.retrievalStartedAtMs,
      ),
      modelLoadMs: result.modelLoadMs,
      modelWasCold: result.modelWasCold,
    };
    if (job.generation !== this.latestGeneration) {
      await this.safeRecord(
        this.baseRecord(job, runId, "stale", {
          staleReason: "superseded",
          ...resultFields,
        }),
      );
      return;
    }
    if (this.deps.isReindexing()) {
      await this.safeRecord(
        this.baseRecord(job, runId, "stale", {
          staleReason: "reindex-started",
          ...resultFields,
        }),
      );
      return;
    }
    if (!this.deps.isScopeCurrent(job.input.scope)) {
      await this.safeRecord(
        this.baseRecord(job, runId, "stale", {
          staleReason: "workspace-scope-changed",
          ...resultFields,
        }),
      );
      return;
    }

    try {
      const comparison = buildSemanticRerankerShadowComparison(
        job.input,
        result,
      );
      await this.safeRecord(
        this.baseRecord(job, runId, "completed", {
          ...resultFields,
          comparison,
        }),
      );
    } catch (error) {
      await this.safeRecord(
        this.baseRecord(job, runId, "failed", {
          errorCode: "RERANKER_COMPARISON_FAILED",
          ...resultFields,
        }),
      );
      debugLog.warn(
        "SemanticRerankerShadow",
        "shadow comparison failed",
        errorDetail(error),
      );
    }
  }

  private baseRecord(
    job: QueuedJob,
    runId: string,
    status: SemanticRerankerShadowRecord["status"],
    extra: Partial<SemanticRerankerShadowRecord> = {},
  ): SemanticRerankerShadowRecord {
    return {
      schemaVersion: 1,
      status,
      runId,
      generation: job.generation,
      requestId: job.input.requestId,
      workspaceKey: job.input.scope.workspaceKey,
      workspaceOpenRevision: job.input.scope.workspaceOpenRevision,
      projectId: job.input.scope.projectId,
      language: job.input.language,
      localInferenceExpected: job.input.localInferenceExpected,
      retrievalLatencyMs: job.input.retrievalLatencyMs,
      comparison: undefined,
      ...extra,
    };
  }

  private async safeRecord(
    record: SemanticRerankerShadowRecord,
  ): Promise<void> {
    try {
      await this.deps.record(record);
    } catch (error) {
      debugLog.warn(
        "SemanticRerankerShadow",
        "shadow record append failed",
        errorDetail(error),
      );
    }
  }

  private trackDetached(promise: Promise<void>): void {
    this.detached.add(promise);
    void promise.finally(() => {
      this.detached.delete(promise);
      this.notifyIdle();
    });
  }

  private isIdle(): boolean {
    return (
      !this.active &&
      !this.scheduled &&
      this.pending === null &&
      this.detached.size === 0
    );
  }

  private notifyIdle(): void {
    if (!this.isIdle()) return;
    const waiters = this.idleWaiters.splice(0);
    waiters.forEach((resolve) => resolve());
  }
}

export function createSemanticRerankerShadowCoordinator(
  deps: SemanticRerankerShadowCoordinatorDeps,
): SemanticRerankerShadowCoordinator {
  return new SemanticRerankerShadowCoordinator(deps);
}

function explicitDevShadowEnabled(): boolean {
  return (
    import.meta.env.DEV && import.meta.env.VITE_SEMANTIC_RERANKER_SHADOW === "1"
  );
}

function currentScopeMatches(scope: SemanticRerankerShadowScope): boolean {
  return (
    isCurrentWorkspaceIdentity({
      path: scope.workspaceKey,
      openRevision: scope.workspaceOpenRevision,
    }) && isCurrentRuntimeProjectId(scope.projectId)
  );
}

function createRunId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `reranker-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

const productionCoordinator = createSemanticRerankerShadowCoordinator({
  enabled: explicitDevShadowEnabled,
  isReindexing: () => useReindexProgressStore.getState().running,
  isScopeCurrent: currentScopeMatches,
  score: (request) =>
    invoke<SemanticRerankerScoreResult>(
      "semantic_reranker_shadow_score",
      request,
    ),
  record: (record) =>
    invoke<void>("semantic_reranker_shadow_record", { record }),
  now: () => performance.now(),
  createRunId,
  defer: (task) => {
    setTimeout(task, 0);
  },
});

export function scheduleSemanticRerankerShadow(
  input: SemanticRerankerShadowInput,
): void {
  productionCoordinator.schedule(input);
}

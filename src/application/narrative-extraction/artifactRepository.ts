import type {
  ArtifactInput,
  GetRunReviewBundleResult,
  ReviewBundleArtifact,
} from "./nativeApi";
import { narrativeExtractionGetRunReviewBundle } from "./nativeApi";
import type { NarrativeExtractionArtifact } from "@/features/narrative-extraction/runtime/types";
import {
  assertChronicleStageTerminalReceiptV1,
  type ChronicleStageTerminalReceiptV1,
} from "@/features/narrative-extraction/reconciler/stageProvenance";
import { getCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";

export interface NarrativeArtifactCacheScope {
  readonly projectId: string;
  readonly workspacePath: string | null;
  readonly workspaceOpenRevision: number | null;
}

interface ScopedInlineArtifact {
  readonly scopeKey: string;
  readonly artifact: NarrativeExtractionArtifact;
}

/**
 * Process-local acceleration for artifacts which Native has already committed.
 * Workspace identity is part of the namespace: Run ids are database-local and
 * therefore cannot identify an artifact across restore, clone, or reopen.
 */
const inlineArtifactIndex = new Map<string, ScopedInlineArtifact>();

/** Runs whose exact scoped namespace was cleared and reloaded from Native. */
const nativeConfirmedRuns = new Set<string>();

/** In-flight Native hydrate only (mutable proposal/decision/application must re-fetch). */
const hydrateInFlight = new Map<
  string,
  Promise<GetRunReviewBundleResult | null>
>();

/**
 * Artifact and review-bundle payloads are JSON-only durable projections.
 * Clone them at every process-local boundary: stages routinely yield while
 * Native work is in flight, so retaining a caller's object reference would
 * let a later consumer execute bytes other than the sealed Native artifact.
 */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneArtifact(
  artifact: NarrativeExtractionArtifact,
): NarrativeExtractionArtifact {
  return {
    ...artifact,
    payloadJson: artifact.payloadJson ? cloneJson(artifact.payloadJson) : null,
  };
}

function artifactScopeKey(scope: NarrativeArtifactCacheScope): string {
  const workspaceCoordinatesArePaired =
    (scope.workspacePath === null) === (scope.workspaceOpenRevision === null);
  if (
    !scope.projectId ||
    !workspaceCoordinatesArePaired ||
    (scope.workspacePath !== null && !scope.workspacePath) ||
    (scope.workspaceOpenRevision !== null &&
      (!Number.isSafeInteger(scope.workspaceOpenRevision) ||
        scope.workspaceOpenRevision < 0))
  ) {
    throw new Error(
      "NEX_ARTIFACT_CACHE_SCOPE_INVALID: project and workspace authority must be exact",
    );
  }
  const currentWorkspace = getCurrentWorkspaceIdentity();
  if (
    currentWorkspace === null
      ? scope.workspacePath !== null
      : currentWorkspace.path !== scope.workspacePath ||
        currentWorkspace.openRevision !== scope.workspaceOpenRevision
  ) {
    throw new Error(
      "NEX_ARTIFACT_CACHE_AUTHORITY_STALE: active workspace changed before artifact access",
    );
  }
  return JSON.stringify([
    scope.projectId,
    scope.workspacePath,
    scope.workspaceOpenRevision,
  ]);
}

function runScopeKey(scopeKey: string, runId: string): string {
  return `${scopeKey}\u0000${runId}`;
}

function artifactIndexKey(
  scopeKey: string,
  runId: string,
  artifactKind: string,
): string {
  return `${runScopeKey(scopeKey, runId)}\u0000${artifactKind}`;
}

function clearRunNamespace(scopeKey: string, runId: string): void {
  for (const [key, scoped] of inlineArtifactIndex) {
    if (scoped.scopeKey === scopeKey && scoped.artifact.runId === runId) {
      inlineArtifactIndex.delete(key);
    }
  }
  nativeConfirmedRuns.delete(runScopeKey(scopeKey, runId));
}

function hydrateKey(scopeKey: string, runId: string): string {
  return runScopeKey(scopeKey, runId);
}

export function resetNarrativeArtifactIndexForTests(): void {
  inlineArtifactIndex.clear();
  nativeConfirmedRuns.clear();
  hydrateInFlight.clear();
}

export interface InlineJsonArtifactDraft {
  readonly artifactId: string;
  readonly artifactKind: string;
  readonly payloadJson: Readonly<Record<string, unknown>>;
  readonly artifactInput: ArtifactInput;
}

export function buildInlineJsonArtifact(
  artifactKind: string,
  payloadJson: Readonly<Record<string, unknown>>,
  artifactId: string = crypto.randomUUID(),
): InlineJsonArtifactDraft {
  const draftPayload = cloneJson(payloadJson);
  return {
    artifactId,
    artifactKind,
    payloadJson: draftPayload,
    artifactInput: {
      artifactId,
      artifactKind,
      payloadStorage: "inline-json",
      // Keep draft-facing and transport-facing values isolated too. A draft
      // holder can never mutate the exact payload passed to FinishTask.
      payloadJson: cloneJson(draftPayload),
    },
  };
}

export function rememberInlineJsonArtifact(input: {
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  /** Authority captured before the Native FinishTask transaction began. */
  readonly scope: NarrativeArtifactCacheScope;
  readonly draft: InlineJsonArtifactDraft;
}): NarrativeExtractionArtifact {
  const scopeKey = artifactScopeKey(input.scope);
  const stored: NarrativeExtractionArtifact = {
    artifactId: input.draft.artifactId,
    runId: input.runId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    artifactKind: input.draft.artifactKind,
    payloadStorage: "inline-json",
    payloadJson: cloneJson(input.draft.payloadJson),
    payloadRef: null,
    payloadDigest: null,
    createdAt: new Date().toISOString(),
  };
  inlineArtifactIndex.set(
    artifactIndexKey(scopeKey, input.runId, input.draft.artifactKind),
    { scopeKey, artifact: stored },
  );
  return cloneArtifact(stored);
}

function rememberBundleArtifact(
  scopeKey: string,
  artifact: ReviewBundleArtifact,
): void {
  if (artifact.payloadStorage !== "inline-json" || !artifact.payloadJson) {
    return;
  }
  const stored: NarrativeExtractionArtifact = {
    artifactId: artifact.artifactId,
    runId: artifact.runId,
    taskId: artifact.taskId,
    attemptId: artifact.attemptId,
    artifactKind: artifact.artifactKind,
    payloadStorage: "inline-json",
    payloadJson: cloneJson(artifact.payloadJson),
    payloadRef: artifact.payloadRef,
    payloadDigest: artifact.payloadDigest,
    createdAt: artifact.createdAt,
  };
  // Ascending createdAt from Native → last write wins per kind.
  inlineArtifactIndex.set(
    artifactIndexKey(scopeKey, artifact.runId, artifact.artifactKind),
    { scopeKey, artifact: stored },
  );
}

/**
 * Fetch Native review bundle and populate the process-local artifact Map.
 * Fail-closed on project mismatch (Native ensure_run_project).
 */
export async function hydrateInlineArtifactsFromNative(input: {
  readonly runId: string;
  readonly scope: NarrativeArtifactCacheScope;
}): Promise<GetRunReviewBundleResult> {
  const scopeKey = artifactScopeKey(input.scope);
  const key = hydrateKey(scopeKey, input.runId);
  const existing = hydrateInFlight.get(key);
  if (existing) {
    const reused = await existing;
    if (!reused) {
      throw new Error(
        `Chronicle extraction review bundle unavailable for run ${input.runId}`,
      );
    }
    return cloneJson(reused);
  }

  // A failed or mismatched Native read must leave no previously cached rows
  // which a restart path could mistake for durable evidence.
  clearRunNamespace(scopeKey, input.runId);
  const pending = narrativeExtractionGetRunReviewBundle({
    runId: input.runId,
    projectId: input.scope.projectId,
  }).then((bundle) => {
    // Revalidate after the IPC await. A workspace handoff during Native I/O
    // must not publish old-database bytes into the new renderer authority.
    artifactScopeKey(input.scope);
    // The promise is shared only as an internal coalescing mechanism. Never
    // leak its Native-owned object graph to either caller.
    const sealedBundle = cloneJson(bundle);
    if (
      sealedBundle.runId !== input.runId ||
      sealedBundle.projectId !== input.scope.projectId ||
      sealedBundle.artifacts.some((artifact) => artifact.runId !== input.runId)
    ) {
      throw new Error(
        "NEX_ARTIFACT_CACHE_NATIVE_IDENTITY_MISMATCH: Native bundle does not match the requested Run scope",
      );
    }
    for (const artifact of sealedBundle.artifacts) {
      rememberBundleArtifact(scopeKey, artifact);
    }
    nativeConfirmedRuns.add(runScopeKey(scopeKey, input.runId));
    return sealedBundle;
  });

  hydrateInFlight.set(key, pending);
  try {
    return cloneJson(await pending);
  } finally {
    // Drop completed/failed entry so later restores re-read mutable proposal state.
    // Concurrent callers still coalesce via the in-flight Map entry above.
    hydrateInFlight.delete(key);
  }
}

/**
 * Recover only Native-verified C1 terminal receipts after a process restart.
 * The transport closure is intentionally absent; callers rebuild it from
 * these sealed rows when they later finish the next stage.
 */
export async function hydrateChronicleStageReceiptsFromNative(input: {
  readonly runId: string;
  readonly scope: NarrativeArtifactCacheScope;
  /** Reuse the exact already-hydrated review bundle when the caller also
   * needs terminal ProposalSet state. This avoids validating receipts from
   * one read and resuming from a later mutable read. */
  readonly bundle?: GetRunReviewBundleResult;
}): Promise<readonly ChronicleStageTerminalReceiptV1[]> {
  const bundle =
    input.bundle ?? (await hydrateInlineArtifactsFromNative(input));
  const stageReceipts = (
    bundle as unknown as {
      readonly stageReceipts?: unknown;
    }
  ).stageReceipts;
  if (!Array.isArray(stageReceipts)) {
    throw new Error(
      "NEX_CHRONICLE_STAGE_HYDRATION_INCONSISTENT: Native hydration did not return a durable stage receipt roster",
    );
  }
  const clonedReceipts = cloneJson(stageReceipts);
  const seenExecutionIds = new Set<string>();
  for (const receipt of clonedReceipts) {
    await assertChronicleStageTerminalReceiptV1(receipt);
    if (
      receipt.stageExecution.projectId !== input.scope.projectId ||
      receipt.stageExecution.runId !== input.runId ||
      !seenExecutionIds.add(receipt.stageExecution.stageExecutionId)
    ) {
      throw new Error(
        "NEX_CHRONICLE_STAGE_HYDRATION_INCONSISTENT: Native receipt roster has an invalid Run identity or duplicate stage execution",
      );
    }
  }
  return clonedReceipts;
}

export async function loadInlineJsonArtifact<T extends object>(
  runId: string,
  artifactKind: string,
  options: {
    readonly scope: NarrativeArtifactCacheScope;
    /** Resume/restore consumers require at least one current Native read. */
    readonly requireNativeConfirmation?: boolean;
  },
): Promise<T | null> {
  const scopeKey = artifactScopeKey(options.scope);
  const confirmedKey = runScopeKey(scopeKey, runId);
  if (
    options.requireNativeConfirmation &&
    !nativeConfirmedRuns.has(confirmedKey)
  ) {
    await hydrateInlineArtifactsFromNative({
      runId,
      scope: options.scope,
    });
  }

  const cached = inlineArtifactIndex.get(
    artifactIndexKey(scopeKey, runId, artifactKind),
  )?.artifact;
  if (!cached?.payloadJson) return null;
  return cloneJson(cached.payloadJson) as T;
}

export function listInlineJsonArtifacts(
  runId: string,
  scope: NarrativeArtifactCacheScope,
): readonly NarrativeExtractionArtifact[] {
  const scopeKey = artifactScopeKey(scope);
  return [...inlineArtifactIndex.values()]
    .filter(
      (scoped) =>
        scoped.scopeKey === scopeKey && scoped.artifact.runId === runId,
    )
    .map((scoped) => cloneArtifact(scoped.artifact));
}

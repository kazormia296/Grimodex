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

const inlineArtifactIndex = new Map<string, NarrativeExtractionArtifact>();

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

function artifactIndexKey(runId: string, artifactKind: string): string {
  return `${runId}:${artifactKind}`;
}

function hydrateKey(runId: string, projectId: string): string {
  return `${runId}:${projectId}`;
}

export function resetNarrativeArtifactIndexForTests(): void {
  inlineArtifactIndex.clear();
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
  readonly draft: InlineJsonArtifactDraft;
}): NarrativeExtractionArtifact {
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
    artifactIndexKey(input.runId, input.draft.artifactKind),
    stored,
  );
  return cloneArtifact(stored);
}

function rememberBundleArtifact(artifact: ReviewBundleArtifact): void {
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
    artifactIndexKey(artifact.runId, artifact.artifactKind),
    stored,
  );
}

/**
 * Fetch Native review bundle and populate the process-local artifact Map.
 * Fail-closed on project mismatch (Native ensure_run_project).
 */
export async function hydrateInlineArtifactsFromNative(input: {
  readonly runId: string;
  readonly projectId: string;
}): Promise<GetRunReviewBundleResult> {
  const key = hydrateKey(input.runId, input.projectId);
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

  const pending = narrativeExtractionGetRunReviewBundle({
    runId: input.runId,
    projectId: input.projectId,
  }).then((bundle) => {
    // The promise is shared only as an internal coalescing mechanism. Never
    // leak its Native-owned object graph to either caller.
    const sealedBundle = cloneJson(bundle);
    for (const artifact of sealedBundle.artifacts) {
      rememberBundleArtifact(artifact);
    }
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
  readonly projectId: string;
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
      receipt.stageExecution.projectId !== input.projectId ||
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
  options?: { readonly projectId?: string },
): Promise<T | null> {
  const key = artifactIndexKey(runId, artifactKind);
  const cached = inlineArtifactIndex.get(key);
  if (cached?.payloadJson) {
    return cloneJson(cached.payloadJson) as T;
  }

  if (!options?.projectId) {
    return null;
  }

  await hydrateInlineArtifactsFromNative({
    runId,
    projectId: options.projectId,
  });
  const hydrated = inlineArtifactIndex.get(key);
  if (!hydrated?.payloadJson) return null;
  return cloneJson(hydrated.payloadJson) as T;
}

export function listInlineJsonArtifacts(
  runId: string,
): readonly NarrativeExtractionArtifact[] {
  return [...inlineArtifactIndex.values()]
    .filter((artifact) => artifact.runId === runId)
    .map(cloneArtifact);
}

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
  return {
    artifactId,
    artifactKind,
    payloadJson,
    artifactInput: {
      artifactId,
      artifactKind,
      payloadStorage: "inline-json",
      payloadJson,
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
    payloadJson: input.draft.payloadJson,
    payloadRef: null,
    payloadDigest: null,
    createdAt: new Date().toISOString(),
  };
  inlineArtifactIndex.set(
    artifactIndexKey(input.runId, input.draft.artifactKind),
    stored,
  );
  return stored;
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
    payloadJson: artifact.payloadJson,
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
    return reused;
  }

  const pending = narrativeExtractionGetRunReviewBundle({
    runId: input.runId,
    projectId: input.projectId,
  }).then((bundle) => {
    for (const artifact of bundle.artifacts) {
      rememberBundleArtifact(artifact);
    }
    return bundle;
  });

  hydrateInFlight.set(key, pending);
  try {
    return await pending;
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
}): Promise<readonly ChronicleStageTerminalReceiptV1[]> {
  const bundle = await hydrateInlineArtifactsFromNative(input);
  const stageReceipts = (bundle as unknown as {
    readonly stageReceipts?: unknown;
  }).stageReceipts;
  if (!Array.isArray(stageReceipts)) {
    throw new Error(
      "NEX_CHRONICLE_STAGE_HYDRATION_INCONSISTENT: Native hydration did not return a durable stage receipt roster",
    );
  }
  const seenExecutionIds = new Set<string>();
  for (const receipt of stageReceipts) {
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
  return stageReceipts;
}

export async function loadInlineJsonArtifact<T extends object>(
  runId: string,
  artifactKind: string,
  options?: { readonly projectId?: string },
): Promise<T | null> {
  const key = artifactIndexKey(runId, artifactKind);
  const cached = inlineArtifactIndex.get(key);
  if (cached?.payloadJson) {
    return cached.payloadJson as T;
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
  return hydrated.payloadJson as T;
}

export function listInlineJsonArtifacts(
  runId: string,
): readonly NarrativeExtractionArtifact[] {
  return [...inlineArtifactIndex.values()].filter(
    (artifact) => artifact.runId === runId,
  );
}

import type { ArtifactInput } from "./nativeApi";
import type { NarrativeExtractionArtifact } from "@/features/narrative-extraction/runtime/types";

const inlineArtifactIndex = new Map<string, NarrativeExtractionArtifact>();

function artifactIndexKey(runId: string, artifactKind: string): string {
  return `${runId}:${artifactKind}`;
}

export function resetNarrativeArtifactIndexForTests(): void {
  inlineArtifactIndex.clear();
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

export async function loadInlineJsonArtifact<T extends object>(
  runId: string,
  artifactKind: string,
): Promise<T | null> {
  const stored = inlineArtifactIndex.get(artifactIndexKey(runId, artifactKind));
  if (!stored?.payloadJson) return null;
  return stored.payloadJson as T;
}

export function listInlineJsonArtifacts(
  runId: string,
): readonly NarrativeExtractionArtifact[] {
  return [...inlineArtifactIndex.values()].filter(
    (artifact) => artifact.runId === runId,
  );
}

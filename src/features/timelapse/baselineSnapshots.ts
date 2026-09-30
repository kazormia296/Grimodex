import { invoke } from "@/lib/tauri";

/** Editor-body domains accepted by the typed Native baseline writers. */
export type GenesisBaselineKind = "scene" | "codex" | "snippet";

export interface BodyBaselineTarget {
  kind: GenesisBaselineKind;
  id: string;
}

export interface AppendBodyBaselinesInput {
  expectedWorkspacePath: string;
  projectId: string;
  targets: readonly BodyBaselineTarget[];
  expectedAnchorSequence?: number | null;
}

export interface AppendBodyBaselinesResult {
  insertedCount: number;
  skippedExistingCount: number;
  anchorSequence: number;
  anchorTimestamp: number;
  /** False when a workspace switch invalidated the caller. */
  completed: boolean;
}

type NativeAppendBodyBaselinesResult = Omit<
  AppendBodyBaselinesResult,
  "completed"
>;

/** The Native body writer accepts bounded identity batches only. */
const BODY_BASELINE_BATCH_SIZE = 64;

/**
 * Ask Native to append body baselines at its current canonical tail. The
 * renderer sends only `(kind, id)` identities; body bytes and snapshot scope
 * are never accepted from this boundary. Batches are bounded and an
 * authority callback prevents a workspace switch from being reported as a
 * successful background pass.
 */
export async function appendBodyBaselines(
  input: AppendBodyBaselinesInput,
  isAuthoritative: () => boolean = () => true,
): Promise<AppendBodyBaselinesResult> {
  const targets = [...input.targets];
  if (targets.length === 0) {
    return {
      insertedCount: 0,
      skippedExistingCount: 0,
      anchorSequence: input.expectedAnchorSequence ?? 0,
      anchorTimestamp: 0,
      completed: true,
    };
  }
  const total: AppendBodyBaselinesResult = {
    insertedCount: 0,
    skippedExistingCount: 0,
    anchorSequence: input.expectedAnchorSequence ?? 0,
    anchorTimestamp: 0,
    completed: true,
  };
  for (
    let offset = 0;
    offset < targets.length;
    offset += BODY_BASELINE_BATCH_SIZE
  ) {
    if (!isAuthoritative()) {
      total.completed = false;
      return total;
    }
    const result = await invoke<NativeAppendBodyBaselinesResult>(
      "timelapse_body_baselines_append",
      {
        expectedWorkspacePath: input.expectedWorkspacePath,
        projectId: input.projectId,
        targets: targets.slice(offset, offset + BODY_BASELINE_BATCH_SIZE),
        expectedAnchorSequence: input.expectedAnchorSequence ?? null,
      },
    );
    if (!isAuthoritative()) {
      total.completed = false;
      return total;
    }
    total.insertedCount += result.insertedCount;
    total.skippedExistingCount += result.skippedExistingCount;
    total.anchorSequence = result.anchorSequence;
    total.anchorTimestamp = result.anchorTimestamp;
  }
  return total;
}

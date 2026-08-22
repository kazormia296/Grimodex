/**
 * Pure execution identity for a Chronicle AI stage.
 *
 * This is deliberately separate from the AI audit and persistence layers. The
 * Wave 1 foundation only carries the identity through the stage boundary; a
 * later lane may bind it to an audit/persistence record without changing the
 * shape or lineage rules here.
 */
export interface NarrativeStageExecutionContext {
  readonly projectId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly stageId: string;
  readonly stageExecutionId: string;
  readonly parentStageExecutionId?: string;
}

export const NARRATIVE_STAGE_IDS = {
  observationExtraction: "narrative_observation_extract",
  eventSynthesis: "narrative_event_synthesize",
  structuredRepair: "narrative_structured_repair",
} as const;

export type ChronicleNarrativeStageId =
  (typeof NARRATIVE_STAGE_IDS)[keyof typeof NARRATIVE_STAGE_IDS];

export interface CreateStageExecutionContextInput extends Omit<
  NarrativeStageExecutionContext,
  "parentStageExecutionId"
> {
  readonly parentStageExecutionId?: string;
}

function assertNonEmptyIdentityPart(
  name: string,
  value: unknown,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(
      `Narrative stage execution ${name} must be a non-empty string`,
    );
  }
}

/** Build and validate a root Stage execution identity without side effects. */
export function createStageExecutionContext(
  input: CreateStageExecutionContextInput,
): NarrativeStageExecutionContext {
  assertNonEmptyIdentityPart("projectId", input.projectId);
  assertNonEmptyIdentityPart("runId", input.runId);
  assertNonEmptyIdentityPart("taskId", input.taskId);
  assertNonEmptyIdentityPart("attemptId", input.attemptId);
  assertNonEmptyIdentityPart("stageId", input.stageId);
  assertNonEmptyIdentityPart("stageExecutionId", input.stageExecutionId);
  if (input.parentStageExecutionId !== undefined) {
    assertNonEmptyIdentityPart(
      "parentStageExecutionId",
      input.parentStageExecutionId,
    );
  }

  return {
    projectId: input.projectId,
    runId: input.runId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    stageId: input.stageId,
    stageExecutionId: input.stageExecutionId,
    ...(input.parentStageExecutionId !== undefined
      ? { parentStageExecutionId: input.parentStageExecutionId }
      : {}),
  };
}

/**
 * Create an inline child Stage. A repair is a child of the failed parse stage,
 * never a new Run, Task, or Attempt.
 */
export function createChildStageExecutionContext(
  parent: NarrativeStageExecutionContext,
  stageId: string,
  stageExecutionId: string,
): NarrativeStageExecutionContext {
  const validatedParent = createStageExecutionContext(parent);
  return createStageExecutionContext({
    projectId: validatedParent.projectId,
    runId: validatedParent.runId,
    taskId: validatedParent.taskId,
    attemptId: validatedParent.attemptId,
    stageId,
    stageExecutionId,
    parentStageExecutionId: validatedParent.stageExecutionId,
  });
}

/** Runtime boundary guard for injected/evaluated task inputs. */
export function isStageExecutionContext(
  value: unknown,
): value is NarrativeStageExecutionContext {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "projectId",
    "runId",
    "taskId",
    "attemptId",
    "stageId",
    "stageExecutionId",
    "parentStageExecutionId",
  ]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) return false;
  const requiredKeys = [
    "projectId",
    "runId",
    "taskId",
    "attemptId",
    "stageId",
    "stageExecutionId",
  ] as const;
  if (
    requiredKeys.some(
      (key) =>
        typeof record[key] !== "string" ||
        (record[key] as string).trim().length === 0,
    )
  ) {
    return false;
  }
  return (
    record.parentStageExecutionId === undefined ||
    (typeof record.parentStageExecutionId === "string" &&
      record.parentStageExecutionId.trim().length > 0)
  );
}

/** Throw a stable error when a stage boundary receives malformed identity. */
export function assertStageExecutionContext(
  value: unknown,
): asserts value is NarrativeStageExecutionContext {
  if (!isStageExecutionContext(value)) {
    throw new TypeError("Invalid Narrative stage execution identity");
  }
}

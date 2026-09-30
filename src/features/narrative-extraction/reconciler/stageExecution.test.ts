import { describe, expect, it } from "vitest";

import {
  NARRATIVE_STAGE_IDS,
  createChildStageExecutionContext,
  createStageExecutionContext,
  isStageExecutionContext,
} from "./stageExecution";

describe("Chronicle stage execution identity", () => {
  const parent = createStageExecutionContext({
    projectId: "project-1",
    runId: "run-1",
    taskId: "task-1",
    attemptId: "attempt-1",
    stageId: NARRATIVE_STAGE_IDS.observationExtraction,
    stageExecutionId: "stage-execution-1",
  });

  it("carries project, run, task, attempt, stage, and execution identity", () => {
    expect(parent).toEqual({
      projectId: "project-1",
      runId: "run-1",
      taskId: "task-1",
      attemptId: "attempt-1",
      stageId: "narrative_observation_extract",
      stageExecutionId: "stage-execution-1",
    });
    expect(isStageExecutionContext(parent)).toBe(true);
  });

  it("creates structured repair as a child in the same Attempt", () => {
    const repair = createChildStageExecutionContext(
      parent,
      NARRATIVE_STAGE_IDS.structuredRepair,
      "stage-execution-repair-1",
    );

    expect(repair).toEqual({
      projectId: parent.projectId,
      runId: parent.runId,
      taskId: parent.taskId,
      attemptId: parent.attemptId,
      stageId: "narrative_structured_repair",
      stageExecutionId: "stage-execution-repair-1",
      parentStageExecutionId: parent.stageExecutionId,
    });
  });

  it("rejects empty or malformed identity at the pure boundary", () => {
    expect(() =>
      createStageExecutionContext({
        projectId: "",
        runId: "run-1",
        taskId: "task-1",
        attemptId: "attempt-1",
        stageId: "stage",
        stageExecutionId: "execution",
      }),
    ).toThrow(/projectId/);
    expect(
      isStageExecutionContext({
        projectId: "project-1",
        runId: "run-1",
        taskId: "task-1",
        attemptId: "attempt-1",
        stageId: "stage",
        stageExecutionId: "execution",
        parentStageExecutionId: "",
      }),
    ).toBe(false);
    expect(
      isStageExecutionContext({
        ...parent,
        unratified: "hidden",
      }),
    ).toBe(false);
  });
});

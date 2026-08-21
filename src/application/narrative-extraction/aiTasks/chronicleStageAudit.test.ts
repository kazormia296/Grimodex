import { describe, expect, it } from "vitest";

import {
  bindChronicleStageAuditContext,
  buildChronicleStageAuditTerminal,
} from "./chronicleStageAudit";
import {
  createChildStageExecutionContext,
  createStageExecutionContext,
  NARRATIVE_STAGE_IDS,
} from "@/features/narrative-extraction/reconciler/stageExecution";

const parent = createStageExecutionContext({
  projectId: "project-1",
  runId: "run-1",
  taskId: "task-1",
  attemptId: "attempt-1",
  stageId: NARRATIVE_STAGE_IDS.observationExtraction,
  stageExecutionId: "stage-execution-1",
});

const digests = {
  contextSetDigest: "sha256:context" as const,
  componentContractDigest: "sha256:component" as const,
  finalRequestDigest: "sha256:request" as const,
};

describe("Chronicle Stage AI Audit binding", () => {
  it("maps stage identity to existing audit correlation fields", () => {
    const bound = bindChronicleStageAuditContext(
      {
        projectId: parent.projectId,
        pathId: "narrative_observation_extract",
      },
      parent,
      digests,
    );

    expect(bound).toMatchObject({
      projectId: "project-1",
      pathId: "narrative_observation_extract",
      operationId: "run-1:task-1:attempt-1",
      executionId: "stage-execution-1",
      parentExecutionId: null,
    });
    expect(bound.metadata).toMatchObject({
      chronicleStage: {
        version: 1,
        stageExecution: parent,
        contextSetDigest: digests.contextSetDigest,
        componentContractDigest: digests.componentContractDigest,
        finalRequestDigest: digests.finalRequestDigest,
      },
    });
  });

  it("preserves repair child lineage without creating a new Attempt", () => {
    const repair = createChildStageExecutionContext(
      parent,
      NARRATIVE_STAGE_IDS.structuredRepair,
      "stage-execution-repair-1",
    );
    const bound = bindChronicleStageAuditContext(
      {
        projectId: repair.projectId,
        pathId: "narrative_structured_repair",
      },
      repair,
      digests,
    );

    expect(bound).toMatchObject({
      operationId: "run-1:task-1:attempt-1",
      executionId: "stage-execution-repair-1",
      parentExecutionId: "stage-execution-1",
    });
    expect(bound.metadata).toMatchObject({
      chronicleStage: {
        repairParentStageExecutionId: "stage-execution-1",
      },
    });
  });

  it("records terminal digests and statuses without retaining response text", async () => {
    const terminal = await buildChronicleStageAuditTerminal({
      stageExecution: parent,
      ...digests,
      responseText: "{\"observations\":[]}",
      parseStatus: "parsed",
      terminalStatus: "succeeded",
      repairChildStageExecutionId: null,
    });

    expect(terminal).toMatchObject({
      version: 1,
      contextSetDigest: digests.contextSetDigest,
      componentContractDigest: digests.componentContractDigest,
      finalRequestDigest: digests.finalRequestDigest,
      responseDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      parseStatus: "parsed",
      terminalStatus: "succeeded",
      repairChildStageExecutionId: null,
    });
    expect(terminal).not.toHaveProperty("responseText");
    expect(JSON.stringify(terminal)).not.toContain("observations");
  });
});

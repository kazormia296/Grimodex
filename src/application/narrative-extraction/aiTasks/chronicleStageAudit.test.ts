import { describe, expect, it } from "vitest";

import {
  bindChronicleStageAuditContext,
  buildChronicleStageAuditNoResponseTerminal,
  buildChronicleStageAuditTerminal,
  chronicleStageAuditUnresolvedBinding,
} from "./chronicleStageAudit";
import { digestStageModelExecutionBinding } from "@/features/narrative-extraction/reconciler/stageProvenance";
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
  contextSetDigest: `sha256:${"1".repeat(64)}` as const,
  componentContractDigest: `sha256:${"2".repeat(64)}` as const,
  finalRequestDigest: `sha256:${"3".repeat(64)}` as const,
};

describe("Chronicle Stage AI Audit binding", () => {
  it("maps stage identity to existing audit correlation fields", async () => {
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
        version: 2,
        stageExecution: parent,
        contextSetDigest: digests.contextSetDigest,
        componentContractDigest: digests.componentContractDigest,
        finalRequestDigest: digests.finalRequestDigest,
        modelExecutionBinding: {
          resolutionStatus: "unresolved",
          provider: null,
          requestedModel: null,
          effectiveModel: null,
        },
        modelBindingDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      },
    });
    expect(
      (bound.metadata?.chronicleStage as Record<string, unknown>)
        .modelBindingDigest,
    ).toBe(
      await digestStageModelExecutionBinding(
        chronicleStageAuditUnresolvedBinding,
      ),
    );
    const resolvedMetadata = await bound.onResolvedRouteMetadata?.(
      {
        provider: "ollama",
        model: "qwen3:8b",
        apiVariant: "chat-completions",
        endpointId: null,
        endpointOrigin: "http://127.0.0.1:11434",
        authority: "turn-snapshot",
        transportResolutionLimitations: [],
      },
      { provider: "ollama", model: "qwen3:8b" },
    );
    expect(resolvedMetadata).toMatchObject({
      chronicleStage: {
        version: 2,
        modelExecutionBinding: {
          resolutionStatus: "requested-only",
          provider: "ollama",
          requestedModel: "qwen3:8b",
          effectiveModel: null,
        },
        modelBindingDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
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
        stageExecution: {
          parentStageExecutionId: "stage-execution-1",
        },
      },
    });
    expect(bound.metadata?.chronicleStage).not.toHaveProperty(
      "repairParentStageExecutionId",
    );
  });

  it("records terminal digests and statuses without retaining response text", async () => {
    const terminal = await buildChronicleStageAuditTerminal({
      stageExecution: parent,
      ...digests,
      responseText: '{"observations":[]}',
      parseStatus: "parsed",
      terminalStatus: "succeeded",
    });

    expect(terminal).toMatchObject({
      version: 2,
      contextSetDigest: digests.contextSetDigest,
      componentContractDigest: digests.componentContractDigest,
      finalRequestDigest: digests.finalRequestDigest,
      responseDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      parseStatus: "parsed",
      terminalStatus: "succeeded",
      modelExecutionBinding: {
        resolutionStatus: "unresolved",
      },
      modelBindingDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      stageExecutionReceiptDigest: expect.stringMatching(
        /^sha256:[0-9a-f]{64}$/,
      ),
    });
    expect(terminal).not.toHaveProperty("responseText");
    expect(JSON.stringify(terminal)).not.toContain("observations");
  });

  it("fails closed when the audit digest seam is not a SHA-256 digest", async () => {
    expect(() =>
      bindChronicleStageAuditContext(
        {
          projectId: parent.projectId,
          pathId: "narrative_observation_extract",
        },
        parent,
        {
          ...digests,
          contextSetDigest: "sha256:context" as never,
        },
      ),
    ).toThrow(/digest/i);

    await expect(
      buildChronicleStageAuditTerminal({
        stageExecution: parent,
        ...digests,
        finalRequestDigest: "sha256:request" as never,
        responseText: '{"observations":[]}',
        parseStatus: "parsed",
        terminalStatus: "succeeded",
      }),
    ).rejects.toThrow(/digest/i);
  });

  it("builds a null-response terminal receipt for a durable pre-response failure", async () => {
    const terminal = await buildChronicleStageAuditNoResponseTerminal({
      stageExecution: parent,
      ...digests,
      terminalStatus: "failed",
    });

    expect(terminal).toMatchObject({
      responseDigest: null,
      parseStatus: "not-attempted",
      terminalStatus: "failed",
      stageExecutionReceiptDigest: expect.stringMatching(
        /^sha256:[0-9a-f]{64}$/,
      ),
    });
  });
});

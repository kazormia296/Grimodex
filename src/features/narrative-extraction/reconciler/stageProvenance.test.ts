import { describe, expect, it } from "vitest";

import {
  CHRONICLE_STAGE_MODEL_BINDING_DIGEST_DOMAIN,
  assertChronicleStageC1ClosureCompleteness,
  assertChronicleStageProvenanceClosureV1,
  assertChronicleStageProvenanceReachability,
  assertChronicleStageTerminalReceiptV1,
  buildChronicleStageProvenanceBindingV1,
  buildChronicleStageProvenanceClosureV1,
  buildChronicleStageTerminalReceiptV1,
  createStageModelExecutionBindingV1,
  createStageModelExecutionBindingFromRoute,
  digestStageModelExecutionBinding,
  type ChronicleStageParseStatus,
  type ChronicleStageTerminalStatus,
  type ChronicleStageTerminalReceiptV1,
} from "./stageProvenance";
import {
  createChildStageExecutionContext,
  createStageExecutionContext,
  NARRATIVE_STAGE_IDS,
} from "./stageExecution";

const DIGEST = `sha256:${"a".repeat(64)}` as const;
const RESPONSE_DIGEST = `sha256:${"b".repeat(64)}` as const;
const OTHER_DIGEST = `sha256:${"c".repeat(64)}` as const;

const rootExecution = createStageExecutionContext({
  projectId: "project-1",
  runId: "run-1",
  taskId: "task-1",
  attemptId: "attempt-1",
  stageId: NARRATIVE_STAGE_IDS.observationExtraction,
  stageExecutionId: "stage-root",
});

const requestedOnlyBinding = createStageModelExecutionBindingV1({
  provider: "ollama",
  requestedModel: "qwen3:8b",
  endpointBindingId: "ollama-local",
  apiVariant: "chat-completions",
  reasoningMode: "disabled",
  generationMode: "explicit",
  resolutionStatus: "requested-only",
});

async function receiptFor(
  stageExecution = rootExecution,
  modelExecutionBinding = requestedOnlyBinding,
  parseStatus: ChronicleStageParseStatus = "parsed",
  terminalStatus: ChronicleStageTerminalStatus = "succeeded",
  contextSetDigest = DIGEST,
  componentContractDigest = DIGEST,
  finalRequestDigest = DIGEST,
): Promise<ChronicleStageTerminalReceiptV1> {
  return buildChronicleStageTerminalReceiptV1({
    stageExecution,
    contextSetVersion: "chronicle.context-set/1",
    contextSetDigest,
    componentContractDigest,
    finalRequestDigest,
    modelExecutionBinding,
    responseDigest: RESPONSE_DIGEST,
    parseStatus,
    terminalStatus,
  });
}

describe("Chronicle stage provenance/model binding contract", () => {
  it("keeps request identity separate from model binding identity", async () => {
    const otherModel = createStageModelExecutionBindingV1({
      ...requestedOnlyBinding,
      requestedModel: "qwen3:14b",
    });
    const firstDigest =
      await digestStageModelExecutionBinding(requestedOnlyBinding);
    const secondDigest = await digestStageModelExecutionBinding(otherModel);

    expect(firstDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(secondDigest).not.toBe(firstDigest);
    expect(CHRONICLE_STAGE_MODEL_BINDING_DIGEST_DOMAIN).toBe(
      "chronicle-stage-model-binding/1",
    );
  });

  it("requires explicit nulls for unresolved and never accepts URL/credential endpoint bindings", () => {
    expect(
      createStageModelExecutionBindingV1({
        provider: null,
        endpointBindingId: null,
        requestedModel: null,
        effectiveModel: null,
        modelFingerprint: null,
        apiVariant: null,
        reasoningMode: null,
        generationMode: "provider-default",
        resolutionStatus: "unresolved",
      }),
    ).toMatchObject({
      resolutionStatus: "unresolved",
      provider: null,
      requestedModel: null,
      effectiveModel: null,
      modelFingerprint: null,
    });

    expect(() =>
      createStageModelExecutionBindingV1({
        ...requestedOnlyBinding,
        endpointBindingId: "https://user:secret@example.invalid/v1",
      }),
    ).toThrow(/endpoint|URL|credential/i);
    expect(() =>
      createStageModelExecutionBindingV1({
        ...requestedOnlyBinding,
        endpointBindingId: "endpoint-secret-token",
      }),
    ).not.toThrow();
    for (const endpointBindingId of [
      "sk-12345678",
      "ghp_012345678901234567890123456789012345",
      "AIzaSy01234567890123456789012345678901234",
    ]) {
      expect(() =>
        createStageModelExecutionBindingV1({
          ...requestedOnlyBinding,
          endpointBindingId,
        }),
      ).toThrow(/credential|safe/i);
    }
    expect(JSON.stringify(requestedOnlyBinding)).not.toContain("http");
  });

  it.each([
    "provider",
    "requestedModel",
    "effectiveModel",
    "modelFingerprint",
    "apiVariant",
    "reasoningMode",
  ] as const)(
    "rejects credential-shaped values in %s without redaction",
    (field) => {
      for (const value of [
        "Bearer secret-token",
        "Bearer abcdef==",
        "sk-12345678",
        "api_key=secret-value",
        "authorization: Bearer secret-value",
        "access_token=secret-value",
        "password=secret-value",
        "ghp_012345678901234567890123456789012345",
        "github_pat_012345678901234567890123456789012345",
        "glpat-012345678901234567890123456789012345",
        "xoxb-012345678901234567890123456789012345",
        "AKIA0123456789ABCDEF",
        "hf_012345678901234567890123456789012345",
      ]) {
        expect(() =>
          createStageModelExecutionBindingV1({
            ...requestedOnlyBinding,
            [field]: value,
          }),
        ).toThrow(/safe non-empty token|credential/i);
      }
    },
  );

  it("keeps valid namespaced and revision model identifiers", () => {
    expect(
      createStageModelExecutionBindingV1({
        ...requestedOnlyBinding,
        provider: "openrouter",
        requestedModel: "openai/gpt@2026-08-01",
        effectiveModel: null,
        modelFingerprint: null,
        resolutionStatus: "requested-only",
      }),
    ).toMatchObject({ requestedModel: "openai/gpt@2026-08-01" });
    expect(
      createStageModelExecutionBindingV1({
        ...requestedOnlyBinding,
        requestedModel: "qwen3:8b",
      }),
    ).toMatchObject({ requestedModel: "qwen3:8b" });
  });

  it("fails closed for resolution status contradictions and keeps fingerprints meaningful", async () => {
    expect(() =>
      createStageModelExecutionBindingV1({
        ...requestedOnlyBinding,
        resolutionStatus: "fingerprinted",
        modelFingerprint: null,
      }),
    ).toThrow(/fingerprint/i);
    expect(() =>
      createStageModelExecutionBindingV1({
        ...requestedOnlyBinding,
        resolutionStatus: "provider-reported",
        effectiveModel: null,
      }),
    ).toThrow(/effectiveModel/i);
    expect(() =>
      createStageModelExecutionBindingV1({
        ...requestedOnlyBinding,
        provider: null,
        effectiveModel: "qwen3:8b",
        modelFingerprint: `sha256:${"e".repeat(64)}`,
        resolutionStatus: "fingerprinted",
      }),
    ).toThrow(/provider|model/i);
    expect(() =>
      createStageModelExecutionBindingV1({
        ...requestedOnlyBinding,
        effectiveModel: "qwen3:8b",
        modelFingerprint: `sha256:${"e".repeat(64)}`,
        resolutionStatus: "provider-reported",
      }),
    ).toThrow(/fingerprint/i);
    expect(() =>
      createStageModelExecutionBindingV1({
        resolutionStatus: "unresolved",
        generationMode: "explicit",
      }),
    ).toThrow(/generationMode|provider-default/i);
    expect(() =>
      createStageModelExecutionBindingV1({
        ...requestedOnlyBinding,
        resolutionStatus: "requested-only",
        provider: null,
      }),
    ).toThrow(/provider/i);

    const sameTagDifferentFingerprint = createStageModelExecutionBindingV1({
      ...requestedOnlyBinding,
      effectiveModel: "qwen3:8b",
      modelFingerprint: `sha256:${"c".repeat(64)}`,
      resolutionStatus: "fingerprinted",
    });
    expect(sameTagDifferentFingerprint.modelFingerprint).not.toBe(
      requestedOnlyBinding.modelFingerprint,
    );
    const sameTagDifferentFingerprintDigest =
      await digestStageModelExecutionBinding(sameTagDifferentFingerprint);
    const requestedOnlyDigest =
      await digestStageModelExecutionBinding(requestedOnlyBinding);
    expect(sameTagDifferentFingerprintDigest).not.toBe(requestedOnlyDigest);
  });

  it("normalizes partial route metadata and preserves namespaced model revisions", () => {
    expect(
      createStageModelExecutionBindingFromRoute(
        {
          provider: "anthropic",
          model: "anthropic/claude-3.5",
        },
        { provider: "anthropic", model: "anthropic/claude-3.5" },
      ),
    ).toMatchObject({
      resolutionStatus: "requested-only",
      generationMode: "provider-default",
    });
    expect(
      createStageModelExecutionBindingFromRoute(
        {
          provider: "anthropic",
          model: "anthropic/claude-3.5",
        },
        {
          provider: "anthropic",
          model: "anthropic/claude-3.5",
          reasoningEffort: "high",
        },
      ),
    ).toMatchObject({
      resolutionStatus: "requested-only",
      generationMode: "explicit",
      reasoningMode: "reasoning-effort:high",
    });
    expect(
      createStageModelExecutionBindingFromRoute({
        provider: "openrouter",
        model: null,
        endpointId: "openrouter-default",
      }),
    ).toMatchObject({
      resolutionStatus: "unresolved",
      provider: null,
      endpointBindingId: null,
      requestedModel: null,
    });
    expect(
      createStageModelExecutionBindingV1({
        provider: "openrouter",
        requestedModel: "anthropic/claude-3.5@revision-1",
        modelFingerprint: `sha256:${"d".repeat(64)}`,
        effectiveModel: "anthropic/claude-3.5@revision-1",
        resolutionStatus: "fingerprinted",
      }),
    ).toMatchObject({ resolutionStatus: "fingerprinted" });
  });

  it("fails closed for terminal parse/status contradictions", async () => {
    await expect(
      receiptFor(rootExecution, requestedOnlyBinding, "invalid", "succeeded"),
    ).rejects.toThrow(/inconsistent|parseStatus/i);
    await expect(
      receiptFor(rootExecution, requestedOnlyBinding, "parsed", "failed"),
    ).rejects.toThrow(/inconsistent|parseStatus/i);
    await expect(
      receiptFor(rootExecution, requestedOnlyBinding, "parsed", "cancelled"),
    ).rejects.toThrow(/inconsistent|parseStatus/i);
  });

  it("pins terminal stage topology and repair parent presence", async () => {
    const unknownStage = createStageExecutionContext({
      ...rootExecution,
      stageId: "unknown-stage",
      stageExecutionId: "stage-unknown",
    });
    await expect(receiptFor(unknownStage)).rejects.toThrow(
      /stageId|unsupported/i,
    );

    const rootRepair = createStageExecutionContext({
      ...rootExecution,
      stageId: NARRATIVE_STAGE_IDS.structuredRepair,
      stageExecutionId: "stage-repair-root",
    });
    await expect(receiptFor(rootRepair)).rejects.toThrow(
      /parentStageExecutionId/i,
    );

    const nonRepairChild = createChildStageExecutionContext(
      rootExecution,
      NARRATIVE_STAGE_IDS.observationExtraction,
      "stage-observation-child",
    );
    await expect(receiptFor(nonRepairChild)).rejects.toThrow(
      /parentStageExecutionId|non-repair/i,
    );
  });

  it("rejects unknown nested stage execution fields at the terminal boundary", async () => {
    const receipt = await receiptFor();
    await expect(
      assertChronicleStageTerminalReceiptV1({
        ...receipt,
        stageExecution: {
          ...receipt.stageExecution,
          unratified: "hidden",
        },
      }),
    ).rejects.toThrow(/unknown field.*unratified/i);
  });

  it.each([
    ["failed", "not-attempted"],
    ["cancelled", "not-attempted"],
    ["skipped", "not-attempted"],
  ] as const)(
    "represents %s without a response digest",
    async (terminalStatus, parseStatus) => {
      const receipt = await buildChronicleStageTerminalReceiptV1({
        stageExecution: rootExecution,
        contextSetVersion: "chronicle.context-set/1",
        contextSetDigest: DIGEST,
        componentContractDigest: DIGEST,
        finalRequestDigest: DIGEST,
        modelExecutionBinding: requestedOnlyBinding,
        responseDigest: null,
        parseStatus,
        terminalStatus,
      });
      await expect(
        assertChronicleStageTerminalReceiptV1(receipt),
      ).resolves.toBeUndefined();
      expect(receipt.responseDigest).toBeNull();
    },
  );

  it("seals terminal receipts and represents repair lineage through the child parent field", async () => {
    const repairExecution = createChildStageExecutionContext(
      rootExecution,
      NARRATIVE_STAGE_IDS.structuredRepair,
      "stage-repair",
    );
    const rootReceipt = await receiptFor(
      rootExecution,
      requestedOnlyBinding,
      "invalid",
      "failed",
    );
    const repairReceipt = await receiptFor(repairExecution, {
      ...requestedOnlyBinding,
      requestedModel: "repair-model",
    });

    expect(rootReceipt.stageExecutionReceiptDigest).toMatch(
      /^sha256:[0-9a-f]{64}$/u,
    );
    expect(repairReceipt.stageExecution.parentStageExecutionId).toBe(
      rootExecution.stageExecutionId,
    );
    expect(repairReceipt).not.toHaveProperty("repairChildStageExecutionId");
    expect(repairReceipt.modelBindingDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("canonicalizes closure receipt refs and proves Envelope run/task reachability", async () => {
    const closure = await buildChronicleStageProvenanceClosureV1({
      projectId: rootExecution.projectId,
      runId: rootExecution.runId,
      ownerTaskId: rootExecution.taskId,
      ownerAttemptId: rootExecution.attemptId,
      receipts: [await receiptFor()],
    });
    const provenanceBinding = buildChronicleStageProvenanceBindingV1({
      projectId: rootExecution.projectId,
      runId: rootExecution.runId,
      taskId: rootExecution.taskId,
      closure,
    });

    expect(closure.receiptRefs).toEqual([
      {
        stageExecutionId: rootExecution.stageExecutionId,
        stageExecutionReceiptDigest:
          closure.receipts[0]!.stageExecutionReceiptDigest,
      },
    ]);
    await expect(
      assertChronicleStageProvenanceReachability({
        execution: rootExecution,
        closure,
        provenanceBinding,
        envelope: {
          revisionBasis: {
            runId: rootExecution.runId,
            taskId: rootExecution.taskId,
          },
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("allows upstream observation and synthesis task receipts while keeping repair lineage local", async () => {
    const observationExecution = createStageExecutionContext({
      projectId: "project-1",
      runId: "run-1",
      taskId: "task-observation",
      attemptId: "attempt-observation",
      stageId: NARRATIVE_STAGE_IDS.observationExtraction,
      stageExecutionId: "stage-observation",
    });
    const synthesisExecution = createStageExecutionContext({
      projectId: "project-1",
      runId: "run-1",
      taskId: "task-synthesis",
      attemptId: "attempt-synthesis",
      stageId: NARRATIVE_STAGE_IDS.eventSynthesis,
      stageExecutionId: "stage-synthesis",
    });
    const repairExecution = createChildStageExecutionContext(
      synthesisExecution,
      NARRATIVE_STAGE_IDS.structuredRepair,
      "stage-repair-synthesis",
    );
    const closure = await buildChronicleStageProvenanceClosureV1({
      projectId: "project-1",
      runId: "run-1",
      ownerTaskId: synthesisExecution.taskId,
      ownerAttemptId: synthesisExecution.attemptId,
      receipts: [
        await receiptFor(observationExecution),
        await receiptFor(
          synthesisExecution,
          requestedOnlyBinding,
          "invalid",
          "failed",
        ),
        await receiptFor(repairExecution),
      ],
    });
    const provenanceBinding = buildChronicleStageProvenanceBindingV1({
      projectId: "project-1",
      runId: "run-1",
      taskId: synthesisExecution.taskId,
      closure,
    });

    await expect(
      assertChronicleStageProvenanceReachability({
        execution: synthesisExecution,
        closure,
        provenanceBinding,
        envelope: {
          revisionBasis: {
            runId: synthesisExecution.runId,
            taskId: synthesisExecution.taskId,
          },
        },
      }),
    ).resolves.toBeUndefined();
    expect(
      closure.receipts.map(
        (receipt) => receipt.stageExecution.stageExecutionId,
      ),
    ).toEqual([
      "stage-observation",
      "stage-repair-synthesis",
      "stage-synthesis",
    ]);
  });

  it("requires C1 observation and synthesis coverage while retaining repair children", async () => {
    const observationExecution = createStageExecutionContext({
      projectId: "project-c1",
      runId: "run-c1",
      taskId: "task-observation",
      attemptId: "attempt-observation",
      stageId: NARRATIVE_STAGE_IDS.observationExtraction,
      stageExecutionId: "c1-observation",
    });
    const synthesisExecution = createStageExecutionContext({
      projectId: "project-c1",
      runId: "run-c1",
      taskId: "task-synthesis",
      attemptId: "attempt-synthesis",
      stageId: NARRATIVE_STAGE_IDS.eventSynthesis,
      stageExecutionId: "c1-synthesis",
    });
    const repairExecution = createChildStageExecutionContext(
      synthesisExecution,
      NARRATIVE_STAGE_IDS.structuredRepair,
      "c1-repair",
    );
    const closure = await buildChronicleStageProvenanceClosureV1({
      projectId: "project-c1",
      runId: "run-c1",
      ownerTaskId: synthesisExecution.taskId,
      ownerAttemptId: synthesisExecution.attemptId,
      receipts: [
        await receiptFor(observationExecution),
        await receiptFor(
          synthesisExecution,
          requestedOnlyBinding,
          "invalid",
          "failed",
        ),
        await receiptFor(repairExecution),
      ],
    });
    const c1Execution = {
      projectId: "project-c1",
      runId: "run-c1",
      taskId: synthesisExecution.taskId,
      attemptId: synthesisExecution.attemptId,
      contextSetDigest: DIGEST,
      componentContractDigest: DIGEST,
      finalRequestDigest: DIGEST,
    };
    await expect(
      assertChronicleStageC1ClosureCompleteness(closure, c1Execution),
    ).resolves.toBeUndefined();
    const missingObservation = await buildChronicleStageProvenanceClosureV1({
      projectId: "project-c1",
      runId: "run-c1",
      ownerTaskId: synthesisExecution.taskId,
      ownerAttemptId: synthesisExecution.attemptId,
      receipts: [
        await receiptFor(
          synthesisExecution,
          requestedOnlyBinding,
          "invalid",
          "failed",
        ),
      ],
    });
    await expect(
      assertChronicleStageC1ClosureCompleteness(
        missingObservation,
        c1Execution,
      ),
    ).rejects.toThrow(/owner synthesis|observation/i);

    const missingRepair = await buildChronicleStageProvenanceClosureV1({
      projectId: "project-c1",
      runId: "run-c1",
      ownerTaskId: synthesisExecution.taskId,
      ownerAttemptId: synthesisExecution.attemptId,
      receipts: [
        await receiptFor(observationExecution),
        await receiptFor(
          synthesisExecution,
          requestedOnlyBinding,
          "invalid",
          "failed",
        ),
      ],
    });
    await expect(
      assertChronicleStageC1ClosureCompleteness(missingRepair, c1Execution),
    ).rejects.toThrow(/successful.*event|repair|terminal path/i);

    const swappedDigestClosure = await buildChronicleStageProvenanceClosureV1({
      projectId: "project-c1",
      runId: "run-c1",
      ownerTaskId: synthesisExecution.taskId,
      ownerAttemptId: synthesisExecution.attemptId,
      receipts: [
        await receiptFor(observationExecution),
        await receiptFor(
          synthesisExecution,
          requestedOnlyBinding,
          "invalid",
          "failed",
          OTHER_DIGEST,
          DIGEST,
          DIGEST,
        ),
        await receiptFor(repairExecution),
      ],
    });
    await expect(
      assertChronicleStageC1ClosureCompleteness(
        swappedDigestClosure,
        c1Execution,
      ),
    ).rejects.toThrow(/digest|owner synthesis/i);
  });

  it("rejects duplicate, tampered, noncanonical, missing-parent, and owner-mismatch closures", async () => {
    const rootReceipt = await receiptFor(
      rootExecution,
      requestedOnlyBinding,
      "invalid",
      "failed",
    );
    const repairExecution = createChildStageExecutionContext(
      rootExecution,
      NARRATIVE_STAGE_IDS.structuredRepair,
      "stage-repair",
    );
    const repairReceipt = await receiptFor(repairExecution);
    const closure = await buildChronicleStageProvenanceClosureV1({
      projectId: rootExecution.projectId,
      runId: rootExecution.runId,
      ownerTaskId: rootExecution.taskId,
      ownerAttemptId: rootExecution.attemptId,
      receipts: [repairReceipt, rootReceipt],
    });

    await expect(
      assertChronicleStageProvenanceClosureV1({
        ...closure,
        receipts: [...closure.receipts, closure.receipts[0]!],
      }),
    ).rejects.toThrow(/duplicate|canonical|receipt/i);
    await expect(
      assertChronicleStageProvenanceClosureV1({
        ...closure,
        receipts: [
          { ...closure.receipts[0]!, responseDigest: DIGEST },
          closure.receipts[1]!,
        ],
      }),
    ).rejects.toThrow(/digest|tamper/i);
    await expect(
      assertChronicleStageProvenanceClosureV1({
        ...closure,
        receipts: [...closure.receipts].reverse(),
      }),
    ).rejects.toThrow(/canonical|order/i);
    await expect(
      assertChronicleStageProvenanceClosureV1({
        ...closure,
        receipts: [
          {
            ...repairReceipt,
            stageExecution: {
              ...repairReceipt.stageExecution,
              parentStageExecutionId: "missing-parent",
            },
          },
          rootReceipt,
        ],
      }),
    ).rejects.toThrow(/parent|digest/i);
    await expect(
      assertChronicleStageProvenanceReachability({
        execution: { ...rootExecution, taskId: "other-task" },
        closure,
        provenanceBinding: buildChronicleStageProvenanceBindingV1({
          projectId: rootExecution.projectId,
          runId: rootExecution.runId,
          taskId: rootExecution.taskId,
          closure,
        }),
      }),
    ).rejects.toThrow(/task|owner|reach/i);

    const unknownStageExecution = createStageExecutionContext({
      ...rootExecution,
      stageId: "unknown-stage",
      stageExecutionId: "unknown-stage-execution",
    });
    await expect(receiptFor(unknownStageExecution)).rejects.toThrow(
      /unsupported|stageId/i,
    );
  });
});

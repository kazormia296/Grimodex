import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CITATION_ID_OBSERVATION_EVIDENCE_MODE } from "@/application/narrative-extraction/aiTasks/citationIdObservation";
import { runObservationExtractionTask } from "@/application/narrative-extraction/aiTasks/runObservationExtractionTask";
import {
  canonicalObservationParseStatus,
  diagnoseCitationIdObservationResponse,
  type ChronicleResponseDiagnostic,
} from "./responseDiagnostics";
import { prepareObservationEvalCase } from "./observationAdapter";
import {
  diagnosticParityFailure,
  runTaskWithResponseDiagnostics,
  runTaskWithInvocationTracking,
  summarizeProductionLiveCases,
  terminalPipelineFailure,
  type TaskDiagnosticCapture,
  writeProductionLiveArtifacts,
} from "./chronicleProductionDiagnostics";
import type { NarrativeEvalCaseV1 } from "./types";

vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: () => false,
}));
vi.mock("@/features/license/gate", () => ({
  blockIfUnlicensed: () => false,
}));
vi.mock("@/features/ai-usage/recordAiUsage", () => ({
  recordAiUsage: vi.fn(),
}));
vi.mock("@/features/chat/modelRouting", () => ({
  resolveRoleSendOverride: () => ({
    apiVariant: undefined,
    model: "test-model",
    provider: "test-provider",
    endpointId: undefined,
  }),
}));
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: {
    getState: () => ({ projectId: "narrative-eval-citation" }),
  },
}));

type TestDiagnostic = {
  readonly output: { readonly acceptedCount: number };
};

function syntheticCase(): NarrativeEvalCaseV1 {
  return {
    schemaVersion: 1,
    id: "chronicle.micro.citation-id-live-diagnostics",
    scope: { slice: "chronicle", tier: "micro" },
    locale: "ja-JP",
    timezone: "Asia/Tokyo",
    frozenTime: "2026-09-05T00:00:00.000Z",
    coverage: {
      mode: "complete",
      includedDocumentIds: ["scene-a"],
      omittedDocumentIds: [],
    },
    documents: [
      {
        id: "scene-a",
        title: "第一場",
        text: "門が開いた。",
      },
    ],
    expected: {
      observations: {
        required: [
          {
            id: "synthetic-a",
            semanticKey: "observation:門が開いた:0",
            dimensions: {
              eventDetection: true,
              actuality: "actual",
              attribution: "narrator",
              narrativeFrame: "story-world",
              evidence: [{ documentId: "scene-a", quote: "門が開いた。" }],
            },
          },
        ],
        forbidden: [],
      },
    },
    criticalViolationClasses: [],
  };
}

describe("Chronicle production response diagnostics", () => {
  it("diagnoses a rejected response before preserving the task rejection", async () => {
    const responseText = '{"observations":[{"sourceRef":"foreign"}]}';
    const diagnostic: TestDiagnostic = { output: { acceptedCount: 0 } };
    const captures: TaskDiagnosticCapture<TestDiagnostic>[] = [];
    const rejection = new Error("citation-id response rejected");
    let parseStatus: "parsed" | "invalid" | undefined;
    const diagnose = vi.fn(async (response: string) => {
      expect(response).toBe(responseText);
      return diagnostic;
    });

    const task = async (): Promise<readonly unknown[]> => {
      parseStatus = "invalid";
      throw rejection;
    };

    await expect(
      runTaskWithResponseDiagnostics({
        runTask: task,
        getResponseText: () => responseText,
        getParseStatus: () => parseStatus,
        diagnose,
        expectedParseStatus: () => "invalid",
        acceptedCount: (value) => value.output.acceptedCount,
        resultCount: (value) => value.length,
        onDiagnostic: (capture) => captures.push(capture),
      }),
    ).rejects.toBe(rejection);

    expect(diagnose).toHaveBeenCalledOnce();
    expect(captures).toEqual([
      {
        diagnostic,
        expectedParseStatus: "invalid",
        parseStatus: "invalid",
      },
    ]);
    expect(JSON.stringify(captures)).not.toContain(rejection.message);
  });

  it("attributes a pre-response rejection to the active invocation", async () => {
    const failures: ReturnType<typeof terminalPipelineFailure>[] = [];
    const firstInvocation = {
      stageId: "narrative_observation_extract",
      invocationIndex: 0,
      parseStatus: "parsed" as const,
    };
    await runTaskWithInvocationTracking(
      firstInvocation,
      async () => [],
      (invocation) => failures.push(terminalPipelineFailure(invocation)),
    );
    const secondInvocation = {
      stageId: "narrative_observation_extract",
      invocationIndex: 1,
      parseStatus: null,
    };
    const rejection = new Error("provider response unavailable");
    await expect(
      runTaskWithInvocationTracking(
        secondInvocation,
        async () => {
          throw rejection;
        },
        (invocation) => failures.push(terminalPipelineFailure(invocation)),
      ),
    ).rejects.toBe(rejection);

    expect(failures).toEqual([
      {
        kind: "terminal-pipeline-failure",
        stageId: "narrative_observation_extract",
        invocationIndex: 1,
        parseStatus: null,
      },
    ]);
  });

  it("keeps diagnostic parity failures bounded for report persistence", () => {
    expect(
      diagnosticParityFailure(["narrative_observation_extract:0"], []),
    ).toEqual({
      kind: "diagnostic-parity-failure",
      dispatchCount: 1,
      diagnosticCount: 0,
      dispatchKeys: ["narrative_observation_extract:0"],
      diagnosticKeys: [],
    });
    expect(
      diagnosticParityFailure(
        ["narrative_observation_extract:0"],
        ["narrative_observation_extract:0"],
      ),
    ).toBeUndefined();
  });

  it("persists diagnostic failure metadata before the certification assertion fails", async () => {
    const responseText = '{"observations":[]}';
    const invocation = {
      stageId: "narrative_observation_extract",
      invocationIndex: 0,
      parseStatus: "parsed" as const,
    };
    const captures: TaskDiagnosticCapture<TestDiagnostic>[] = [];
    const diagnosticFailure = new Error("diagnostic parser failed");
    const failures: ReturnType<typeof terminalPipelineFailure>[] = [];

    await expect(
      runTaskWithInvocationTracking(
        invocation,
        () =>
          runTaskWithResponseDiagnostics({
            runTask: async () => [],
            getResponseText: () => responseText,
            getParseStatus: () => invocation.parseStatus,
            diagnose: (): TestDiagnostic => {
              throw diagnosticFailure;
            },
            expectedParseStatus: () => "parsed",
            acceptedCount: (value) => value.output.acceptedCount,
            resultCount: (result) => result.length,
            onDiagnostic: (capture) => captures.push(capture),
          }),
        (failedInvocation) =>
          failures.push(terminalPipelineFailure(failedInvocation)),
      ),
    ).rejects.toBe(diagnosticFailure);

    expect(captures).toHaveLength(0);
    expect(failures).toEqual([
      {
        kind: "terminal-pipeline-failure",
        stageId: invocation.stageId,
        invocationIndex: invocation.invocationIndex,
        parseStatus: "parsed",
      },
    ]);
    const parityFailure = diagnosticParityFailure(
      ["narrative_observation_extract:0"],
      [],
    );
    if (!parityFailure) throw new Error("expected diagnostic parity failure");

    const accounting = summarizeProductionLiveCases(
      [{ evaluation: { passed: true } }],
      [
        {
          caseId: "chronicle.micro.diagnostic-failure",
          terminalFailure: parityFailure,
        },
      ],
      0,
      2,
    );
    const report = {
      schemaVersion: 1,
      mode: "chronicle-production-live",
      caseCount: accounting.caseCount,
      certificationEligible: false,
      summary: accounting.summary,
      cases: [{ evaluation: { passed: true } }],
      failedCases: [
        {
          caseId: "chronicle.micro.diagnostic-failure",
          terminalFailure: parityFailure,
        },
      ],
    };
    const diagnosticsReport = {
      schemaVersion: 1,
      mode: "chronicle-production-live-diagnostics",
      certificationEligible: false,
      caseCount: 2,
      cases: [
        { caseId: "chronicle.micro.success", stageDiagnostics: [] },
        {
          caseId: "chronicle.micro.diagnostic-failure",
          stageDiagnostics: [],
          terminalFailure: parityFailure,
        },
      ],
    };
    const artifactRoot = await mkdtemp(
      path.join(os.tmpdir(), "chronicle-production-diagnostic-failure-"),
    );
    try {
      await writeProductionLiveArtifacts({
        artifactRoot,
        reportJson: `${JSON.stringify(report)}\n`,
        diagnosticsReport,
      });
      const savedReport = JSON.parse(
        await readFile(path.join(artifactRoot, "report.json"), "utf8"),
      ) as typeof report;
      const savedDiagnostics = JSON.parse(
        await readFile(path.join(artifactRoot, "diagnostics.json"), "utf8"),
      ) as typeof diagnosticsReport;
      expect(savedReport.caseCount).toBe(2);
      expect(savedReport.certificationEligible).toBe(false);
      expect(savedReport.summary).toEqual({
        passed: 1,
        failed: 1,
        parseFailureCount: 0,
      });
      expect(savedReport.failedCases[0]?.terminalFailure).toEqual(
        parityFailure,
      );
      expect(savedDiagnostics.cases[1]?.terminalFailure).toEqual(parityFailure);
      expect(JSON.stringify(savedReport)).not.toContain(
        diagnosticFailure.message,
      );
      expect(JSON.stringify(savedDiagnostics)).not.toContain(
        diagnosticFailure.message,
      );
      expect(() => {
        if (
          savedReport.certificationEligible !== true ||
          savedReport.summary.failed !== 0
        ) {
          throw new Error(
            "certification remains ineligible after terminal failure",
          );
        }
      }).toThrow("certification remains ineligible after terminal failure");
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("uses the canonical citation-ID task and diagnostic for a foreign alias", async () => {
    const prepared = await prepareObservationEvalCase(syntheticCase(), {
      evidenceMode: CITATION_ID_OBSERVATION_EVIDENCE_MODE,
    });
    const window = prepared.windows[0];
    if (!window?.windowId) throw new Error("prepared window is missing");
    const binding = prepared.evidenceSpanCatalogBindingsByWindowId?.get(
      window.windowId,
    );
    if (!binding) throw new Error("citation binding is missing");
    const alias = binding.aliases[0]?.alias;
    if (!alias) throw new Error("citation alias is missing");
    const boundWindow = binding.windows[0];
    if (!boundWindow) throw new Error("bound window is missing");
    const responseText = JSON.stringify({
      observations: [
        {
          localId: "foreign-alias",
          evidenceRefs: [alias, "Eforeign-token-999"],
          assertion: {
            attribution: "narrator",
            narrativeFrame: "story-world",
          },
          payload: {
            predicate: "門が開いた",
            actuality: "actual",
            participants: [],
            temporalExpressions: [],
            durationKind: "instant",
          },
        },
      ],
    });
    let observedResponse: string | undefined;
    let parseStatus: "parsed" | "invalid" | undefined;
    const captures: TaskDiagnosticCapture<ChronicleResponseDiagnostic>[] = [];

    await expect(
      runTaskWithResponseDiagnostics({
        runTask: () =>
          runObservationExtractionTask({
            windows: [
              {
                windowId: boundWindow.windowId,
                sourceRef: boundWindow.sourceView.ref,
                text: boundWindow.text,
              },
            ],
            projectId:
              "narrative-eval:chronicle.micro.citation-id-live-diagnostics",
            repairOnFailure: false,
            evidenceMode: CITATION_ID_OBSERVATION_EVIDENCE_MODE,
            evidenceSpanCatalogBinding: binding,
            send: async () => {
              observedResponse = responseText;
              return { text: responseText, inputTokens: 1, outputTokens: 1 };
            },
            onParseStatus: (status) => {
              parseStatus = status;
            },
          }),
        getResponseText: () => observedResponse,
        getParseStatus: () => parseStatus,
        diagnose: (text) =>
          diagnoseCitationIdObservationResponse(text, {
            invocationIndex: 3,
            binding,
          }),
        expectedParseStatus: canonicalObservationParseStatus,
        acceptedCount: (diagnostic) => diagnostic.output.acceptedCount,
        resultCount: (result) => result.length,
        onDiagnostic: (capture) => captures.push(capture),
      }),
    ).rejects.toThrow(/foreign|unknown|citation|reference/i);

    expect(captures).toHaveLength(1);
    const capture = captures[0];
    expect(capture?.expectedParseStatus).toBe("invalid");
    expect(capture?.parseStatus).toBe("invalid");
    expect(capture?.diagnostic).toMatchObject({
      stageId: "narrative_observation_extract",
      invocationIndex: 3,
      evidenceMode: CITATION_ID_OBSERVATION_EVIDENCE_MODE,
      citation: { status: "rejected", resolvedCount: 0 },
      output: { acceptedCount: 0 },
    });
    expect(capture?.diagnostic.refs.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "UNKNOWN_EVIDENCE_REF" }),
      ]),
    );
  });

  it("serializes terminal failed cases without changing case accounting", async () => {
    const failedCase = {
      caseId: "chronicle.micro.failed",
      terminalFailure: {
        kind: "terminal-pipeline-failure",
        stageId: "narrative_observation_extract",
        invocationIndex: 0,
        parseStatus: "invalid",
      },
    } as const;
    const successfulCases = [{ evaluation: { passed: true } }];
    const accounting = summarizeProductionLiveCases(
      successfulCases,
      [failedCase],
      1,
      2,
    );
    const report = {
      schemaVersion: 1,
      mode: "chronicle-production-live",
      caseCount: accounting.caseCount,
      summary: accounting.summary,
      cases: successfulCases,
      failedCases: [failedCase],
    };
    const diagnosticsReport = {
      schemaVersion: 1,
      mode: "chronicle-production-live-diagnostics",
      caseCount: 2,
      cases: [
        { caseId: "chronicle.micro.success", stageDiagnostics: [] },
        {
          caseId: failedCase.caseId,
          stageDiagnostics: [{ parseStatus: "invalid" }],
          terminalFailure: failedCase.terminalFailure,
        },
      ],
    };
    const artifactRoot = await mkdtemp(
      path.join(os.tmpdir(), "chronicle-production-diagnostics-"),
    );
    try {
      await writeProductionLiveArtifacts({
        artifactRoot,
        reportJson: `${JSON.stringify(report)}\n`,
        diagnosticsReport,
      });
      const savedReport = JSON.parse(
        await readFile(path.join(artifactRoot, "report.json"), "utf8"),
      ) as typeof report;
      const savedDiagnostics = JSON.parse(
        await readFile(path.join(artifactRoot, "diagnostics.json"), "utf8"),
      ) as typeof diagnosticsReport;
      expect(savedReport.caseCount).toBe(2);
      expect(savedReport.summary).toEqual({
        passed: 1,
        failed: 1,
        parseFailureCount: 1,
      });
      expect(savedReport.cases).toHaveLength(1);
      expect(savedReport.failedCases).toEqual([failedCase]);
      expect(savedDiagnostics.caseCount).toBe(2);
      expect(savedDiagnostics.cases).toHaveLength(2);
      expect(JSON.stringify(savedReport)).not.toContain("apiKey");
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });
});

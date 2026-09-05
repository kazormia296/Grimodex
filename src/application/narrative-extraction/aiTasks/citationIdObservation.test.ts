import { describe, expect, it, vi } from "vitest";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { buildNarrativeCorpusSnapshot } from "@/features/narrative-extraction/source/buildSnapshot";
import { buildNarrativeSourceView } from "@/features/narrative-extraction/source/sourceView";
import {
  createStageExecutionContext,
  NARRATIVE_STAGE_IDS,
} from "@/features/narrative-extraction/reconciler/stageExecution";
import { sha256Digest } from "@/features/narrative-extraction/source/digest";
import {
  bindEvidenceSpanCatalog,
  buildEvidenceSpanCatalog,
} from "@/features/narrative-extraction/evidence/spanCatalog";
import {
  CITATION_ID_OBSERVATION_EVIDENCE_MODE,
  validateCitationIdBinding,
} from "./citationIdObservation";
import { runObservationExtractionTask } from "./runObservationExtractionTask";

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
  useTreeStore: { getState: () => ({ projectId: "citation-task-test" }) },
}));

function prose(text: string): string {
  return JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
}

async function fixture(): Promise<{
  readonly binding: Awaited<ReturnType<typeof bindEvidenceSpanCatalog>>;
  readonly window: {
    readonly windowId: string;
    readonly sourceRef: string;
    readonly text: string;
  };
}> {
  const built = await buildNarrativeCorpusSnapshot({
    snapshotId: "snapshot-citation-task",
    language: "ja",
    origin: { kind: "grimodex-project", projectId: "citation-task-test" },
    documents: [
      {
        sourceKey: "project:scene:one",
        parentSourceKey: null,
        title: "一場",
        orderIndex: 0,
        proseMirrorJson: prose("同じ文。門が開いた。"),
        origin: {
          kind: "project-node",
          projectId: "citation-task-test",
          nodeId: "scene-one",
          sourceVersion: 1,
          sourceUpdatedAt: "2026-09-05T00:00:00.000Z",
          sourceUri: null,
        },
      },
    ],
    omissions: [],
    createdAt: "2026-09-05T00:00:00.000Z",
  });
  expect(built.ok).toBe(true);
  if (!built.ok) throw new Error("fixture snapshot failed");
  const document = built.snapshot.documents[0];
  if (!document) throw new Error("fixture document missing");
  const sourceView = await buildNarrativeSourceView({
    ref: "S0001",
    document,
    documentRange: { start: 0, end: document.canonical.text.length },
  });
  const catalog = await buildEvidenceSpanCatalog(built.snapshot);
  const binding = await bindEvidenceSpanCatalog(built.snapshot, catalog, {
    requestIdentity: "citation-task-request",
    windows: [
      {
        windowId: "window-001",
        documentRef: document.ref,
        sourceView,
        ownedRanges: [{ start: 0, end: document.canonical.text.length }],
        contextRanges: [],
      },
    ],
  });
  return {
    binding,
    window: {
      windowId: "window-001",
      sourceRef: sourceView.ref,
      text: sourceView.text,
    },
  };
}

function responseWithEvidenceRefs(
  evidenceRefs: readonly string[],
  predicate = "門が開いた",
  localId = "obs-1",
): string {
  return JSON.stringify({
    observations: [
      {
        localId,
        evidenceRefs,
        assertion: { attribution: "narrator", narrativeFrame: "story-world" },
        payload: {
          predicate,
          actuality: "actual",
          participants: [],
          temporalExpressions: [],
          durationKind: "instant",
        },
      },
    ],
  });
}

function response(
  alias: string,
  predicate = "門が開いた",
  localId = "obs-1",
): string {
  return responseWithEvidenceRefs([alias], predicate, localId);
}

describe("citation-ID observation runtime", () => {
  it("materializes code-owned occurrence text and rejects an unknown alias", async () => {
    const { binding, window } = await fixture();
    const occurrence = binding.aliases[1];
    const alias = occurrence?.alias;
    if (!alias) throw new Error("fixture alias missing");

    await expect(
      runObservationExtractionTask({
        windows: [window],
        evidenceMode: CITATION_ID_OBSERVATION_EVIDENCE_MODE,
        evidenceSpanCatalogBinding: binding,
        projectId: "citation-task-test",
        repairOnFailure: false,
        createId: () => "unused-create-id",
        send: async () => ({
          text: response(alias),
          inputTokens: 1,
          outputTokens: 1,
        }),
      }),
    ).resolves.toMatchObject([
      {
        evidence: [
          { sourceRef: occurrence.canonicalSourceRef, quote: "門が開いた。" },
        ],
      },
    ]);

    await expect(
      runObservationExtractionTask({
        windows: [window],
        evidenceMode: CITATION_ID_OBSERVATION_EVIDENCE_MODE,
        evidenceSpanCatalogBinding: binding,
        projectId: "citation-task-test",
        repairOnFailure: false,
        send: async () => ({
          text: response("Eforeign-token-999"),
          inputTokens: 1,
          outputTokens: 1,
        }),
      }),
    ).rejects.toThrow(/foreign|unknown|reference|citation/i);
  });

  it("captures the window roster before an async transport can mutate it", async () => {
    const { binding, window } = await fixture();
    const alias = binding.aliases[0]?.alias;
    if (!alias) throw new Error("fixture alias missing");
    const mutableInput: {
      windows: { windowId: string; sourceRef: string; text: string }[];
    } = { windows: [window] };
    let rendered = "";
    const result = await runObservationExtractionTask({
      windows: mutableInput.windows,
      evidenceMode: CITATION_ID_OBSERVATION_EVIDENCE_MODE,
      evidenceSpanCatalogBinding: binding,
      projectId: "citation-task-test",
      repairOnFailure: false,
      send: async (messages) => {
        rendered = String(messages[0]?.content ?? "");
        mutableInput.windows[0]!.text = "呼び出し後に改変された本文";
        return { text: response(alias), inputTokens: 1, outputTokens: 1 };
      },
    });
    expect(rendered).toContain(alias);
    expect(rendered).toContain("同じ文。");
    expect(result[0]?.evidence[0]?.quote).toBe("同じ文。");
  });

  it("keeps multiple code-issued IDs on one observation without inventing quote text", async () => {
    const { binding, window } = await fixture();
    const occurrences = binding.aliases.slice(0, 2);
    const aliases = occurrences.map((occurrence) => occurrence.alias);
    if (aliases.length !== 2) throw new Error("fixture aliases missing");
    let rendered = "";
    const result = await runObservationExtractionTask({
      windows: [window],
      evidenceMode: CITATION_ID_OBSERVATION_EVIDENCE_MODE,
      evidenceSpanCatalogBinding: binding,
      projectId: "citation-task-test",
      repairOnFailure: false,
      send: async (messages) => {
        rendered = String(messages[0]?.content ?? "");
        return {
          text: responseWithEvidenceRefs(
            aliases,
            "二つの本文範囲をまとめた主張",
          ),
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    });

    expect(rendered).toContain("意味単位");
    expect(result).toMatchObject([
      {
        payload: { predicate: "二つの本文範囲をまとめた主張" },
        evidence: [
          { sourceRef: occurrences[0]?.canonicalSourceRef, quote: "同じ文。" },
          {
            sourceRef: occurrences[1]?.canonicalSourceRef,
            quote: "門が開いた。",
          },
        ],
      },
    ]);
  });

  it("does not confuse a valid empty result with an invalid foreign-reference result, and repairs on the same binding", async () => {
    const { binding, window } = await fixture();
    const alias = binding.aliases[0]?.alias;
    if (!alias) throw new Error("fixture alias missing");

    await expect(
      runObservationExtractionTask({
        windows: [window],
        evidenceMode: CITATION_ID_OBSERVATION_EVIDENCE_MODE,
        evidenceSpanCatalogBinding: binding,
        projectId: "citation-task-test",
        repairOnFailure: false,
        send: async () => ({
          text: JSON.stringify({ observations: [] }),
          inputTokens: 1,
          outputTokens: 1,
        }),
      }),
    ).resolves.toEqual([]);

    await expect(
      runObservationExtractionTask({
        windows: [window],
        evidenceMode: CITATION_ID_OBSERVATION_EVIDENCE_MODE,
        evidenceSpanCatalogBinding: binding,
        projectId: "citation-task-test",
        send: async () => ({
          text: response("Eforeign-token-999"),
          inputTokens: 1,
          outputTokens: 1,
        }),
        repairSend: async (messages) => {
          const prompt = String(messages[0]?.content ?? "");
          expect(prompt).toContain(alias);
          return {
            text: response(alias, "修復後も保持する完全な主張"),
            inputTokens: 1,
            outputTokens: 1,
          };
        },
      }),
    ).resolves.toMatchObject([
      { payload: { predicate: "修復後も保持する完全な主張" } },
    ]);
  });

  it("revalidates a reused caller binding after it is tampered", async () => {
    const { binding } = await fixture();
    const persisted = JSON.parse(JSON.stringify(binding)) as typeof binding;
    await expect(validateCitationIdBinding(persisted)).resolves.toBeDefined();
    const segment = persisted.windows[0]?.segments[0];
    if (!segment) throw new Error("fixture segment missing");
    (segment as { text: string }).text = "tampered";
    await expect(validateCitationIdBinding(persisted)).rejects.toThrow(
      /stale|forged|binding|segment/i,
    );
  });

  it("records the generated localId in audit selections when the model leaves it blank", async () => {
    const { binding, window } = await fixture();
    const occurrence = binding.aliases[1];
    const alias = occurrence?.alias;
    if (!alias) throw new Error("fixture alias missing");
    vi.mocked(recordAiUsage).mockClear();
    const stageExecution = createStageExecutionContext({
      projectId: "citation-task-test",
      runId: "run-citation-audit",
      taskId: "task-observation",
      attemptId: "attempt-observation",
      stageId: NARRATIVE_STAGE_IDS.observationExtraction,
      stageExecutionId: "stage-observation",
    });

    const result = await runObservationExtractionTask({
      windows: [window],
      evidenceMode: CITATION_ID_OBSERVATION_EVIDENCE_MODE,
      evidenceSpanCatalogBinding: binding,
      projectId: "citation-task-test",
      stageExecution,
      createId: () => "generated-observation-id",
      repairOnFailure: false,
      send: async () => ({
        text: response(alias, "門が開いた", ""),
        inputTokens: 1,
        outputTokens: 1,
      }),
    });

    expect(result[0]?.localId).toBe("generated-observation-id");
    const usageCall = vi.mocked(recordAiUsage).mock.calls.at(-1)?.[0];
    expect(usageCall?.metadata).toMatchObject({
      citationEvidence: {
        selectionStatus: "resolved",
        selections: [
          {
            localId: "generated-observation-id",
            evidenceRefs: [alias],
            canonicalSourceRefs: [occurrence.canonicalSourceRef],
          },
        ],
      },
    });
  });

  it("separates the failed parent response from repaired citation selections", async () => {
    const { binding, window } = await fixture();
    const occurrence = binding.aliases[1];
    const alias = occurrence?.alias;
    if (!alias) throw new Error("fixture alias missing");
    vi.mocked(recordAiUsage).mockClear();
    const parentStageExecution = createStageExecutionContext({
      projectId: "citation-task-test",
      runId: "run-citation-repair-audit",
      taskId: "task-observation",
      attemptId: "attempt-observation",
      stageId: NARRATIVE_STAGE_IDS.observationExtraction,
      stageExecutionId: "stage-observation-parent",
    });
    const initialResponse = response("Eforeign-token-999");
    const repairedJson = response(alias, "修復後の主張", "  ");
    const repairedResponse = `\n\n\`\`\`json\n${repairedJson}\n\`\`\`\n`;
    let createIdCalls = 0;
    const result = await runObservationExtractionTask({
      windows: [window],
      evidenceMode: CITATION_ID_OBSERVATION_EVIDENCE_MODE,
      evidenceSpanCatalogBinding: binding,
      projectId: "citation-task-test",
      stageExecution: parentStageExecution,
      createId: () => {
        createIdCalls += 1;
        return "generated-repair-observation-id";
      },
      send: async () => ({
        text: initialResponse,
        inputTokens: 1,
        outputTokens: 1,
      }),
      repairSend: async () => ({
        text: repairedResponse,
        inputTokens: 1,
        outputTokens: 1,
      }),
    });

    expect(result[0]?.localId).toBe("generated-repair-observation-id");
    expect(createIdCalls).toBe(1);
    const auditInputs = vi
      .mocked(recordAiUsage)
      .mock.calls.map(
        ([input]) => input as { metadata?: Record<string, unknown> },
      );
    const parentAudit = auditInputs.find(
      (input) =>
        (
          input.metadata?.chronicleStageAudit as
            | { stageExecution?: { stageId?: string } }
            | undefined
        )?.stageExecution?.stageId ===
        NARRATIVE_STAGE_IDS.observationExtraction,
    );
    const childAudit = auditInputs.find(
      (input) =>
        (
          input.metadata?.chronicleStageAudit as
            | { stageExecution?: { stageId?: string } }
            | undefined
        )?.stageExecution?.stageId === NARRATIVE_STAGE_IDS.structuredRepair,
    );
    expect(parentAudit?.metadata).toMatchObject({
      citationEvidence: { selectionStatus: "rejected" },
      repairResolution: {
        kind: "chronicle.observation-repair-resolution@1",
        childResponseDigest: await sha256Digest(repairedResponse),
        childStageExecution: {
          stageId: NARRATIVE_STAGE_IDS.structuredRepair,
          parentStageExecutionId: "stage-observation-parent",
        },
        childCitationEvidence: {
          selectionStatus: "resolved",
          selections: [
            {
              localId: "generated-repair-observation-id",
              evidenceRefs: [alias],
              canonicalSourceRefs: [occurrence.canonicalSourceRef],
            },
          ],
        },
      },
    });
    expect(
      (parentAudit?.metadata?.citationEvidence as { selections?: unknown[] })
        ?.selections,
    ).toBeUndefined();
    expect(childAudit?.metadata).toMatchObject({
      citationEvidence: {
        mode: CITATION_ID_OBSERVATION_EVIDENCE_MODE,
        bindingToken: binding.bindingToken,
      },
    });
    expect(parentAudit?.metadata?.chronicleStageAudit).toMatchObject({
      responseDigest: await sha256Digest(initialResponse),
    });
    expect(childAudit?.metadata?.chronicleStageAudit).toMatchObject({
      responseDigest: await sha256Digest(repairedResponse),
    });
  });
});

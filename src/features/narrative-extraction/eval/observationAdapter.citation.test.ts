import { describe, expect, it, vi } from "vitest";
import {
  CITATION_ID_OBSERVATION_EVIDENCE_MODE,
  LEGACY_OBSERVATION_EVIDENCE_MODE,
} from "@/application/narrative-extraction/aiTasks/citationIdObservation";
import { runObservationExtractionTask } from "@/application/narrative-extraction/aiTasks/runObservationExtractionTask";
import {
  evaluateCitationIdObservationResponse,
  prepareObservationEvalCase,
  runProductionObservationExtraction,
} from "./observationAdapter";
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

function syntheticCase(): NarrativeEvalCaseV1 {
  return {
    schemaVersion: 1,
    id: "chronicle.micro.citation-id-adapter",
    scope: { slice: "chronicle", tier: "micro" },
    locale: "ja-JP",
    timezone: "Asia/Tokyo",
    frozenTime: "2026-09-05T00:00:00.000Z",
    coverage: {
      mode: "complete",
      includedDocumentIds: ["scene-a", "scene-b"],
      omittedDocumentIds: [],
    },
    documents: [
      {
        id: "scene-a",
        title: "第一場",
        text: "同じ文。門が開いた。",
      },
      {
        id: "scene-b",
        title: "第二場",
        text: "同じ文。灯りが消えた。",
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
              evidence: [{ documentId: "scene-a", quote: "同じ文。" }],
            },
          },
        ],
        forbidden: [],
      },
    },
    criticalViolationClasses: [],
  };
}

function bindingForWindow(
  prepared: Awaited<ReturnType<typeof prepareObservationEvalCase>>,
  index: number,
) {
  const window = prepared.windows[index];
  if (!window?.windowId) throw new Error("prepared window id is missing");
  const binding = prepared.evidenceSpanCatalogBindingsByWindowId?.get(
    window.windowId,
  );
  if (!binding) throw new Error(`binding missing for ${window.windowId}`);
  return { binding, window };
}

function singleIdResponse(alias: string, predicate: string): string {
  return JSON.stringify({
    observations: [
      {
        localId: predicate,
        evidenceRefs: [alias],
        assertion: {
          attribution: "narrator",
          narrativeFrame: "story-world",
        },
        payload: {
          // Deliberately does not repeat the quote. The quote must be restored
          // from the catalog while the complete, possibly wrong claim stays.
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

describe("observationAdapter citation-ID mode", () => {
  it("prepares a sealed catalog and keeps explicit legacy mode compatible", async () => {
    const idPrepared = await prepareObservationEvalCase(syntheticCase(), {
      evidenceMode: CITATION_ID_OBSERVATION_EVIDENCE_MODE,
    });
    expect(idPrepared.evidenceMode).toBe(CITATION_ID_OBSERVATION_EVIDENCE_MODE);
    expect(idPrepared.evidenceSpanCatalog).toBeDefined();
    expect(idPrepared.evidenceSpanCatalogBindingsByWindowId?.size).toBe(
      idPrepared.windows.length,
    );
    expect(idPrepared.versions).not.toEqual(
      (await prepareObservationEvalCase(syntheticCase())).versions,
    );
    expect(idPrepared.versions.prompt).toBe(
      "narrative-observation-extract/citation-id-v3",
    );

    const legacyPrepared = await prepareObservationEvalCase(syntheticCase(), {
      evidenceMode: LEGACY_OBSERVATION_EVIDENCE_MODE,
    });
    expect(legacyPrepared.evidenceMode).toBe(LEGACY_OBSERVATION_EVIDENCE_MODE);
    expect(legacyPrepared.prompt).toContain("sourceRef");
    expect(legacyPrepared.prompt).not.toContain("evidenceRefs");
  });

  it("routes request-bound IDs through the canonical task and restores repeated occurrences", async () => {
    const prepared = await prepareObservationEvalCase(syntheticCase(), {
      evidenceMode: CITATION_ID_OBSERVATION_EVIDENCE_MODE,
    });
    const first = bindingForWindow(prepared, 0).binding;
    const second = bindingForWindow(prepared, 1).binding;
    const aliasA = first.aliases[0]?.alias;
    const aliasB = second.aliases[0]?.alias;
    if (!aliasA || !aliasB) throw new Error("citation aliases are missing");
    expect(aliasA).toMatch(/^E[a-f0-9]{12}-\d{3}$/);
    expect(aliasB).toMatch(/^E[a-f0-9]{12}-\d{3}$/);
    expect(aliasA).not.toBe(aliasB);

    const renderedPrompts: string[] = [];
    let invocation = 0;
    const { observations, evaluation } =
      await runProductionObservationExtraction(prepared, async (messages) => {
        renderedPrompts.push(
          typeof messages[0]?.content === "string" ? messages[0].content : "",
        );
        const response =
          invocation === 0
            ? singleIdResponse(aliasA, "門が開いた")
            : singleIdResponse(aliasB, "scene-b-claim");
        invocation += 1;
        return {
          text: response,
          inputTokens: 1,
          outputTokens: 1,
        };
      });

    expect(renderedPrompts).toHaveLength(2);
    expect(renderedPrompts[0]).toContain(aliasA);
    expect(renderedPrompts[1]).toContain(aliasB);
    expect(renderedPrompts.join("\n")).not.toContain("E000001");
    expect(observations).toHaveLength(2);
    expect(observations.map((entry) => entry.payload.predicate)).toEqual([
      "門が開いた",
      "scene-b-claim",
    ]);
    expect(observations.map((entry) => entry.evidence[0]?.sourceRef)).toEqual([
      "E000001",
      "E000003",
    ]);
    expect(observations.map((entry) => entry.evidence[0]?.quote)).toEqual([
      "同じ文。",
      "同じ文。",
    ]);
    for (const observation of observations) {
      for (const evidence of observation.evidence) {
        expect(prepared.allowedSourceRefs.has(evidence.sourceRef)).toBe(true);
      }
    }
    expect(evaluation.evidenceQuotesExact).toBe(true);
  });

  it("rejects foreign or mixed IDs without converting failure into an empty success", async () => {
    const prepared = await prepareObservationEvalCase(syntheticCase(), {
      evidenceMode: CITATION_ID_OBSERVATION_EVIDENCE_MODE,
    });
    const { binding } = bindingForWindow(prepared, 0);
    const alias = binding.aliases[0]?.alias;
    if (!alias) throw new Error("citation alias is missing");
    const invalid = JSON.stringify({
      observations: [
        {
          localId: "mixed",
          evidenceRefs: [alias, "Eforeign-token-999"],
          assertion: {
            attribution: "narrator",
            narrativeFrame: "story-world",
          },
          payload: {
            predicate: "kept claim",
            actuality: "actual",
            participants: [],
            temporalExpressions: [],
            durationKind: "instant",
          },
        },
      ],
    });

    const evaluation = await evaluateCitationIdObservationResponse(
      prepared,
      invalid,
      binding,
    );
    expect(evaluation.parseStatus).toBe("invalid");
    expect(evaluation.actual.observations).toEqual([]);
    expect(evaluation.criticalViolations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ classId: "parse-failure-as-empty" }),
      ]),
    );
    await expect(
      runProductionObservationExtraction(prepared, async () => ({
        text: invalid,
        inputTokens: 1,
        outputTokens: 1,
      })),
    ).rejects.toThrow(/foreign|unknown|citation|reference/i);
  });

  it("uses the canonical task parser rather than accepting model-written quotes", async () => {
    const prepared = await prepareObservationEvalCase(syntheticCase(), {
      evidenceMode: CITATION_ID_OBSERVATION_EVIDENCE_MODE,
    });
    const { binding } = bindingForWindow(prepared, 0);
    const alias = binding.aliases[0]?.alias;
    if (!alias) throw new Error("citation alias is missing");
    const captured = vi.fn();
    const result = await runObservationExtractionTask({
      windows: (() => {
        const window = binding.windows[0];
        if (!window) throw new Error("bound window missing");
        return [
          {
            windowId: window.windowId,
            sourceRef: window.sourceView.ref,
            text: window.text,
          },
        ];
      })(),
      evidenceMode: CITATION_ID_OBSERVATION_EVIDENCE_MODE,
      evidenceSpanCatalogBinding: binding,
      projectId: "narrative-eval:chronicle.micro.citation-id-adapter",
      repairOnFailure: false,
      send: async () => ({
        text: JSON.stringify({
          observations: [
            {
              localId: "written-quote",
              evidenceRefs: [alias],
              assertion: {
                attribution: "narrator",
                narrativeFrame: "story-world",
              },
              payload: {
                predicate: "wrong meaning is retained",
                actuality: "actual",
                participants: [],
                temporalExpressions: [],
                durationKind: "instant",
              },
            },
          ],
        }),
        inputTokens: 1,
        outputTokens: 1,
      }),
      onParseStatus: captured,
    });
    expect(captured).toHaveBeenCalledWith("parsed");
    expect(result[0]?.evidence[0]).toEqual({
      sourceRef: "E000001",
      quote: "同じ文。",
    });
    expect(result[0]?.payload.predicate).toBe("wrong meaning is retained");
  });
});

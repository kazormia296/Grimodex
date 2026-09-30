import { describe, expect, it } from "vitest";
import {
  CITATION_ID_OBSERVATION_EVIDENCE_MODE,
  parseCitationIdObservationJson,
} from "@/application/narrative-extraction/aiTasks/citationIdObservation";
import { parseRawChronicleEventObservationEvidenceRefs } from "@/features/chronicle/extraction/schemas";
import { prepareObservationEvalCase } from "./observationAdapter";
import {
  canonicalObservationParseStatus,
  canonicalSynthesisParseStatus,
  diagnoseCitationIdObservationResponse,
  diagnoseObservationResponse,
  diagnoseSynthesisResponse,
} from "./responseDiagnostics";
import type { NarrativeEvalCaseV1 } from "./types";

const OBSERVATION = {
  localId: "obs-1",
  evidence: [{ sourceRef: "S0001", quote: "門が倒れた。" }],
  assertion: {
    attribution: "narrator",
    narrativeFrame: "story-world",
  },
  payload: {
    predicate: "門が倒れた",
    actuality: "actual",
    participants: [],
    temporalExpressions: [],
    durationKind: "instant",
  },
} as const;

const SYNTHESIS_EVENT = {
  observationRefs: ["obs-1"],
  titleSuggestion: "門の倒壊",
  summary: "門が倒れた",
  actuality: "actual",
  significance: "major",
} as const;

function citationDiagnosticCase(): NarrativeEvalCaseV1 {
  return {
    schemaVersion: 1,
    id: "chronicle.micro.citation-id-diagnostics",
    scope: { slice: "chronicle", tier: "micro" },
    locale: "ja-JP",
    timezone: "Asia/Tokyo",
    frozenTime: "2026-09-05T00:00:00.000Z",
    coverage: {
      mode: "complete",
      includedDocumentIds: ["diagnostic-scene"],
      omittedDocumentIds: [],
    },
    documents: [
      {
        id: "diagnostic-scene",
        title: "診断用場面",
        text: "門が開いた。",
      },
    ],
    expected: { observations: { required: [], forbidden: [] } },
    criticalViolationClasses: [],
  };
}

function citationResponse(
  alias: string,
  localId: unknown = "citation-diagnostic-observation",
): string {
  return JSON.stringify({
    observations: [
      {
        localId,
        evidenceRefs: [alias],
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
}

describe("Chronicle response diagnostics", () => {
  it("diagnoses citation-ID responses with mode-aware schema and resolver status", async () => {
    const prepared = await prepareObservationEvalCase(
      citationDiagnosticCase(),
      {
        evidenceMode: CITATION_ID_OBSERVATION_EVIDENCE_MODE,
      },
    );
    const binding = prepared.evidenceSpanCatalogBinding;
    const alias = binding?.aliases[0]?.alias;
    if (!binding || !alias)
      throw new Error("citation diagnostic binding missing");

    const valid = await diagnoseCitationIdObservationResponse(
      citationResponse(alias),
      { invocationIndex: 13, binding },
    );
    expect(valid).toMatchObject({
      stageId: "narrative_observation_extract",
      invocationIndex: 13,
      evidenceMode: CITATION_ID_OBSERVATION_EVIDENCE_MODE,
      schema: { status: "valid", errors: [] },
      refs: { status: "valid", checkedCount: 1, rejectedCount: 0 },
      citation: {
        status: "resolved",
        checkedCount: 1,
        rejectedCount: 0,
        resolvedCount: 1,
      },
      output: { candidateCount: 1, acceptedCount: 1, rejectedCount: 0 },
    });
    expect(canonicalObservationParseStatus(valid)).toBe("parsed");
    expect(JSON.stringify(valid)).not.toContain(alias);

    const foreign = await diagnoseCitationIdObservationResponse(
      citationResponse(`${alias}-foreign`),
      { invocationIndex: 14, binding },
    );
    expect(foreign).toMatchObject({
      evidenceMode: CITATION_ID_OBSERVATION_EVIDENCE_MODE,
      schema: { status: "valid", errors: [] },
      refs: { status: "invalid", checkedCount: 1, rejectedCount: 1 },
      citation: { status: "rejected", rejectedCount: 1, resolvedCount: 0 },
      output: { candidateCount: 1, acceptedCount: 0, rejectedCount: 1 },
    });
    expect(canonicalObservationParseStatus(foreign)).toBe("invalid");
    expect(JSON.stringify(foreign)).not.toContain(`${alias}-foreign`);

    for (const [invocationIndex, localId] of [
      [15, ""],
      [16, "  "],
    ] as const) {
      const rawValue = JSON.parse(citationResponse(alias, localId)) as {
        readonly observations: readonly unknown[];
      };
      const rawSchema = parseRawChronicleEventObservationEvidenceRefs(
        rawValue.observations[0],
      );
      expect(rawSchema.ok).toBe(localId.length > 0);
      expect(parseCitationIdObservationJson(rawValue).ok).toBe(true);

      const blankLocalId = await diagnoseCitationIdObservationResponse(
        citationResponse(alias, localId),
        { invocationIndex, binding },
      );
      expect(blankLocalId).toMatchObject({
        schema: { status: "valid", errors: [] },
        citation: {
          status: "resolved",
          checkedCount: 1,
          rejectedCount: 0,
          resolvedCount: 1,
        },
        output: {
          candidateCount: 1,
          schemaAcceptedCount: 1,
          acceptedCount: 1,
        },
      });
      expect(canonicalObservationParseStatus(blankLocalId)).toBe("parsed");
    }

    const wrongLocalIdType = await diagnoseCitationIdObservationResponse(
      citationResponse(alias, 7),
      { invocationIndex: 17, binding },
    );
    expect(wrongLocalIdType).toMatchObject({
      schema: { status: "invalid" },
      citation: { status: "not-evaluated" },
      output: { candidateCount: 1, schemaAcceptedCount: 0, acceptedCount: 0 },
    });
    expect(canonicalObservationParseStatus(wrongLocalIdType)).toBe("invalid");

    const missingEvidenceRefs = JSON.stringify({
      observations: [
        {
          localId: "missing-evidence-refs",
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
    const missingRequired = await diagnoseCitationIdObservationResponse(
      missingEvidenceRefs,
      { invocationIndex: 18, binding },
    );
    expect(missingRequired).toMatchObject({
      schema: { status: "invalid" },
      citation: { status: "not-evaluated" },
      output: { candidateCount: 1, schemaAcceptedCount: 0, acceptedCount: 0 },
    });
    expect(canonicalObservationParseStatus(missingRequired)).toBe("invalid");
  });

  it("classifies missing, unbalanced, and malformed JSON without retaining response text", () => {
    const missing = diagnoseObservationResponse("説明だけ", {
      invocationIndex: 1,
      allowedSourceRefs: new Set(["S0001"]),
    });
    expect(missing.json).toEqual({
      status: "object-not-found",
      rootType: "unknown",
    });
    expect(missing.schema).toEqual({
      status: "not-evaluated",
      errors: [],
    });
    expect(missing.refs).toEqual({
      status: "not-evaluated",
      checkedCount: 0,
      rejectedCount: 0,
      errors: [],
    });

    const unbalanced = diagnoseObservationResponse('{"observations":[', {
      invocationIndex: 2,
      allowedSourceRefs: new Set(["S0001"]),
    });
    expect(unbalanced.json).toEqual({
      status: "unbalanced-object",
      rootType: "unknown",
    });

    const malformed = diagnoseObservationResponse('{"observations":[}],', {
      invocationIndex: 3,
      allowedSourceRefs: new Set(["S0001"]),
    });
    expect(malformed.json).toEqual({
      status: "syntax-error",
      rootType: "unknown",
    });
    expect(JSON.stringify(malformed)).not.toMatch(
      /説明だけ|observations.*\[\]|rawText|rawResponse|apiKey|authorization|Bearer/iu,
    );
  });

  it("reports schema/ref paths and valid-row salvage counts for observations", () => {
    const response = JSON.stringify({
      observations: [
        {
          ...OBSERVATION,
          localId: "bad-row",
          evidence: [{ sourceRef: "S9999", quote: "未知の参照" }],
          payload: { ...OBSERVATION.payload, actuality: "invented" },
        },
        OBSERVATION,
      ],
    });

    const diagnostic = diagnoseObservationResponse(response, {
      invocationIndex: 4,
      allowedSourceRefs: new Set(["S0001"]),
    });

    expect(diagnostic).toMatchObject({
      stageId: "narrative_observation_extract",
      invocationIndex: 4,
      json: { status: "object-found", rootType: "object" },
      schema: {
        status: "invalid",
        errors: [
          {
            code: "SCHEMA_INVALID",
            path: "observations[0].payload.actuality",
          },
        ],
      },
      refs: {
        status: "invalid",
        checkedCount: 2,
        rejectedCount: 1,
        errors: [
          {
            code: "UNKNOWN_SOURCE_REF",
            path: "observations[0].evidence[0].sourceRef",
          },
        ],
      },
      output: {
        candidateCount: 2,
        acceptedCount: 1,
        rejectedCount: 1,
        salvagedCount: 1,
      },
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(
      /S9999|未知の参照|invented/iu,
    );
  });

  it("runs the canonical schema parser for shape failures and separates row rejection from normalization drops", () => {
    const shapeFailure = diagnoseObservationResponse("{}", {
      invocationIndex: 5,
      allowedSourceRefs: new Set(["S0001"]),
    });
    expect(shapeFailure).toMatchObject({
      json: { status: "object-found", rootType: "object" },
      schema: {
        status: "invalid",
        errors: [{ code: "SCHEMA_TYPE", path: "observations" }],
      },
      refs: { status: "not-evaluated" },
      output: {
        candidateCount: 0,
        schemaAcceptedCount: 0,
        schemaRejectedCount: 0,
        normalizerDroppedCount: 0,
        acceptedCount: 0,
        rejectedCount: 0,
        salvagedCount: 0,
      },
    });

    const mixed = diagnoseObservationResponse(
      JSON.stringify({
        observations: [
          {
            ...OBSERVATION,
            localId: "unknown-ref",
            evidence: [{ sourceRef: "S9999", quote: "unknown" }],
          },
          {
            ...OBSERVATION,
            localId: "invalid-schema",
            payload: { ...OBSERVATION.payload, actuality: "invented" },
          },
          OBSERVATION,
        ],
      }),
      {
        invocationIndex: 6,
        allowedSourceRefs: new Set(["S0001"]),
      },
    );
    expect(mixed.output).toEqual({
      candidateCount: 3,
      schemaAcceptedCount: 2,
      schemaRejectedCount: 1,
      normalizerDroppedCount: 1,
      acceptedCount: 1,
      rejectedCount: 2,
      salvagedCount: 1,
    });
    expect(JSON.stringify(mixed)).not.toMatch(/S9999|invented|unknown-ref/iu);
  });

  it("distinguishes empty, all-filtered, and partially-filtered valid observation batches", () => {
    const empty = diagnoseObservationResponse(
      JSON.stringify({ observations: [] }),
      {
        invocationIndex: 7,
        allowedSourceRefs: new Set(["S0001"]),
      },
    );
    expect(empty).toMatchObject({
      schema: { status: "valid", errors: [] },
      refs: { status: "valid", checkedCount: 0, rejectedCount: 0 },
      output: {
        candidateCount: 0,
        schemaAcceptedCount: 0,
        schemaRejectedCount: 0,
        normalizerDroppedCount: 0,
        acceptedCount: 0,
        rejectedCount: 0,
        salvagedCount: 0,
      },
    });

    const allUnknown = diagnoseObservationResponse(
      JSON.stringify({
        observations: [
          {
            ...OBSERVATION,
            evidence: [{ sourceRef: "S9999", quote: "unknown" }],
          },
        ],
      }),
      {
        invocationIndex: 8,
        allowedSourceRefs: new Set(["S0001"]),
      },
    );
    expect(allUnknown).toMatchObject({
      schema: { status: "valid" },
      refs: { status: "invalid", checkedCount: 1, rejectedCount: 1 },
      output: {
        candidateCount: 1,
        schemaAcceptedCount: 1,
        schemaRejectedCount: 0,
        normalizerDroppedCount: 1,
        acceptedCount: 0,
        rejectedCount: 1,
        salvagedCount: 0,
      },
    });
    expect(canonicalObservationParseStatus(allUnknown)).toBe("parsed");

    const partiallyUnknown = diagnoseObservationResponse(
      JSON.stringify({
        observations: [
          {
            ...OBSERVATION,
            evidence: [
              { sourceRef: "S9999", quote: "unknown" },
              { sourceRef: "S0001", quote: "門が倒れた。" },
            ],
          },
        ],
      }),
      {
        invocationIndex: 9,
        allowedSourceRefs: new Set(["S0001"]),
      },
    );
    expect(partiallyUnknown).toMatchObject({
      schema: { status: "valid" },
      refs: { status: "invalid", checkedCount: 2, rejectedCount: 1 },
      output: {
        candidateCount: 1,
        schemaAcceptedCount: 1,
        schemaRejectedCount: 0,
        normalizerDroppedCount: 0,
        acceptedCount: 1,
        rejectedCount: 0,
        salvagedCount: 0,
      },
    });
    expect(canonicalObservationParseStatus(partiallyUnknown)).toBe("parsed");
    expect(JSON.stringify(partiallyUnknown)).not.toMatch(
      /S9999|unknown-ref|nested-secret/iu,
    );
  });

  it("keeps wrong-root and nested parser paths bounded to the production schema", () => {
    const wrongRoot = diagnoseObservationResponse("[]", {
      invocationIndex: 10,
      allowedSourceRefs: new Set(["S0001"]),
    });
    expect(wrongRoot).toMatchObject({
      json: { status: "root-not-object", rootType: "array" },
      schema: { status: "not-evaluated" },
    });

    const invalidRow = diagnoseObservationResponse(
      JSON.stringify({ observations: [null] }),
      {
        invocationIndex: 11,
        allowedSourceRefs: new Set(["S0001"]),
      },
    );
    expect(invalidRow.schema).toEqual({
      status: "invalid",
      errors: [{ code: "SCHEMA_TYPE", path: "observations[0].root" }],
    });

    const nestedSecret = diagnoseObservationResponse(
      JSON.stringify({
        observations: [
          {
            ...OBSERVATION,
            nestedSecret: "nested-secret",
          },
        ],
      }),
      {
        invocationIndex: 12,
        allowedSourceRefs: new Set(["S0001"]),
      },
    );
    expect(nestedSecret.schema.status).toBe("valid");
    expect(JSON.stringify(nestedSecret)).not.toContain("nested-secret");
  });

  it("keeps synthesis schema validity separate from cluster/ref diagnostics", () => {
    const diagnostic = diagnoseSynthesisResponse(
      JSON.stringify({
        clusterRef: "cluster-other",
        resolution: "single-event",
        events: [
          {
            ...SYNTHESIS_EVENT,
            observationRefs: ["obs-unknown"],
          },
        ],
      }),
      {
        invocationIndex: 2,
        clusterRef: "cluster-expected",
        allowedObservationRefs: new Set(["obs-1"]),
      },
    );

    expect(diagnostic).toMatchObject({
      stageId: "narrative_event_synthesize",
      invocationIndex: 2,
      json: { status: "object-found", rootType: "object" },
      schema: { status: "valid", errors: [] },
      refs: {
        status: "invalid",
        checkedCount: 1,
        rejectedCount: 1,
        errors: [
          {
            code: "CLUSTER_REF_MISMATCH",
            path: "clusterRef",
          },
          {
            code: "UNKNOWN_OBSERVATION_REF",
            path: "events[0].observationRefs[0]",
          },
        ],
      },
      output: {
        candidateCount: 1,
        acceptedCount: 0,
        rejectedCount: 1,
        salvagedCount: 0,
      },
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(
      /cluster-other|cluster-expected|obs-unknown/iu,
    );
    expect(canonicalSynthesisParseStatus(diagnostic)).toBe("invalid");

    const allUnknownRefs = diagnoseSynthesisResponse(
      JSON.stringify({
        clusterRef: "cluster-expected",
        resolution: "single-event",
        events: [
          {
            ...SYNTHESIS_EVENT,
            observationRefs: ["obs-unknown"],
          },
        ],
      }),
      {
        invocationIndex: 4,
        clusterRef: "cluster-expected",
        allowedObservationRefs: new Set(["obs-1"]),
      },
    );
    expect(allUnknownRefs).toMatchObject({
      schema: { status: "valid" },
      refs: {
        status: "invalid",
        checkedCount: 1,
        rejectedCount: 1,
        errors: [
          {
            code: "UNKNOWN_OBSERVATION_REF",
            path: "events[0].observationRefs[0]",
          },
        ],
      },
      output: {
        candidateCount: 1,
        schemaAcceptedCount: 1,
        schemaRejectedCount: 0,
        normalizerDroppedCount: 1,
        acceptedCount: 0,
        rejectedCount: 1,
        salvagedCount: 0,
      },
    });
    expect(canonicalSynthesisParseStatus(allUnknownRefs)).toBe("parsed");
  });

  it("reports synthesis schema errors and preserves only static field paths", () => {
    const diagnostic = diagnoseSynthesisResponse(
      JSON.stringify({
        clusterRef: "",
        resolution: "not-a-resolution",
        events: [
          {
            ...SYNTHESIS_EVENT,
            significance: "none",
            nestedSecret: "nested-secret",
          },
        ],
      }),
      {
        invocationIndex: 3,
        clusterRef: "cluster-expected",
        allowedObservationRefs: new Set(["obs-1"]),
      },
    );

    expect(diagnostic).toMatchObject({
      json: { status: "object-found", rootType: "object" },
      schema: {
        status: "invalid",
        errors: [
          { code: "SCHEMA_REQUIRED", path: "clusterRef" },
          { code: "SCHEMA_INVALID", path: "resolution" },
          {
            code: "SCHEMA_INVALID",
            path: "events[0].significance",
          },
        ],
      },
      refs: {
        status: "invalid",
        checkedCount: 1,
        rejectedCount: 0,
        errors: [{ code: "CLUSTER_REF_MISMATCH", path: "clusterRef" }],
      },
      output: {
        candidateCount: 1,
        schemaAcceptedCount: 0,
        schemaRejectedCount: 1,
        normalizerDroppedCount: 0,
        acceptedCount: 0,
        rejectedCount: 1,
        salvagedCount: 0,
      },
    });
    expect(JSON.stringify(diagnostic)).not.toContain("nested-secret");

    const mixed = diagnoseSynthesisResponse(
      JSON.stringify({
        clusterRef: "cluster-expected",
        resolution: "single-event",
        events: [{ ...SYNTHESIS_EVENT, significance: "none" }, SYNTHESIS_EVENT],
      }),
      {
        invocationIndex: 13,
        clusterRef: "cluster-expected",
        allowedObservationRefs: new Set(["obs-1"]),
      },
    );
    expect(mixed).toMatchObject({
      schema: {
        status: "invalid",
        errors: [
          {
            code: "SCHEMA_INVALID",
            path: "events[0].significance",
          },
        ],
      },
      refs: { status: "valid", checkedCount: 2, rejectedCount: 0 },
      output: {
        candidateCount: 2,
        schemaAcceptedCount: 1,
        schemaRejectedCount: 1,
        normalizerDroppedCount: 0,
        acceptedCount: 0,
        rejectedCount: 2,
        salvagedCount: 0,
      },
    });
    expect(canonicalSynthesisParseStatus(mixed)).toBe("invalid");
  });

  it("reports a valid synthesis response with normalized counts", () => {
    const diagnostic = diagnoseSynthesisResponse(
      JSON.stringify({
        clusterRef: "cluster-expected",
        resolution: "single-event",
        events: [SYNTHESIS_EVENT],
      }),
      {
        invocationIndex: 1,
        clusterRef: "cluster-expected",
        allowedObservationRefs: new Set(["obs-1"]),
      },
    );

    expect(diagnostic).toEqual({
      stageId: "narrative_event_synthesize",
      invocationIndex: 1,
      json: { status: "object-found", rootType: "object" },
      schema: { status: "valid", errors: [] },
      refs: {
        status: "valid",
        checkedCount: 1,
        rejectedCount: 0,
        errors: [],
      },
      output: {
        candidateCount: 1,
        schemaAcceptedCount: 1,
        schemaRejectedCount: 0,
        normalizerDroppedCount: 0,
        acceptedCount: 1,
        rejectedCount: 0,
        salvagedCount: 0,
      },
    });
  });
});

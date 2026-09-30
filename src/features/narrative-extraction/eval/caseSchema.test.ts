import { describe, expect, it } from "vitest";
import { validateNarrativeEvalCase } from "./caseSchema";

function validCase(): unknown {
  return {
    schemaVersion: 1,
    id: "chronicle.micro.rumor-vs-fact-001",
    scope: {
      slice: "chronicle",
      tier: "micro",
    },
    locale: "ja-JP",
    timezone: "Asia/Tokyo",
    frozenTime: "2026-08-10T00:00:00.000Z",
    coverage: {
      mode: "complete",
      includedDocumentIds: ["scene-001"],
      omittedDocumentIds: [],
    },
    documents: [
      {
        id: "scene-001",
        title: "鐘楼",
        text: "鐘が三度鳴った。旅人は『王が死んだらしい』と噂した。",
      },
    ],
    expected: {
      observations: {
        required: [
          {
            id: "required-bell-rang",
            semanticKey: "bell-rang",
            dimensions: {
              eventDetection: true,
              actuality: "actual",
              attribution: "narrator",
              narrativeFrame: "story-world",
              evidence: [
                {
                  documentId: "scene-001",
                  quote: "鐘が三度鳴った",
                },
              ],
              clustering: "bell-rang",
              significance: "minor",
              proposalGate: "propose",
            },
          },
        ],
        forbidden: [
          {
            id: "forbidden-rumor-promoted-to-fact",
            semanticKey: "king-died-rumor",
            dimensions: {
              actuality: "actual",
            },
          },
        ],
      },
    },
    criticalViolationClasses: [
      {
        id: "rumor-as-actual",
        description:
          "A reported rumor must not be promoted to story-world fact.",
        match: {
          semanticKey: "king-died-rumor",
          dimension: "actuality",
          value: "actual",
        },
      },
    ],
  };
}

function diagnosticCodes(result: ReturnType<typeof validateNarrativeEvalCase>) {
  if (result.ok) return [];
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

describe("validateNarrativeEvalCase", () => {
  it("accepts the complete, deterministic Narrative eval case contract", () => {
    const candidate = validCase();

    const result = validateNarrativeEvalCase(candidate);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      schemaVersion: 1,
      id: "chronicle.micro.rumor-vs-fact-001",
      scope: { slice: "chronicle", tier: "micro" },
      locale: "ja-JP",
      timezone: "Asia/Tokyo",
      frozenTime: "2026-08-10T00:00:00.000Z",
      coverage: { mode: "complete" },
      expected: {
        observations: {
          required: [{ semanticKey: "bell-rang" }],
          forbidden: [{ semanticKey: "king-died-rumor" }],
        },
      },
      criticalViolationClasses: [{ id: "rumor-as-actual" }],
    });
  });

  it.each([
    ["schemaVersion", { schemaVersion: 2 }, "CASE_SCHEMA_VERSION_UNSUPPORTED"],
    ["id", { id: "" }, "CASE_ID_INVALID"],
    ["scope", { scope: null }, "CASE_SCOPE_INVALID"],
    ["locale", { locale: "not_a_locale" }, "CASE_LOCALE_INVALID"],
    ["timezone", { timezone: "Mars/Olympus" }, "CASE_TIMEZONE_INVALID"],
    ["frozenTime", { frozenTime: "next Tuesday" }, "CASE_FROZEN_TIME_INVALID"],
  ])("rejects an invalid %s", (_name, replacement, expectedCode) => {
    const candidate = {
      ...(validCase() as Record<string, unknown>),
      ...replacement,
    };

    const result = validateNarrativeEvalCase(candidate);

    expect(result.ok).toBe(false);
    expect(diagnosticCodes(result)).toContain(expectedCode);
  });

  it("rejects duplicate document ids and coverage references outside the corpus", () => {
    const base = validCase() as Record<string, unknown>;
    const candidate = {
      ...base,
      coverage: {
        mode: "complete",
        includedDocumentIds: ["scene-001", "scene-missing"],
        omittedDocumentIds: [],
      },
      documents: [
        { id: "scene-001", title: "A", text: "本文A" },
        { id: "scene-001", title: "B", text: "本文B" },
      ],
    };

    const result = validateNarrativeEvalCase(candidate);

    expect(result.ok).toBe(false);
    expect(diagnosticCodes(result)).toEqual(
      expect.arrayContaining([
        "CASE_DOCUMENT_ID_DUPLICATE",
        "CASE_COVERAGE_DOCUMENT_UNKNOWN",
      ]),
    );
  });

  it("rejects evidence that cites an unknown document or a quote absent from it", () => {
    const candidate = validCase() as {
      expected: {
        observations: {
          required: Array<{
            dimensions: {
              evidence: Array<{ documentId: string; quote: string }>;
            };
          }>;
        };
      };
    };
    candidate.expected.observations.required[0].dimensions.evidence = [
      { documentId: "scene-missing", quote: "鐘が三度鳴った" },
      { documentId: "scene-001", quote: "本文にない引用" },
    ];

    const result = validateNarrativeEvalCase(candidate);

    expect(result.ok).toBe(false);
    expect(diagnosticCodes(result)).toEqual(
      expect.arrayContaining([
        "CASE_EVIDENCE_DOCUMENT_UNKNOWN",
        "CASE_EVIDENCE_QUOTE_NOT_EXACT",
      ]),
    );
  });

  it("requires both required and forbidden observation collections", () => {
    const base = validCase() as Record<string, unknown>;
    const candidate = {
      ...base,
      expected: {
        observations: {
          required: [],
        },
      },
    };

    const result = validateNarrativeEvalCase(candidate);

    expect(result.ok).toBe(false);
    expect(diagnosticCodes(result)).toContain(
      "CASE_FORBIDDEN_OBSERVATIONS_REQUIRED",
    );
  });

  it("rejects duplicate expectation ids and malformed critical violation classes", () => {
    const candidate = validCase() as {
      expected: {
        observations: {
          required: Array<Record<string, unknown>>;
          forbidden: Array<Record<string, unknown>>;
        };
      };
      criticalViolationClasses: Array<Record<string, unknown>>;
    };
    candidate.expected.observations.forbidden[0].id =
      candidate.expected.observations.required[0].id;
    candidate.criticalViolationClasses = [
      {
        id: "rumor-as-actual",
        description: "missing a deterministic matcher",
      },
    ];

    const result = validateNarrativeEvalCase(candidate);

    expect(result.ok).toBe(false);
    expect(diagnosticCodes(result)).toEqual(
      expect.arrayContaining([
        "CASE_EXPECTATION_ID_DUPLICATE",
        "CASE_CRITICAL_VIOLATION_MATCH_INVALID",
      ]),
    );
  });
});

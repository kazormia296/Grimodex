import { describe, expect, it } from "vitest";
import { validateNarrativeEvalCase } from "./caseSchema";
import {
  evaluateObservationResponse,
  prepareObservationEvalCase,
} from "./observationAdapter";

describe("observationAdapter", () => {
  it("accepts production-shaped JSON and rejects unknown source refs", async () => {
    const result = validateNarrativeEvalCase({
      schemaVersion: 1,
      id: "chronicle.micro.adapter-unit",
      scope: { slice: "chronicle", tier: "micro" },
      locale: "ja-JP",
      timezone: "Asia/Tokyo",
      frozenTime: "2026-08-10T00:00:00.000Z",
      coverage: {
        mode: "complete",
        includedDocumentIds: ["scene-a"],
        omittedDocumentIds: [],
      },
      documents: [
        {
          id: "scene-a",
          title: "北門",
          text: "北門の鎖が切れ、重い門扉が街路へ倒れた。",
        },
      ],
      expected: {
        observations: {
          required: [
            {
              id: "required-gate",
              semanticKey: "north-gate-collapse",
              dimensions: {
                eventDetection: true,
                actuality: "actual",
                attribution: "narrator",
                narrativeFrame: "story-world",
                evidence: [
                  {
                    documentId: "scene-a",
                    quote: "北門の鎖が切れ、重い門扉が街路へ倒れた。",
                  },
                ],
              },
            },
          ],
          forbidden: [],
        },
      },
      criticalViolationClasses: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const prepared = await prepareObservationEvalCase(result.value);
    const sourceRef = prepared.windows[0]?.sourceRef;
    expect(sourceRef).toMatch(/^S\d{4}$/);

    const evaluation = evaluateObservationResponse(
      prepared,
      JSON.stringify({
        observations: [
          {
            localId: "obs-1",
            evidence: [
              {
                sourceRef,
                quote: "北門の鎖が切れ、重い門扉が街路へ倒れた。",
              },
              {
                sourceRef: "UNKNOWN",
                quote: "北門の鎖が切れ、重い門扉が街路へ倒れた。",
              },
            ],
            assertion: {
              attribution: "narrator",
              narrativeFrame: "story-world",
            },
            payload: {
              predicate: "北門が倒れた",
              actuality: "actual",
              participants: [],
              temporalExpressions: [],
              durationKind: "instant",
            },
          },
        ],
      }),
    );

    expect(evaluation.parseStatus).toBe("parsed");
    expect(evaluation.unknownSourceRefsRejected).toBe(true);
    expect(evaluation.evidenceQuotesExact).toBe(true);
    expect(evaluation.actual.observations).toHaveLength(1);
    expect(
      evaluation.actual.observations[0]?.dimensions.evidence,
    ).toMatchObject({
      status: "observed",
      value: [{ documentId: sourceRef, quote: expect.any(String) }],
    });
  });
});

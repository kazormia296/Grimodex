import { describe, expect, it } from "vitest";
import { loadNarrativeEvalSuite } from "./narrativeEvalSuite";
import {
  buildProductionChronicleCapabilityReport,
  classifyProductionChronicleExpectation,
  PRODUCTION_CHRONICLE_EVAL_CONTEXT,
  type ProductionChronicleCapabilityContext,
} from "./productionChronicleCapabilities";
import type { NarrativeEvalExpectedObservation } from "./types";

const repoRoot = new URL("../../../../", import.meta.url).pathname;

function expectation(
  dimensions: NarrativeEvalExpectedObservation["dimensions"],
): NarrativeEvalExpectedObservation {
  return {
    id: "boundary-expectation",
    semanticKey: "boundary-event",
    dimensions,
  };
}

function issueCodes(
  value: NarrativeEvalExpectedObservation,
  context?: ProductionChronicleCapabilityContext,
): readonly string[] {
  return classifyProductionChronicleExpectation(
    value,
    context ?? PRODUCTION_CHRONICLE_EVAL_CONTEXT,
  ).map((issue) => issue.code);
}

describe("production Chronicle capability report", () => {
  it("reports the manifest-loaded 14-case qualification suite and 5-case motif suite without case-specific rules", async () => {
    const [qualification, motif] = await Promise.all([
      loadNarrativeEvalSuite({
        repoRoot,
        suiteId: "chronicle-micro-v1",
      }),
      loadNarrativeEvalSuite({
        repoRoot,
        suiteId: "chronicle-motif-boundary-v1",
      }),
    ]);
    const cases = [...qualification.cases, ...motif.cases];
    const report = buildProductionChronicleCapabilityReport(cases);

    expect(report.version).toBe(1);
    expect(report.input.caseCount).toBe(19);
    expect(report.input.caseIds).toEqual(cases.map((evalCase) => evalCase.id));
    expect(report.input.requiredObservationCount).toBe(
      cases.reduce(
        (count, evalCase) =>
          count + evalCase.expected.observations.required.length,
        0,
      ),
    );
    expect(report.input.forbiddenObservationCount).toBe(
      cases.reduce(
        (count, evalCase) =>
          count + evalCase.expected.observations.forbidden.length,
        0,
      ),
    );

    expect(report.status).toBe("BLOCKED");
    expect(report.contractCompatibility.status).toBe("partially-compatible");
    expect(report.semanticAssessment.status).toBe("BLOCKED");
    expect(report.semanticAssessment.blockers).toEqual(report.gaps);

    const required = (
      predicate: (observation: NarrativeEvalExpectedObservation) => boolean,
    ) =>
      cases.flatMap((evalCase) =>
        evalCase.expected.observations.required
          .filter(predicate)
          .map((observation) => ({ caseId: evalCase.id, observation })),
      );

    const expectedNegativeDetection = required(
      (observation) => observation.dimensions.eventDetection === false,
    ).map(({ caseId }) => caseId);
    const expectedNoneSignificance = required(
      (observation) => observation.dimensions.significance === "none",
    ).map(({ caseId }) => caseId);
    const expectedEligibleSuppress = required(
      (observation) =>
        (observation.dimensions.significance === "major" ||
          observation.dimensions.significance === "scene-level") &&
        (observation.dimensions.actuality === undefined ||
          ["actual", "attempted", "prevented"].includes(
            observation.dimensions.actuality,
          )) &&
        observation.dimensions.proposalGate === "suppress" &&
        (observation.dimensions.evidence?.length ?? 0) > 0,
    );

    expect(
      report.gaps.find(
        (gap) => gap.code === "event-detection-negative-unrepresentable",
      )?.caseIds,
    ).toEqual([...new Set(expectedNegativeDetection)]);
    expect(
      report.gaps.find(
        (gap) => gap.code === "actuality-rumored-unrepresentable",
      ),
    ).toBeUndefined();
    expect(
      report.gaps.find(
        (gap) => gap.code === "significance-none-unrepresentable",
      )?.caseIds,
    ).toEqual([...new Set(expectedNoneSignificance)]);
    expect(
      report.gaps.find(
        (gap) => gap.code === "suppressed-eligible-proposal-unrepresentable",
      )?.caseIds,
    ).toEqual([
      ...new Set(expectedEligibleSuppress.map(({ caseId }) => caseId)),
    ]);
    expect(
      report.gaps.find(
        (gap) => gap.code === "suppressed-eligible-proposal-unrepresentable",
      )?.expectationIds,
    ).toHaveLength(expectedEligibleSuppress.length);

    expect(report.limitations.map((limitation) => limitation.code)).toEqual(
      expect.arrayContaining([
        "forbidden-direct-scoring-unimplemented",
        "predicate-content-aware-alignment-unimplemented",
      ]),
    );
    expect(report.limitations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "forbidden-direct-scoring-unimplemented",
        }),
        expect.objectContaining({
          code: "predicate-content-aware-alignment-unimplemented",
        }),
      ]),
    );
  });

  it("keeps the boundary matrix explicit and does not turn a suppress gate into a blocker by itself", () => {
    expect(
      issueCodes(
        expectation({
          eventDetection: true,
          actuality: "actual",
          significance: "minor",
          proposalGate: "suppress",
          evidence: [{ documentId: "scene", quote: "event" }],
        }),
      ),
    ).toEqual([]);
    expect(
      issueCodes(
        expectation({
          eventDetection: true,
          actuality: "actual",
          significance: "major",
          proposalGate: "suppress",
          evidence: [{ documentId: "scene", quote: "event" }],
        }),
      ),
    ).toContain("suppressed-eligible-proposal-unrepresentable");
    expect(
      issueCodes(
        expectation({
          eventDetection: true,
          actuality: "actual",
          significance: "major",
          proposalGate: "suppress",
          evidence: [{ documentId: "scene", quote: "event" }],
        }),
        { evidenceResolution: "unknown", existingMatch: "unknown" },
      ),
    ).not.toContain("suppressed-eligible-proposal-unrepresentable");
    expect(
      issueCodes(
        expectation({
          eventDetection: true,
          actuality: "actual",
          significance: "major",
          proposalGate: "suppress",
          evidence: [{ documentId: "scene", quote: "event" }],
        }),
        { evidenceResolution: "resolved", existingMatch: "already-satisfied" },
      ),
    ).not.toContain("suppressed-eligible-proposal-unrepresentable");
    expect(
      issueCodes(
        expectation({
          eventDetection: true,
          actuality: "actual",
          significance: "major",
          proposalGate: "suppress",
          evidence: [{ documentId: "scene", quote: "event" }],
        }),
        {
          evidenceResolution: "resolved",
          existingMatch: "not-already-satisfied",
        },
      ),
    ).toContain("suppressed-eligible-proposal-unrepresentable");

    const negativeIssue = classifyProductionChronicleExpectation(
      expectation({ eventDetection: false }),
    )[0];
    expect(negativeIssue).toMatchObject({
      code: "event-detection-negative-unrepresentable",
      scope: "evaluation-adapter",
    });
    expect(issueCodes(expectation({ actuality: "rumored" }))).toEqual([]);
    expect(
      issueCodes(
        expectation({
          actuality: "rumored",
          significance: "major",
          proposalGate: "suppress",
          evidence: [{ documentId: "scene", quote: "event" }],
        }),
      ),
    ).toEqual([]);
    expect(issueCodes(expectation({ actuality: "planned" }))).toEqual([]);
    expect(issueCodes(expectation({ actuality: "dreamed" }))).toEqual([]);
    expect(issueCodes(expectation({ actuality: "hypothetical" }))).toEqual([]);
    expect(issueCodes(expectation({ significance: "none" }))).toContain(
      "significance-none-unrepresentable",
    );
    expect(issueCodes(expectation({ significance: "future-level" }))).toContain(
      "significance-value-unrepresentable",
    );
    expect(issueCodes(expectation({}))).toEqual([]);
  });

  it("only reports a suppressed major/scene-level proposal gap when the eval adapter context is complete", () => {
    const suppressed = expectation({
      significance: "scene-level",
      proposalGate: "suppress",
      evidence: [{ documentId: "scene", quote: "event" }],
    });
    const contexts: readonly [ProductionChronicleCapabilityContext, boolean][] =
      [
        [PRODUCTION_CHRONICLE_EVAL_CONTEXT, true],
        [
          {
            evidenceResolution: "resolved",
            existingMatch: "not-already-satisfied",
          },
          true,
        ],
        [
          {
            evidenceResolution: "resolved",
            existingMatch: "already-satisfied",
          },
          false,
        ],
        [
          {
            evidenceResolution: "unresolved",
            existingMatch: "not-already-satisfied",
          },
          false,
        ],
        [{ evidenceResolution: "unknown", existingMatch: "unknown" }, false],
      ];

    for (const [context, blocked] of contexts) {
      expect(
        issueCodes(suppressed, context).includes(
          "suppressed-eligible-proposal-unrepresentable",
        ),
      ).toBe(blocked);
    }
  });

  it("keeps semantic assessment blocked even for an empty input because global limitations remain explicit", () => {
    const report = buildProductionChronicleCapabilityReport([]);

    expect(report.status).toBe("BLOCKED");
    expect(report.contractCompatibility.status).toBe("compatible");
    expect(report.semanticAssessment.status).toBe("BLOCKED");
    expect(report.gaps).toEqual([]);
    expect(report.limitations).toHaveLength(2);
    expect(report.semanticAssessment.limitations).toEqual(report.limitations);
  });
});

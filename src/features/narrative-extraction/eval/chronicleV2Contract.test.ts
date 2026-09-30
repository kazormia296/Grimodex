import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import fixture from "../../../../evals/narrative/contracts/chronicle-v2/actual-gate-collapse.json";
import schema from "../../../../evals/narrative/contracts/chronicle-v2/contract.schema.json";
import {
  CHRONICLE_V2_CONTRACT_VERSION,
  CHRONICLE_V2_SCHEMA_VERSION,
  loadChronicleV2Contract,
  normalizeChronicleV2Actual,
  type ChronicleV2RawActualClaim,
} from "./chronicleV2Contract";

function cloneFixture(): Record<string, unknown> {
  return structuredClone(fixture) as Record<string, unknown>;
}

function actualClaim(
  overrides: Partial<ChronicleV2RawActualClaim> = {},
): ChronicleV2RawActualClaim {
  return {
    id: "actual-chain-break",
    predicate: "鎖が切れた",
    participants: [{ entity: "北門の鎖", role: "theme" }],
    actuality: "actual",
    attribution: "narrator",
    narrativeFrame: "story-world",
    evidenceRefs: ["citation-v2-north-gate"],
    ...overrides,
  };
}

describe("chronicle v2 contract", () => {
  it("keeps the JSON Schema and semantic loader aligned for fixed and scored policy shapes", () => {
    const ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      validateFormats: false,
    });
    const validateSchema = ajv.compile(schema);

    expect(validateSchema(fixture)).toBe(true);
    expect(loadChronicleV2Contract(fixture).ok).toBe(true);

    const threeClaims = cloneFixture();
    (threeClaims.observationGold as Record<string, unknown>).claims = (
      (threeClaims.observationGold as Record<string, unknown>)
        .claims as unknown[]
    ).slice(0, 3);
    expect(validateSchema(threeClaims)).toBe(false);
    const threeResult = loadChronicleV2Contract(threeClaims);
    expect(threeResult.ok).toBe(false);
    if (!threeResult.ok) {
      expect(
        threeResult.diagnostics.map((diagnostic) => diagnostic.code),
      ).toContain("V2_CLAIM_COUNT_INVALID");
    }

    const scoredPolicy = cloneFixture();
    (scoredPolicy as Record<string, unknown>).proposalPolicy = {
      mode: "scored",
      scoredClaimIds: [
        "chain-break",
        "gate-fall",
        "guards-ring-bell",
        "guards-evacuate-passersby",
      ],
      expectedDecisions: {
        "chain-break": "propose",
        "gate-fall": "propose",
        "guards-ring-bell": "suppress",
        "guards-evacuate-passersby": "suppress",
      },
      reason: "explicit-fixture-policy",
    };
    expect(validateSchema(scoredPolicy)).toBe(true);
    expect(loadChronicleV2Contract(scoredPolicy).ok).toBe(true);
  });

  it("loads the independent four-claim fixture without registering a live suite", () => {
    const result = loadChronicleV2Contract(fixture);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.contractVersion).toBe(CHRONICLE_V2_CONTRACT_VERSION);
    expect(result.value.authorship).toMatchObject({
      status: "draft-for-human-review",
      derivation: "source-text-only",
      candidateOutputContamination: false,
    });
    expect(result.value.coverage).toEqual({
      observation: "exhaustive",
      proposal: "targeted",
    });
    expect(result.value.observationGold.claims).toHaveLength(4);
    expect(
      result.value.observationGold.claims.map((claim) => claim.id),
    ).toEqual([
      "chain-break",
      "gate-fall",
      "guards-ring-bell",
      "guards-evacuate-passersby",
    ]);
    expect(result.value.proposalPolicy).toMatchObject({
      mode: "unscored",
      scoredClaimIds: [],
    });
    expect(Object.isFrozen(result.value)).toBe(true);
  });

  it("loads the scoped temporal Gold without changing the four event claims", () => {
    const result = loadChronicleV2Contract(fixture);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.schemaVersion).toBe(CHRONICLE_V2_SCHEMA_VERSION);
    expect(result.value.contractVersion).toBe("chronicle-evaluation-v2/3");
    expect(result.value.observationGold.claims).toHaveLength(4);
    expect(
      result.value.observationGold.claims.map((claim) => claim.id),
    ).toEqual([
      "chain-break",
      "gate-fall",
      "guards-ring-bell",
      "guards-evacuate-passersby",
    ]);
    expect(result.value.temporalGold).toEqual({
      coverage: "targeted",
      relations: [
        {
          id: "night-half-chain-break",
          targetClaimId: "chain-break",
          relation: "occurs-at",
          expression: "夜半",
          requiredRegion: {
            documentId: "scene-north-gate",
            start: 0,
            end: 2,
          },
        },
        {
          id: "night-half-gate-fall",
          targetClaimId: "gate-fall",
          relation: "occurs-at",
          expression: "夜半",
          requiredRegion: {
            documentId: "scene-north-gate",
            start: 0,
            end: 2,
          },
        },
      ],
      unscoredClaimIds: ["guards-ring-bell", "guards-evacuate-passersby"],
    });
    expect(result.value.authorship).toMatchObject({
      formalCertification: false,
      reviewScope: {
        sourceAndGoldReviewed: true,
        atomicObservationClaimIds: [
          "chain-break",
          "gate-fall",
          "guards-ring-bell",
          "guards-evacuate-passersby",
        ],
        temporalRelationIds: ["night-half-chain-break", "night-half-gate-fall"],
        temporalUnscoredClaimIds: [
          "guards-ring-bell",
          "guards-evacuate-passersby",
        ],
        excludedTemporalScopes: [
          "absolute-date-conversion",
          "downstream-sentence-time-inheritance",
          "structured-entity-properties",
          "proposal-importance",
        ],
      },
    });
    expect(Object.isFrozen(result.value.temporalGold)).toBe(true);
  });

  it("rejects temporal Gold that changes an event identity or leaves the bounded scope", () => {
    const candidate = cloneFixture();
    const temporalGold = candidate.temporalGold as Record<string, unknown>;
    const relations = temporalGold.relations as Array<Record<string, unknown>>;
    relations[0]!.targetClaimId = "guards-ring-bell";

    const result = loadChronicleV2Contract(candidate);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "V2_TEMPORAL_TARGET_UNSCORED",
    );
  });

  it.each([
    [
      "duplicate relation",
      (relations: Array<Record<string, unknown>>) => {
        relations[1] = { ...relations[0] };
      },
    ],
    [
      "swapped relation order",
      (relations: Array<Record<string, unknown>>) => {
        relations.reverse();
      },
    ],
    [
      "crossed relation identity",
      (relations: Array<Record<string, unknown>>) => {
        relations[0]!.targetClaimId = "gate-fall";
      },
    ],
  ])(
    "rejects temporal Gold with %s in both schema and loader",
    (_label, mutate) => {
      const candidate = cloneFixture();
      const temporalGold = candidate.temporalGold as Record<string, unknown>;
      mutate(temporalGold.relations as Array<Record<string, unknown>>);

      const ajv = new Ajv2020({
        allErrors: true,
        strict: true,
        validateFormats: false,
      });
      const validateSchema = ajv.compile(schema);
      expect(validateSchema(candidate)).toBe(false);
      expect(loadChronicleV2Contract(candidate).ok).toBe(false);
    },
  );

  it.each([
    [
      "formal implementation-wide replacement",
      (candidate: Record<string, unknown>) => {
        const reviewScope = (candidate.authorship as Record<string, unknown>)
          .reviewScope as Record<string, unknown>;
        reviewScope.eventObservationPolicy = "implementation-wide-formal";
      },
    ],
    [
      "changed approved relation",
      (candidate: Record<string, unknown>) => {
        const reviewScope = (candidate.authorship as Record<string, unknown>)
          .reviewScope as Record<string, unknown>;
        (reviewScope.temporalRelationIds as string[])[0] =
          "night-half-gate-fall";
      },
    ],
    [
      "changed excluded scope",
      (candidate: Record<string, unknown>) => {
        const reviewScope = (candidate.authorship as Record<string, unknown>)
          .reviewScope as Record<string, unknown>;
        (reviewScope.excludedTemporalScopes as string[])[0] =
          "relative-time-inheritance";
      },
    ],
  ])("rejects review scope overreach: %s", (_label, mutate) => {
    const candidate = cloneFixture();
    mutate(candidate);

    const ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      validateFormats: false,
    });
    const validateSchema = ajv.compile(schema);
    expect(validateSchema(candidate)).toBe(false);

    const result = loadChronicleV2Contract(candidate);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "V2_AUTHORSHIP_REVIEW_SCOPE_INVALID",
    );
  });

  it.each([
    [
      "candidate output contamination",
      (candidate: Record<string, unknown>) => {
        (
          candidate.authorship as Record<string, unknown>
        ).candidateOutputContamination = true;
      },
      "V2_AUTHORSHIP_CONTAMINATED",
    ],
    [
      "duplicate claim ids",
      (candidate: Record<string, unknown>) => {
        const claims = (candidate.observationGold as Record<string, unknown>)
          .claims as Array<Record<string, unknown>>;
        claims[1]!.id = claims[0]!.id;
      },
      "V2_CLAIM_ID_DUPLICATE",
    ],
    [
      "out of bounds evidence region",
      (candidate: Record<string, unknown>) => {
        const claims = (candidate.observationGold as Record<string, unknown>)
          .claims as Array<Record<string, unknown>>;
        (
          claims[0]!.requiredDirectRegions as Array<Record<string, unknown>>
        )[0]!.end = 99999;
      },
      "V2_EVIDENCE_REGION_OUT_OF_BOUNDS",
    ],
  ])("rejects %s", (_label, mutate, expectedCode) => {
    const candidate = cloneFixture();
    mutate(candidate);

    const result = loadChronicleV2Contract(candidate);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      expectedCode,
    );
  });

  it("normalizes actual aliases using only the finite fixture lexicon", () => {
    const normalized = normalizeChronicleV2Actual(actualClaim());

    expect(normalized.predicate).toEqual({
      status: "known",
      value: "chain-break",
    });
    expect(normalized.participants).toEqual([
      {
        entity: { status: "known", value: "north-gate-chain" },
        role: { status: "known", value: "theme" },
      },
    ]);
    expect(normalized.actuality).toEqual({ status: "known", value: "actual" });
    expect(normalized.attribution).toEqual({
      status: "known",
      value: "narrator",
    });
    expect(normalized.narrativeFrame).toEqual({
      status: "known",
      value: "story-world",
    });
  });

  it("preserves unknown status for unsupported free-form values", () => {
    const normalized = normalizeChronicleV2Actual(
      actualClaim({
        predicate: "鎖がほどけたような何か",
        participants: [{ entity: "見知らぬもの", role: "maybe-agent" }],
        actuality: "probably-real",
        attribution: "unknown",
        narrativeFrame: "free-association",
      }),
    );

    expect(normalized.predicate).toEqual({
      status: "unknown",
      reason: "predicate-out-of-vocabulary",
    });
    expect(normalized.participants).toEqual([
      {
        entity: {
          status: "unknown",
          reason: "entity-out-of-vocabulary",
        },
        role: { status: "unknown", reason: "role-out-of-vocabulary" },
      },
    ]);
    expect(normalized.actuality).toEqual({
      status: "unknown",
      reason: "actuality-out-of-vocabulary",
    });
    expect(normalized.attribution).toEqual({
      status: "unknown",
      reason: "attribution-out-of-vocabulary",
    });
    expect(normalized.narrativeFrame).toEqual({
      status: "unknown",
      reason: "narrative-frame-out-of-vocabulary",
    });
  });

  it("keeps a finite contrastive predicate distinct from an unknown expression", () => {
    const normalized = normalizeChronicleV2Actual(
      actualClaim({ predicate: "門扉を修復した" }),
    );

    expect(normalized.predicate).toEqual({
      status: "known",
      value: "gate-repair",
    });
  });

  it("maps guards, passersby, street, and raw patient roles to the canonical vocabulary", () => {
    const normalized = normalizeChronicleV2Actual(
      actualClaim({
        predicate: "evacuation",
        participants: [
          { entity: "guards", role: "agent" },
          { entity: "passersby", role: "patient" },
          { entity: "広場へ", role: "destination" },
        ],
      }),
    );

    expect(normalized.predicate).toEqual({
      status: "known",
      value: "evacuate",
    });
    expect(normalized.participants).toEqual([
      {
        entity: { status: "known", value: "guard" },
        role: { status: "known", value: "agent" },
      },
      {
        entity: { status: "known", value: "passerby" },
        role: { status: "known", value: "theme" },
      },
      {
        entity: { status: "known", value: "square" },
        role: { status: "known", value: "destination" },
      },
    ]);
  });

  it("normalizes every canonical Gold entity used by the four-claim fixture", () => {
    const surfaces: Record<string, string> = {
      "north-gate-chain": "北門の鎖",
      "gate-leaf": "門扉",
      guard: "衛兵",
      bell: "鐘",
      passerby: "通行人",
      street: "街路",
      square: "広場",
    };
    for (const [entity, surface] of Object.entries(surfaces)) {
      const normalized = normalizeChronicleV2Actual(
        actualClaim({
          participants: [{ entity: surface, role: "theme" }],
        }),
      );
      expect(normalized.participants[0]?.entity).toEqual({
        status: "known",
        value: entity,
      });
    }
  });

  it("keeps normalized actual meaning independent from Gold input", () => {
    const raw = actualClaim();
    const first = normalizeChronicleV2Actual(raw);
    const candidate = cloneFixture();
    const claims = (candidate.observationGold as Record<string, unknown>)
      .claims as Array<Record<string, unknown>>;
    claims[0]!.predicate = "gate-fall";
    claims[0]!.participants = [{ entity: "gate-leaf", role: "theme" }];
    const second = normalizeChronicleV2Actual(raw);

    expect(second).toEqual(first);
  });

  it("exposes the alignment boundary without copying Gold meaning into actual claims", () => {
    const result = loadChronicleV2Contract(fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const normalized = normalizeChronicleV2Actual(actualClaim());
    const input = {
      goldClaims: result.value.observationGold.claims,
      normalizedActualClaims: [normalized],
      evidenceCandidates: [
        {
          actualRef: "citation-v2-north-gate",
          goldRef: "chain-break",
          evidenceValid: true,
          overlap: true,
          directSupport: true,
          contextSupport: true,
        },
      ],
      coverage: result.value.coverage,
      proposalPolicy: result.value.proposalPolicy,
    };

    expect(input.evidenceCandidates[0]).toEqual({
      actualRef: "citation-v2-north-gate",
      goldRef: "chain-break",
      evidenceValid: true,
      overlap: true,
      directSupport: true,
      contextSupport: true,
    });
    expect(input.normalizedActualClaims[0]!.predicate).toEqual({
      status: "known",
      value: "chain-break",
    });
  });
});

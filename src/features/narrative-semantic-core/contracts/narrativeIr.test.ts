import { describe, expect, it } from "vitest";

import {
  NARRATIVE_IR_REGISTRY,
  validateNarrativeRevisionEnvelopeV2,
  type NarrativeRevisionEnvelopeV2,
} from "./narrativeIr";

const DIGEST = `sha256:${"a".repeat(64)}` as const;

const scope = {
  schemaVersion: 2 as const,
  registryVersion: "narrative-scope/2" as const,
  timeline: { kind: "any" as const },
  worldline: { kind: "any" as const },
  scene: { kind: "exact" as const, ref: "scene:1" },
  viewpoint: { kind: "any" as const },
  knowledgeHolder: { kind: "any" as const },
  audience: { kind: "any" as const },
  narrativeLayer: { kind: "any" as const },
  storyTime: { kind: "any" as const },
  readingOrder: { kind: "any" as const },
};

const validEnvelope = (): NarrativeRevisionEnvelopeV2<
  Record<string, unknown>
> => ({
  schemaVersion: 2,
  assertion: {
    assertionId: null,
    assertionKind: "scene-event@1",
    payloadSchemaRef: { id: "narrative.scene-event", version: "1" },
    payload: { eventId: "event:1" },
    scope,
    modality: "modality-explicit-text",
    polarity: "affirmative",
    supportClass: "direct-source",
    producer: {
      kind: "reconciler-proposal",
      id: "chronicle",
      version: "1",
    },
  },
  assertionDigests: {
    assertionCoreDigest: DIGEST,
    scopeDigest: DIGEST,
    assertionDigest: DIGEST,
  },
  changeIntent: { changeKind: "add" },
  effectiveMaterialBasis: {
    sourceBasis: [
      { sourceKind: "scene", sourceKey: "scene:1", revisionToken: "rev:1" },
    ],
    evidenceSet: [{ evidenceRef: "anchor:1" }],
    dependencySet: [
      {
        dependencyId: "dependency:1",
        inputRef: "anchor:1",
        contextIds: [],
        role: "direct-evidence",
        selector: { kind: "whole-source" },
      },
    ],
    dependencySetDigest: DIGEST,
    materialBasisDigest: DIGEST,
  },
  revisionBasis: {
    kind: "interpretation",
    runId: "run:1",
    taskId: "task:1",
    producer: { kind: "reconciler-proposal", id: "chronicle", version: "1" },
    contextSet: [],
    contextSetDigest: DIGEST,
    componentContractDigest: DIGEST,
    finalRequestDigest: DIGEST,
  },
  projectionBinding: {
    proposalKind: "chronicle.create-event@1",
    proposalSchemaRef: {
      id: "narrative.chronicle-event.create",
      version: "1",
    },
    proposalPayloadDigest: DIGEST,
    adapterContractId: "chronicle.scene-event",
    adapterContractVersion: "1",
  },
});

type MutableEnvelope = {
  effectiveMaterialBasis: {
    evidenceSet: Array<Record<string, unknown>>;
    dependencySet: Array<Record<string, unknown>>;
  };
  revisionBasis: {
    contextSet: unknown[];
  };
};

const mutableEnvelope = (): MutableEnvelope =>
  structuredClone(validEnvelope()) as unknown as MutableEnvelope;

describe("Narrative IR V2 registry and structural schema", () => {
  it("exposes the ratified assertion and shared vocabulary registry", () => {
    expect(NARRATIVE_IR_REGISTRY.contractVersion).toBe("narrative-ir/2");
    expect(NARRATIVE_IR_REGISTRY.assertionKinds).toEqual(["scene-event@1"]);
    expect(NARRATIVE_IR_REGISTRY.producerKinds).toContain(
      "reconciler-proposal",
    );
    expect(NARRATIVE_IR_REGISTRY.supportClasses).toContain("direct-source");
    expect(NARRATIVE_IR_REGISTRY.changeKinds).toEqual([
      "add",
      "revise",
      "retract",
      "merge",
      "split",
    ]);
  });

  it("accepts the typed V2 envelope shape", () => {
    expect(validateNarrativeRevisionEnvelopeV2(validEnvelope())).toEqual({
      valid: true,
    });
  });

  it.each([
    [
      "unknown envelope version",
      { schemaVersion: 1 },
      "unsupported-schema-version",
    ],
    [
      "unknown assertion kind",
      { assertion: { assertionKind: "future-event@1" } },
      "unsupported-assertion-kind",
    ],
    [
      "unknown modality",
      { assertion: { modality: "future-modality" } },
      "unsupported-modality",
    ],
    [
      "unknown support class",
      { assertion: { supportClass: "future-support" } },
      "unsupported-support-class",
    ],
    [
      "unknown producer kind",
      { assertion: { producer: { kind: "future-producer" } } },
      "unsupported-producer-kind",
    ],
    [
      "unknown change kind",
      { changeIntent: { changeKind: "future-change" } },
      "unsupported-change-kind",
    ],
  ] as const)("refuses %s", (_label, patch, reason) => {
    const candidate = structuredClone(validEnvelope()) as unknown as Record<
      string,
      unknown
    >;
    for (const [key, value] of Object.entries(patch)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        candidate[key] = {
          ...(candidate[key] as Record<string, unknown>),
          ...(value as Record<string, unknown>),
        };
      } else {
        candidate[key] = value;
      }
    }
    expect(validateNarrativeRevisionEnvelopeV2(candidate)).toMatchObject({
      valid: false,
      reason,
    });
  });

  it("enforces change-intent target invariants and digest shape", () => {
    expect(
      validateNarrativeRevisionEnvelopeV2({
        ...validEnvelope(),
        changeIntent: { changeKind: "add", targetProjectionRef: "event:1" },
      }),
    ).toMatchObject({ valid: false, reason: "target-projection-forbidden" });

    expect(
      validateNarrativeRevisionEnvelopeV2({
        ...validEnvelope(),
        changeIntent: { changeKind: "retract" },
      }),
    ).toMatchObject({ valid: false, reason: "target-projection-required" });

    expect(
      validateNarrativeRevisionEnvelopeV2({
        ...validEnvelope(),
        assertionDigests: {
          ...validEnvelope().assertionDigests,
          scopeDigest: "sha256:not-a-digest",
        },
      }),
    ).toMatchObject({ valid: false, reason: "invalid-digest" });
  });

  it("requires D0 Dependency roles/selectors and ADR010 evidence coverage", () => {
    const unknownRole = mutableEnvelope();
    unknownRole.effectiveMaterialBasis.dependencySet[0].role = "future-role";
    expect(validateNarrativeRevisionEnvelopeV2(unknownRole)).toMatchObject({
      valid: false,
      reason: "invalid-material-basis",
    });

    const invalidSelector = mutableEnvelope();
    invalidSelector.effectiveMaterialBasis.dependencySet[0].selector = {
      kind: "future-selector",
    };
    expect(validateNarrativeRevisionEnvelopeV2(invalidSelector)).toMatchObject({
      valid: false,
      reason: "invalid-material-basis",
    });

    const missingEvidenceDependency = mutableEnvelope();
    missingEvidenceDependency.effectiveMaterialBasis.dependencySet = [];
    expect(
      validateNarrativeRevisionEnvelopeV2(missingEvidenceDependency),
    ).toMatchObject({ valid: false, reason: "invalid-material-basis" });

    const mismatchedEvidenceDependency = mutableEnvelope();
    mismatchedEvidenceDependency.effectiveMaterialBasis.dependencySet[0].inputRef =
      "anchor:other";
    expect(
      validateNarrativeRevisionEnvelopeV2(mismatchedEvidenceDependency),
    ).toMatchObject({ valid: false, reason: "invalid-material-basis" });
  });

  it("rejects a role without a proposal-revision effect rule", () => {
    const rankingOnly = mutableEnvelope();
    rankingOnly.effectiveMaterialBasis.dependencySet.push({
      dependencyId: "dependency:ranking",
      inputRef: "ranking:context",
      contextIds: [],
      role: "ranking-only",
      selector: { kind: "whole-source" },
    });
    expect(validateNarrativeRevisionEnvelopeV2(rankingOnly)).toMatchObject({
      valid: false,
      reason: "invalid-material-basis",
    });

    const qualityContext = mutableEnvelope();
    qualityContext.effectiveMaterialBasis.dependencySet.push({
      dependencyId: "dependency:quality",
      inputRef: "quality:context",
      contextIds: [],
      role: "quality-context",
      selector: { kind: "whole-source" },
    });
    expect(validateNarrativeRevisionEnvelopeV2(qualityContext)).toEqual({
      valid: true,
    });
  });

  it("rejects present empty or non-string revisionObservedAt values", () => {
    for (const revisionObservedAt of ["", 42]) {
      const candidate = structuredClone(validEnvelope()) as unknown as Record<
        string,
        any
      >;
      candidate.effectiveMaterialBasis.sourceBasis[0].revisionObservedAt =
        revisionObservedAt;
      expect(validateNarrativeRevisionEnvelopeV2(candidate)).toMatchObject({
        valid: false,
        reason: "invalid-material-basis",
        path: "effectiveMaterialBasis.sourceBasis[0].revisionObservedAt",
      });
    }
  });

  it("requires model-visible Context coverage and a conservative role", () => {
    const modelVisibleContext = {
      contextId: "context:1",
      inputRef: "source:context",
      stageId: "stage:1",
      exposure: "model-visible",
      selector: { kind: "whole-source" },
    } as const;
    const withoutCoverage = mutableEnvelope();
    withoutCoverage.revisionBasis.contextSet = [modelVisibleContext];
    expect(validateNarrativeRevisionEnvelopeV2(withoutCoverage)).toMatchObject({
      valid: false,
      reason: "invalid-material-basis",
    });

    const declaredPurpose = structuredClone(withoutCoverage);
    declaredPurpose.effectiveMaterialBasis.dependencySet.push({
      dependencyId: "dependency:context",
      inputRef: "source:context",
      contextIds: ["context:1"],
      role: "entity-resolution",
      selector: { kind: "whole-source" },
    });
    expect(validateNarrativeRevisionEnvelopeV2(declaredPurpose)).toEqual({
      valid: true,
    });

    const selectorMismatch = structuredClone(withoutCoverage);
    selectorMismatch.effectiveMaterialBasis.dependencySet.push({
      dependencyId: "dependency:context",
      inputRef: "source:context",
      contextIds: ["context:1"],
      role: "opaque-model-context",
      selector: {
        kind: "field-path",
        objectIdentity: "object:1",
        fieldPath: "title",
      },
    });
    expect(validateNarrativeRevisionEnvelopeV2(selectorMismatch)).toMatchObject(
      {
        valid: false,
        reason: "invalid-material-basis",
      },
    );

    const directEvidenceContext = structuredClone(withoutCoverage);
    directEvidenceContext.effectiveMaterialBasis.evidenceSet.push({
      evidenceRef: "anchor:context",
      sourceKey: "source:context",
    });
    directEvidenceContext.effectiveMaterialBasis.dependencySet.push({
      dependencyId: "dependency:context",
      inputRef: "source:context",
      contextIds: ["context:1"],
      role: "direct-evidence",
      selector: { kind: "whole-source" },
    });
    expect(validateNarrativeRevisionEnvelopeV2(directEvidenceContext)).toEqual({
      valid: true,
    });

    const conservativeFallback = structuredClone(withoutCoverage);
    conservativeFallback.effectiveMaterialBasis.dependencySet.push({
      dependencyId: "dependency:context",
      inputRef: "source:context",
      contextIds: ["context:1"],
      role: "opaque-model-context",
      selector: { kind: "whole-source" },
    });
    expect(validateNarrativeRevisionEnvelopeV2(conservativeFallback)).toEqual({
      valid: true,
    });
  });
});

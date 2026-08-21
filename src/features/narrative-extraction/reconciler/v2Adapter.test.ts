import { describe, expect, it } from "vitest";

import {
  adaptReconciliationEnvelopeV1ToV2,
  assertNarrativeRevisionEnvelopeV2,
  assertV2LineageMonotonicity,
} from "./v2Adapter";
import type {
  ContextSetEntry,
  DependencySetEntry,
  NarrativeScopeV2,
  ReconciliationEnvelopeV1,
} from "./types";

const scope: NarrativeScopeV2 = {
  schemaVersion: 2,
  registryVersion: "narrative-scope/2",
  timeline: { kind: "any" },
  worldline: { kind: "any" },
  scene: { kind: "exact", ref: "scene:1" },
  viewpoint: { kind: "any" },
  knowledgeHolder: { kind: "any" },
  audience: { kind: "any" },
  narrativeLayer: { kind: "any" },
  storyTime: { kind: "any" },
  readingOrder: { kind: "any" },
};

const contextSet: readonly ContextSetEntry[] = [
  {
    contextId: "context-1",
    inputRef: "source:1",
    stageId: "narrative_observation_extract",
    exposure: "model-visible",
    selector: { kind: "whole-source" },
  },
];

const dependencySet: readonly DependencySetEntry[] = [
  {
    dependencyId: "dependency-1",
    inputRef: "source:1",
    contextIds: ["context-1"],
    role: "direct-evidence",
    selector: { kind: "whole-source" },
  },
];

const DIGEST = `sha256:${"a".repeat(64)}` as const;
const OTHER_DIGEST = `sha256:${"b".repeat(64)}` as const;

const v1: ReconciliationEnvelopeV1 = {
  schemaVersion: 1,
  runId: "run-1",
  taskId: "task-1",
  reconcilerId: "grimodex.chronicle-extraction",
  reconcilerVersion: "1",
  proposalSchemaId: "narrative.chronicle-event.create",
  proposalSchemaVersion: "1",
  sourceBasis: [
    {
      sourceKind: "scene-body",
      sourceKey: "scene:1",
      revisionToken: "v1",
    },
  ],
  evidenceSet: [
    {
      evidenceRef: "anchor:1",
      documentRef: "document:1",
      quote: "Arrival.",
      sourceKey: "source:1",
    },
  ],
  readSet: [
    {
      inputRef: "scene:1",
      kind: "snapshot-document",
      revisionToken: "v1",
    },
  ],
  readSetDigest: DIGEST,
  changeKind: "add",
};

function buildInput() {
  return {
    envelope: v1,
    assertion: {
      assertionId: null,
      assertionKind: "scene-event@1" as const,
      payloadSchemaRef: {
        id: "narrative.chronicle-event.create",
        version: "1",
      },
      payload: { eventId: "event:1", title: "Arrival" },
      scope,
      modality: "modality-narrator-claim" as const,
      polarity: "affirmative" as const,
      supportClass: "direct-source" as const,
    },
    assertionDigests: {
      assertionCoreDigest: DIGEST,
      scopeDigest: DIGEST,
      assertionDigest: DIGEST,
    },
    contextSet,
    contextSetDigest: DIGEST,
    dependencySet,
    dependencySetDigest: DIGEST,
    materialBasisDigest: DIGEST,
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
    revisionBasis: {
      kind: "interpretation" as const,
      componentContractDigest: DIGEST,
      finalRequestDigest: DIGEST,
    },
  };
}

function buildCallerOwnedHumanDerivedBasis() {
  return {
    kind: "human-derived" as const,
    parentRevisionId: "parent-revision",
    expectedParentEnvelopeDigest: DIGEST,
    parentAssertionDigest: DIGEST,
    rootInterpretationRevisionId: "root-revision",
    derivation: {
      adapterId: "chronicle.scene-event",
      adapterVersion: "1",
      kind: "projection-only" as const,
      proposalPayloadChangedPaths: ["/title"],
    },
    revisionActor: {
      kind: "human" as const,
      surfaceId: "editor",
    },
    derivationContextSet: contextSet,
    derivationContextSetDigest: DIGEST,
  } as never;
}

describe("Narrative Revision Envelope V2 adapter", () => {
  it("rejects a caller-supplied human-derived basis", () => {
    expect(() =>
      adaptReconciliationEnvelopeV1ToV2({
        ...buildInput(),
        revisionBasis: buildCallerOwnedHumanDerivedBasis(),
      }),
    ).toThrow(/revisionBasis|interpretation/i);
  });

  it("rejects unknown revision basis authority fields at runtime", () => {
    expect(() =>
      adaptReconciliationEnvelopeV1ToV2({
        ...buildInput(),
        revisionBasis: {
          kind: "interpretation" as const,
          componentContractDigest: DIGEST,
          finalRequestDigest: DIGEST,
          extraAuthorityDigest: OTHER_DIGEST,
        } as never,
      }),
    ).toThrow(/unknown|unsupported|revisionBasis/i);
  });

  it("rejects caller-supplied interpretation identity and context authority", () => {
    const minimalBasis = buildInput().revisionBasis;
    const cases = [
      { ...minimalBasis, runId: "spoofed-run" },
      { ...minimalBasis, taskId: "spoofed-task" },
      {
        ...minimalBasis,
        producer: {
          kind: "reconciler-proposal" as const,
          id: "spoofed-producer",
          version: "spoofed-version",
        },
      },
      {
        ...minimalBasis,
        contextSet: [
          {
            ...contextSet[0],
            contextId: "spoofed-context",
          },
        ],
      },
      { ...minimalBasis, contextSetDigest: DIGEST },
    ];

    for (const candidateBasis of cases) {
      expect(() =>
        adaptReconciliationEnvelopeV1ToV2({
          ...buildInput(),
          revisionBasis: candidateBasis as never,
        }),
      ).toThrow(/caller-owned revisionBasis field/);
    }
  });

  it("maps the V1 reconciler identity to a reconciler-proposal producer", () => {
    const envelope = adaptReconciliationEnvelopeV1ToV2(buildInput());

    expect(envelope.schemaVersion).toBe(2);
    expect(envelope.assertion.producer).toEqual({
      kind: "reconciler-proposal",
      id: v1.reconcilerId,
      version: v1.reconcilerVersion,
    });
    expect(envelope.changeIntent).toEqual({ changeKind: "add" });
    expect(envelope.projectionBinding.proposalKind).toBe(
      "chronicle.create-event@1",
    );
    expect(envelope.effectiveMaterialBasis.sourceBasis).toEqual(v1.sourceBasis);
    expect(envelope.effectiveMaterialBasis.evidenceSet).toEqual(v1.evidenceSet);
    expect(envelope.revisionBasis).toEqual({
      kind: "interpretation",
      runId: v1.runId,
      taskId: v1.taskId,
      producer: {
        kind: "reconciler-proposal",
        id: v1.reconcilerId,
        version: v1.reconcilerVersion,
      },
      contextSet,
      contextSetDigest: DIGEST,
      componentContractDigest: DIGEST,
      finalRequestDigest: DIGEST,
    });
  });

  it("preserves retract target and rejects an add target", () => {
    const retract = adaptReconciliationEnvelopeV1ToV2({
      ...buildInput(),
      envelope: {
        ...v1,
        changeKind: "retract",
        targetProjectionRef: "event:1",
      },
    });
    expect(retract.changeIntent).toEqual({
      changeKind: "retract",
      targetProjectionRef: "event:1",
    });

    expect(() =>
      adaptReconciliationEnvelopeV1ToV2({
        ...buildInput(),
        envelope: { ...v1, targetProjectionRef: "event:1" },
      }),
    ).toThrow(/targetProjectionRef.*add/);
  });

  it("fails closed for malformed V2 invariants and downgrade lineage", () => {
    const envelope = adaptReconciliationEnvelopeV1ToV2(buildInput());
    expect(() =>
      assertNarrativeRevisionEnvelopeV2({
        ...envelope,
        assertion: {
          ...envelope.assertion,
          producer: {
            ...envelope.assertion.producer,
            kind: "not-a-producer" as never,
          },
        },
      }),
    ).toThrow(/producer/);
    expect(() =>
      assertV2LineageMonotonicity(envelope, { schemaVersion: 1 } as never),
    ).toThrow(/downgrade/);
  });

  it("uses the canonical K1 validator and registered adapter authority", () => {
    const envelope = adaptReconciliationEnvelopeV1ToV2(buildInput());

    expect(() =>
      assertNarrativeRevisionEnvelopeV2({
        ...envelope,
        assertion: {
          ...envelope.assertion,
          scope: {
            ...envelope.assertion.scope,
            futureAxis: { kind: "any" },
          } as unknown as NarrativeScopeV2,
        },
      }),
    ).toThrow(/unknown|invalid/i);

    expect(() =>
      adaptReconciliationEnvelopeV1ToV2({
        ...buildInput(),
        projectionBinding: {
          ...buildInput().projectionBinding,
          adapterContractId: "unregistered.adapter",
        },
      }),
    ).toThrow(/adapter/i);
  });
});

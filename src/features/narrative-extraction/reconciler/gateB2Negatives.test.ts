import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  assertDeclarativeReconcilerResult,
  buildProposalDraftEnvelope,
  isAllowedPropagationSignal,
  isCompensatingChangeKind,
  staleProjectionRefs,
} from "./contract";
import type {
  NarrativeProposalDraftEnvelope,
  NarrativeReconcilerInput,
  ProposalChangeKind,
  ReadSetDigest,
  SourceBasis,
} from "./types";

const context = {
  runId: "run-gate-b2",
  taskId: "task-gate-b2",
  reconcilerId: "gate-b2.contract-test",
  reconcilerVersion: "1.0.0",
};

const sourceBasis: SourceBasis = [
  {
    sourceKind: "snapshot-document",
    sourceKey: "scene/chapter-1",
    revisionToken: "revision-7",
    revisionObservedAt: "2026-08-12T00:00:00.000Z",
  },
];

const evidenceReadSet = {
  evidenceSet: [
    {
      evidenceRef: "evidence-1",
      documentRef: "scene/chapter-1",
      quoteDigest: "sha256:evidence" as const,
    },
  ],
  readSet: [
    { inputRef: "scene/chapter-1", kind: "snapshot-document" as const },
    { inputRef: "projection/parent", kind: "projection" as const },
  ],
  readSetDigest: "sha256:read-set" as const,
};

function draftEnvelope(
  draftId: string,
  overrides: {
    changeKind?: ProposalChangeKind;
    targetProjectionRef?: string;
    semanticAssessment?: "unchanged" | "revision" | "retraction" | "conflict";
    payload?: Readonly<Record<string, unknown>>;
  } = {},
): NarrativeProposalDraftEnvelope {
  return buildProposalDraftEnvelope({
    context,
    schema: {
      proposalSchemaId: "narrative.proposal",
      proposalSchemaVersion: "1",
    },
    proposalKey: `proposal:${draftId}`,
    kind: "gate-b2.contract@1",
    sourceBasis,
    evidenceReadSet,
    draft: {
      changeKind: overrides.changeKind ?? "revise",
      targetProjectionRef: overrides.targetProjectionRef,
      semanticAssessment: overrides.semanticAssessment ?? "revision",
      payload: overrides.payload ?? {},
    },
    createId: () => draftId,
  });
}

describe("Gate B2 cross-cutting negative contracts", () => {
  it("admits semantically weird content when the draft envelope is structurally valid", () => {
    const draft = draftEnvelope("draft-weird", {
      payload: {
        title: "月はスープでできている",
        participants: ["火曜日"],
        confidence: -9000,
      },
    });

    expect(() =>
      assertDeclarativeReconcilerResult({
        drafts: [draft],
        propagation: ["needs-reconciliation"],
      }),
    ).not.toThrow();
    expect(draft.payload).toEqual({
      title: "月はスープでできている",
      participants: ["火曜日"],
      confidence: -9000,
    });
  });

  it("requires source-basis fields on every draft envelope", () => {
    type EnvelopeRequiresSourceBasis = NarrativeProposalDraftEnvelope extends {
      readonly sourceBasis: SourceBasis;
      readonly readSetDigest: ReadSetDigest;
    }
      ? true
      : false;
    type BuilderRequiresSourceBasis = Parameters<
      typeof buildProposalDraftEnvelope
    >[0] extends {
      readonly sourceBasis: SourceBasis;
    }
      ? true
      : false;

    expectTypeOf<EnvelopeRequiresSourceBasis>().toEqualTypeOf<true>();
    expectTypeOf<BuilderRequiresSourceBasis>().toEqualTypeOf<true>();

    const draft = draftEnvelope("draft-source-basis");
    expect(draft.sourceBasis).toEqual(sourceBasis);
    expect(draft.readSetDigest).toEqual(evidenceReadSet.readSetDigest);
  });

  it("allows only needs-reconciliation propagation", () => {
    expect(isAllowedPropagationSignal("needs-reconciliation")).toBe(true);
    for (const forbidden of [
      "domain-delete",
      "semantic-retract-cascade",
      "merge",
      "split",
    ]) {
      expect(isAllowedPropagationSignal(forbidden)).toBe(false);
    }
  });

  it("rejects domain-delete and semantic-retract-cascade propagation", () => {
    const draft = draftEnvelope("draft-propagation");
    for (const forbidden of [
      "domain-delete",
      "semantic-retract-cascade",
    ] as const) {
      expect(() =>
        assertDeclarativeReconcilerResult({
          drafts: [draft],
          propagation: [forbidden as "needs-reconciliation"],
        }),
      ).toThrow(/needs-reconciliation/);

      expect(() =>
        assertDeclarativeReconcilerResult({
          drafts: [
            {
              ...draft,
              propagation: forbidden as "needs-reconciliation",
            },
          ],
          propagation: [],
        }),
      ).toThrow(/not allowed/);
    }
  });

  it("creates semantic retraction as a new compensating draft without mutating history", () => {
    const prior = draftEnvelope("draft-prior", {
      changeKind: "add",
      semanticAssessment: "unchanged",
      payload: { title: "旧解釈", state: "applied" },
    });
    const priorSnapshot = structuredClone(prior);

    const compensation = draftEnvelope("draft-compensation", {
      changeKind: "retract",
      targetProjectionRef: "projection/prior",
      semanticAssessment: "retraction",
      payload: { compensatesDraftId: prior.draftId },
    });

    expect(compensation.draftId).not.toBe(prior.draftId);
    expect(compensation.changeKind).toBe("retract");
    expect(compensation.payload).toEqual({ compensatesDraftId: "draft-prior" });
    expect(prior).toEqual(priorSnapshot);
    expect(prior.payload).toEqual({ title: "旧解釈", state: "applied" });
  });

  it("turns a stale parent into only a child needs-reconciliation signal", () => {
    const input: NarrativeReconcilerInput = {
      context,
      snapshotRef: "snapshot-1",
      snapshotDigest: "sha256:snapshot" as const,
      projections: [
        {
          projectionRef: "projection/parent",
          freshness: "stale",
          sourceBasis,
        },
      ],
    };
    const childDraft = draftEnvelope("draft-child", {
      targetProjectionRef: "projection/child",
      semanticAssessment: "revision",
      payload: {
        generatedFrom: "projection/parent",
        action: "needs-reconciliation",
      },
    });
    const result = {
      drafts: [childDraft],
      propagation: ["needs-reconciliation"] as const,
    };

    expect(staleProjectionRefs(input)).toEqual(["projection/parent"]);
    expect(result.propagation).toEqual(["needs-reconciliation"]);
    expect(result.drafts[0]?.semanticAssessment).toBe("revision");
    expect(result.drafts[0]?.changeKind).not.toBe("retract");
    assertDeclarativeReconcilerResult(result);
  });

  it("does not represent Undo as semantic retraction in reconciler types", () => {
    type UndoChangeKind = Extract<ProposalChangeKind, "undo">;
    expectTypeOf<UndoChangeKind>().toEqualTypeOf<never>();

    const proposalKinds: readonly ProposalChangeKind[] = [
      "add",
      "revise",
      "retract",
      "merge",
      "split",
    ];
    expect(proposalKinds).not.toContain("undo");
    expect(isCompensatingChangeKind("retract")).toBe(true);
    expect(isCompensatingChangeKind("revise")).toBe(false);
  });

  it("keeps browser and Electron writer trace schemas in parity", () => {
    const fixturePath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../evals/fixtures/narrative/writer-parity/gate-b2-trace.json",
    );
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      runtimes: Record<
        "browser" | "electron",
        {
          expectedTrace: Record<string, Record<string, unknown>>;
        }
      >;
    };
    const browser = fixture.runtimes.browser.expectedTrace;
    const electron = fixture.runtimes.electron.expectedTrace;

    expect(Object.keys(browser).sort()).toEqual(Object.keys(electron).sort());
    for (const key of Object.keys(browser)) {
      expect(Object.keys(browser[key] ?? {}).sort()).toEqual(
        Object.keys(electron[key] ?? {}).sort(),
      );
    }
  });
});

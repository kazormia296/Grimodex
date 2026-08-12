import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  assertDeclarativeReconcilerResult,
  buildProposalDraftEnvelope,
  isAllowedPropagationSignal,
  isEvidenceFreshness,
  isSemanticAssessment,
  rollupProjectionFreshness,
  staleProjectionRefs,
} from "./contract";
import type {
  NarrativeProposalDraftEnvelope,
  NarrativeReconciler,
  NarrativeReconcilerInput,
} from "./types";

const context = {
  runId: "run-1",
  taskId: "task-1",
  reconcilerId: "maintenance.generic",
  reconcilerVersion: "0.1.0",
};

const sourceBasis = [
  {
    sourceKind: "snapshot-document",
    sourceKey: "doc/ch1",
    revisionToken: "rev-3",
  },
];

const evidenceReadSet = {
  evidenceSet: [{ evidenceRef: "ev-1", documentRef: "doc/ch1" }],
  readSet: [
    { inputRef: "doc/ch1", kind: "snapshot-document" as const },
    { inputRef: "proj-1", kind: "projection" as const },
  ],
  readSetDigest: "sha256:abc" as const,
};

describe("NarrativeReconciler contract", () => {
  it("separates EvidenceFreshness (Core) from SemanticAssessment (Reconciler)", () => {
    for (const freshness of [
      "fresh",
      "stale",
      "source-missing",
      "anchor-mismatch",
      "read-set-drift",
      "unknown",
    ]) {
      expect(isEvidenceFreshness(freshness)).toBe(true);
      expect(isSemanticAssessment(freshness)).toBe(false);
    }
    for (const assessment of [
      "unchanged",
      "revision",
      "retraction",
      "conflict",
    ]) {
      expect(isSemanticAssessment(assessment)).toBe(true);
      expect(isEvidenceFreshness(assessment)).toBe(false);
    }
  });

  it("limits propagation to needs-reconciliation", () => {
    expect(isAllowedPropagationSignal("needs-reconciliation")).toBe(true);
    expect(isAllowedPropagationSignal("domain-delete")).toBe(false);
    expect(isAllowedPropagationSignal("semantic-retract-cascade")).toBe(false);
  });

  it("builds draft envelopes with source basis, read-set digest, and evidence/read separation", () => {
    const draft = buildProposalDraftEnvelope({
      context,
      schema: {
        proposalSchemaId: "narrative.proposal",
        proposalSchemaVersion: "1",
      },
      proposalKey: "codex.entity:hero",
      kind: "codex.bind-entity@1",
      sourceBasis,
      evidenceReadSet,
      draft: {
        changeKind: "revise",
        targetProjectionRef: "projection/codex/hero",
        semanticAssessment: "revision",
        payload: { name: "Hero" },
      },
      createId: () => "draft-1",
    });

    expect(draft).toMatchObject({
      draftId: "draft-1",
      reconcilerId: "maintenance.generic",
      reconcilerVersion: "0.1.0",
      proposalSchemaId: "narrative.proposal",
      proposalSchemaVersion: "1",
      schemaVersion: 1,
      runId: "run-1",
      taskId: "task-1",
      sourceBasis,
      readSetDigest: evidenceReadSet.readSetDigest,
      propagation: "needs-reconciliation",
      semanticAssessment: "revision",
    });
    expect(draft.evidenceSet).not.toBe(draft.readSet);
    expect(draft.evidenceSet).toHaveLength(1);
    expect(draft.readSet).toHaveLength(2);
  });

  it("rolls up projection freshness without semantic assessment", () => {
    const input: NarrativeReconcilerInput = {
      context,
      snapshotRef: "snap-1",
      snapshotDigest: "sha256:snap" as const,
      projections: [
        {
          projectionRef: "p1",
          freshness: "fresh",
          sourceBasis,
        },
        {
          projectionRef: "p2",
          freshness: "stale",
          sourceBasis,
        },
      ],
    };

    expect(rollupProjectionFreshness(input)).toBe("stale");
    expect(staleProjectionRefs(input)).toEqual(["p2"]);
  });

  it("rejects reconciler results that expose forbidden propagation signals", () => {
    const envelope: NarrativeProposalDraftEnvelope = buildProposalDraftEnvelope(
      {
        context,
        schema: {
          proposalSchemaId: "narrative.proposal",
          proposalSchemaVersion: "1",
        },
        proposalKey: "k",
        kind: "test@1",
        sourceBasis,
        evidenceReadSet,
        draft: {
          changeKind: "add",
          semanticAssessment: "unchanged",
          payload: {},
        },
        createId: () => "d",
      },
    );

    assertDeclarativeReconcilerResult({
      drafts: [envelope],
      propagation: ["needs-reconciliation"],
    });

    expect(() =>
      assertDeclarativeReconcilerResult({
        drafts: [envelope],
        propagation: ["domain-delete" as "needs-reconciliation"],
      }),
    ).toThrow(/needs-reconciliation/);
  });

  it("NarrativeReconciler interface returns declarative drafts only", () => {
    const reconciler: NarrativeReconciler = {
      identity: {
        reconcilerId: context.reconcilerId,
        reconcilerVersion: context.reconcilerVersion,
      },
      reconcile(input) {
        const stale = staleProjectionRefs(input);
        if (stale.length === 0) {
          return { drafts: [], propagation: [] };
        }
        return {
          drafts: [
            buildProposalDraftEnvelope({
              context: input.context,
              schema: {
                proposalSchemaId: "narrative.proposal",
                proposalSchemaVersion: "1",
              },
              proposalKey: stale[0]!,
              kind: "maintenance.reconcile@1",
              sourceBasis: input.projections[0]!.sourceBasis,
              evidenceReadSet,
              draft: {
                changeKind: "revise",
                targetProjectionRef: stale[0],
                semanticAssessment: "revision",
                payload: { reason: "stale-projection" },
              },
            }),
          ],
          propagation: ["needs-reconciliation"],
        };
      },
    };

    const result = reconciler.reconcile({
      context,
      snapshotRef: "snap",
      snapshotDigest: "sha256:s" as const,
      projections: [
        {
          projectionRef: "p1",
          freshness: "stale",
          sourceBasis,
        },
      ],
    });

    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]).not.toHaveProperty("sql");
    expect(result.drafts[0]).not.toHaveProperty("operation");
    expect(result.drafts[0]).not.toHaveProperty("writerCommand");
    assertDeclarativeReconcilerResult(result);
  });
});

describe("reconciler module contract boundary", () => {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const exportFiles = ["index.ts", "types.ts", "contract.ts"];

  const forbiddenPatterns = [
    /\bINSERT\b/i,
    /\bUPDATE\b/i,
    /\bDELETE\b/i,
    /\bSELECT\b/i,
    /\bCREATE\s+TABLE\b/i,
    /DbOperation/,
    /PreparedPlan/,
    /TypedWriter/,
    /writerCommand/,
    /executeRenderer/,
  ];

  it("does not expose SQL/DML strings or writer command types in public exports", () => {
    for (const file of exportFiles) {
      const source = readFileSync(join(moduleDir, file), "utf8");
      for (const pattern of forbiddenPatterns) {
        expect(source).not.toMatch(pattern);
      }
    }
  });

  it("public index re-exports only reconciler contract symbols", () => {
    const indexSource = readFileSync(join(moduleDir, "index.ts"), "utf8");
    expect(indexSource).not.toMatch(/from ["']@\/db/);
    expect(indexSource).not.toMatch(/from ["'].*grimodex/);
    expect(indexSource).not.toMatch(/defaultSemanticAssessmentForFreshness/);
    expect(indexSource).toMatch(/from "\.\/types"/);
    expect(indexSource).toMatch(/from "\.\/contract"/);
  });

  it("module tree contains no nested writer or db imports", () => {
    const files = readdirSync(moduleDir).filter((name) => name.endsWith(".ts"));
    for (const file of files) {
      const source = readFileSync(join(moduleDir, file), "utf8");
      expect(source).not.toMatch(/from ["']@\/db\//);
      expect(source).not.toMatch(/from ["'].*\/nativeApi/);
    }
  });
});

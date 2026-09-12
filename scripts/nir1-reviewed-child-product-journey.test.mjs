import assert from "node:assert/strict";
import test from "node:test";
import {
  assertInitialProposals,
  assertUnreviewedChild,
  assertExplicitChildApproval,
  assertColdReviewBundle,
  assertScopeOverrideLineage,
} from "../electron/scripts/nir1-reviewed-child-evidence.mjs";
import {
  findClosedRevision,
  parseClosedRevisionRows,
} from "../electron/scripts/nir1-reviewed-child-db.mjs";
import { assertSetupRevisionPayloads } from "./quality/nir1-retrieval/setup-evidence.mjs";

const digest = (letter) => `sha256:${letter.repeat(64)}`;
function proposal() {
  return {
    proposalId: "proposal-1",
    proposalSetId: "set-1",
    kind: "create-event",
    currentRevisionId: "root-1",
    status: "unreviewed",
    originKind: "enveloped",
    reconciliationEnvelopeSchemaVersion: 2,
    reconciliationEnvelopeDigest: digest("a"),
    payloadJson: {
      title: "門",
      disclosure: { secret: true },
      evidence: [{ text: "門が開く" }],
    },
    latestDecision: null,
    application: null,
  };
}
function child() {
  const result = proposal();
  result.currentRevisionId = "child-1";
  result.reconciliationEnvelopeDigest = digest("b");
  result.payloadJson.disclosure.secret = false;
  return result;
}
function approve(row) {
  return {
    ...row,
    status: "approved",
    latestDecision: {
      decisionId: "decision-1",
      proposalId: row.proposalId,
      revisionId: row.currentRevisionId,
      decision: "approved",
      actorKind: "human",
      actorId: "electron:human-review",
      authorityScope: `project/project-1/proposal/${row.proposalId}/revision/${row.currentRevisionId}`,
    },
  };
}

test("normal root is sealed, secret, unreviewed, and unapplied", () => {
  assertInitialProposals([proposal()], 1);
  for (const patch of [
    { status: "approved" },
    { originKind: "legacy-unbound" },
    { application: {} },
  ]) {
    assert.throws(() =>
      assertInitialProposals([{ ...proposal(), ...patch }], 1),
    );
  }
  assert.throws(() => assertInitialProposals([child()], 1));
});

test("secret-off produces a new sealed child and no carried decision", () => {
  assertUnreviewedChild(proposal(), child());
  for (const patch of [
    { currentRevisionId: "root-1" },
    { reconciliationEnvelopeDigest: digest("a") },
    { latestDecision: approve(proposal()).latestDecision },
    { status: "approved" },
  ])
    assert.throws(() =>
      assertUnreviewedChild(proposal(), { ...child(), ...patch }),
    );
  const changedEvidence = child();
  changedEvidence.payloadJson.evidence[0].text = "別の記述";
  assert.throws(() => assertUnreviewedChild(proposal(), changedEvidence));
});

test("approval must identify this child and exact human authority", () => {
  assertExplicitChildApproval(child(), approve(child()), "project-1");
  for (const patch of [
    { revisionId: "root-1" },
    { actorKind: "agent" },
    { actorId: "mcp" },
    { authorityScope: "project/other/proposal/proposal-1/revision/child-1" },
  ]) {
    const actual = approve(child());
    Object.assign(actual.latestDecision, patch);
    assert.throws(() =>
      assertExplicitChildApproval(child(), actual, "project-1"),
    );
  }
});

test("cold reopen preserves exact decisions, artifacts and model receipts", () => {
  const bundle = {
    runId: "run-1",
    projectId: "project-1",
    proposals: [approve(child())],
    stageReceipts: [{ id: "receipt-1" }],
    artifacts: [{ id: "artifact-1" }],
  };
  assertColdReviewBundle(bundle, structuredClone(bundle));
  for (const key of ["proposals", "stageReceipts", "artifacts"]) {
    assert.throws(() =>
      assertColdReviewBundle(bundle, { ...bundle, [key]: [] }),
    );
  }
});

test("closed fixture snapshot parses full history without renderer SQL", () => {
  const rows = parseClosedRevisionRows([
    {
      revisionId: "root-1",
      proposalId: "proposal-1",
      revisionNumber: 1,
      payloadJson: '{"disclosure":{"secret":true}}',
      originKind: "enveloped",
      envelopeJson: '{"revisionBasis":{"kind":"interpretation"}}',
      envelopeDigest: digest("a"),
      createdAt: "2026-09-13T00:00:00.000Z",
      createdBy: "ai",
    },
    {
      revisionId: "child-1",
      proposalId: "proposal-1",
      revisionNumber: 2,
      payloadJson: '{"disclosure":{"secret":false}}',
      originKind: "enveloped",
      envelopeJson: '{"revisionBasis":{"kind":"human-derived"}}',
      envelopeDigest: digest("b"),
      createdAt: "2026-09-13T00:00:01.000Z",
      createdBy: "human",
    },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(
    findClosedRevision(rows, "root-1").payloadJson.disclosure.secret,
    true,
  );
  assert.equal(
    findClosedRevision(rows, "child-1").envelope.revisionBasis.kind,
    "human-derived",
  );
  assert.throws(
    () => findClosedRevision(rows, "missing"),
    /missing requested revision/,
  );
  assert.throws(
    () =>
      parseClosedRevisionRows([
        {
          revisionId: "root-1",
          proposalId: "proposal-1",
          revisionNumber: 1,
          payloadJson: "not-json",
          originKind: "enveloped",
          envelopeJson: "{}",
          envelopeDigest: digest("a"),
          createdAt: "2026-09-13T00:00:00.000Z",
          createdBy: "ai",
        },
      ]),
    /malformed payloadJson/,
  );
});

test("closed setup verification keeps approved as a proposal row", () => {
  const initial = {
    runId: "run-1",
    projectId: "project-1",
    proposals: [proposal()],
    stageReceipts: [{ id: "receipt-1" }],
    artifacts: [{ id: "artifact-1" }],
  };
  const approved = approve(child());
  const after = { ...initial, proposals: [approved] };
  const item = { initial, approved, bundle: after };
  const closed = parseClosedRevisionRows([
    {
      revisionId: "root-1",
      proposalId: "proposal-1",
      revisionNumber: 1,
      payloadJson: JSON.stringify(initial.proposals[0].payloadJson),
      originKind: "enveloped",
      envelopeJson: "{}",
      envelopeDigest: initial.proposals[0].reconciliationEnvelopeDigest,
      createdAt: "2026-09-13T00:00:00.000Z",
      createdBy: "ai",
    },
    {
      revisionId: "child-1",
      proposalId: "proposal-1",
      revisionNumber: 2,
      payloadJson: JSON.stringify(approved.payloadJson),
      originKind: "enveloped",
      envelopeJson: "{}",
      envelopeDigest: approved.reconciliationEnvelopeDigest,
      createdAt: "2026-09-13T00:00:01.000Z",
      createdBy: "human",
    },
  ]);
  assertSetupRevisionPayloads(
    item,
    findClosedRevision(closed, "root-1"),
    findClosedRevision(closed, "child-1"),
  );
  assert.deepEqual(item.bundle.proposals[0], approved);
  assert.equal(item.approved.proposals, undefined);
});

test("scope child binds immutable root and unchanged semantic core and Evidence", () => {
  const root = {
    revisionId: "root-1",
    envelopeDigest: digest("a"),
    envelope: {
      assertion: {
        scope: {
          schemaVersion: 2,
          registryVersion: "narrative-scope/2",
          scene: { kind: "exact", ref: "scene:scene-1" },
          audience: { kind: "unknown" },
          readingOrder: { kind: "unknown" },
          storyTime: { kind: "unknown" },
        },
      },
      assertionDigests: {
        assertionDigest: digest("c"),
        assertionCoreDigest: digest("d"),
        scopeDigest: digest("a"),
      },
      effectiveMaterialBasis: { evidenceSet: [{ source: "scene-1" }] },
    },
  };
  const derived = {
    revisionId: "child-1",
    envelopeDigest: digest("b"),
    envelope: {
      assertion: {
        scope: {
          schemaVersion: 2,
          registryVersion: "narrative-scope/2",
          scene: { kind: "exact", ref: "scene:scene-1" },
          audience: { kind: "any" },
          readingOrder: { kind: "any" },
          storyTime: { kind: "any" },
        },
      },
      assertionDigests: {
        assertionDigest: digest("e"),
        assertionCoreDigest: digest("d"),
        scopeDigest: digest("b"),
      },
      effectiveMaterialBasis: structuredClone(
        root.envelope.effectiveMaterialBasis,
      ),
      revisionBasis: {
        kind: "human-derived",
        parentRevisionId: "root-1",
        expectedParentEnvelopeDigest: digest("a"),
        rootInterpretationRevisionId: "root-1",
        parentAssertionDigest: digest("c"),
        derivation: {
          kind: "scope-override",
          proposalPayloadChangedPaths: ["/disclosure/secret"],
        },
        revisionActor: { kind: "human" },
      },
    },
  };
  assertScopeOverrideLineage(root, derived);
  for (const patch of [
    { parentRevisionId: "other" },
    { rootInterpretationRevisionId: "other" },
    { expectedParentEnvelopeDigest: digest("f") },
  ]) {
    const altered = structuredClone(derived);
    Object.assign(altered.envelope.revisionBasis, patch);
    assert.throws(() => assertScopeOverrideLineage(root, altered));
  }
  for (const alter of [
    (envelope) => {
      delete envelope.assertion;
    },
    (envelope) => {
      envelope.assertion.scope.scene.ref = "scene:other";
    },
    (envelope) => {
      envelope.assertion.scope.audience = { kind: "unknown" };
    },
    (envelope) => {
      envelope.assertion.scope.readingOrder = { kind: "unknown" };
    },
    (envelope) => {
      envelope.assertion.scope.storyTime = { kind: "unknown" };
    },
    (envelope) => {
      envelope.assertionDigests.scopeDigest = digest("a");
    },
    (envelope) => {
      envelope.assertionDigests.assertionDigest = digest("c");
    },
    (envelope) => {
      envelope.assertionDigests.assertionCoreDigest = digest("f");
    },
    (envelope) => {
      envelope.effectiveMaterialBasis.evidenceSet = [];
    },
    (envelope) => {
      envelope.revisionBasis.derivation.kind = "projection-only";
    },
    (envelope) => {
      envelope.revisionBasis.derivation.proposalPayloadChangedPaths.push(
        "/title",
      );
    },
    (envelope) => {
      envelope.revisionBasis.revisionActor.kind = "agent";
    },
  ]) {
    const altered = structuredClone(derived);
    alter(altered.envelope);
    assert.throws(() => assertScopeOverrideLineage(root, altered));
  }
});

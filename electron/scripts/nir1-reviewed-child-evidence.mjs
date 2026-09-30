import assert from "node:assert/strict";

function assertSealed(row) {
  assert.equal(row.originKind, "enveloped");
  assert.equal(row.reconciliationEnvelopeSchemaVersion, 2);
  assert.match(row.reconciliationEnvelopeDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.ok(row.currentRevisionId);
  assert.equal(row.application, null);
}

export function assertInitialProposals(proposals, expectedCount) {
  assert.equal(proposals.length, expectedCount);
  assert.equal(
    new Set(proposals.map((row) => row.proposalId)).size,
    expectedCount,
  );
  for (const row of proposals) {
    assertSealed(row);
    assert.equal(row.payloadJson.disclosure.secret, true);
    assert.equal(row.status, "unreviewed");
    assert.equal(row.latestDecision, null);
  }
}

export function assertUnreviewedChild(parent, child) {
  assertSealed(child);
  assert.equal(child.proposalId, parent.proposalId);
  assert.equal(child.proposalSetId, parent.proposalSetId);
  assert.notEqual(child.currentRevisionId, parent.currentRevisionId);
  assert.notEqual(
    child.reconciliationEnvelopeDigest,
    parent.reconciliationEnvelopeDigest,
  );
  const expectedPayload = structuredClone(parent.payloadJson);
  expectedPayload.disclosure.secret = false;
  assert.deepEqual(child.payloadJson, expectedPayload);
  assert.equal(child.status, "unreviewed");
  assert.equal(
    child.latestDecision,
    null,
    "a child must not inherit a parent Decision",
  );
}

export function assertExplicitChildApproval(child, approved, projectId) {
  assertSealed(approved);
  assert.equal(approved.proposalId, child.proposalId);
  assert.equal(approved.currentRevisionId, child.currentRevisionId);
  assert.equal(
    approved.reconciliationEnvelopeDigest,
    child.reconciliationEnvelopeDigest,
  );
  assert.deepEqual(approved.payloadJson, child.payloadJson);
  assert.equal(approved.status, "approved");
  const decision = approved.latestDecision;
  assert.ok(decision?.decisionId);
  assert.equal(decision.proposalId, child.proposalId);
  assert.equal(decision.revisionId, child.currentRevisionId);
  assert.equal(decision.decision, "approved");
  assert.equal(decision.actorKind, "human");
  assert.equal(decision.actorId, "electron:human-review");
  assert.equal(
    decision.authorityScope,
    `project/${projectId}/proposal/${child.proposalId}/revision/${child.currentRevisionId}`,
  );
}

export function assertColdReviewBundle(approved, cold) {
  for (const key of [
    "runId",
    "projectId",
    "proposals",
    "stageReceipts",
    "artifacts",
  ]) {
    assert.deepEqual(cold[key], approved[key], `cold reopen preserves ${key}`);
  }
}

export function assertScopeOverrideLineage(root, child) {
  assert.notEqual(child.revisionId, root.revisionId);
  assert.notEqual(child.envelopeDigest, root.envelopeDigest);
  const basis = child.envelope.revisionBasis;
  assert.equal(basis.kind, "human-derived");
  assert.equal(basis.parentRevisionId, root.revisionId);
  assert.equal(basis.expectedParentEnvelopeDigest, root.envelopeDigest);
  assert.equal(basis.rootInterpretationRevisionId, root.revisionId);
  assert.equal(
    basis.parentAssertionDigest,
    root.envelope.assertionDigests.assertionDigest,
  );
  assert.equal(basis.derivation.kind, "scope-override");
  assert.deepEqual(basis.derivation.proposalPayloadChangedPaths, [
    "/disclosure/secret",
  ]);
  assert.equal(basis.revisionActor.kind, "human");
  const rootScope = root.envelope.assertion.scope;
  assert.equal(rootScope.schemaVersion, 2);
  assert.equal(rootScope.registryVersion, "narrative-scope/2");
  assert.equal(rootScope.scene.kind, "exact");
  assert.deepEqual(child.envelope.assertion.scope, {
    ...rootScope,
    audience: { kind: "any" },
    readingOrder: { kind: "any" },
    storyTime: { kind: "any" },
  });
  for (const digest of ["scopeDigest", "assertionDigest"]) {
    assert.match(
      child.envelope.assertionDigests[digest],
      /^sha256:[a-f0-9]{64}$/u,
    );
    assert.notEqual(
      child.envelope.assertionDigests[digest],
      root.envelope.assertionDigests[digest],
    );
  }
  assert.equal(
    child.envelope.assertionDigests.assertionCoreDigest,
    root.envelope.assertionDigests.assertionCoreDigest,
  );
  assert.ok(
    root.envelope.effectiveMaterialBasis.evidenceSet.length > 0,
    "root Evidence must be recorded",
  );
  assert.deepEqual(
    child.envelope.effectiveMaterialBasis.evidenceSet,
    root.envelope.effectiveMaterialBasis.evidenceSet,
  );
}

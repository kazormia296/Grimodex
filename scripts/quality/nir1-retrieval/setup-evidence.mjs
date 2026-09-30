import assert from "node:assert/strict";

export function assertSetupRevisionPayloads(item, rootRevision, childRevision) {
  const initialProposal = item.initial?.proposals?.[0];
  assert.ok(initialProposal, "setup initial review bundle contains a proposal");
  assert.ok(item.approved, "setup approved review row exists");
  assert.deepEqual(rootRevision.payloadJson, initialProposal.payloadJson);
  assert.equal(
    rootRevision.envelopeDigest,
    initialProposal.reconciliationEnvelopeDigest,
  );
  assert.deepEqual(childRevision.payloadJson, item.approved.payloadJson);
  assert.equal(
    childRevision.envelopeDigest,
    item.approved.reconciliationEnvelopeDigest,
  );
}

export function assertCorpusInterpretation(bundle, revision, scene) {
  assert.equal(bundle.proposals.length, 1);
  const snapshots = bundle.artifacts.filter(
    (row) => row.artifactKind === "source.snapshot@1",
  );
  assert.equal(snapshots.length, 1);
  const documents = snapshots[0].payloadJson.snapshot.documents;
  assert.equal(
    documents.length,
    1,
    "one isolated source in actual planner snapshot",
  );
  assert.equal(documents[0].sourceKey, `project:scene:${scene.id}`);
  assert.equal(documents[0].canonical.text.trim(), scene.body);
  assert.deepEqual(
    bundle.stageReceipts.map((row) => row.stageExecution.stageId).sort(),
    ["narrative_event_synthesize", "narrative_observation_extract"],
  );
  for (const receipt of bundle.stageReceipts) {
    assert.equal(receipt.parseStatus, "parsed");
    assert.equal(receipt.terminalStatus, "succeeded");
  }
  const envelope = revision.envelope;
  assert.equal(envelope.revisionBasis.kind, "interpretation");
  assert.equal(envelope.assertion.scope.scene.ref, `scene:${scene.id}`);
  for (const [key, value] of Object.entries(scene.interpretationSeed))
    assert.equal(
      envelope.assertion.payload[key],
      value,
      `frozen semantic seed ${scene.id}/${key}`,
    );
  const basis = envelope.effectiveMaterialBasis;
  assert.ok(basis.evidenceSet.length > 0);
  assert.ok(
    basis.evidenceSet.every(
      (row) => row.sourceKey === `project:scene:${scene.id}`,
    ),
  );
  const storySources = basis.sourceBasis.filter(
    (row) => row.sourceKind === "scene-body",
  );
  assert.equal(storySources.length, 1);
  assert.equal(storySources[0].sourceKey, `project:scene:${scene.id}`);
  assert.ok(
    basis.sourceBasis.some((row) => row.sourceKind === "snapshot-document"),
  );
  const contexts = envelope.revisionBasis.contextSet;
  assert.equal(
    contexts.length,
    2,
    "one cluster and one observation; no hidden optional story input",
  );
  assert.equal(
    contexts.filter((row) => row.contextId.startsWith("event-observation:"))
      .length,
    1,
  );
  const observations = bundle.artifacts.filter(
    (row) => row.artifactKind === "chronicle.raw-observations@1",
  );
  assert.equal(observations.length, 1);
  assert.equal(observations[0].payloadJson.observations.length, 1);
}

export function assertSetupRoster(scenes, query, persistedScenes) {
  const expected = [
    ...scenes,
    { id: query.currentSceneId, body: query.currentBody },
  ];
  assert.equal(persistedScenes.length, expected.length);
  assert.equal(
    new Set(persistedScenes.map((row) => row.id)).size,
    expected.length,
  );
  for (const scene of expected) {
    const actual = persistedScenes.find((row) => row.id === scene.id);
    assert.ok(actual, `persisted source ${scene.id}`);
    assert.equal(actual.storyTimeOrder, null);
    const doc = JSON.parse(actual.content);
    assert.deepEqual(doc, {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: scene.body }] },
      ],
    });
  }
}

export function assertSetupReadingOrder(scenes, query, nodes) {
  const flattened = [];
  const visit = (parentId) => {
    const children = nodes
      .filter((row) => row.parentId === parentId)
      .sort((a, b) =>
        a.sortOrder < b.sortOrder ? -1 : a.sortOrder > b.sortOrder ? 1 : 0,
      );
    for (const child of children) {
      if (child.nodeType === "scene") flattened.push(child.id);
      visit(child.id);
    }
  };
  visit(null);
  const expected = [
    ...scenes,
    { id: query.currentSceneId, order: query.currentOrder },
  ]
    .sort((a, b) => a.order - b.order)
    .map((row) => row.id);
  assert.deepEqual(
    flattened,
    expected,
    "persisted production tree traversal preserves frozen source and query order",
  );
}

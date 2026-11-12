import assert from "node:assert/strict";
import test from "node:test";
import {
  PRODUCT_CONTRACT_REQUIREMENTS,
  PRODUCT_DOMAIN_RULES,
  PRODUCT_JOURNEY_CATALOG,
} from "../electron/scripts/product-journey-catalog.mjs";
import { selectProductJourneys } from "../electron/scripts/product-journey-impact.mjs";
import { PRODUCT_JOURNEYS } from "../electron/scripts/product-journeys.mjs";
import { FIXED_PRODUCT_JOURNEY_SHARDS } from "../electron/scripts/product-journey-shards.mjs";
import {
  CHRONICLE_EDITED_APPLY_JOURNEY_ID as ID,
  assertEditedChild,
  assertEditedChronicleApplied,
  assertHumanDerivedLineage,
  clearProposalSecretInReview,
  clickEnabledApplyButton,
} from "../electron/scripts/chronicle-edited-apply-product-journey.mjs";

const CONTRACT = "chronicle:extract-edit-approve-apply-reopen";
const EXISTING_ID = "chronicle-extract-review-apply-reopen";

test("the edited-apply journey is a distinct required catalog entry with its own contract", () => {
  assert.equal(ID, "chronicle-extract-edit-approve-apply-reopen");
  const entry = PRODUCT_JOURNEY_CATALOG.find((row) => row.id === ID);
  assert.ok(entry);
  assert.deepEqual(entry.contracts, [CONTRACT]);
  assert.deepEqual(entry.capabilities, ["electron", "napi"]);
  assert.deepEqual(entry.domains, ["chronicle-extraction"]);
  assert.notEqual(entry.required, false);
  assert.ok(PRODUCT_CONTRACT_REQUIREMENTS.some((row) => row.id === CONTRACT));
  assert.ok(
    PRODUCT_JOURNEYS.some(
      (row) => row.id === ID && typeof row.run === "function",
    ),
  );
  // The existing journey keeps its own id and contract.
  assert.deepEqual(
    PRODUCT_JOURNEY_CATALOG.find((row) => row.id === EXISTING_ID).contracts,
    ["chronicle:extract-review-apply-reopen"],
  );
  assert.deepEqual(
    PRODUCT_JOURNEYS.map((row) => row.id),
    PRODUCT_JOURNEY_CATALOG.map((row) => row.id),
    "runnable journeys follow catalog order",
  );
});

test("the edited-apply journey shares the Chronicle shard and stays after the existing journey", () => {
  const shard = FIXED_PRODUCT_JOURNEY_SHARDS.findIndex((ids) =>
    ids.includes(ID),
  );
  assert.equal(shard, 4, "fifth shard");
  assert.equal(FIXED_PRODUCT_JOURNEY_SHARDS[shard].length, 6);
  const ids = FIXED_PRODUCT_JOURNEY_SHARDS[shard];
  assert.equal(ids.indexOf(ID), ids.indexOf(EXISTING_ID) + 1);
  assert.equal(FIXED_PRODUCT_JOURNEY_SHARDS.flat().length, 36);
});

test("a Chronicle review UI or journey-script change selects both Chronicle journeys", () => {
  for (const changedPath of [
    "src/features/chronicle/ChronicleProposalReview.tsx",
    "src/application/narrative-extraction/chronicleV2Production.ts",
  ]) {
    const selected = selectProductJourneys({
      catalog: PRODUCT_JOURNEY_CATALOG,
      domainRules: PRODUCT_DOMAIN_RULES,
      changedPaths: [changedPath],
    });
    assert.ok(selected.journeyIds.includes(ID));
    assert.ok(selected.journeyIds.includes(EXISTING_ID));
    assert.equal(selected.fallback, false);
  }
  for (const changedPath of [
    "electron/scripts/chronicle-edited-apply-product-journey.mjs",
    "scripts/chronicle-edited-apply-product-journey.test.mjs",
  ]) {
    const selected = selectProductJourneys({
      catalog: PRODUCT_JOURNEY_CATALOG,
      domainRules: PRODUCT_DOMAIN_RULES,
      changedPaths: [changedPath],
    });
    assert.equal(
      selected.fallback,
      false,
      `${changedPath} is a known infrastructure path`,
    );
  }
});

const DIGEST = (seed) => `sha256:${seed.repeat(64).slice(0, 64)}`;

function revision(revisionId, proposalId, basis) {
  return {
    revisionId,
    proposalId,
    revisionNumber: 1,
    envelopeDigest: DIGEST(revisionId.slice(-1)),
    envelope: { revisionBasis: basis },
  };
}

function interpretation(id, proposalId) {
  return revision(id, proposalId, { kind: "interpretation" });
}

function humanDerived(id, proposalId, root) {
  return revision(id, proposalId, {
    kind: "human-derived",
    parentRevisionId: root.revisionId,
    expectedParentEnvelopeDigest: root.envelopeDigest,
    rootInterpretationRevisionId: root.revisionId,
    derivation: {
      kind: "scope-override",
      proposalPayloadChangedPaths: ["/disclosure/secret"],
    },
    revisionActor: { kind: "human" },
  });
}

function proposal(proposalId, revisionId, title, secret, application) {
  return {
    proposalId,
    currentRevisionId: revisionId,
    status: "approved",
    payloadJson: { title, disclosure: { secret } },
    latestDecision: {
      decision: "approved",
      actorKind: "human",
      revisionId,
    },
    application,
  };
}

function appliedFixture() {
  const rootA = interpretation("rev-a1", "pa");
  const childA = humanDerived("rev-a2", "pa", rootA);
  const rootB = interpretation("rev-b1", "pb");
  const bundle = {
    proposals: [
      proposal("pa", "rev-a2", "門が開いた", false, {
        revisionId: "rev-a2",
        commitId: "c1",
        appliedEntityId: "e1",
      }),
      proposal("pb", "rev-b1", "鐘が鳴った", true, {
        revisionId: "rev-b1",
        commitId: "c1",
        appliedEntityId: "e2",
      }),
    ],
  };
  const state = {
    revisions: [rootA, childA, rootB],
    events: [
      { id: "e1", title: "門が開いた", secret: 1 },
      { id: "e2", title: "鐘が鳴った", secret: 1 },
    ],
    sceneLinks: [
      { sceneId: "scene-1", eventId: "e1" },
      { sceneId: "scene-1", eventId: "e2" },
    ],
    applications: [
      { revisionId: "rev-a2", commitId: "c1", appliedEntityId: "e1" },
      { revisionId: "rev-b1", commitId: "c1", appliedEntityId: "e2" },
    ],
    commits: [{ id: "c1", status: "applied" }],
    journals: [{ id: "j1", commitId: "c1", afterJson: "{}" }],
  };
  const context = {
    sceneId: "scene-1",
    editedProposalId: "pa",
    rootRevisionId: "rev-a1",
  };
  return { bundle, state, context, rootA, childA };
}

test("the applied edited journey state passes only for a human-derived, secret-free applied revision with secret Events", () => {
  const { bundle, state, context } = appliedFixture();
  assertEditedChronicleApplied(state, bundle, context);
});

test("applied state fails if the edited proposal was applied from a non-human-derived revision", () => {
  const { bundle, state, context } = appliedFixture();
  state.revisions.find(
    (row) => row.revisionId === "rev-a2",
  ).envelope.revisionBasis = { kind: "interpretation" };
  assert.throws(() => assertEditedChronicleApplied(state, bundle, context));
});

test("applied state fails if the edited proposal's applied revision is still the root", () => {
  const { bundle, state, context } = appliedFixture();
  bundle.proposals[0].currentRevisionId = "rev-a1";
  bundle.proposals[0].latestDecision.revisionId = "rev-a1";
  bundle.proposals[0].application.revisionId = "rev-a1";
  state.applications[0].revisionId = "rev-a1";
  assert.throws(() => assertEditedChronicleApplied(state, bundle, context));
});

test("applied state fails if the edited revision still carries secret", () => {
  const { bundle, state, context } = appliedFixture();
  bundle.proposals[0].payloadJson.disclosure.secret = true;
  assert.throws(() => assertEditedChronicleApplied(state, bundle, context));
});

test("applied state fails if any created Event is not secret (CAS/1)", () => {
  const { bundle, state, context } = appliedFixture();
  state.events[0].secret = 0;
  assert.throws(
    () => assertEditedChronicleApplied(state, bundle, context),
    /secret/,
  );
});

test("applied state fails if Events are missing or duplicated", () => {
  for (const mutate of [
    (state) => state.events.pop(),
    (state) => state.events.push({ id: "e3", title: "門が開いた", secret: 1 }),
  ]) {
    const { bundle, state, context } = appliedFixture();
    mutate(state);
    assert.throws(() => assertEditedChronicleApplied(state, bundle, context));
  }
});

test("applied state fails if the other proposal was changed by the edit", () => {
  const { bundle, state, context } = appliedFixture();
  state.revisions.find(
    (row) => row.revisionId === "rev-b1",
  ).envelope.revisionBasis = { kind: "human-derived" };
  assert.throws(() => assertEditedChronicleApplied(state, bundle, context));
});

test("applied state fails if the Decision is not a human approval of the applied revision", () => {
  const { bundle, state, context } = appliedFixture();
  bundle.proposals[0].latestDecision.revisionId = "rev-a1";
  assert.throws(() => assertEditedChronicleApplied(state, bundle, context));
});

test("lineage requires the child to name its root revision and digest", () => {
  const { rootA, childA } = appliedFixture();
  assertHumanDerivedLineage(rootA, childA);
  for (const mutate of [
    (child) => (child.envelope.revisionBasis.parentRevisionId = "other"),
    (child) =>
      (child.envelope.revisionBasis.expectedParentEnvelopeDigest = DIGEST("f")),
    (child) =>
      (child.envelope.revisionBasis.derivation.proposalPayloadChangedPaths = [
        "/title",
      ]),
    (child) => (child.envelope.revisionBasis.revisionActor.kind = "ai"),
    (child) => (child.envelope.revisionBasis.derivation.kind = "title-edit"),
    (child) => (child.envelope.revisionBasis.kind = "interpretation"),
  ]) {
    const child = globalThis.structuredClone(childA);
    mutate(child);
    assert.throws(() => assertHumanDerivedLineage(rootA, child));
  }
});

test("the edited child must differ from its parent only in secret and start unreviewed", () => {
  const parent = {
    proposalId: "pa",
    currentRevisionId: "rev-a1",
    payloadJson: { title: "門が開いた", disclosure: { secret: true } },
  };
  const child = {
    proposalId: "pa",
    currentRevisionId: "rev-a2",
    status: "unreviewed",
    latestDecision: null,
    payloadJson: { title: "門が開いた", disclosure: { secret: false } },
  };
  assertEditedChild(parent, child);
  for (const mutate of [
    (row) => (row.currentRevisionId = "rev-a1"),
    (row) => (row.payloadJson.disclosure.secret = true),
    (row) => (row.payloadJson.title = "別の題"),
    (row) => (row.status = "approved"),
    (row) => (row.latestDecision = { decision: "approved" }),
  ]) {
    const changed = globalThis.structuredClone(child);
    mutate(changed);
    assert.throws(() => assertEditedChild(parent, changed));
  }
});

function reviewFakes({ checked = true, enabled = true, bundleRows = [] }) {
  const calls = { clicks: [], testIds: [], waits: [] };
  const state = { checked, settled: false };
  const checkbox = {
    waitFor: async () => {},
    isChecked: async () => state.checked,
    click: async () => {
      calls.clicks.push("checkbox");
      state.checked = !state.checked;
      state.settled = true;
    },
  };
  const card = {
    getByRole: () => ({
      first: () => ({ click: async () => calls.clicks.push("card") }),
    }),
  };
  const button = {
    waitFor: async () => {},
    isEnabled: async () => enabled,
    click: async () => calls.clicks.push("apply"),
  };
  const dialog = {
    getByTestId: (id) => {
      calls.testIds.push(id);
      return id === "chronicle-proposal-secret-input" ? checkbox : card;
    },
    getByRole: (role, options) => {
      assert.equal(role, "button");
      assert.deepEqual(options, { name: "取り込む", exact: true });
      return button;
    },
  };
  const harness = {
    waitUntil: async (predicate, label, timeout) => {
      calls.waits.push({ label, timeout });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const outcome = await predicate();
        if (outcome) return outcome;
      }
      throw new Error(`timeout: ${label}`);
    },
  };
  return { calls, dialog, harness, bundleRows };
}

const editParent = {
  proposalId: "pa",
  currentRevisionId: "rev-a1",
  payloadJson: { title: "門が開いた", disclosure: { secret: true } },
};
const editChild = {
  proposalId: "pa",
  currentRevisionId: "rev-a2",
  status: "unreviewed",
  latestDecision: null,
  payloadJson: { title: "門が開いた", disclosure: { secret: false } },
};

test("the edit step selects the proposal card and clicks the secret checkbox once", async () => {
  const { calls, dialog, harness } = reviewFakes({});
  const child = await clearProposalSecretInReview({
    harness,
    dialog,
    parent: editParent,
    readBundle: async () => ({ proposals: [editChild] }),
  });
  assert.equal(child, editChild);
  assert.deepEqual(calls.clicks, ["card", "checkbox"]);
  assert.deepEqual(calls.testIds, [
    "chronicle-proposal-card-pa",
    "chronicle-proposal-secret-input",
  ]);
});

test("the edit step fails if the secret checkbox does not start checked or no child appears", async () => {
  const unchecked = reviewFakes({ checked: false });
  await assert.rejects(
    clearProposalSecretInReview({
      harness: unchecked.harness,
      dialog: unchecked.dialog,
      parent: editParent,
      readBundle: async () => ({ proposals: [editChild] }),
    }),
  );
  assert.ok(!unchecked.calls.clicks.includes("checkbox"));
  const noChild = reviewFakes({});
  await assert.rejects(
    clearProposalSecretInReview({
      harness: noChild.harness,
      dialog: noChild.dialog,
      parent: editParent,
      readBundle: async () => ({ proposals: [editParent] }),
    }),
    /timeout/,
  );
});

test("a disabled apply button fails the journey and is never clicked", async () => {
  const disabled = reviewFakes({ enabled: false });
  await assert.rejects(
    clickEnabledApplyButton({
      harness: disabled.harness,
      dialog: disabled.dialog,
    }),
    /timeout/,
  );
  assert.deepEqual(disabled.calls.clicks, []);
  const enabled = reviewFakes({ enabled: true });
  await clickEnabledApplyButton({
    harness: enabled.harness,
    dialog: enabled.dialog,
  });
  assert.deepEqual(enabled.calls.clicks, ["apply"]);
});

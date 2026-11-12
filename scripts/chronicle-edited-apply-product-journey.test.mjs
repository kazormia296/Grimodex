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
  BULK_APPROVE_BUTTON_TESTID,
  BULK_APPROVE_RESULT_TESTID,
  CHRONICLE_EDITED_APPLY_JOURNEY_ID as ID,
  assertBulkApproveButtonIdle,
  assertBulkApproveResultText,
  assertBulkApprovalJudgement,
  assertBulkApprovalLeftUntouched,
  assertBulkApprovedChild,
  assertEditedChild,
  assertEditedChronicleApplied,
  assertHumanDerivedLineage,
  assertNoBulkApprovalTargets,
  assertSameApprovalActor,
  bulkApproveCountFromLabel,
  clearProposalSecretInReview,
  clickEnabledApplyButton,
  clickEnabledBulkApproveButton,
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

// ---- bulk approval (BAO/1) ----

const gateProposal = (overrides = {}) => ({
  proposalId: "pa",
  payloadJson: { title: "門が開いた", disclosure: { secret: true } },
  bulkApproval: { eligible: false, reasons: ["r3-significance"] },
  ...overrides,
});
const bellProposal = (overrides = {}) => ({
  proposalId: "pb",
  payloadJson: { title: "鐘が鳴った", disclosure: { secret: true } },
  bulkApproval: { eligible: true, reasons: [] },
  ...overrides,
});
const JUDGEMENT_TITLES = {
  eligibleTitle: "鐘が鳴った",
  ineligibleTitle: "門が開いた",
};

test("the bulk approval judgement passes only for one target with no reason and one r3-significance exclusion", () => {
  assertBulkApprovalJudgement(
    [gateProposal(), bellProposal()],
    JUDGEMENT_TITLES,
  );
  for (const proposals of [
    [gateProposal(), bellProposal({ bulkApproval: undefined })],
    [
      gateProposal(),
      bellProposal({
        bulkApproval: { eligible: false, reasons: ["approved"] },
      }),
    ],
    [
      gateProposal({ bulkApproval: { eligible: true, reasons: [] } }),
      bellProposal(),
    ],
    [
      gateProposal({
        bulkApproval: {
          eligible: false,
          reasons: ["r3-significance", "r4-actuality"],
        },
      }),
      bellProposal(),
    ],
    [gateProposal()],
  ]) {
    assert.throws(() =>
      assertBulkApprovalJudgement(proposals, JUDGEMENT_TITLES),
    );
  }
});

test("no bulk approval target may remain after the press", () => {
  assertNoBulkApprovalTargets([
    gateProposal(),
    bellProposal({ bulkApproval: { eligible: false, reasons: ["approved"] } }),
  ]);
  assert.throws(() =>
    assertNoBulkApprovalTargets([gateProposal(), bellProposal()]),
  );
  assert.throws(() =>
    assertNoBulkApprovalTargets([gateProposal({ bulkApproval: undefined })]),
  );
});

const bulkParent = {
  proposalId: "pb",
  currentRevisionId: "rev-b1",
  payloadJson: { title: "鐘が鳴った", disclosure: { secret: true } },
};
const bulkChild = {
  proposalId: "pb",
  currentRevisionId: "rev-b2",
  status: "approved",
  latestDecision: {
    decision: "approved",
    actorKind: "human",
    revisionId: "rev-b2",
  },
  payloadJson: { title: "鐘が鳴った", disclosure: { secret: false } },
};

test("the bulk-approved child differs from its parent only in secret and carries the approval of that revision", () => {
  assertBulkApprovedChild(bulkParent, bulkChild);
  for (const mutate of [
    (row) => (row.currentRevisionId = "rev-b1"),
    (row) => (row.payloadJson.disclosure.secret = true),
    (row) => (row.payloadJson.title = "別の題"),
    (row) => (row.status = "unreviewed"),
    (row) => (row.latestDecision = null),
    (row) => (row.latestDecision.revisionId = "rev-b1"),
    (row) => (row.latestDecision.actorKind = "ai"),
    (row) => (row.latestDecision.decision = "rejected"),
    (row) => (row.application = { revisionId: "rev-b2" }),
  ]) {
    const changed = globalThis.structuredClone(bulkChild);
    mutate(changed);
    assert.throws(() => assertBulkApprovedChild(bulkParent, changed));
  }
});

test("a proposal outside the bulk approval must not change", () => {
  const before = {
    proposalId: "pa",
    currentRevisionId: "rev-a1",
    status: "unreviewed",
    latestDecision: null,
    payloadJson: { title: "門が開いた", disclosure: { secret: true } },
  };
  assertBulkApprovalLeftUntouched(before, globalThis.structuredClone(before));
  for (const mutate of [
    (row) => (row.currentRevisionId = "rev-a2"),
    (row) => (row.status = "approved"),
    (row) => (row.latestDecision = { decision: "approved" }),
    (row) => (row.payloadJson.disclosure.secret = false),
    (row) => (row.application = { revisionId: "rev-a1" }),
  ]) {
    const changed = globalThis.structuredClone(before);
    mutate(changed);
    assert.throws(() => assertBulkApprovalLeftUntouched(before, changed));
  }
});

test("every approval carries the author actor and the authority of its own revision", () => {
  const proposals = [
    { proposalId: "pa", currentRevisionId: "rev-a2" },
    { proposalId: "pb", currentRevisionId: "rev-b2" },
  ];
  const decision = (proposalId, revisionId) => ({
    proposalId,
    revisionId,
    decision: "approved",
    actorKind: "human",
    actorId: "electron:human-review",
    authorityScope: `project/p1/proposal/${proposalId}/revision/${revisionId}`,
  });
  const good = [decision("pa", "rev-a2"), decision("pb", "rev-b2")];
  assertSameApprovalActor(good, { projectId: "p1", proposals });
  for (const mutate of [
    (rows) => (rows[1].actorId = "bulk-approve"),
    (rows) => (rows[1].actorKind = "system"),
    (rows) => (rows[1].authorityScope = "project/p1/bulk"),
    (rows) => (rows[1].revisionId = "rev-b1"),
    (rows) => rows.push(decision("pb", "rev-b2")),
    (rows) => rows.pop(),
  ]) {
    const rows = globalThis.structuredClone(good);
    mutate(rows);
    assert.throws(() =>
      assertSameApprovalActor(rows, { projectId: "p1", proposals }),
    );
  }
});

test("the button label count and the result line are read strictly", () => {
  assert.equal(
    bulkApproveCountFromLabel("見せる理由の無い提案をまとめて承認 (1)"),
    1,
  );
  assert.equal(
    bulkApproveCountFromLabel("見せる理由の無い提案をまとめて承認"),
    0,
  );
  const text = "1 件を承認しました。 個別に決める提案が 1 件残っています。";
  assertBulkApproveResultText(text, { approved: 1, remaining: 1 });
  for (const bad of [
    "0 件を承認しました。 個別に決める提案が 1 件残っています。",
    "1 件を承認しました。 個別に決める提案が 0 件残っています。",
    "1 件を承認しました。 1 件は飛ばしました（編集済み）。 個別に決める提案が 1 件残っています。",
    "1 件を承認しました。",
    "1 件を承認しました。 個別に決める提案が 1 件残っています。 途中で止まりました（終了または workspace の切り替え）。",
  ]) {
    assert.throws(() =>
      assertBulkApproveResultText(bad, { approved: 1, remaining: 1 }),
    );
  }
});

function bulkButtonFakes({ enabled = true, label, result = "" }) {
  const calls = { clicks: [], testIds: [] };
  const state = { enabled, label };
  const button = {
    waitFor: async () => {},
    isEnabled: async () => state.enabled,
    textContent: async () => state.label,
    click: async () => {
      calls.clicks.push("bulk");
      state.enabled = false;
      state.label = "見せる理由の無い提案をまとめて承認";
    },
  };
  const note = {
    waitFor: async () => {},
    textContent: async () => result,
  };
  const dialog = {
    getByTestId: (id) => {
      calls.testIds.push(id);
      if (id === BULK_APPROVE_BUTTON_TESTID) return button;
      if (id === BULK_APPROVE_RESULT_TESTID) return note;
      throw new Error(`unexpected testid ${id}`);
    },
  };
  const harness = {
    waitUntil: async (predicate, label) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (await predicate()) return true;
      }
      throw new Error(`timeout: ${label}`);
    },
  };
  return { calls, dialog, harness, state };
}

test("a disabled bulk approve button fails the journey and is never clicked", async () => {
  const fake = bulkButtonFakes({
    enabled: false,
    label: "見せる理由の無い提案をまとめて承認",
  });
  await assert.rejects(
    clickEnabledBulkApproveButton({
      harness: fake.harness,
      dialog: fake.dialog,
      expectedCount: 1,
    }),
    /timeout/,
  );
  assert.deepEqual(fake.calls.clicks, []);
});

test("a bulk approve count other than the expected one fails before the click", async () => {
  for (const label of [
    "見せる理由の無い提案をまとめて承認 (2)",
    "見せる理由の無い提案をまとめて承認 (0)",
    "見せる理由の無い提案をまとめて承認",
  ]) {
    const fake = bulkButtonFakes({ label });
    await assert.rejects(
      clickEnabledBulkApproveButton({
        harness: fake.harness,
        dialog: fake.dialog,
        expectedCount: 1,
      }),
    );
    assert.deepEqual(fake.calls.clicks, []);
  }
});

test("the bulk approve step presses once and returns the result line", async () => {
  const fake = bulkButtonFakes({
    label: "見せる理由の無い提案をまとめて承認 (1)",
    result: " 1 件を承認しました。 ",
  });
  const text = await clickEnabledBulkApproveButton({
    harness: fake.harness,
    dialog: fake.dialog,
    expectedCount: 1,
  });
  assert.equal(text, "1 件を承認しました。");
  assert.deepEqual(fake.calls.clicks, ["bulk"]);
});

test("after the press the bulk approve button must be disabled with no target", async () => {
  const idle = bulkButtonFakes({
    enabled: false,
    label: "見せる理由の無い提案をまとめて承認",
  });
  await assertBulkApproveButtonIdle({
    harness: idle.harness,
    dialog: idle.dialog,
  });
  for (const fake of [
    bulkButtonFakes({
      enabled: true,
      label: "見せる理由の無い提案をまとめて承認 (1)",
    }),
    bulkButtonFakes({
      enabled: false,
      label: "見せる理由の無い提案をまとめて承認 (1)",
    }),
    bulkButtonFakes({
      enabled: true,
      label: "見せる理由の無い提案をまとめて承認",
    }),
  ]) {
    await assert.rejects(
      assertBulkApproveButtonIdle({
        harness: fake.harness,
        dialog: fake.dialog,
      }),
      /timeout/,
    );
  }
});

function bulkAppliedFixture() {
  const rootA = interpretation("rev-a1", "pa");
  const childA = humanDerived("rev-a2", "pa", rootA);
  const rootB = interpretation("rev-b1", "pb");
  const childB = humanDerived("rev-b2", "pb", rootB);
  const bundle = {
    proposals: [
      proposal("pa", "rev-a2", "門が開いた", false, {
        revisionId: "rev-a2",
        commitId: "c1",
        appliedEntityId: "e1",
      }),
      proposal("pb", "rev-b2", "鐘が鳴った", false, {
        revisionId: "rev-b2",
        commitId: "c1",
        appliedEntityId: "e2",
      }),
    ],
  };
  const state = {
    revisions: [rootA, childA, rootB, childB],
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
      { revisionId: "rev-b2", commitId: "c1", appliedEntityId: "e2" },
    ],
    commits: [{ id: "c1", status: "applied" }],
    journals: [{ id: "j1", commitId: "c1", afterJson: "{}" }],
  };
  const context = {
    sceneId: "scene-1",
    editedProposalId: "pa",
    rootRevisionId: "rev-a1",
    bulkApproved: [{ proposalId: "pb", rootRevisionId: "rev-b1" }],
  };
  return { bundle, state, context };
}

test("the applied state passes when both proposals were applied from a human-derived, secret-free child", () => {
  const { bundle, state, context } = bulkAppliedFixture();
  assertEditedChronicleApplied(state, bundle, context);
});

test("applied state fails if the bulk-approved proposal was applied from a non-derived or secret revision", () => {
  for (const mutate of [
    ({ state }) =>
      (state.revisions.find(
        (row) => row.revisionId === "rev-b2",
      ).envelope.revisionBasis = { kind: "interpretation" }),
    ({ bundle }) => (bundle.proposals[1].payloadJson.disclosure.secret = true),
    ({ bundle, state }) => {
      bundle.proposals[1].currentRevisionId = "rev-b1";
      bundle.proposals[1].latestDecision.revisionId = "rev-b1";
      bundle.proposals[1].application.revisionId = "rev-b1";
      state.applications[1].revisionId = "rev-b1";
    },
    ({ state }) =>
      (state.revisions.find(
        (row) => row.revisionId === "rev-b2",
      ).envelope.revisionBasis.derivation.proposalPayloadChangedPaths = [
        "/disclosure/secret",
        "/title",
      ]),
    ({ state }) =>
      (state.revisions.find(
        (row) => row.revisionId === "rev-b2",
      ).envelope.revisionBasis.revisionActor.kind = "ai"),
  ]) {
    const fixtureState = bulkAppliedFixture();
    mutate(fixtureState);
    assert.throws(() =>
      assertEditedChronicleApplied(
        fixtureState.state,
        fixtureState.bundle,
        fixtureState.context,
      ),
    );
  }
});

test("without the bulk-approved list a human-derived second proposal is not accepted as untouched", () => {
  const { bundle, state, context } = bulkAppliedFixture();
  assert.throws(() =>
    assertEditedChronicleApplied(state, bundle, {
      ...context,
      bulkApproved: [],
    }),
  );
});

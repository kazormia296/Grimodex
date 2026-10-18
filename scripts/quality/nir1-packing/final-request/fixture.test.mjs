// Consistency tests for the placed final-request fixture (DP-H / DPH-2).
//
// Nothing here runs Native or reads a receipt. The tests fix that the fixture's
// expected entries are what the hand-derivation rules (fixture-derive.mjs) give
// for the fixture's own materials, that the reject variants carry the reasons
// the A2 gate order gives, and that the freeze and review records bind the
// bytes on disk. They cannot make the derivation correct: an independent
// expectation reviewer checks the rules against the product's source.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  DPH_CASE_IDS,
  FIXTURE_PATH,
  FREEZE_PATH,
  PARITY_VECTOR_PATH,
  README_PATH,
  REVIEW_PATH,
  REJECT_CODE,
  SCORER_FILES,
  sha256,
  validateFinalRequestFixture,
  validateFreezeRecord,
  validateNir1FinalRequestFixtures,
  validateReviewRecord,
  variantRequests,
} from "./contract.mjs";
import { deriveEntryTemplates } from "./fixture-derive.mjs";
import { estimateTokens, loadFixedTemplate } from "./payload.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const read = (file) => readFile(path.join(repoRoot, file));

const fixtureBytes = await read(FIXTURE_PATH);
const fixture = JSON.parse(fixtureBytes);
const template = await loadFixedTemplate(repoRoot);

const REASON_BY_NEGATIVE = {
  "approval-cancelled": "revision-not-human-approved",
  "source-stale": "source-revision-changed",
  "scope-authority-changed": "source-revision-changed",
};
const REASON_BY_BINDING = {
  scope: "source-revision-changed",
  source: "source-revision-changed",
  decision: "revision-not-human-approved",
};

/** The draft's DP-H reject column, as negatives this fixture makes or excludes. */
const DRAFT_REJECT_COLUMN = {
  "P-01": { made: [], excluded: [] },
  "P-02": {
    made: ["scope-authority-changed", "source-stale"],
    excluded: ["unknown-scope"],
  },
  "P-04": {
    made: [],
    excluded: ["approval-of-another-revision", "evidence-missing"],
  },
  "P-05": { made: [], excluded: ["unknown-scope"] },
  "P-06": { made: ["source-stale", "approval-cancelled"], excluded: [] },
  "P-07": { made: [], excluded: [] },
  "P-08": {
    made: ["approval-cancelled", "scope-authority-changed"],
    excluded: ["freshness-not-evaluated"],
  },
  "P-10": { made: [], excluded: ["revision", "freshness"] },
  "P-11": {
    made: ["scope-authority-changed"],
    excluded: ["freshness-mismatch"],
  },
};

function variantsOf(testCase, kind) {
  return testCase.variants.filter((variant) => variant.kind === kind);
}

function stepsOf(variant) {
  return variant.setup.steps;
}

/** The Codex records a variant's workspace holds at `stage`, after earlier binding changes. */
function entitiesAtStage(testCase, variant, stage) {
  const records = new Map(
    [
      ...testCase.setup.codexEntities,
      ...(variant.setup.codexEntities ?? []),
    ].map((entity) => [entity.logicalId, { ...entity }]),
  );
  for (const step of stepsOf(variant)) {
    if (step.stage > stage) continue;
    const change =
      step.op === "binding-change"
        ? step
        : step.op === "invalidate-negative"
          ? step
          : null;
    if (change?.write === "codex-update") {
      records.get(change.entity).summary = change.summary;
    }
  }
  return records;
}

test("the placed fixture is a valid fixture with exactly the nine DP-H cases", () => {
  assert.deepEqual(validateFinalRequestFixture(fixture, { template }), []);
  assert.deepEqual(
    fixture.cases.map((testCase) => testCase.caseId),
    [...DPH_CASE_IDS],
  );
  assert.equal(fixture.fixtureVersion, 1);
});

test("every case marker occurs in the case's own Raw and nowhere else", () => {
  for (const testCase of fixture.cases) {
    const raws = new Set(
      testCase.variants.flatMap((variant) =>
        variantRequests(variant).flatMap((request) =>
          request.expected?.rawText ? [request.expected.rawText] : [],
        ),
      ),
    );
    const query = testCase.setup.scenes.find((scene) => scene.role === "query");
    assert.ok(raws.size >= 1, `${testCase.caseId} has a Raw`);
    for (const raw of raws) assert.equal(raw, query.body);
    for (const marker of testCase.markers) {
      assert.ok(query.body.includes(marker), `${testCase.caseId} ${marker}`);
    }
  }
});

test("no case marker occurs in another case's user message or Codex materials (the user message is part of the payload)", () => {
  for (const testCase of fixture.cases) {
    for (const other of fixture.cases) {
      if (other.caseId === testCase.caseId) continue;
      const haystacks = [
        other.userMessage,
        ...other.setup.scenes.map((scene) => scene.body),
        ...other.variants.flatMap((variant) =>
          [
            ...other.setup.codexEntities,
            ...(variant.setup.codexEntities ?? []),
          ].flatMap((entity) => [entity.name, entity.summary]),
        ),
      ];
      for (const marker of testCase.markers) {
        for (const haystack of haystacks) {
          assert.ok(
            !haystack.includes(marker),
            `${testCase.caseId} marker ${marker} occurs in ${other.caseId}`,
          );
        }
      }
    }
  }
});

test("expected entries are what the derivation rules give for the case's materials", () => {
  let checked = 0;
  for (const testCase of fixture.cases) {
    const project = testCase.setup.project.logicalId;
    const anchor = testCase.setup.scenes.find(
      (scene) => scene.role === "anchor",
    );
    for (const variant of variantsOf(testCase, "positive")) {
      for (const request of variantRequests(variant)) {
        const records = entitiesAtStage(testCase, variant, request.stage);
        const prepared = stepsOf(variant).filter(
          (step) => step.op === "prepare" && step.stage === request.stage,
        );
        assert.deepEqual(
          prepared.map((step) => step.revision),
          request.revisionIds,
          `${variant.variantId} stage ${request.stage}: prepared Revisions are the request's`,
        );
        const derived = prepared.flatMap((step) => {
          const entity = records.get(step.entity);
          assert.ok(
            entity,
            `${step.entity} is a Codex Entity of the workspace`,
          );
          assert.equal(step.anchorScene, anchor.logicalId);
          return deriveEntryTemplates({
            revision: { logicalId: step.revision },
            entity,
            anchorSceneLogicalId: step.anchorScene,
            projectLogicalId: project,
            scopeAuthorityLogicalId: `${testCase.setup.project.logicalId.replace(/-project$/, "")}-scope-authority`,
          });
        });
        assert.deepEqual(
          request.expected.codexEntries,
          derived,
          `${variant.variantId} stage ${request.stage}`,
        );
        checked += 1;
      }
    }
  }
  assert.ok(checked >= 12);
});

test("a stage's Codex summary is the Evidence quote and every entry is a single line", () => {
  for (const testCase of fixture.cases) {
    for (const variant of testCase.variants) {
      for (const entity of [
        ...testCase.setup.codexEntities,
        ...(variant.setup.codexEntities ?? []),
      ]) {
        assert.equal(entity.summary.trim(), entity.summary);
        assert.ok(entity.summary.length > 0);
        assert.doesNotMatch(entity.summary, /["\\<\n\r]/);
        assert.doesNotMatch(entity.name, /["\\<\n\r]/);
      }
      for (const request of variantRequests(variant)) {
        for (const entry of request.expected?.codexEntries ?? []) {
          assert.ok(!entry.text.includes("\n"));
          assert.equal(
            JSON.parse(entry.text.replaceAll(/\{\{[^}]*\}\}/g, "x")) !== null,
            true,
          );
        }
      }
    }
  }
});

test("reject variants carry the reason the A2 gate order gives, derived before observation", () => {
  for (const testCase of fixture.cases) {
    for (const variant of variantsOf(testCase, "reject")) {
      const last = variant.requests.at(-1);
      assert.equal(last.expected.code, REJECT_CODE);
      const expectedReason =
        testCase.caseId === "P-10"
          ? REASON_BY_BINDING[
              variant.negative.replace(/^old-revision-after-|-change$/g, "")
            ]
          : REASON_BY_NEGATIVE[variant.negative];
      assert.ok(expectedReason, `${variant.variantId} has a derivation`);
      assert.equal(last.expected.reason, expectedReason, variant.variantId);
      const added = last.revisionIds.at(-1);
      assert.equal(added, variant.ineligibleLogicalId);
      if (testCase.caseId !== "P-10") {
        const negativeSteps = stepsOf(variant).filter((step) =>
          step.op.endsWith("-negative"),
        );
        assert.deepEqual(
          negativeSteps.map((step) => step.op),
          ["prepare-negative", "approve-negative", "invalidate-negative"],
        );
        assert.ok(negativeSteps.every((step) => step.revision === added));
        const firstPositive = stepsOf(variant).findIndex(
          (step) => step.op === "prepare",
        );
        const invalidate = stepsOf(variant).findIndex(
          (step) => step.op === "invalidate-negative",
        );
        assert.ok(
          invalidate < firstPositive,
          "the negative is invalidated first",
        );
      }
    }
  }
});

test("each case makes or excludes exactly the negatives of the draft's DP-H reject column", () => {
  for (const testCase of fixture.cases) {
    const wanted = DRAFT_REJECT_COLUMN[testCase.caseId];
    const made = variantsOf(testCase, "reject")
      .filter((variant) => testCase.caseId !== "P-10")
      .map((variant) => variant.negative);
    assert.deepEqual(made.sort(), [...wanted.made].sort(), testCase.caseId);
    const excluded = fixture.excludedNegatives
      .filter((row) => row.caseId === testCase.caseId)
      .map((row) => row.negative);
    assert.deepEqual(
      excluded.sort(),
      [...wanted.excluded].sort(),
      testCase.caseId,
    );
  }
  for (const row of fixture.excludedNegatives) {
    assert.ok(
      row.reason.length > 40,
      `${row.caseId}/${row.negative} has a reason`,
    );
  }
  const p10 = fixture.cases.find((testCase) => testCase.caseId === "P-10");
  assert.deepEqual(
    variantsOf(p10, "positive")
      .map((variant) => variant.binding)
      .sort(),
    ["decision", "scope", "source"],
  );
});

test("P-10: the binding change precedes the new Revision and the old Revision is never prepared again", () => {
  const p10 = fixture.cases.find((testCase) => testCase.caseId === "P-10");
  for (const variant of p10.variants) {
    const steps = stepsOf(variant);
    const change = steps.findIndex((step) => step.op === "binding-change");
    const stage2Prepare = steps.findIndex(
      (step) => step.op === "prepare" && step.stage === 2,
    );
    const stage1Prepare = steps.findIndex(
      (step) => step.op === "prepare" && step.stage === 1,
    );
    assert.ok(stage1Prepare < change && change < stage2Prepare);
    const prepared = steps
      .filter((step) => step.op === "prepare")
      .map((step) => step.revision);
    assert.equal(new Set(prepared).size, prepared.length);
    assert.deepEqual(
      variant.requests.map((request) => request.stage),
      [1, 2],
    );
    assert.equal(variant.setup.chatSessions.length, 2);
  }
});

test("canaries are embedded in the setup and never in an expected payload", () => {
  const note = fixture.canaries.find(
    (canary) => canary.kind === "decision-note",
  );
  const meta = fixture.canaries.find(
    (canary) => canary.kind === "internal-metadata",
  );
  for (const testCase of fixture.cases) {
    for (const variant of testCase.variants) {
      const approvals = stepsOf(variant).filter((step) =>
        step.op.startsWith("approve"),
      );
      assert.ok(approvals.length > 0);
      for (const step of approvals)
        assert.equal(step.decisionJson.note, note.text);
      for (const step of stepsOf(variant).filter((s) =>
        s.op.startsWith("prepare"),
      )) {
        assert.ok(step.proposalKey.includes(meta.text));
        assert.ok(step.proposalKey.length <= 256);
      }
      for (const request of variantRequests(variant)) {
        const text = JSON.stringify(request.expected ?? {});
        assert.ok(!text.includes(note.text.slice(0, 20)));
        assert.ok(!text.includes(meta.text.slice(0, 20)));
      }
    }
  }
});

test("the route and budgets are the fixture's own values, not new product limits", () => {
  assert.deepEqual(fixture.route, {
    model: "dph-fixture-local-model",
    contextWindowTokens: 16384,
    outputTokens: 1024,
  });
  for (const testCase of fixture.cases) {
    for (const variant of testCase.variants) {
      for (const [index, request] of variantRequests(variant).entries()) {
        if (variant.kind === "reject" && index === variant.requests.length - 1)
          continue;
        const tokens = estimateTokens(request.expected.rawText);
        assert.ok(tokens > 0);
      }
    }
  }
});

test("the freeze and review records bind the bytes on disk (pending review until a reviewer approves)", async () => {
  const freeze = JSON.parse(await read(FREEZE_PATH));
  const review = JSON.parse(await read(REVIEW_PATH));
  // The record states what happened. A fixture whose materials Native observed
  // lists the observations and cannot be frozen; a frozen record says false.
  assert.equal(
    freeze.nativeOutputObservedBeforeFreeze,
    (freeze.nativeObservations ?? []).length > 0,
  );
  if (freeze.status === "frozen") {
    assert.equal(freeze.nativeOutputObservedBeforeFreeze, false);
  }
  assert.equal(freeze.authorSeparation.nativeReceiptProvidedToAuthor, false);
  assert.ok(["pending-review", "frozen"].includes(freeze.status));
  const bytes = new Map();
  for (const file of [
    FIXTURE_PATH,
    REVIEW_PATH,
    README_PATH,
    PARITY_VECTOR_PATH,
    ...SCORER_FILES,
  ])
    bytes.set(file, await read(file));
  const reviewErrors = validateReviewRecord(review, {
    fixtureSha256: sha256(fixtureBytes),
    fixture,
  });
  assert.deepEqual(reviewErrors, []);
  assert.deepEqual(
    validateFreezeRecord(freeze, { bytes, review, reviewErrors, fixture }),
    [],
  );
  assert.equal(freeze.fixture.sha256, sha256(fixtureBytes));
  assert.deepEqual(
    freeze.scorer.files.map((file) => file.path).sort(),
    [...SCORER_FILES].sort(),
  );
  // Until an independent reviewer approves, the freeze must not be final.
  if (review.verdict !== "approve") {
    assert.equal(freeze.status, "pending-review");
    assert.notEqual(freeze.reviewVerdict, "approve");
  } else {
    assert.equal(freeze.reviewVerdict, "approve");
  }
  assert.deepEqual(
    freeze.authorSeparation.harnessImplementers.includes(
      freeze.authorSeparation.fixtureAuthor.agent,
    ),
    false,
  );
});

test("the repository report validates the placed fixture, freeze and review records", async () => {
  const report = await validateNir1FinalRequestFixtures({ repoRoot });
  assert.deepEqual(report.errors, []);
  assert.ok(["pending-review", "frozen"].includes(report.status));
  assert.deepEqual(
    report.cases.map((entry) => entry.caseId),
    [...DPH_CASE_IDS],
  );
});

// Consistency tests for the final-request fixture version 2 (DP-H S1, the
// replacement of the superseded version 1; dp-h-decisions.md DR-DPH-90..95).
//
// Nothing here runs Native or reads a receipt. The tests fix that every
// expectation of final-request.v2.json is what the derivation rules
// (fixture-derive.v2.mjs, read from the product's source after X1-3) give for
// the fixture's own materials, that no material of version 1 is reused, and
// that the approving review record and the frozen freeze record (S3) bind the
// bytes on disk. They cannot make the rules right: the independent expectation reviewer
// (S2) checks the rules against the cited source.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  DPH_CASE_IDS,
  FIXTURE_VERSIONS,
  SCORER_FILES,
  fixtureMaterials,
  replacedMaterialReuseErrors,
  sha256,
  templatePlaceholders,
  validateFinalRequestFixture,
  validateFreezeRecord,
  validateNir1FinalRequestFixtures,
  validateReviewRecord,
  variantRequests,
} from "./contract.mjs";
import {
  REJECT_CODE,
  WRITE_BY_BINDING,
  WRITE_BY_NEGATIVE,
  anchorProjectionLogicalId,
  anchorScene,
  deriveEntryTemplates,
  derivePositiveExpectation,
  deriveRejectExpectation,
  queryScene,
} from "./fixture-derive.v2.mjs";
import { loadFixedTemplate } from "./payload.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const read = (file) => readFile(path.join(repoRoot, file));
const V1 = FIXTURE_VERSIONS[1];
const V2 = FIXTURE_VERSIONS[2];

const fixtureBytes = await read(V2.fixturePath);
const fixture = JSON.parse(fixtureBytes);
const v1Fixture = JSON.parse(await read(V1.fixturePath));
const v1Freeze = JSON.parse(await read(V1.freezePath));
const template = await loadFixedTemplate(repoRoot);

const AUTHOR = "dph-v2-fixture-author (claude-opus-5-5, independent)";

/** The draft's DP-H reject column, as negatives version 2 makes or excludes. */
const DRAFT_REJECT_COLUMN = {
  "P-01": { made: [], excluded: [] },
  "P-02": {
    made: ["scope-authority-changed", "source-stale", "unknown-scope"],
    excluded: [],
  },
  "P-04": {
    made: [],
    excluded: ["approval-of-another-revision", "evidence-missing"],
  },
  "P-05": { made: ["unknown-scope"], excluded: [] },
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

const isRejectRequest = (variant, index) =>
  variant.kind === "reject" && index === variant.requests.length - 1;

function positiveRequests() {
  const rows = [];
  for (const testCase of fixture.cases) {
    for (const variant of testCase.variants) {
      variantRequests(variant).forEach((request, index) => {
        if (!isRejectRequest(variant, index))
          rows.push({ testCase, variant, request });
      });
    }
  }
  return rows;
}

test("version 2 is a valid fixture with exactly the nine DP-H cases", () => {
  assert.deepEqual(
    validateFinalRequestFixture(fixture, { template, fixtureVersion: 2 }),
    [],
  );
  assert.equal(fixture.fixtureVersion, 2);
  assert.equal(fixture.phase, "dp-h");
  assert.equal(fixture.draftRef, "nir1-final-request-eval-proposal/2");
  assert.deepEqual(
    fixture.cases.map((testCase) => testCase.caseId),
    [...DPH_CASE_IDS],
  );
});

test("no logical id or text of version 1 is reused, short materials included", () => {
  assert.deepEqual(replacedMaterialReuseErrors(fixture, v1Fixture), []);
  const fresh = fixtureMaterials(fixture);
  const old = fixtureMaterials(v1Fixture);
  const short = [...old.texts].filter((text) => text.length <= 3);
  assert.ok(short.length >= 9, "the version-1 short materials are known");
  for (const text of fresh.texts) {
    for (const piece of short) {
      assert.ok(!text.includes(piece), `${text} contains ${piece}`);
    }
  }
  for (const id of fresh.ids) assert.ok(!old.ids.has(id), id);
  // The materials the expected entries are made of (names, summaries, the
  // summaries a later write sets) are new too.
  for (const testCase of fixture.cases) {
    for (const variant of testCase.variants) {
      for (const step of variant.setup.steps) {
        if (typeof step.summary !== "string") continue;
        for (const previous of old.texts) {
          assert.ok(
            !previous.includes(step.summary) &&
              !step.summary.includes(previous),
            step.summary,
          );
        }
      }
    }
  }
  // The canaries and the Scope references are renewed as well.
  for (const canary of fixture.canaries) {
    assert.ok(!v1Fixture.canaries.some((row) => row.text === canary.text));
  }
  const refs = (row) =>
    JSON.stringify(row.setupContract.sceneScope.registry).match(
      /[a-z]+:[A-Za-z0-9-]+/g,
    );
  for (const ref of refs(fixture))
    assert.ok(!refs(v1Fixture).includes(ref), ref);
});

test("every positive expectation is what the derivation rules give for the case's materials", () => {
  let checked = 0;
  for (const { testCase, variant, request } of positiveRequests()) {
    assert.deepEqual(
      request.expected,
      derivePositiveExpectation({
        template,
        route: fixture.route,
        canaries: fixture.canaries,
        testCase,
        variant,
        request,
      }),
      `${variant.variantId} stage ${request.stage}`,
    );
    checked += 1;
  }
  assert.equal(checked, 17);
});

test("every reject expectation is the reason the A2 gate gives for the invalidating write", () => {
  let checked = 0;
  for (const testCase of fixture.cases) {
    for (const variant of testCase.variants) {
      if (variant.kind !== "reject") continue;
      const last = variant.requests.at(-1);
      assert.deepEqual(
        last.expected,
        deriveRejectExpectation(testCase, variant),
      );
      assert.equal(last.expected.code, REJECT_CODE);
      assert.equal(last.revisionIds.at(-1), variant.ineligibleLogicalId);
      checked += 1;
    }
  }
  assert.equal(checked, 12);
});

test("after X1-3 the Entity Scope token is the anchor Scene's projection, named per case", () => {
  for (const { testCase, request } of positiveRequests()) {
    const projection = anchorProjectionLogicalId(testCase);
    for (const entry of request.expected.codexEntries) {
      if (entry.part !== "statement") continue;
      const scope = JSON.parse(
        entry.text.replaceAll(/\{\{([A-Za-z]+):([^}]*)\}\}/g, "<$1:$2>"),
      ).entity.scope;
      assert.equal(scope.authorityRevision, `<revisionToken:${projection}>`);
      assert.equal(
        scope.reading.value,
        `scene:<runtimeId:${anchorScene(testCase).logicalId}>`,
      );
    }
    for (const text of [
      ...request.expected.codexEntries.map((entry) => entry.text),
      ...request.expected.forbidden.texts,
    ]) {
      for (const placeholder of templatePlaceholders(text)) {
        if (placeholder.kind === "revisionToken")
          assert.equal(placeholder.logicalId, projection);
      }
    }
  }
});

test("runtimeValues name exactly the token placeholders of the stages with positive expectations", () => {
  for (const testCase of fixture.cases) {
    for (const variant of testCase.variants) {
      const wanted = new Set();
      variantRequests(variant).forEach((request, index) => {
        if (isRejectRequest(variant, index)) return;
        const texts = request.expected.codexEntries.map((entry) => entry.text);
        for (const text of texts) {
          for (const row of templatePlaceholders(text)) {
            if (["revisionToken", "sourceToken"].includes(row.kind))
              wanted.add(`${row.kind}|${row.logicalId}|${request.stage}`);
          }
        }
        // A later stage's forbidden template resolves with the earlier stage's values.
        for (const text of request.expected.forbidden.texts) {
          for (const row of templatePlaceholders(text)) {
            if (["revisionToken", "sourceToken"].includes(row.kind))
              wanted.add(`${row.kind}|${row.logicalId}|${request.stage - 1}`);
          }
        }
      });
      const listed = variant.setup.runtimeValues.map(
        (row) => `${row.kind}|${row.logicalId}|${row.stage}`,
      );
      assert.equal(new Set(listed).size, listed.length, variant.variantId);
      assert.deepEqual(
        [...listed].sort(),
        [...wanted].sort(),
        variant.variantId,
      );
      for (const row of variant.setup.runtimeValues) {
        assert.ok(
          row.read.length > 20,
          `${variant.variantId} says how to read`,
        );
      }
    }
  }
});

test("one anchor and one query Scene per case; positives anchor to it, an unknown-scope negative to its own Scene", () => {
  let negativeAnchors = 0;
  for (const testCase of fixture.cases) {
    assert.deepEqual(
      testCase.setup.scenes.map((scene) => scene.role),
      ["anchor", "query"],
    );
    for (const variant of testCase.variants) {
      const own = variant.setup.scenes ?? [];
      if (variant.kind === "positive") assert.deepEqual(own, []);
      // DR-DPH-106: a negative-anchor Scene belongs to an unknown-scope reject
      // variant only, and is the anchor of that variant's negative only.
      assert.equal(own.length, variant.negative === "unknown-scope" ? 1 : 0);
      for (const scene of own) {
        assert.equal(scene.role, "negative-anchor");
        assert.ok(
          !testCase.setup.scenes.some(
            (row) => row.logicalId === scene.logicalId,
          ),
        );
        negativeAnchors += 1;
      }
      for (const step of variant.setup.steps) {
        if (step.op === "prepare") {
          assert.equal(step.anchorScene, anchorScene(testCase).logicalId);
        } else if (step.op === "prepare-negative") {
          assert.equal(
            step.anchorScene,
            own[0]?.logicalId ?? anchorScene(testCase).logicalId,
          );
        }
      }
      for (const session of variant.setup.chatSessions) {
        assert.equal(session.nodeScene, queryScene(testCase).logicalId);
      }
      assert.deepEqual(
        variant.setup.chatSessions.map((session) => session.stage),
        [...new Set(variant.requests.map((request) => request.stage))],
      );
    }
  }
  assert.equal(negativeAnchors, 2);
});

test("every case marker occurs in the case's own Raw and in no other case's payload material", () => {
  for (const testCase of fixture.cases) {
    for (const marker of testCase.markers) {
      assert.ok(queryScene(testCase).body.includes(marker), marker);
    }
    for (const other of fixture.cases) {
      if (other === testCase) continue;
      const haystacks = [
        other.userMessage,
        ...other.setup.scenes.flatMap((scene) => [scene.title, scene.body]),
        ...other.variants.flatMap((variant) => [
          ...(variant.setup.scenes ?? []).flatMap((scene) => [
            scene.title,
            scene.body,
          ]),
          ...[
            ...other.setup.codexEntities,
            ...(variant.setup.codexEntities ?? []),
          ].flatMap((entity) => [entity.name, entity.summary]),
          ...variant.setup.steps.map(
            (step) => step.summary ?? step.unresolvedReason ?? "",
          ),
        ]),
      ];
      for (const marker of testCase.markers) {
        assert.ok(
          haystacks.every((text) => !text.includes(marker)),
          `${testCase.caseId} marker ${marker} occurs in ${other.caseId}`,
        );
      }
    }
  }
});

test("Codex names and summaries are single-line, trimmed, BMP-only and need no JSON escape", () => {
  for (const testCase of fixture.cases) {
    for (const variant of testCase.variants) {
      const texts = [
        ...testCase.setup.codexEntities,
        ...(variant.setup.codexEntities ?? []),
      ].flatMap((entity) => [entity.name, entity.summary]);
      texts.push(
        ...variant.setup.steps
          .flatMap((step) => [step.summary, step.unresolvedReason])
          .filter((text) => typeof text === "string"),
      );
      for (const text of [
        ...texts,
        ...testCase.setup.scenes.map((scene) => scene.body),
        ...(variant.setup.scenes ?? []).map((scene) => scene.body),
      ]) {
        assert.equal(text.trim(), text);
        assert.ok(text.length > 0);
        assert.doesNotMatch(text, /["\\<\n\r\t]/);
        assert.doesNotMatch(text, /[\uD800-\uDFFF]/, "no surrogate pair");
      }
    }
  }
});

test("reject variants and P-10 bindings use the writes the reasons are derived from, in the setup order", () => {
  for (const testCase of fixture.cases) {
    for (const variant of testCase.variants) {
      const steps = variant.setup.steps;
      const firstPositive = steps.findIndex((step) => step.op === "prepare");
      if (testCase.caseId === "P-10") {
        const change = steps.findIndex((step) => step.op === "binding-change");
        const stage2 = steps.findIndex(
          (step) => step.op === "prepare" && step.stage === 2,
        );
        assert.ok(firstPositive < change && change < stage2);
        assert.equal(
          steps[change].write,
          WRITE_BY_BINDING[variant.binding ?? steps[change].binding],
        );
        const prepared = steps
          .filter((step) => step.op === "prepare")
          .map((step) => step.revision);
        assert.equal(new Set(prepared).size, prepared.length);
        assert.deepEqual(
          variant.requests.map((request) => request.stage),
          [1, 2],
        );
        if (variant.kind === "reject") {
          assert.deepEqual(variant.requests[1].revisionIds, [
            ...variant.requests[0].revisionIds.map((id) =>
              id.replace(/-stage1$/, "-stage2"),
            ),
            variant.ineligibleLogicalId,
          ]);
        }
        continue;
      }
      if (variant.kind !== "reject") continue;
      const negativeSteps = steps.filter((step) =>
        step.op.endsWith("-negative"),
      );
      assert.deepEqual(
        negativeSteps.map((step) => step.op),
        ["prepare-negative", "approve-negative", "invalidate-negative"],
      );
      assert.ok(
        negativeSteps.every(
          (step) => step.revision === variant.ineligibleLogicalId,
        ),
      );
      assert.equal(negativeSteps[2].write, WRITE_BY_NEGATIVE[variant.negative]);
      if (negativeSteps[2].write === "scene-scope-unknown") {
        // The unknown marker is written on the negative's own anchor only.
        assert.equal(negativeSteps[2].scene, negativeSteps[0].anchorScene);
        assert.equal(negativeSteps[2].scene, variant.setup.scenes[0].logicalId);
        assert.notEqual(
          negativeSteps[2].scene,
          anchorScene(testCase).logicalId,
        );
        assert.notEqual(negativeSteps[2].scene, queryScene(testCase).logicalId);
        assert.equal(
          negativeSteps[2].unresolvedReason.trim(),
          negativeSteps[2].unresolvedReason,
        );
      }
      assert.ok(
        steps.indexOf(negativeSteps[2]) < firstPositive,
        "the negative is invalidated before any positive is prepared",
      );
      const base = testCase.variants.find(
        (row) => row.variantId === variant.baseVariantId,
      );
      assert.deepEqual(
        steps.slice(firstPositive),
        base.setup.steps,
        "the positive steps are the base variant's",
      );
    }
  }
});

test("each case makes or excludes exactly the negatives of the draft's DP-H reject column", () => {
  for (const testCase of fixture.cases) {
    const wanted = DRAFT_REJECT_COLUMN[testCase.caseId];
    const made = testCase.variants
      .filter(
        (variant) => variant.kind === "reject" && testCase.caseId !== "P-10",
      )
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
    assert.ok(row.reason.length > 80, `${row.caseId}/${row.negative}`);
  }
  const p10 = fixture.cases.find((testCase) => testCase.caseId === "P-10");
  assert.deepEqual(
    p10.variants
      .filter((variant) => variant.kind === "positive")
      .map((variant) => variant.binding)
      .sort(),
    ["decision", "scope", "source"],
  );
});

test("the derivation fixes the five parts of a group (one worked example)", () => {
  const entries = deriveEntryTemplates({
    revisionLogicalId: "r",
    entity: { logicalId: "e", type: "lore", name: "名", summary: "要約。" },
    anchorSceneLogicalId: "a",
    projectLogicalId: "p",
    anchorProjectionLogicalId: "x-anchor-projection",
  });
  assert.deepEqual(
    entries.map((entry) => entry.part),
    ["statement", "negation", "attribution", "evidence", "qualification"],
  );
  assert.equal(
    entries[1].text,
    '{"atomicPart":"negation","family":"nir1.entity-relation@1","status":"not-represented-by-this-family"}',
  );
  assert.equal(
    entries[4].text,
    '{"actorId":"electron:human-review","actorKind":"human","approval":"human-approved","authorityScope":"project/{{runtimeId:p}}/proposal/{{proposalId:r}}/revision/{{revisionId:r}}","decision":"approved","decisionId":"{{decisionId:r}}","proposalId":"{{proposalId:r}}","recordId":"{{runtimeId:e}}","revisionId":"{{revisionId:r}}"}',
  );
  assert.match(
    entries[0].text,
    /"authorityRevision":"\{\{revisionToken:x-anchor-projection\}\}"/,
  );
  assert.match(entries[0].text, /"endUtf16":3,/);
});

test("canaries are embedded in the setup and never in an expected payload", () => {
  const note = fixture.canaries.find((row) => row.kind === "decision-note");
  const meta = fixture.canaries.find((row) => row.kind === "internal-metadata");
  for (const testCase of fixture.cases) {
    for (const variant of testCase.variants) {
      const steps = variant.setup.steps;
      for (const step of steps.filter((row) => /^approve/.test(row.op)))
        assert.equal(step.decisionJson.note, note.text);
      for (const step of steps.filter((row) => /^prepare/.test(row.op))) {
        assert.ok(step.proposalKey.includes(meta.text));
        assert.ok(step.proposalKey.length <= 256);
        assert.equal(step.proposalKey.trim(), step.proposalKey);
      }
      for (const request of variant.requests) {
        const text = JSON.stringify(request.expected);
        assert.ok(!text.includes(note.text) && !text.includes(meta.text));
      }
    }
  }
});

test("the route is the fixture's own value, not a new product limit", () => {
  assert.deepEqual(fixture.route, {
    model: "dph-fixture-local-model",
    contextWindowTokens: 16384,
    outputTokens: 1024,
  });
});

test("the approving review and the frozen freeze record bind the bytes on disk", async () => {
  const freeze = JSON.parse(await read(V2.freezePath));
  const review = JSON.parse(await read(V2.reviewPath));
  // The independent review (S2) approved every case of these bytes.
  assert.equal(review.verdict, "approve");
  assert.equal(review.fixtureSha256, sha256(fixtureBytes));
  assert.deepEqual(review.requiredChanges, []);
  assert.deepEqual(
    review.cases.map((row) => [row.caseId, row.verdict]),
    DPH_CASE_IDS.map((caseId) => [caseId, "approve"]),
  );
  assert.deepEqual(
    {
      distinctFromFixtureAuthor: review.reviewer.distinctFromFixtureAuthor,
      distinctFromImplementers: review.reviewer.distinctFromImplementers,
      readOnly: review.reviewer.readOnly,
      nativeOutputObserved: review.reviewer.nativeOutputObserved,
    },
    {
      distinctFromFixtureAuthor: true,
      distinctFromImplementers: true,
      readOnly: true,
      nativeOutputObserved: false,
    },
  );
  const reviewErrors = validateReviewRecord(review, {
    fixtureSha256: sha256(fixtureBytes),
    fixture,
  });
  assert.deepEqual(reviewErrors, []);

  // The record (S3): frozen, approved, not observed, superseding version 1.
  assert.equal(freeze.status, "frozen");
  assert.equal(freeze.reviewVerdict, "approve");
  assert.equal(freeze.reviewRecord.sha256, sha256(await read(V2.reviewPath)));
  assert.equal(freeze.nativeOutputObservedBeforeFreeze, false);
  assert.equal(freeze.nativeObservations, undefined);
  assert.deepEqual(freeze.supersedes, {
    fixtureVersion: 1,
    fixture: { path: V1.fixturePath, sha256: V1.pinned.fixture },
    freezeRecord: { path: V1.freezePath, sha256: V1.pinned.freezeRecord },
    freezeRecordCommit: V1.pinned.freezeRecordCommit,
    decision: "DR-DPH-70",
  });
  const separation = freeze.authorSeparation;
  assert.equal(separation.fixtureAuthor.agent, AUTHOR);
  assert.equal(separation.nativeReceiptProvidedToAuthor, false);
  assert.equal(separation.expectationReviewer.agent, review.reviewer.agent);
  for (const name of [
    ...v1Freeze.authorSeparation.harnessImplementers,
    ...V2.requiredImplementers,
  ]) {
    assert.ok(separation.harnessImplementers.includes(name), name);
  }
  for (const excluded of [
    v1Freeze.authorSeparation.fixtureAuthor.agent,
    v1Freeze.authorSeparation.expectationReviewer.agent,
    ...separation.harnessImplementers,
  ]) {
    assert.notEqual(AUTHOR, excluded);
    assert.notEqual(separation.expectationReviewer.agent, excluded);
  }
  const bytes = new Map();
  for (const file of [
    V2.fixturePath,
    V2.reviewPath,
    V2.readmePath,
    V2.parityVectorPath,
    V1.fixturePath,
    V1.freezePath,
    ...SCORER_FILES,
  ])
    bytes.set(file, await read(file));
  assert.deepEqual(
    validateFreezeRecord(freeze, {
      bytes,
      review,
      reviewErrors,
      fixture,
      fixtureVersion: 2,
      replaced: { fixture: v1Fixture, freeze: v1Freeze },
    }),
    [],
  );
  assert.equal(freeze.contextBudget.perRequest.length, 17);
});

test("the repository report has version 2 frozen, version 1 on HOLD, and no error", async () => {
  const report = await validateNir1FinalRequestFixtures({ repoRoot });
  assert.deepEqual(report.errors, []);
  assert.equal(report.fixtureVersion, 2);
  assert.equal(report.status, "frozen");
  const v2 = report.versions.find((entry) => entry.fixtureVersion === 2);
  assert.equal(v2.status, "frozen");
  const v1 = report.versions.find((entry) => entry.fixtureVersion === 1);
  assert.equal(v1.status, "pending-review");
  assert.deepEqual(
    v2.cases.map((entry) => entry.caseId),
    [...DPH_CASE_IDS],
  );
});

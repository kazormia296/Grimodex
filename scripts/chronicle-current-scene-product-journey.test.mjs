import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PRODUCT_CONTRACT_REQUIREMENTS,
  PRODUCT_DOMAIN_RULES,
  PRODUCT_JOURNEY_CATALOG,
} from "../electron/scripts/product-journey-catalog.mjs";
import { selectProductJourneys } from "../electron/scripts/product-journey-impact.mjs";
import { PRODUCT_JOURNEYS } from "../electron/scripts/product-journeys.mjs";
import { FIXED_PRODUCT_JOURNEY_SHARDS } from "../electron/scripts/product-journey-shards.mjs";
import { analyzeChronicleAndWaitForProposals } from "../electron/scripts/chronicle-extraction-product-journey.mjs";
import { clickEnabledApplyButton } from "../electron/scripts/chronicle-edited-apply-product-journey.mjs";
import {
  CHRONICLE_CURRENT_SCENE_JOURNEY_ID as ID,
  SIBLING_BODIES,
  assertIrPreconditionsByDisclosure,
  assertSceneBindingsExplicit,
  setMainLineSceneScopeDefault,
  assertRevisionsSealOnlyScene,
  assertSceneScopedRun,
  assertSiblingBodiesAreInert,
  chooseCurrentSceneTarget,
  currentSceneOptionValue,
  openSceneInEditor,
  readIrAdmissionPreconditions,
} from "../electron/scripts/chronicle-current-scene-product-journey.mjs";

const CONTRACT = "chronicle:extract-current-scene-apply-reopen";
const EXISTING_IDS = [
  "chronicle-extract-review-apply-reopen",
  "chronicle-extract-edit-approve-apply-reopen",
];

test("the current-scene journey is a distinct required catalog entry with its own contract", () => {
  assert.equal(ID, "chronicle-extract-current-scene-apply-reopen");
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
  for (const id of EXISTING_IDS) {
    assert.ok(PRODUCT_JOURNEY_CATALOG.some((row) => row.id === id));
  }
  assert.deepEqual(
    PRODUCT_JOURNEYS.map((row) => row.id),
    PRODUCT_JOURNEY_CATALOG.map((row) => row.id),
    "runnable journeys follow catalog order",
  );
  assert.equal(PRODUCT_JOURNEY_CATALOG.length, 36);
});

test("the current-scene journey sits in the third shard, after the shard's existing journeys", () => {
  const shard = FIXED_PRODUCT_JOURNEY_SHARDS.findIndex((ids) =>
    ids.includes(ID),
  );
  assert.equal(shard, 2, "third shard");
  const ids = FIXED_PRODUCT_JOURNEY_SHARDS[shard];
  assert.equal(ids.length, 3);
  assert.equal(ids.at(-1), ID);
  assert.equal(
    FIXED_PRODUCT_JOURNEY_SHARDS.filter((list) => list.includes(ID)).length,
    1,
  );
  assert.equal(FIXED_PRODUCT_JOURNEY_SHARDS.flat().length, 36);
});

test("a Chronicle review UI or journey-script change selects all three Chronicle journeys", () => {
  for (const changedPath of [
    "src/features/chronicle/ChronicleProposalReview.tsx",
    "src/features/chronicle/ChronicleExtractDialog.tsx",
    "src/application/narrative-extraction/chronicleV2Production.ts",
  ]) {
    const selected = selectProductJourneys({
      catalog: PRODUCT_JOURNEY_CATALOG,
      domainRules: PRODUCT_DOMAIN_RULES,
      changedPaths: [changedPath],
    });
    assert.ok(selected.journeyIds.includes(ID), changedPath);
    for (const id of EXISTING_IDS)
      assert.ok(selected.journeyIds.includes(id), changedPath);
    assert.equal(selected.fallback, false);
  }
  for (const changedPath of [
    "electron/scripts/chronicle-current-scene-product-journey.mjs",
    "scripts/chronicle-current-scene-product-journey.test.mjs",
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

const SCENE = "scene-1";
const FOLDER = "folder-1";
const SIBLINGS = ["scene-2", "scene-3"];
const SIBLING_TEXTS = Object.values(SIBLING_BODIES);

function runRow(overrides = {}) {
  return {
    scopeJson: JSON.stringify({ folderId: FOLDER, sceneIds: [SCENE] }),
    coverageJson: JSON.stringify({ windowCount: 1, documentCount: 1 }),
    surfacePathId: "chronicle.extract",
    ...overrides,
  };
}

function artifact(artifactKind, payloadJson) {
  return { artifactId: artifactKind, artifactKind, payloadJson };
}

function observations() {
  return [{ localId: "o1", payload: { predicate: "門を開ける" } }];
}

function bundleFixture({ secrets = [true, false] } = {}) {
  const receipt = (stageId, id) => ({
    stageExecution: { stageId, stageExecutionId: id },
    contextSetVersion: "chronicle.context-set/1",
    terminalStatus: "succeeded",
    parseStatus: "parsed",
  });
  return {
    artifacts: [
      artifact("source.snapshot@1", {
        snapshot: { documents: [{ sourceKey: `project:scene:${SCENE}` }] },
        evidence: {
          catalog: { version: 1, segmentationVersion: "sentence-like-v1" },
        },
      }),
      artifact("source.window-plan@1", { windows: [{ index: 0 }] }),
      artifact("chronicle.raw-observations@1", {
        observations: observations(),
      }),
      artifact("chronicle.merged-observations@1", {
        observations: observations(),
      }),
    ],
    stageReceipts: [
      receipt("narrative_observation_extract", "s1"),
      receipt("narrative_event_synthesize", "s2"),
      receipt("narrative_event_synthesize", "s3"),
    ],
    proposals: secrets.map((secret, index) => ({
      proposalId: `p${index}`,
      currentRevisionId: `r${index}`,
      status: "approved",
      payloadJson: { disclosure: { secret } },
    })),
  };
}

function revisionsFixture(bundle) {
  return bundle.proposals.map((proposal) => ({
    revisionId: proposal.currentRevisionId,
    proposalId: proposal.proposalId,
    envelope: {
      assertion: {
        scope: {
          scene: { kind: "exact", ref: `scene:${SCENE}` },
          readingOrder: { kind: "any" },
          storyTime: { kind: "any" },
          audience: { kind: "any" },
        },
      },
    },
  }));
}

function decisionsFixture(bundle) {
  return bundle.proposals.map((proposal) => ({
    id: `d-${proposal.proposalId}`,
    proposalId: proposal.proposalId,
    revisionId: proposal.currentRevisionId,
    decision: "approved",
    actorKind: "human",
    actorId: "electron:human-review",
    authorityScope: `project/project-1/proposal/${proposal.proposalId}/revision/${proposal.currentRevisionId}`,
    createdAt: "2026-01-01T00:00:00Z",
  }));
}

function readings(mutate) {
  const input = {
    projectId: "project-1",
    sceneId: SCENE,
    bundle: bundleFixture(),
    run: runRow(),
  };
  input.revisions = revisionsFixture(input.bundle);
  input.decisions = decisionsFixture(input.bundle);
  mutate?.(input);
  return readIrAdmissionPreconditions(input);
}

test("the sibling bodies cannot satisfy any fixed-response quote", () => {
  assertSiblingBodiesAreInert();
  assert.throws(() =>
    assertSiblingBodiesAreInert({ first: "ここに 衛兵が門を開けた。 がある" }),
  );
});

test("the scene-scoped Run passes only for one scene, one window and one sealed document", () => {
  const base = {
    run: runRow(),
    bundle: bundleFixture(),
    folderId: FOLDER,
    sceneId: SCENE,
    siblingSceneIds: SIBLINGS,
    siblingTexts: SIBLING_TEXTS,
  };
  assertSceneScopedRun(base);
  for (const mutate of [
    (input) =>
      (input.run = runRow({
        scopeJson: JSON.stringify({
          folderId: FOLDER,
          sceneIds: [SCENE, SIBLINGS[0]],
        }),
      })),
    (input) =>
      (input.run = runRow({
        scopeJson: JSON.stringify({ folderId: "other", sceneIds: [SCENE] }),
      })),
    (input) =>
      (input.run = runRow({
        scopeJson: JSON.stringify({
          folderId: FOLDER,
          sceneIds: [SCENE],
          note: SIBLINGS[1],
        }),
      })),
    (input) =>
      (input.run = runRow({
        coverageJson: JSON.stringify({ windowCount: 2 }),
      })),
    (input) =>
      (input.run = runRow({
        coverageJson: JSON.stringify({ windowCount: 0 }),
      })),
    (input) =>
      (input.bundle.artifacts[0].payloadJson.snapshot.documents = [
        { sourceKey: `project:scene:${SCENE}` },
        { sourceKey: `project:scene:${SIBLINGS[0]}` },
      ]),
    (input) =>
      (input.bundle.artifacts[0].payloadJson.snapshot.documents = [
        { sourceKey: `project:scene:${SIBLINGS[0]}` },
      ]),
    (input) =>
      input.bundle.artifacts.push(artifact("x", { text: SIBLING_TEXTS[0] })),
  ]) {
    const input = globalThis.structuredClone(base);
    mutate(input);
    assert.throws(() => assertSceneScopedRun(input));
  }
});

test("persisted envelopes must be bound to the scene and mention no sibling", () => {
  const revisions = revisionsFixture(bundleFixture());
  assertRevisionsSealOnlyScene(revisions, {
    sceneId: SCENE,
    siblingIds: SIBLINGS,
  });
  const leaking = globalThis.structuredClone(revisions);
  leaking[0].envelope.note = SIBLINGS[0];
  assert.throws(() =>
    assertRevisionsSealOnlyScene(leaking, {
      sceneId: SCENE,
      siblingIds: SIBLINGS,
    }),
  );
  const unbound = globalThis.structuredClone(revisions);
  unbound[0].envelope.assertion.scope.scene.ref = "scene:other";
  assert.throws(() =>
    assertRevisionsSealOnlyScene(unbound, {
      sceneId: SCENE,
      siblingIds: SIBLINGS,
    }),
  );
});

test("IR preconditions: the secret-free approved proposal passes and the secret one is stopped only by Secret", () => {
  const result = readings();
  assertIrPreconditionsByDisclosure(result, { editedProposalId: "p1" });
  assert.deepEqual(
    result.map((row) => row.failures),
    [["Secret"], []],
  );
});

test("IR preconditions accept any number of windows from one up", () => {
  for (const count of [1, 2, 3, 8, 32]) {
    const result = readings((input) => {
      input.run = runRow({
        coverageJson: JSON.stringify({ windowCount: count }),
      });
      input.bundle.artifacts[1].payloadJson.windows = Array.from(
        { length: count },
        () => ({}),
      );
    });
    assertIrPreconditionsByDisclosure(result, { editedProposalId: "p1" });
    assert.deepEqual(
      result.map((row) => row.failures),
      [["Secret"], []],
      `${count} windows`,
    );
  }
});

test("IR preconditions fail when a readable obstacle other than the disclosure mark appears", () => {
  const edited = { editedProposalId: "p1" };
  const cases = {
    "edited proposal stays secret": (input) =>
      (input.bundle.proposals[1].payloadJson.disclosure.secret = true),
    "secret proposal was cleared": (input) =>
      (input.bundle.proposals[0].payloadJson.disclosure.secret = false),
    "edited proposal not approved": (input) =>
      (input.bundle.proposals[1].status = "unreviewed"),
    "decision belongs to another revision": (input) =>
      (input.decisions[1].revisionId = "r0"),
    "decision is not from the human review actor": (input) =>
      (input.decisions[1].actorId = "legacy-review"),
    "decision authority scope is not bound to the revision": (input) =>
      (input.decisions[1].authorityScope = "legacy-review"),
    "scene scope is not exact": (input) =>
      (input.revisions[1].envelope.assertion.scope.scene = { kind: "any" }),
    "scope still unresolved": (input) =>
      (input.revisions[1].envelope.assertion.scope.audience = {
        kind: "unresolved",
      }),
    "no window at all": (input) => {
      input.run = runRow({ coverageJson: JSON.stringify({ windowCount: 0 }) });
      input.bundle.artifacts[1].payloadJson.windows = [];
    },
    "coverage names more windows than the plan holds": (input) => {
      input.run = runRow({ coverageJson: JSON.stringify({ windowCount: 3 }) });
      input.bundle.artifacts[1].payloadJson.windows = [{}, {}];
    },
    "a repair stage ran": (input) =>
      input.bundle.stageReceipts.push({
        stageExecution: { stageId: "narrative_structured_repair" },
      }),
    "merge changed the observations": (input) =>
      (input.bundle.artifacts[3].payloadJson.observations = []),
    "synthesis did not succeed": (input) =>
      (input.bundle.stageReceipts[1].terminalStatus = "failed"),
    "catalog version differs": (input) =>
      (input.bundle.artifacts[0].payloadJson.evidence.catalog.version = 2),
  };
  for (const [name, mutate] of Object.entries(cases)) {
    assert.throws(
      () => assertIrPreconditionsByDisclosure(readings(mutate), edited),
      undefined,
      name,
    );
  }
});

function noticeHarness(kinds) {
  const calls = { analyze: 0, waits: 0 };
  const harness = {
    invokeOk: async (_page, command) => {
      assert.equal(command, "db_execute");
      return { rows: [{ runId: "old-run" }] };
    },
    waitUntil: async (predicate, label) => {
      assert.equal(label, "exactly two actual proposals");
      calls.waits += 1;
      const outcome = await predicate();
      if (!outcome) throw new Error("fake timeout");
      return outcome;
    },
    recordTimeline: () => {},
  };
  const dialog = {
    getByRole: () => ({ click: async () => (calls.analyze += 1) }),
    locator: (selector) => {
      assert.equal(selector, '[data-testid^="chronicle-extract-notice-"]');
      return {
        evaluateAll: async (fn) =>
          fn(
            kinds.map((kind) => ({
              getAttribute: () => `chronicle-extract-notice-${kind}`,
            })),
          ),
      };
    },
  };
  return { harness, dialog, calls };
}

test("a start notice after the first 解析 fails the journey and names the notice", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "chronicle-notice-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { harness, dialog, calls } = noticeHarness([
    "same-scene-approved",
    "a-notice-kind-that-does-not-exist-yet",
  ]);
  await assert.rejects(
    analyzeChronicleAndWaitForProposals({
      harness,
      dialog,
      page: {},
      projectId: "project-1",
      directory,
      failOnStartNotices: true,
    }),
    /unexpected start notices before the Run: same-scene-approved, a-notice-kind-that-does-not-exist-yet/,
  );
  assert.equal(calls.analyze, 1, "the notice is never answered by a 2nd press");
});

test("without a notice the wait keeps polling for the Run", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "chronicle-nonotice-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { harness, dialog } = noticeHarness([]);
  await assert.rejects(
    analyzeChronicleAndWaitForProposals({
      harness,
      dialog,
      page: {},
      projectId: "project-1",
      directory,
      failOnStartNotices: true,
    }),
    /fake timeout/,
  );
});

test("the option value is the 'scene:' prefixed scene id and a missing option fails the choice", async () => {
  assert.equal(currentSceneOptionValue(SCENE), "scene:scene-1");
  const calls = [];
  const select = {
    selectOption: async (value, options) => calls.push({ value, options }),
    inputValue: async () => "scene:scene-1",
  };
  await chooseCurrentSceneTarget({ locator: () => select }, SCENE);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].value, "scene:scene-1");
  await assert.rejects(
    chooseCurrentSceneTarget(
      {
        locator: () => ({
          selectOption: async () => {
            throw new Error("option not found");
          },
          inputValue: async () => "",
        }),
      },
      SCENE,
    ),
    /option not found/,
  );
  await assert.rejects(
    chooseCurrentSceneTarget(
      {
        locator: () => ({
          selectOption: async () => {},
          inputValue: async () => "folder-1",
        }),
      },
      SCENE,
    ),
  );
});

function sceneRowPage({ rowVisible }) {
  const calls = { clicks: [], panels: [], waits: [] };
  const locator = (selector) => ({
    waitFor: async (options) => {
      calls.waits.push(selector);
      if (selector.includes("data-node-row") && !rowVisible.current)
        throw new Error("hidden");
      return options;
    },
    click: async (options) => {
      calls.clicks.push({ selector, options });
      if (selector === `[data-node-row="${FOLDER}"]`) rowVisible.current = true;
    },
    getAttribute: async () => "true",
  });
  return { calls, page: { locator, getByTestId: locator } };
}

test("opening the scene clicks its row (expanding the folder first when hidden) and waits for the editor", async () => {
  const visible = { current: false };
  const { calls, page } = sceneRowPage({ rowVisible: visible });
  await openSceneInEditor(page, { sceneId: SCENE, folderId: FOLDER });
  const clicked = calls.clicks.map((row) => row.selector);
  assert.ok(clicked.includes(`[data-node-row="${FOLDER}"]`));
  assert.equal(clicked.at(-1), `[data-node-row="${SCENE}"]`);
  assert.deepEqual(calls.clicks.at(-1).options, { position: { x: 2, y: 2 } });
  assert.ok(
    calls.waits.some((selector) =>
      selector.includes(`data-editor-loaded-document-id="${SCENE}"`),
    ),
    "waits for the loaded editor document",
  );
});

function applyFakes(enabled) {
  const clicks = [];
  const button = {
    waitFor: async () => {},
    isEnabled: async () => enabled,
    click: async () => clicks.push("apply"),
  };
  return {
    clicks,
    dialog: { getByRole: () => button },
    harness: {
      waitUntil: async (predicate, label) => {
        for (let attempt = 0; attempt < 3; attempt += 1)
          if (await predicate()) return true;
        throw new Error(`timeout: ${label}`);
      },
    },
  };
}

test("a disabled apply button fails the current-scene journey and is never clicked", async () => {
  const disabled = applyFakes(false);
  await assert.rejects(
    clickEnabledApplyButton({
      harness: disabled.harness,
      dialog: disabled.dialog,
    }),
    /timeout/,
  );
  assert.deepEqual(disabled.clicks, []);
  const enabled = applyFakes(true);
  await clickEnabledApplyButton({
    harness: enabled.harness,
    dialog: enabled.dialog,
  });
  assert.deepEqual(enabled.clicks, ["apply"]);
});

test("the setup sets the main-line project default with the read baseVersion, and fails unless every Scene binding is explicit", async () => {
  const calls = [];
  const response = { ok: true };
  const result = await setMainLineSceneScopeDefault({
    invoke: async (command, args) => {
      calls.push([command, args]);
      return command.endsWith("_read") ? { version: 3 } : response;
    },
    workspace: "/w",
    projectId: "p1",
  });
  assert.equal(result, response);
  assert.deepEqual(
    calls.map(([c]) => c),
    [
      "narrative_scope_project_default_read",
      "narrative_scope_project_default_update",
    ],
  );
  const payload = calls[1][1].payload;
  assert.equal(payload.baseVersion, 3);
  assert.equal(payload.default.state, "set");
  assert.deepEqual(
    payload.default.queryIdentity,
    payload.default.materialConstraint,
  );
  assert.deepEqual(payload.default.queryIdentity, {
    timeline: { kind: "exact", ref: "timeline:main" },
    worldline: { kind: "exact", ref: "worldline:prime" },
    narrativeLayer: { kind: "exact", ref: "layer:manuscript" },
  });
  const good = ["a", "b", "c"].map((sceneId) => ({
    sceneId,
    compatibilityMarker: "explicit",
  }));
  assertSceneBindingsExplicit(good, ["a", "b", "c"]);
  assert.throws(() =>
    assertSceneBindingsExplicit(
      [{ ...good[0], compatibilityMarker: "unknown" }, good[1], good[2]],
      ["a", "b", "c"],
    ),
  );
  assert.throws(() =>
    assertSceneBindingsExplicit(good.slice(0, 2), ["a", "b", "c"]),
  );
});

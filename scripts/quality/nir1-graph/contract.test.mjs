import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  APPROVING_REVIEW_VERDICT,
  GRAPH_CASE_IDS,
  MANIFEST_STATUS,
  NIR1_GRAPH_FREEZE_PATH,
  NIR1_GRAPH_MANIFEST_PATH,
  NIR1_GRAPH_README_PATH,
  NIR1_GRAPH_REVIEW_RECEIPT_PATH,
  NIR1_GRAPH_SCHEMA_PATH,
  NIR1_G01_FIXTURE_PATH,
  NIR1_L6L9_PLAN_PATH,
  NIR1_RANKING_POLICY_PATH,
  NIR1_RETRIEVAL_MANIFEST_PATH,
  PRECONDITIONS,
  RUNTIME_COMPARED_FIELDS,
  RUNTIME_COMPARISON_CONTROL_FIELDS,
  RUNTIME_RECORDED_ONLY_FIELDS,
  SLOT_CLASSES,
  evaluateGraphCaseVariant,
  foreshadowDisclosedAtQuery,
  parseGraphCaseTable,
  requiredPreconditions,
  resolveVariantOutcome,
  schemaExpectationFieldPaths,
  sha256,
  validateGraphCaseFixture,
  validateNir1GraphCases,
} from "./contract.mjs";
import { lexicalConflict, porterStem } from "./porter.mjs";

const root = path.resolve(import.meta.dirname, "../../..");

async function readJson(relative, base = root) {
  return JSON.parse(await readFile(path.join(base, relative), "utf8"));
}

async function context() {
  const schema = await readJson(NIR1_GRAPH_SCHEMA_PATH);
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  return {
    validateSchema: ajv.compile(schema),
    caseTable: parseGraphCaseTable(
      await readFile(path.join(root, NIR1_L6L9_PLAN_PATH), "utf8"),
    ),
  };
}

async function fixture(caseId) {
  const manifest = await readJson(NIR1_GRAPH_MANIFEST_PATH);
  return readJson(manifest.cases.find((row) => row.caseId === caseId).path);
}

async function errorsFor(value) {
  return validateGraphCaseFixture(value, await context()).errors;
}

function variant(value, id) {
  return value.variants.find((row) => row.id === id);
}

/** Copies every file the population validator reads into a scratch root. */
async function copyPopulation(temp) {
  const manifest = await readJson(NIR1_GRAPH_MANIFEST_PATH);
  const files = [
    NIR1_GRAPH_MANIFEST_PATH,
    NIR1_GRAPH_SCHEMA_PATH,
    NIR1_GRAPH_README_PATH,
    NIR1_GRAPH_REVIEW_RECEIPT_PATH,
    NIR1_GRAPH_FREEZE_PATH,
    NIR1_L6L9_PLAN_PATH,
    NIR1_RANKING_POLICY_PATH,
    NIR1_RETRIEVAL_MANIFEST_PATH,
    ...manifest.cases.map((row) => row.path),
  ];
  for (const file of files)
    await cp(path.join(root, file), path.join(temp, file), {
      recursive: true,
    });
}

async function withPopulationCopy(run) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "nir1-graph-freeze-"));
  try {
    await copyPopulation(temp);
    return await run(temp);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function editJson(base, relative, edit) {
  const file = path.join(base, relative);
  const value = JSON.parse(await readFile(file, "utf8"));
  edit(value);
  await writeFile(file, JSON.stringify(value, null, 2));
}

/** Re-binds every hash of a copied freeze record, as a regenerated freeze would. */
async function rebindFreeze(temp) {
  const digest = async (relative) =>
    sha256(await readFile(path.join(temp, relative)));
  const hashes = {
    manifestSha256: await digest(NIR1_GRAPH_MANIFEST_PATH),
    schemaSha256: await digest(NIR1_GRAPH_SCHEMA_PATH),
    readmeSha256: await digest(NIR1_GRAPH_README_PATH),
  };
  const freeze = await readJson(NIR1_GRAPH_FREEZE_PATH, temp);
  const cases = new Map();
  for (const entry of freeze.cases)
    cases.set(entry.caseId, await digest(entry.path));
  await editJson(temp, NIR1_GRAPH_FREEZE_PATH, (value) => {
    Object.assign(value, hashes);
    for (const entry of value.cases) entry.sha256 = cases.get(entry.caseId);
  });
}

async function populationErrors(base) {
  return (await validateNir1GraphCases({ repoRoot: base })).errors;
}

function assertError(errors, message) {
  assert.ok(
    errors.some((error) => error.includes(message)),
    `${message}: ${errors.join("; ")}`,
  );
}

test("the fixed G-01..G-08 population validates and is frozen without any Graph runtime result", async () => {
  const result = await validateNir1GraphCases({ repoRoot: root });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.cases.map((row) => row.caseId),
    GRAPH_CASE_IDS,
  );
  assert.equal(result.manifest.graphRuntimeObservedBeforeFreeze, false);
  assert.deepEqual(
    [...new Set(result.cases.map((row) => row.slotClass))].sort(),
    [...SLOT_CLASSES].sort(),
  );
  for (const row of result.cases) assert.match(row.sha256, /^[0-9a-f]{64}$/);
  assert.equal(result.freeze.status, "frozen");
  assert.equal(result.freeze.reviewReceipt, NIR1_GRAPH_REVIEW_RECEIPT_PATH);
  assert.equal(result.freeze.reviewVerdict, APPROVING_REVIEW_VERDICT);
  assert.equal(result.manifest.status, MANIFEST_STATUS.frozen);
  assert.equal(result.manifest.independentExpectationReview.status, "reviewed");
  assert.equal(
    result.manifest.independentExpectationReview.verdict,
    APPROVING_REVIEW_VERDICT,
  );
  const freeze = await readJson(NIR1_GRAPH_FREEZE_PATH);
  assert.equal(freeze.graphRuntimeObservedBeforeFreeze, false);
  assert.equal(freeze.baselineHead, "a153743b3f672b7274bdd748f15ef9c216dc9961");
});

test("G-01 stays the unchanged predeclared fixture", async () => {
  const manifest = await readJson(NIR1_GRAPH_MANIFEST_PATH);
  const g01 = manifest.cases.find((row) => row.caseId === "G-01");
  const bytes = await readFile(path.join(root, NIR1_G01_FIXTURE_PATH));
  assert.equal(g01.sha256, sha256(bytes));
  assert.equal(g01.predeclaredImprovement, true);
  assert.equal(
    manifest.cases.filter((row) => row.predeclaredImprovement).length,
    1,
  );
});

test("case classes are copied exactly from the l6-l9 G-01..G-08 table", async () => {
  const table = parseGraphCaseTable(
    await readFile(path.join(root, NIR1_L6L9_PLAN_PATH), "utf8"),
  );
  assert.deepEqual([...table.keys()].sort(), GRAPH_CASE_IDS);
  const value = structuredClone(await fixture("G-02"));
  assert.deepEqual(value.caseClass, table.get("G-02"));
  value.caseClass.negative = "逆向きedge";
  assert.ok(
    (await errorsFor(value)).some((error) => error.includes("caseClass")),
  );
});

test("a reverse directed edge cannot be declared as a traversed path", async () => {
  const value = structuredClone(await fixture("G-02"));
  variant(value, "base").expectations.graph.nodes.push({
    entityId: "g02-rook",
    hop: 1,
  });
  assert.ok(
    (await errorsFor(value)).some((error) => error.includes("graph.nodes")),
  );
  const flipped = structuredClone(await fixture("G-02"));
  flipped.relations.find((row) => row.id === "g02-trained-orla").direction =
    "symmetric";
  assert.ok(
    (await errorsFor(flipped)).some(
      (error) =>
        error.includes("pathAttachments") || error.includes("graph.nodes"),
    ),
  );
});

test("two same-hop new Scenes are rejected because the appended Scene would depend on runtime IDs", async () => {
  const value = structuredClone(await fixture("G-02"));
  value.pins.push({
    sceneId: "g02-harbor",
    entryId: "g02-sela",
    source: "scene_codex_pins",
  });
  assert.ok(
    (await errorsFor(value)).some((error) => error.includes("runtime IDs")),
  );
});

test("more than eight pins of reached Entities are rejected because N_F=8 truncation would decide the result", async () => {
  for (const caseId of GRAPH_CASE_IDS.slice(1)) {
    const value = await fixture(caseId);
    for (const row of value.variants) {
      const pins = evaluateGraphCaseVariant(value, row).computed.framePinCount;
      assert.ok(pins === null || pins <= 8, `${caseId}/${row.id}`);
    }
  }
  const value = structuredClone(await fixture("G-02"));
  for (const sceneId of [
    "g02-review",
    "g02-probe",
    "g02-attach",
    "g02-rook-decoy",
    "g02-dace-decoy",
    "g02-harbor",
  ])
    value.pins.push({
      sceneId,
      entryId: "g02-tamsin",
      source: "scene_codex_pins",
    });
  value.pins.push({
    sceneId: "g02-review",
    entryId: "g02-sela",
    source: "scene_codex_pins",
  });
  const result = evaluateGraphCaseVariant(value, variant(value, "base"));
  assert.equal(result.computed.framePinCount, 9);
  assert.ok(result.errors.some((error) => error.includes("N_F=8")));
});

test("Raw-full and IR-supplemented cases never append a Graph-only Scene", async () => {
  for (const [caseId, blocked] of [
    ["G-03", "g03-hollis-ward"],
    ["G-06", "g06-bram-galley"],
    ["G-04", "g04-lio-market"],
    ["G-05", "g05-pia-ridge"],
  ]) {
    const value = await fixture(caseId);
    const result = evaluateGraphCaseVariant(value, value.variants[0]);
    assert.equal(result.computed.added, null, caseId);
    assert.ok(
      result.computed.blocked.some((row) => row.sceneId === blocked),
      caseId,
    );
    assert.deepEqual(
      result.computed.finalSceneIds,
      value.variants[0].expectations.arms.rPlusIr.sceneIds,
      caseId,
    );
  }
  const value = structuredClone(await fixture("G-03"));
  const base = variant(value, "base").expectations;
  base.addedScene = {
    sceneId: "g03-hollis-ward",
    path: base.pathAttachments[1].path,
    sceneExcerpt: {
      sceneId: "g03-hollis-ward",
      body: value.scenes.find((row) => row.id === "g03-hollis-ward").body,
      canonicalUtf16Range: { start: 0, end: 75 },
    },
  };
  assert.ok(
    (await errorsFor(value)).some((error) => error.includes("addedScene")),
  );
});

test("frontier overflow refuses the whole Graph instead of truncating it", async () => {
  const value = await fixture("G-03");
  const result = evaluateGraphCaseVariant(
    value,
    variant(value, "frontier-exceeded"),
  );
  assert.equal(result.computed.graph.reasonClass, "graph-limit-exceeded");
  assert.deepEqual(result.computed.attachments, []);
  assert.equal(result.computed.frontier.discoveredEntities, 16);
  const truncated = structuredClone(value);
  const expectations = variant(truncated, "frontier-exceeded").expectations;
  expectations.graph.status = "available";
  expectations.graph.reasonClass = null;
  expectations.pathAttachments = variant(
    truncated,
    "base",
  ).expectations.pathAttachments;
  assert.ok((await errorsFor(truncated)).length > 0);
});

test("documented qualification rules exclude stale, unapproved, out-of-scope and unrevealed material", async () => {
  const reasons = async (caseId) => {
    const value = await fixture(caseId);
    return Object.fromEntries(
      evaluateGraphCaseVariant(value, value.variants[0]).revisionReasons,
    );
  };
  assert.deepEqual(await reasons("G-04"), {
    "g04-r-lio": [],
    "g04-r-kit": ["scope-mismatch"],
    "g04-r-ora": ["scope-unresolved"],
    "g04-r-tam": ["scope-marker-unknown"],
    "g04-r-sel": ["holder-not-reader"],
  });
  assert.deepEqual(await reasons("G-05"), {
    "g05-r-pia": [],
    "g05-r-xan-1": ["stale-after-approval"],
    "g05-r-xan-2": [],
    "g05-r-yara": ["stale-after-approval"],
    "g05-r-zeb-1": ["stale-after-approval"],
    "g05-r-zeb-2": ["decision-missing"],
    "g05-r-wynn": ["decision-rejected"],
  });
  assert.deepEqual(await reasons("G-07"), {
    "g07-r-pell": [],
    "g07-r-rhea": [],
    "g07-r-fenn": ["reading-future"],
    "g07-r-quin": ["reading-same-boundary"],
    "g07-r-hask": ["secret-not-revealed"],
    "g07-r-nim": ["secret-not-revealed"],
  });
  const revealed = structuredClone(await fixture("G-07"));
  revealed.foreshadows.find((row) => row.id === "g07-fs-hask").payoffSceneId =
    "g07-rhea-reveal";
  assert.ok(
    (await errorsFor(revealed)).some((error) =>
      error.includes("excludedRevisions"),
    ),
  );
});

test("the reveal rule follows read_a3_reveal_state on every branch", async () => {
  const orders = new Map([
    ["before", 10],
    ["s2", 100],
    ["after", 120],
  ]);
  const disclosed = (row) =>
    foreshadowDisclosedAtQuery(
      { secret: true, abandoned: false, payoffConfirmed: false, ...row },
      orders,
      100,
    );
  assert.equal(disclosed({ secret: false, payoffSceneId: null }), true);
  assert.equal(disclosed({ abandoned: true, payoffSceneId: null }), true);
  assert.equal(disclosed({ payoffSceneId: "before" }), true);
  assert.equal(disclosed({ payoffSceneId: "s2" }), true);
  assert.equal(
    disclosed({ payoffSceneId: "after", payoffConfirmed: true }),
    false,
  );
  assert.equal(disclosed({ payoffSceneId: null, payoffConfirmed: true }), true);
  assert.equal(disclosed({ payoffSceneId: null }), false);
  assert.equal(
    disclosed({ payoffSceneId: "unmapped", payoffConfirmed: true }),
    false,
  );

  const reasonsFor = (value) =>
    Object.fromEntries(
      evaluateGraphCaseVariant(value, value.variants[0]).revisionReasons,
    );
  const base = await fixture("G-07");
  // A payoff at S2 itself is not after S2, so the secret is disclosed.
  const atS2 = structuredClone(base);
  atS2.foreshadows.find((row) => row.id === "g07-fs-hask").payoffSceneId =
    "g07-query";
  assert.deepEqual(reasonsFor(atS2)["g07-r-hask"], []);
  const atS2Errors = await errorsFor(atS2);
  assert.ok(!atS2Errors.some((error) => error.includes("payoff Scene")));
  assert.ok(atS2Errors.some((error) => error.includes("excludedRevisions")));
  // A payoff Scene before S2 discloses without payoff confirmation.
  const unconfirmed = structuredClone(base);
  unconfirmed.foreshadows.find(
    (row) => row.id === "g07-fs-rhea",
  ).payoffConfirmed = false;
  assert.deepEqual(reasonsFor(unconfirmed)["g07-r-rhea"], []);
  assert.deepEqual(await errorsFor(unconfirmed), []);
  // A confirmed payoff without a payoff Scene discloses.
  const orphan = structuredClone(base);
  orphan.foreshadows.find((row) => row.id === "g07-fs-nim").payoffConfirmed =
    true;
  assert.deepEqual(reasonsFor(orphan)["g07-r-nim"], []);
  // An abandoned secret no longer withholds.
  const abandoned = structuredClone(base);
  abandoned.foreshadows.find((row) => row.id === "g07-fs-hask").abandoned =
    true;
  assert.deepEqual(reasonsFor(abandoned)["g07-r-hask"], []);
  // A payoff Scene must keep an explicit Scope so its position is mapped.
  const unmapped = structuredClone(base);
  unmapped.scope.overrides["g07-rhea-reveal"] = { marker: "unknown" };
  assert.ok(
    (await errorsFor(unmapped)).some((error) =>
      error.includes("payoff Scene must keep an explicit Scope"),
    ),
  );
});

test("Graph unusable falls back to R+IR and Chronicle unusable to exact R with no mixed set", async () => {
  const value = await fixture("G-08");
  const graph = evaluateGraphCaseVariant(
    value,
    variant(value, "graph-index-unusable"),
  );
  assert.equal(graph.computed.graph.reasonClass, "graph-index-unusable");
  assert.deepEqual(graph.computed.finalSceneIds, ["g08-control", "g08-attach"]);
  assert.deepEqual(graph.computed.attachments, []);
  const chronicle = evaluateGraphCaseVariant(
    value,
    variant(value, "chronicle-index-unusable"),
  );
  assert.equal(
    chronicle.computed.graph.reasonClass,
    "chronicle-index-unusable",
  );
  assert.equal(
    variant(value, "chronicle-index-unusable").expectations.arms.rPlusIr
      .resultKind,
    "raw",
  );
  const partial = structuredClone(value);
  variant(partial, "graph-index-unusable").expectations.arms.rPlusIrPlusGraph =
    {
      baseline: "rPlusIr",
      sceneIds: ["g08-control", "g08-attach", "g08-cass-attic"],
      appendedSceneId: "g08-cass-attic",
      orderPredeclared: false,
    };
  assert.ok(
    (await errorsFor(partial)).some((error) =>
      error.includes("R+IR+Graph membership/order differs"),
    ),
  );
});

test("R+IR result kind is a recorded-only prediction except where an IR supplement is admitted", async () => {
  const raw = structuredClone(await fixture("G-02"));
  variant(raw, "base").expectations.arms.rPlusIr.resultKind = "raw";
  assert.deepEqual(await errorsFor(raw), []);
  const supplement = structuredClone(await fixture("G-04"));
  variant(supplement, "base").expectations.arms.rPlusIr.resultKind = "raw";
  assert.ok(
    (await errorsFor(supplement)).some((error) =>
      error.includes("admitted IR supplement"),
    ),
  );
  const chronicle = structuredClone(await fixture("G-08"));
  variant(
    chronicle,
    "chronicle-index-unusable",
  ).expectations.arms.rPlusIr.resultKind = "fused";
  assert.ok(
    (await errorsFor(chronicle)).some((error) =>
      error.includes("Chronicle unusable has no IR supplement"),
    ),
  );
});

test("every variant declares exactly its observation-time preconditions", async () => {
  const declared = async (caseId, variantId) =>
    variant(await fixture(caseId), variantId).preconditions;
  assert.deepEqual(
    (await declared("G-04", "base")).map((row) => [row.id, row.sceneId]),
    [
      ["b-sealed-binding", undefined],
      ["maintenance-enabled", undefined],
      ["raw-membership", undefined],
      ["ir-supplement-admission", "g04-lio-landing"],
    ],
  );
  assert.ok(
    (await declared("G-08", "graph-index-unusable")).some(
      (row) => row.id === "index-state-holding",
    ),
  );
  assert.deepEqual(
    (await declared("G-02", "base")).find((row) => row.id === "cb4-inputs"),
    { id: "cb4-inputs", scope: "added-scene", sceneId: "g02-tamsin-first" },
  );
  for (const caseId of GRAPH_CASE_IDS.slice(1)) {
    const value = await fixture(caseId);
    for (const row of value.variants) {
      const added = evaluateGraphCaseVariant(value, row).computed.added;
      assert.deepEqual(
        row.preconditions,
        requiredPreconditions(value, row, added),
        `${caseId}/${row.id}`,
      );
    }
  }

  const missing = structuredClone(await fixture("G-04"));
  variant(missing, "base").preconditions = variant(
    missing,
    "base",
  ).preconditions.filter((row) => row.id !== "ir-supplement-admission");
  assert.ok(
    (await errorsFor(missing)).some((error) =>
      error.includes("preconditions must be exactly"),
    ),
  );
  const extra = structuredClone(await fixture("G-02"));
  variant(extra, "base").preconditions.splice(3, 0, {
    id: "index-state-holding",
    scope: "variant",
  });
  assert.ok(
    (await errorsFor(extra)).some((error) =>
      error.includes("preconditions must be exactly"),
    ),
  );
  const scope = structuredClone(await fixture("G-07"));
  variant(scope, "base").preconditions.at(-1).scope = "variant";
  assert.ok(
    (await errorsFor(scope)).some((error) =>
      error.includes("cb4-inputs has scope added-scene"),
    ),
  );
  const scene = structuredClone(await fixture("G-08"));
  variant(scene, "graph-recovered").preconditions.at(-1).sceneId = "g08-attach";
  assert.ok(
    (await errorsFor(scene)).some((error) =>
      error.includes("preconditions must be exactly"),
    ),
  );
  const order = structuredClone(await fixture("G-03"));
  variant(order, "base").preconditions.reverse();
  assert.ok(
    (await errorsFor(order)).some((error) =>
      error.includes("follow the manifest definition order"),
    ),
  );
});

test("an unmet precondition blocks instead of Hold, and only a declared one can", async () => {
  const g04 = variant(await fixture("G-04"), "base");
  assert.deepEqual(
    resolveVariantOutcome(g04, { unmet: ["ir-supplement-admission"] }),
    {
      outcome: "blocked:ir-supplement-admission",
      unmet: ["ir-supplement-admission"],
      evaluated: false,
      macroEligible: false,
      pass: false,
      blockedSubExpectations: [],
    },
  );
  const g08 = variant(await fixture("G-08"), "graph-index-unusable");
  const both = resolveVariantOutcome(g08, {
    unmet: ["index-state-holding", "raw-membership"],
    comparisonPassed: true,
  });
  assert.equal(both.outcome, "blocked:raw-membership");
  assert.deepEqual(both.unmet, ["raw-membership", "index-state-holding"]);
  assert.equal(both.pass, false);

  const g02 = variant(await fixture("G-02"), "base");
  const appended = resolveVariantOutcome(g02, {
    unmet: ["cb4-inputs"],
    comparisonPassed: true,
  });
  assert.equal(appended.outcome, "pass");
  assert.equal(appended.macroEligible, true);
  assert.deepEqual(
    appended.blockedSubExpectations.map((row) => row.outcome),
    ["blocked:cb4-inputs"],
  );
  assert.ok(
    appended.blockedSubExpectations[0].notEvaluated.includes("addedScene"),
  );
  assert.equal(
    resolveVariantOutcome(g02, { comparisonPassed: false }).outcome,
    "hold",
  );
  assert.throws(
    () =>
      resolveVariantOutcome(g02, {
        unmet: ["index-state-holding"],
        comparisonPassed: false,
      }),
    /not declared/,
  );
  assert.throws(() => resolveVariantOutcome(g02, {}), /comparison result/);
});

test("runtime comparison classes cover exactly the schema expectation fields", async () => {
  const schema = await readJson(NIR1_GRAPH_SCHEMA_PATH);
  const classified = [
    ...RUNTIME_COMPARED_FIELDS,
    ...RUNTIME_COMPARISON_CONTROL_FIELDS,
    ...RUNTIME_RECORDED_ONLY_FIELDS,
  ];
  assert.equal(new Set(classified).size, classified.length);
  assert.deepEqual(
    [...schemaExpectationFieldPaths(schema)].sort(),
    [...classified].sort(),
  );
  for (const field of [
    "arms.rPlusIr.resultKind",
    "graph.reasonClass",
    "graph.frontier",
    "graph.excludedRevisions",
  ])
    assert.ok(RUNTIME_RECORDED_ONLY_FIELDS.includes(field), field);
  const manifest = await readJson(NIR1_GRAPH_MANIFEST_PATH);
  assert.deepEqual(
    manifest.runtimeComparison.comparedFields,
    RUNTIME_COMPARED_FIELDS,
  );
  assert.equal(manifest.runtimeComparison.reasonClass, "status-only");
  assert.deepEqual(
    manifest.preconditions.definitions.map((row) => [row.id, row.scope]),
    PRECONDITIONS.map((row) => [row.id, row.scope]),
  );

  await withPopulationCopy(async (temp) => {
    const file = path.join(temp, NIR1_GRAPH_MANIFEST_PATH);
    const changed = JSON.parse(await readFile(file, "utf8"));
    changed.runtimeComparison.comparedFields.push("arms.rPlusIr.resultKind");
    await writeFile(file, JSON.stringify(changed));
    const result = await validateNir1GraphCases({ repoRoot: temp });
    assert.ok(
      result.errors.some((error) =>
        error.includes("runtimeComparison.comparedFields"),
      ),
    );
  });
  await withPopulationCopy(async (temp) => {
    const file = path.join(temp, NIR1_GRAPH_SCHEMA_PATH);
    const changed = JSON.parse(await readFile(file, "utf8"));
    changed.$defs.variant.properties.expectations.properties.graph.properties.latencyMs =
      { type: "number" };
    await writeFile(file, JSON.stringify(changed));
    const result = await validateNir1GraphCases({ repoRoot: temp });
    assert.ok(
      result.errors.some((error) =>
        error.includes("cover exactly the expectation fields"),
      ),
    );
  });
});

test("a Graph Source edit after IR creation must stay independent of IR material", async () => {
  const value = structuredClone(await fixture("G-08"));
  const juno = value.pins.find((row) => row.entryId === "g08-juno");
  juno.sceneId = "g08-control";
  assert.ok(
    (await errorsFor(value)).some((error) =>
      error.includes("after the qualified-ir step"),
    ),
  );
  const early = structuredClone(await fixture("G-08"));
  const steps = early.setupTimeline;
  const withdraw = steps.findIndex((row) => row.id === "g08-m-ir-withdraw");
  const [step] = steps.splice(withdraw, 1);
  steps.unshift(step);
  assert.ok(
    (await errorsFor(early)).some((error) =>
      error.includes("must follow the qualified-ir step"),
    ),
  );
});

test("non-control Scenes cannot share Raw-visible vocabulary with S2", async () => {
  const value = structuredClone(await fixture("G-02"));
  value.scenes.find((row) => row.id === "g02-tamsin-first").body =
    "Tamsin was trained to twist molten glass into a thin blue stem.";
  assert.ok(
    (await errorsFor(value)).some((error) =>
      error.includes("Raw-visible token"),
    ),
  );
  const named = structuredClone(await fixture("G-02"));
  named.query.body = "Which earlier scene shows an apprentice trained by Orla?";
  const errors = await errorsFor(named);
  assert.ok(errors.some((error) => error.includes("proper-noun")));
});

test("Porter stems follow the FTS5 porter tokenizer for the predicted vocabulary", () => {
  assert.equal(porterStem("carried"), "carri");
  assert.equal(porterStem("carry"), "carri");
  assert.equal(porterStem("trained"), "train");
  assert.equal(porterStem("witness"), "wit");
  assert.equal(porterStem("detective"), "detect");
  assert.equal(porterStem("questioned"), "question");
  assert.equal(porterStem("generalizations"), "gener");
  assert.ok(lexicalConflict("carried", "carry"));
  assert.ok(lexicalConflict("earlier", "early"));
  assert.ok(!lexicalConflict("scene", "scent"));
});

test("the existing 24 retrieval queries keep no Graph seed and their manifest stays not Graph", async () => {
  const manifest = await readJson(NIR1_GRAPH_MANIFEST_PATH);
  const retrieval = await readJson(NIR1_RETRIEVAL_MANIFEST_PATH);
  const policy = manifest.existingRetrievalSeedPolicy;
  assert.equal(policy.manualSeed, "none");
  assert.equal(policy.expectedGraphContribution, 0);
  assert.equal(policy.graphStatus, "not-requested");
  assert.equal(policy.retrievalManifestScope, retrieval.scope);
  assert.match(retrieval.scope, /\bnot Graph\b/);
});

test("the freeze binds the manifest, every fixture, the schema, the README and the review receipt", async () => {
  await withPopulationCopy(async (temp) => {
    const copied = await validateNir1GraphCases({ repoRoot: temp });
    assert.deepEqual(copied.errors, []);
    assert.equal(copied.freeze.status, "frozen");
  });
  const drifts = [
    [
      NIR1_GRAPH_README_PATH,
      (text) => `${text}\n`,
      "nir1-graph freeze README hash differs",
    ],
    [
      NIR1_GRAPH_SCHEMA_PATH,
      (text) => `${text}\n`,
      "nir1-graph freeze schema hash differs",
    ],
    [
      NIR1_GRAPH_REVIEW_RECEIPT_PATH,
      (text) => `${text}\n`,
      "nir1-graph freeze review receipt hash differs",
    ],
    [
      "evals/nir1-graph/g04-scope-exact-unknown.v1.json",
      (text) => `${text}\n`,
      "nir1-graph freeze does not bind G-04",
    ],
  ];
  for (const [file, change, message] of drifts) {
    await withPopulationCopy(async (temp) => {
      const target = path.join(temp, file);
      await writeFile(target, change(await readFile(target, "utf8")));
      const result = await validateNir1GraphCases({ repoRoot: temp });
      assert.ok(
        result.errors.some((error) => error.includes(message)),
        `${file}: ${result.errors.join("; ")}`,
      );
    });
  }
});

test("the freeze record and the manifest status agree in both directions", async () => {
  await withPopulationCopy(async (temp) => {
    const file = path.join(temp, NIR1_GRAPH_MANIFEST_PATH);
    const manifest = JSON.parse(await readFile(file, "utf8"));
    manifest.status = MANIFEST_STATUS.pending;
    manifest.independentExpectationReview.status = "pending";
    await writeFile(file, JSON.stringify(manifest, null, 2));
    const result = await validateNir1GraphCases({ repoRoot: temp });
    assert.ok(
      result.errors.some((error) =>
        error.includes("freeze record requires manifest status"),
      ),
    );
    assert.ok(
      result.errors.some((error) =>
        error.includes("independentExpectationReview.status reviewed"),
      ),
    );
  });
  await withPopulationCopy(async (temp) => {
    await rm(path.join(temp, NIR1_GRAPH_FREEZE_PATH));
    const result = await validateNir1GraphCases({ repoRoot: temp });
    assert.equal(
      result.freeze.status,
      "pending-independent-expectation-review",
    );
    assert.ok(
      result.errors.some((error) =>
        error.includes(`status must stay ${MANIFEST_STATUS.pending}`),
      ),
    );
  });
  await withPopulationCopy(async (temp) => {
    await rm(path.join(temp, NIR1_GRAPH_FREEZE_PATH));
    const file = path.join(temp, NIR1_GRAPH_MANIFEST_PATH);
    const manifest = JSON.parse(await readFile(file, "utf8"));
    manifest.status = MANIFEST_STATUS.pending;
    manifest.independentExpectationReview.status = "pending";
    await writeFile(file, JSON.stringify(manifest, null, 2));
    const result = await validateNir1GraphCases({ repoRoot: temp });
    assert.deepEqual(result.errors, []);
    assert.equal(
      result.freeze.status,
      "pending-independent-expectation-review",
    );
  });
  await withPopulationCopy(async (temp) => {
    const file = path.join(temp, NIR1_GRAPH_FREEZE_PATH);
    const freeze = JSON.parse(await readFile(file, "utf8"));
    freeze.graphRuntimeObservedBeforeFreeze = true;
    freeze.baselineHead = "a153743b";
    freeze.irSupplementAdmissionProbe = { status: "run" };
    await writeFile(file, JSON.stringify(freeze, null, 2));
    const result = await validateNir1GraphCases({ repoRoot: temp });
    for (const message of [
      "must record no Graph runtime observation",
      "baselineHead must be a full commit id",
      "disagree on the IR admission probe",
    ])
      assert.ok(
        result.errors.some((error) => error.includes(message)),
        message,
      );
  });
});

test("the freeze follows an approving review by a read-only reviewer other than the fixture author", async () => {
  const freeze = await readJson(NIR1_GRAPH_FREEZE_PATH);
  const record = freeze.independentExpectationReview;
  const final = record.rounds.at(-1);
  assert.equal(freeze.reviewVerdict, APPROVING_REVIEW_VERDICT);
  assert.equal(final.verdict, APPROVING_REVIEW_VERDICT);
  assert.deepEqual(final.requiredChanges, []);
  assert.deepEqual(
    final.cases.map((row) => [row.id, row.verdict]),
    GRAPH_CASE_IDS.slice(1).map((id) => [id, APPROVING_REVIEW_VERDICT]),
  );
  assert.deepEqual(
    [
      record.reviewer.distinctFromFixtureAuthor,
      record.reviewer.readOnly,
      record.reviewer.graphRuntimeOutputObserved,
    ],
    [true, true, false],
  );
  const receipt = await readJson(NIR1_GRAPH_REVIEW_RECEIPT_PATH);
  assert.equal(record.rounds[0].verdict, receipt.result.verdict);

  const finalRound = (value) =>
    value.independentExpectationReview.rounds.at(-1);
  const reviewer = (value) => value.independentExpectationReview.reviewer;
  const mutations = [
    [
      (value) => {
        finalRound(value).cases[3].verdict = "changes-required";
      },
      "does not approve G-05",
    ],
    [
      (value) => {
        finalRound(value).requiredChanges = ["Add a negative case."];
      },
      "must leave no required change",
    ],
    [
      (value) => {
        finalRound(value).verdict = "changes-required";
      },
      "must follow an approving final review round",
    ],
    [
      (value) => {
        value.reviewVerdict = "changes-required";
      },
      "reviewVerdict and the manifest review verdict disagree",
    ],
    [
      (value) => {
        reviewer(value).graphRuntimeOutputObserved = true;
      },
      "must not have observed Graph runtime output",
    ],
    [
      (value) => {
        reviewer(value).distinctFromFixtureAuthor = false;
      },
      "must be distinct from the fixture author",
    ],
    [
      (value) => {
        reviewer(value).readOnly = false;
      },
      "must be read-only",
    ],
    [
      (value) => {
        value.independentExpectationReview.rounds[0].verdict =
          APPROVING_REVIEW_VERDICT;
      },
      "review round 1 verdict differs from its receipt",
    ],
    [
      (value) => {
        value.independentExpectationReview.rounds[0].receiptSha256 = "0".repeat(
          64,
        );
      },
      "review round 1 must be the bound review receipt",
    ],
  ];
  for (const [edit, message] of mutations) {
    await withPopulationCopy(async (temp) => {
      await editJson(temp, NIR1_GRAPH_FREEZE_PATH, edit);
      assertError(await populationErrors(temp), message);
    });
  }
  await withPopulationCopy(async (temp) => {
    await editJson(temp, NIR1_GRAPH_MANIFEST_PATH, (value) => {
      value.independentExpectationReview.verdict = "changes-required";
    });
    await rebindFreeze(temp);
    const errors = await populationErrors(temp);
    assertError(
      errors,
      `requires independentExpectationReview.verdict ${APPROVING_REVIEW_VERDICT}`,
    );
    assertError(
      errors,
      "reviewVerdict and the manifest review verdict disagree",
    );
  });
});

test("after the approving review only the manifest review block and declared README sections may change", async () => {
  const freeze = await readJson(NIR1_GRAPH_FREEZE_PATH);
  const changes = freeze.independentExpectationReview.changesAfterApproval;
  const scopeOf = (file) => changes.find((row) => row.path === file)?.scope;
  assert.deepEqual(scopeOf(NIR1_GRAPH_MANIFEST_PATH), {
    kind: "json-keys",
    keys: ["independentExpectationReview"],
  });
  assert.equal(scopeOf(NIR1_GRAPH_README_PATH)?.kind, "markdown-sections");

  await withPopulationCopy(async (temp) => {
    const readme = path.join(temp, NIR1_GRAPH_README_PATH);
    const heading = `## ${scopeOf(NIR1_GRAPH_README_PATH).headings[0]}\n`;
    const text = await readFile(readme, "utf8");
    assert.ok(text.includes(heading));
    await writeFile(readme, text.replace(heading, `${heading}\n- 追記。\n`));
    await editJson(temp, NIR1_GRAPH_MANIFEST_PATH, (value) => {
      value.independentExpectationReview.afterApproval += " Edited.";
    });
    await rebindFreeze(temp);
    assert.deepEqual(await populationErrors(temp), []);
  });

  const compact = (text) => JSON.stringify(JSON.parse(text));
  const outsideScope = [
    [
      NIR1_GRAPH_README_PATH,
      (text) => `${text}\n追記。\n`,
      "README.md changed outside its declared scope",
    ],
    [
      NIR1_GRAPH_MANIFEST_PATH,
      (text) => {
        const value = JSON.parse(text);
        value.scope = `${value.scope} Edited.`;
        return JSON.stringify(value, null, 2);
      },
      "manifest.v1.json changed outside its declared scope",
    ],
    [
      NIR1_GRAPH_SCHEMA_PATH,
      compact,
      "schema.v1.json differs from the bytes the approving review saw",
    ],
    [
      "evals/nir1-graph/g06-evidence-anchor-path.v1.json",
      compact,
      "g06-evidence-anchor-path.v1.json differs from the bytes the approving review saw",
    ],
  ];
  for (const [file, change, message] of outsideScope) {
    await withPopulationCopy(async (temp) => {
      const target = path.join(temp, file);
      await writeFile(target, change(await readFile(target, "utf8")));
      await rebindFreeze(temp);
      assertError(await populationErrors(temp), message);
    });
  }

  await withPopulationCopy(async (temp) => {
    await editJson(temp, NIR1_GRAPH_FREEZE_PATH, (value) => {
      const declared = value.independentExpectationReview.changesAfterApproval;
      declared
        .find((row) => row.path === NIR1_GRAPH_MANIFEST_PATH)
        .scope.keys.push("comparison");
      declared.push({
        path: NIR1_GRAPH_SCHEMA_PATH,
        scope: { kind: "json-keys", keys: ["$defs"] },
        approvedSha256OutsideScope: "0".repeat(64),
        change: "None.",
      });
    });
    const errors = await populationErrors(temp);
    assertError(
      errors,
      "may change after the approving review only in independentExpectationReview",
    );
    assertError(
      errors,
      `declares a change to ${NIR1_GRAPH_SCHEMA_PATH}, which keeps its approved bytes`,
    );
  });
});

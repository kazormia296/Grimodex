// CP-4 S1i: 凍結した G-case の setup の plan（fixture の宣言を読むだけ。実行しない）。
// fixture は node の fs で読み、凍結の bytes を照合してから plan を導く。実 Electron
// も製品の runtime も使わない。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { GRAPH_EVAL_VARIANTS } from "./constants.mjs";
import {
  CANDIDATE_DOCUMENT_PATH,
  FROZEN_SETUP_PLAN_SCHEMA,
  G01_SETUP_SOURCES,
  R5_CHECK_FORBIDS,
  R5_CHECK_RUN,
  R5_CHECK_SCOPE,
  SETUP_ORDER_CLAUSES,
  SETUP_STOPS,
  assertR5CheckPhases,
  executedPhaseNames,
  frozenSetupPlan,
  loadFrozenSetupPlans,
  phaseCategories,
  plannedPhaseNames,
  readCandidateDocument,
  setupOrderCorrespondence,
} from "./frozen-setup-plan.mjs";
import { SEED_PIN_PHASE, assertSeedPinPlacement } from "./seed-pin-setup.mjs";
import { REPO_ROOT } from "./test-support.mjs";

const readFixture = (file) =>
  JSON.parse(readFileSync(path.join(REPO_ROOT, file), "utf8"));
const fixtureOf = (caseId) =>
  readFixture(
    GRAPH_EVAL_VARIANTS.find((row) => row.caseId === caseId).fixturePath,
  );

/** S2（claude/cp4-s2-observation-prep の 2a748d2d）の r5Gate.exempt の行を写したもの。 */
const S2_R5_EXEMPT = Object.freeze({
  run: "r5-seed-pin-check",
  scope: ["setup-through-seed-pin-step", "product-db-read"],
  forbids: [
    "graph-arm",
    "rir-query",
    "evaluation-run",
    "diagnostic",
    "trace",
    "v10-ready-probe",
    "maintenance-enable",
    "setup-timeline",
    "typed-revision-prepare",
    "b-graph-index-build",
    "chronicle-index-build",
    "index-state-record",
  ],
});

test("① の禁止の集合と範囲は S2 の r5Gate.exempt と完全に一致する（observation-prep の file があればそれとも照合）", () => {
  assert.equal(R5_CHECK_RUN, S2_R5_EXEMPT.run);
  assert.deepEqual([...R5_CHECK_SCOPE], S2_R5_EXEMPT.scope);
  assert.deepEqual([...R5_CHECK_FORBIDS], S2_R5_EXEMPT.forbids);
  const prep = path.join(
    REPO_ROOT,
    "evals/nir1-graph/observation-prep.v1.json",
  );
  if (existsSync(prep)) {
    const row = JSON.parse(readFileSync(prep, "utf8")).r5Gate.exempt.find(
      (entry) => entry.run === R5_CHECK_RUN,
    );
    assert.deepEqual([...R5_CHECK_FORBIDS], row.forbids);
    assert.deepEqual([...R5_CHECK_SCOPE], row.scope);
  }
});

test("setupOrder の対応表: G-02〜G-08 の文は節の表で過不足なく覆われ、どの節も driver か runner の段に対応する", () => {
  for (const caseId of [
    "G-02",
    "G-03",
    "G-04",
    "G-05",
    "G-06",
    "G-07",
    "G-08",
  ]) {
    const fixture = fixtureOf(caseId);
    const rows = setupOrderCorrespondence({ caseId, fixture });
    assert.equal(
      rows.map((row) => row.text + row.after).join(""),
      fixture.measurementBoundary.setupOrder,
      caseId,
    );
    assert.deepEqual(
      rows.map((row) => row.clauseId),
      SETUP_ORDER_CLAUSES.map((row) => row.id),
    );
    for (const row of rows)
      assert.ok(
        row.phases.length > 0 || typeof row.guard === "string",
        `${caseId} ${row.clauseId} maps to no phase`,
      );
  }
  // 文が 1 語でも違えば（対応できない step）[precheck]。
  const g02 = fixtureOf("G-02");
  for (const setupOrder of [
    g02.measurementBoundary.setupOrder.replace("then Codex", "then Codex rows"),
    `${g02.measurementBoundary.setupOrder} Then reopen the workspace.`,
    undefined,
  ])
    assert.throws(
      () =>
        setupOrderCorrespondence({
          caseId: "G-02",
          fixture: {
            ...g02,
            measurementBoundary: { ...g02.measurementBoundary, setupOrder },
          },
        }),
      /\[precheck\] S1i setup-order/u,
    );
});

test("setupOrder の対応表: G-01（setupOrder なし）は runtimeSetup と候補 §7 の文から導き、文は file の bytes と一致する", () => {
  const g01 = fixtureOf("G-01");
  const candidateDocument = readCandidateDocument({ root: REPO_ROOT });
  const rows = setupOrderCorrespondence({
    caseId: "G-01",
    fixture: g01,
    candidateDocument,
  });
  assert.deepEqual(
    rows.map((row) => row.clauseId),
    G01_SETUP_SOURCES.map((row) => row.id),
  );
  const candidate = readFileSync(
    path.join(REPO_ROOT, "docs/plans/nir1-c-scene-connection-candidate.md"),
    "utf8",
  );
  for (const row of G01_SETUP_SOURCES) {
    if (row.source === "fixture.measurementBoundary.runtimeSetup")
      assert.equal(row.text, g01.measurementBoundary.runtimeSetup);
    else assert.ok(candidate.includes(row.text), `${row.id} is quoted`);
    assert.ok(row.phases.length > 0);
  }
  // S1j P3: 候補 §7 の文は file から読んで一字ずつ照合し、文書の sha を残す。
  assert.equal(candidateDocument.path, CANDIDATE_DOCUMENT_PATH);
  assert.equal(
    candidateDocument.sha256,
    createHash("sha256").update(candidate).digest("hex"),
  );
  for (const row of rows.filter((entry) =>
    entry.source.startsWith("candidate"),
  ))
    assert.deepEqual(
      [row.documentPath, row.documentSha256],
      [CANDIDATE_DOCUMENT_PATH, candidateDocument.sha256],
    );
  for (const document of [
    undefined,
    {
      ...candidateDocument,
      text: candidateDocument.text.replace("唯一のpinは", "唯一の pin は"),
    },
    {
      ...candidateDocument,
      text: candidateDocument.text.replace(
        "Option Bの通常prepare",
        "Option B の通常 prepare",
      ),
    },
  ])
    assert.throws(
      () =>
        setupOrderCorrespondence({
          caseId: "G-01",
          fixture: g01,
          candidateDocument: document,
        }),
      /\[precheck\] S1i setup-order/u,
    );
  // G-01 の fixture の setup の材料は、どれかの段が書く。
  const phases = new Set(rows.flatMap((row) => row.phases));
  for (const phase of [
    "scenes",
    "entities",
    "relations",
    "scope-registry",
    "scene-scope",
    "pins",
    "typed-revisions",
    "qualified-ir",
    "b-seal",
  ])
    assert.ok(phases.has(phase), phase);
  assert.throws(
    () =>
      setupOrderCorrespondence({
        caseId: "G-01",
        fixture: {
          ...g01,
          measurementBoundary: {
            ...g01.measurementBoundary,
            runtimeSetup: "Requires something else.",
          },
        },
        candidateDocument,
      }),
    /\[precheck\] S1i setup-order/u,
  );
});

const GRAPH_CASE_PREFIX = [
  "project",
  "scenes",
  "entities",
  "relations",
  "scope-registry",
  "scene-scope",
  "foreshadows",
  "foreshadow-links",
  "pins",
  SEED_PIN_PHASE,
  "maintenance-enabled",
];

test("13 の variant の plan: setupOrder の順、seed の pin の段は pins の直後で maintenance の前、variant の timeline と測定点", () => {
  const plans = loadFrozenSetupPlans({
    root: REPO_ROOT,
    stopsAt: SETUP_STOPS.complete,
  });
  assert.deepEqual(
    plans.map((plan) => `${plan.caseId}/${plan.variantId}`),
    GRAPH_EVAL_VARIANTS.map((row) => row.key),
  );
  const names = Object.fromEntries(
    plans.map((plan) => [
      `${plan.caseId}/${plan.variantId}`,
      plannedPhaseNames(plan),
    ]),
  );
  // G-01: S1 の setup の順（seed → graph-input → graph-review →
  // extract-and-review。Scope を Codex の前、Chronicle の承認を最後）。
  assert.deepEqual(names["G-01/v1"], [
    "project",
    "scenes",
    "scope-registry",
    "scene-scope",
    "entities",
    "relations",
    "pins",
    SEED_PIN_PHASE,
    "maintenance-enabled",
    "typed-revisions",
    "qualified-ir",
    "b-seal",
    "chronicle-index",
    "measurement-point",
  ]);
  assert.deepEqual(names["G-02/base"], [
    ...GRAPH_CASE_PREFIX,
    "setup-timeline:g02-r-tamsin",
    "setup-timeline:g02-r-rook",
    "setup-timeline:g02-r-sela",
    "setup-timeline:g02-r-dace",
    "setup-timeline:g02-m-dace-type",
    "setup-timeline:g02-ir",
    "b-seal",
    "chronicle-index",
    "measurement-point",
  ]);
  // G-03: onlyInVariants の Revision は frontier-exceeded にだけある。
  assert.ok(!names["G-03/base"].includes("setup-timeline:g03-r-frontier"));
  assert.ok(
    names["G-03/frontier-exceeded"].includes("setup-timeline:g03-r-frontier"),
  );
  assert.deepEqual(
    plans.find((plan) => plan.variantId === "base" && plan.caseId === "G-03")
      .skippedTimelineSteps,
    [{ id: "g03-r-frontier", kind: "revision", reason: "not-in-variant" }],
  );
  // G-08: IR の後の mutation は、sealed generation に届いてから commit する。
  assert.deepEqual(names["G-08/base-usable"].slice(GRAPH_CASE_PREFIX.length), [
    "setup-timeline:g08-r-cass",
    "setup-timeline:g08-r-juno",
    "setup-timeline:g08-ir",
    "b-seal",
    "chronicle-index",
    "measurement-point",
  ]);
  assert.deepEqual(
    names["G-08/graph-index-unusable"].slice(GRAPH_CASE_PREFIX.length),
    [
      "setup-timeline:g08-r-cass",
      "setup-timeline:g08-r-juno",
      "setup-timeline:g08-ir",
      "b-seal",
      "chronicle-index",
      "setup-timeline:g08-m-juno",
      "measurement-point",
    ],
  );
  assert.deepEqual(
    names["G-08/graph-recovered"].slice(GRAPH_CASE_PREFIX.length),
    [
      "setup-timeline:g08-r-cass",
      "setup-timeline:g08-r-juno",
      "setup-timeline:g08-ir",
      "b-seal",
      "chronicle-index",
      "setup-timeline:g08-m-juno",
      "b-seal:after-mutation",
      "chronicle-index:after-mutation",
      "measurement-point",
    ],
  );
  assert.deepEqual(
    names["G-08/both-indexes-unusable"].slice(GRAPH_CASE_PREFIX.length),
    [
      "setup-timeline:g08-r-cass",
      "setup-timeline:g08-r-juno",
      "setup-timeline:g08-ir",
      "b-seal",
      "chronicle-index",
      "setup-timeline:g08-m-juno",
      "setup-timeline:g08-m-ir-withdraw",
      "measurement-point",
    ],
  );
  for (const plan of plans) {
    const key = `${plan.caseId}/${plan.variantId}`;
    const list = names[key];
    assert.equal(plan.schema, FROZEN_SETUP_PLAN_SCHEMA);
    if (plan.caseId !== "G-01")
      assert.deepEqual(
        list.slice(0, GRAPH_CASE_PREFIX.length),
        GRAPH_CASE_PREFIX,
        key,
      );
    // S1g-A の置き場の判定が plan の並びで通る（SP-N6、SP-N14）。
    assert.equal(
      assertSeedPinPlacement({ phases: list, anchor: plan.seedPin.anchor }).ok,
      true,
      key,
    );
    // 最初の typed Revision の後は tree の順序、registry、Scene Scope を書かない。
    const first = list.findIndex(
      (name, at) =>
        name === "typed-revisions" ||
        plan.steps[at].timelineKind === "revision",
    );
    assert.ok(first > list.indexOf(SEED_PIN_PHASE), key);
    for (const name of list.slice(first))
      assert.ok(
        !["project", "scenes", "scope-registry", "scene-scope"].includes(name),
        `${key} writes ${name} after the first typed Revision`,
      );
    assert.equal(
      plan.measurementPoint,
      plan.caseId === "G-01"
        ? null
        : fixtureOf(plan.caseId).variants.find(
            (row) => row.id === plan.variantId,
          ).measurementPoint,
      key,
    );
  }
});

test("① の部分実行の plan: seed の pin の段で止まり、その後の段はすべて S2 の禁止の集合に入り、前の段は範囲の中", () => {
  const plans = loadFrozenSetupPlans({
    root: REPO_ROOT,
    stopsAt: SETUP_STOPS.seedPin,
  });
  assert.equal(plans.length, 13);
  for (const plan of plans) {
    const key = `${plan.caseId}/${plan.variantId}`;
    const executed = executedPhaseNames(plan);
    assert.equal(executed.at(-1), SEED_PIN_PHASE, key);
    for (const name of executed)
      assert.ok(
        phaseCategories(name).every((category) =>
          R5_CHECK_SCOPE.includes(category),
        ),
        `${key} ${name}`,
      );
    const after = [
      ...plannedPhaseNames(plan).slice(executed.length),
      ...plan.runnerSteps.map((row) => row.phase),
    ];
    assert.ok(after.length > 0);
    for (const name of after)
      assert.ok(
        phaseCategories(name).some((category) =>
          R5_CHECK_FORBIDS.includes(category),
        ),
        `${key} ${name} is not forbidden in ①`,
      );
    assert.equal(assertR5CheckPhases({ plan, phases: executed }).ok, true);
  }
  // 禁止の集合のどの種類の段も、① の記録に現れたら止める。
  const plan = plans.find((row) => row.caseId === "G-02");
  const forbidden = {
    "graph-arm": "graph-arm:sample-0",
    "rir-query": "measure:hybrid-0",
    "evaluation-run": "measurement-workspace",
    diagnostic: "diagnostic:sp-p4",
    trace: "trace:editing",
    "v10-ready-probe": "v10-ready-probe",
    "maintenance-enable": "maintenance-enabled",
    "setup-timeline": "setup-timeline:g02-ir",
    "typed-revision-prepare": "typed-revisions",
    "b-graph-index-build": "b-seal",
    "chronicle-index-build": "chronicle-index",
    "index-state-record": "measurement-point",
  };
  assert.deepEqual(Object.keys(forbidden).sort(), [...R5_CHECK_FORBIDS].sort());
  for (const [category, name] of Object.entries(forbidden)) {
    assert.ok(phaseCategories(name).includes(category), name);
    assert.throws(
      () =>
        assertR5CheckPhases({
          plan,
          phases: [...executedPhaseNames(plan), name],
        }),
      new RegExp(`\\[precheck\\] S1i r5-check.*${category}`, "u"),
    );
  }
  // 範囲の外の段（宣言の段）と、知らない段、seed の pin の手前で止めた記録も止める。
  for (const phases of [
    [...executedPhaseNames(plan), "declaration"],
    [...executedPhaseNames(plan), "reopen-workspace"],
    executedPhaseNames(plan).slice(0, -1),
    [...executedPhaseNames(plan)].reverse(),
  ])
    assert.throws(
      () => assertR5CheckPhases({ plan, phases }),
      /\[precheck\] S1i/u,
    );
  // 完全な setup の plan は ① に使えない。
  const complete = loadFrozenSetupPlans({
    root: REPO_ROOT,
    stopsAt: SETUP_STOPS.complete,
  })[1];
  assert.throws(
    () =>
      assertR5CheckPhases({
        plan: complete,
        phases: executedPhaseNames(complete),
      }),
    /\[precheck\] S1i r5-check/u,
  );
});

test("対応できない step（IR の provider、Relation の型の編集、IR の承認撤回、unusable の状態の保持）は plan に [precheck] の executor として残す", () => {
  const plans = loadFrozenSetupPlans({
    root: REPO_ROOT,
    stopsAt: SETUP_STOPS.complete,
  });
  const prechecks = (plan) =>
    plan.steps
      .filter((step) => step.executor === "precheck")
      .map((step) => [step.phase, step.precheck.code]);
  const byKey = Object.fromEntries(
    plans.map((plan) => [`${plan.caseId}/${plan.variantId}`, prechecks(plan)]),
  );
  assert.deepEqual(byKey["G-01/v1"], [
    ["qualified-ir", "qualified-ir-provider-undecided"],
  ]);
  assert.deepEqual(byKey["G-02/base"], [
    ["setup-timeline:g02-m-dace-type", "relation-type-writer-missing"],
    ["setup-timeline:g02-ir", "qualified-ir-provider-undecided"],
  ]);
  assert.deepEqual(byKey["G-08/both-indexes-unusable"], [
    ["setup-timeline:g08-ir", "qualified-ir-provider-undecided"],
    [
      "setup-timeline:g08-m-ir-withdraw",
      "ir-approval-withdrawal-writer-undecided",
    ],
    ["measurement-point", "index-state-holding-undesigned"],
  ]);
  for (const plan of plans)
    for (const step of plan.steps.filter(
      (row) => row.executor === "precheck",
    )) {
      assert.ok(step.precheck.reason.length > 0);
      assert.ok(step.precheck.options.length >= 2, step.phase);
    }
  // ① の部分実行は、どの [precheck] の step にも届かない。
  for (const plan of loadFrozenSetupPlans({
    root: REPO_ROOT,
    stopsAt: SETUP_STOPS.seedPin,
  }))
    assert.ok(
      plan.steps
        .slice(0, plan.stopIndex + 1)
        .every((step) => step.executor !== "precheck"),
    );
  // 知らない timeline の種類は plan を作らない。
  const g05 = fixtureOf("G-05");
  assert.throws(
    () =>
      frozenSetupPlan({
        caseId: "G-05",
        variantId: "base",
        fixture: {
          ...g05,
          setupTimeline: [...g05.setupTimeline, { kind: "reindex", id: "x" }],
        },
        stopsAt: SETUP_STOPS.complete,
      }),
    /\[precheck\] S1i setup-timeline/u,
  );
  // 知らない mutation の種類も同じ。
  assert.throws(
    () =>
      frozenSetupPlan({
        caseId: "G-05",
        variantId: "base",
        fixture: {
          ...g05,
          mutations: g05.mutations.map((row, at) =>
            at === 0 ? { ...row, kind: "codex-entry-delete" } : row,
          ),
        },
        stopsAt: SETUP_STOPS.complete,
      }),
    /\[precheck\] S1i setup-timeline/u,
  );
});

test("K2/4 の宣言の段: 宣言の 5 run だけに、測定の workspace を開いた後・V-10 の probe と Graph arm の前に置く（setupOrder の外）", () => {
  const plans = loadFrozenSetupPlans({
    root: REPO_ROOT,
    stopsAt: SETUP_STOPS.complete,
  });
  for (const plan of plans) {
    const variant = GRAPH_EVAL_VARIANTS.find(
      (row) => row.caseId === plan.caseId && row.variantId === plan.variantId,
    );
    const runner = plan.runnerSteps.map((row) => row.phase);
    assert.ok(!plannedPhaseNames(plan).includes("declaration"));
    if (variant.declaration) {
      assert.deepEqual(runner, [
        "measurement-workspace",
        "declaration",
        "v10-ready-probe",
        "graph-arm",
      ]);
      assert.equal(
        plan.declaration.sceneId,
        {
          "G-01": "g01-mira",
          "G-02": "g02-tamsin-first",
          "G-07": "g07-pell-dock",
          "G-08": "g08-cass-attic",
        }[plan.caseId],
      );
    } else {
      assert.deepEqual(runner, [
        "measurement-workspace",
        "v10-ready-probe",
        "graph-arm",
      ]);
      assert.equal(plan.declaration, null);
    }
  }
});

test("plan の入力: 論理 ID のまま写し（runtime ID を持たない）、Scope は validator の effectiveScope、harness の選択は記録する", () => {
  const g04 = frozenSetupPlan({
    caseId: "G-04",
    variantId: "base",
    fixture: fixtureOf("G-04"),
    stopsAt: SETUP_STOPS.seedPin,
  });
  const scope = g04.steps.find((step) => step.phase === "scene-scope").input;
  // unknown の marker の Scene は「explicit な Scene Scope」ではないので書かない。
  assert.deepEqual(scope.skipped, [
    {
      sceneId: "g04-rv-unknown",
      marker: "unknown",
      reason: "effective-scope-not-explicit",
    },
  ]);
  const holder = scope.writes.find((row) => row.sceneId === "g04-rv-holder");
  assert.deepEqual(holder.scope.knowledgeHolder, {
    kind: "character",
    entityId: "g04-mott",
  });
  const unresolved = scope.writes.find(
    (row) => row.sceneId === "g04-rv-unresolved",
  );
  assert.deepEqual(unresolved.scope.materialConstraint.worldline, {
    kind: "unresolved",
    reason: "ambiguous",
  });
  // 問いの Scene を含む全 Scene が reading order で並ぶ（S2 が最後）。
  const scenes = g04.steps.find((step) => step.phase === "scenes").input.rows;
  assert.equal(scenes.at(-1).logicalId, "g04-query");
  assert.deepEqual(
    scenes.map((row) => row.readingOrder),
    [...scenes.map((row) => row.readingOrder)].sort((a, b) => a - b),
  );
  // Relation の label は UI と同じ（label = 型。slugify で型に戻る）。
  const g02 = frozenSetupPlan({
    caseId: "G-02",
    variantId: "base",
    fixture: fixtureOf("G-02"),
    stopsAt: SETUP_STOPS.seedPin,
  });
  const slugify = (label) =>
    label.trim().toLowerCase().replace(/\s+/gu, "_").slice(0, 48) || "custom";
  for (const relation of g02.steps.find((step) => step.phase === "relations")
    .input.rows) {
    assert.equal(relation.label, relation.relationType);
    assert.equal(slugify(relation.label), relation.relationType);
  }
  const ids = new Set(g02.harnessChoices.map((row) => row.id));
  for (const id of ["relation-label", "project-title", "phase-resolution-mode"])
    assert.ok(ids.has(id), id);
  const g01 = frozenSetupPlan({
    caseId: "G-01",
    variantId: "v1",
    fixture: fixtureOf("G-01"),
    stopsAt: SETUP_STOPS.seedPin,
    candidateDocument: readCandidateDocument({ root: REPO_ROOT }),
  });
  const g01Choices = new Set(g01.harnessChoices.map((row) => row.id));
  for (const id of [
    "g01-query-title",
    "g01-scope-refs",
    "g01-typed-revision",
    "g01-setup-order",
    "ir-scene-folders",
  ])
    assert.ok(g01Choices.has(id), id);
  // G-01 は S1 の SETUP_DECISIONS の Scope の ref（K2/4 :413、C14 (d)）。
  assert.deepEqual(
    g01.steps.find((step) => step.phase === "scope-registry").input.registry,
    {
      timelineRefs: ["timeline:main"],
      worldlineRefs: ["worldline:prime"],
      narrativeLayerRefs: ["layer:manuscript"],
    },
  );
  const g01Query = g01.steps
    .find((step) => step.phase === "scene-scope")
    .input.writes.find((row) => row.sceneId === "g01-query");
  assert.deepEqual(g01Query.scope.queryIdentity, {
    timeline: { kind: "exact", ref: "timeline:main" },
    worldline: { kind: "exact", ref: "worldline:prime" },
    narrativeLayer: { kind: "exact", ref: "layer:manuscript" },
  });
  assert.deepEqual(
    g01Query.scope.materialConstraint,
    g01Query.scope.queryIdentity,
  );
  // 不正な variant と stopsAt は plan を作らない。
  assert.throws(
    () =>
      frozenSetupPlan({
        caseId: "G-02",
        variantId: "nope",
        fixture: fixtureOf("G-02"),
        stopsAt: SETUP_STOPS.seedPin,
      }),
    /\[precheck\]/u,
  );
  assert.throws(
    () =>
      frozenSetupPlan({
        caseId: "G-02",
        variantId: "base",
        fixture: fixtureOf("G-02"),
        stopsAt: "maintenance-enabled",
      }),
    /\[precheck\]/u,
  );
});

test("IR を持つ Scene を folder に包む: fixture の qualifiedIr の 10 行の Scene ごとに 1 つ、位置はその Scene の読む順の位置（論理 ID と title は harness の値）", () => {
  const plans = loadFrozenSetupPlans({
    root: REPO_ROOT,
    stopsAt: SETUP_STOPS.seedPin,
  });
  const byCase = {};
  for (const plan of plans) {
    const fixture = fixtureOf(plan.caseId);
    const rows = plan.steps.find((step) => step.phase === "scenes").input.rows;
    const wrapped = rows.filter((row) => row.folder !== null);
    const irScenes = [
      ...new Set(fixture.qualifiedIr.map((row) => row.sceneId)),
    ];
    assert.deepEqual(
      wrapped.map((row) => row.logicalId).sort(),
      [...irScenes].sort(),
      plan.variantKey,
    );
    for (const row of wrapped) {
      assert.deepEqual(row.folder, {
        logicalId: `nir1-folder-${row.logicalId}`,
        title: row.title,
      });
      // folder の論理 ID は fixture の Scene や Entity の ID と重ならない。
      assert.ok(
        !rows.some((other) => other.logicalId === row.folder.logicalId),
      );
    }
    // 読む順は変えない（folder は包む Scene の位置に置く）。
    assert.deepEqual(
      rows.map((row) => row.readingOrder),
      [...rows.map((row) => row.readingOrder)].sort((a, b) => a - b),
    );
    // 問いの Scene、宣言の Scene は包まない。
    assert.equal(rows.find((row) => row.query).folder, null);
    if (plan.declaration)
      assert.equal(
        rows.find((row) => row.logicalId === plan.declaration.sceneId).folder,
        null,
      );
    byCase[plan.caseId] = wrapped.map((row) => row.logicalId);
  }
  assert.deepEqual(byCase, {
    "G-01": ["g01-question"],
    "G-02": ["g02-attach"],
    "G-03": ["g03-c5"],
    "G-04": ["g04-control", "g04-lio-landing"],
    "G-05": ["g05-control", "g05-xan-watch"],
    "G-06": ["g06-c6"],
    "G-07": ["g07-probe"],
    "G-08": ["g08-control"],
  });
  assert.equal(
    Object.values(byCase).reduce((sum, list) => sum + list.length, 0),
    10,
  );
  // IR の Scene が fixture の Scene でなければ plan を作らない。
  const g02 = fixtureOf("G-02");
  assert.throws(
    () =>
      frozenSetupPlan({
        caseId: "G-02",
        variantId: "base",
        fixture: {
          ...g02,
          qualifiedIr: [{ ...g02.qualifiedIr[0], sceneId: "g02-query" }],
        },
        stopsAt: SETUP_STOPS.seedPin,
      }),
    /\[precheck\] S1i scenes/u,
  );
});

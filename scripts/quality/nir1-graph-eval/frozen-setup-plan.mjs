// CP-4 S1i: 凍結した G-case の setup の plan（DR-CP4-I-*）。
//
// 凍結した fixture（G-01〜G-08、13 variant）の `measurementBoundary.setupOrder`
// と `setupTimeline` から、setup の driver（frozen-setup-driver.mjs）が再生する段の
// 並びを導く。fixture は読むだけで、凍結の bytes を照合してから宣言を写す（論理 ID
// のまま。runtime ID は setup の受領書が対応付ける）。何も実行しない。
//
//   - setupOrder の対応表: 文を節に分け、節ごとに driver の段（phase）か runner の
//     段に対応させる。文の全体が節の表で過不足なく覆われなければ `[precheck]`
//     （対応できない step を残さない）。G-01 は setupOrder を持たないので、
//     runtimeSetup と候補 §7 の文から導く（S2 の stepOrder.g01 と同じ並び）。
//   - 段を挟む位置: SP/1 の seed の pin の段（G-02〜G-08 は pins の直後で
//     maintenance の前、G-01 は唯一の pin の後で typed Revision の前）と、K2/4 の
//     宣言の段（setupOrder の外。測定の workspace を開いた後、V-10 の probe と
//     Graph arm の前。runner の段）。
//   - 停止位置: ① R5 の照合の run は seed の pin の段で止める（S2 の
//     `r5Gate.exempt` の `r5-seed-pin-check`）。止めた後の段はすべて S2 の禁止の
//     集合に入る（試験で固定）。完全な setup は ⑤ の評価の run 用。
//   - 対応する製品の writer が無い、または決まっていない step（IR の provider、
//     Relation の型の編集、IR の承認撤回、unusable の状態の保持）は plan に
//     `[precheck]` の executor として残し、driver は着いたところで止める。

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { effectiveScope } from "../nir1-graph/contract.mjs";
import { GRAPH_EVAL_VARIANTS } from "./constants.mjs";
import {
  SEED_PIN_PHASE,
  assertFrozenSetupBytes,
  seedPinPlanFromFixture,
} from "./seed-pin-setup.mjs";

export const FROZEN_SETUP_PLAN_SCHEMA = "nir1-cp4-frozen-setup-plan/1";
/** The harness's folder ID of a Scene with a qualifiedIr row (24 件の setup と同じ型). */
export const IR_FOLDER_PREFIX = "nir1-folder-";
export const SETUP_STOPS = Object.freeze({
  seedPin: "seed-pin",
  complete: "complete",
});

/**
 * S2 `observation-prep.v1.json` の `r5Gate.exempt` の `r5-seed-pin-check` の行
 * （`claude/cp4-s2-observation-prep` の 2a748d2d）をそのまま写したもの。
 */
export const R5_CHECK_RUN = "r5-seed-pin-check";
export const R5_CHECK_SCOPE = Object.freeze([
  "setup-through-seed-pin-step",
  "product-db-read",
]);
export const R5_CHECK_FORBIDS = Object.freeze([
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
]);

function fail(code, detail) {
  throw new Error(`[precheck] S1i ${code}: ${detail}`);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

/**
 * The frozen `setupOrder` of G-02〜G-08 (one text in all seven fixtures),
 * clause by clause: `text` + `after` reproduce the whole text. Each clause is
 * done by driver phases, a guard the plan keeps, or the runner.
 */
export const SETUP_ORDER_CLAUSES = Object.freeze(
  [
    {
      id: "project-and-scenes",
      text: "Create the project and every Scene (including S2) in reading order",
      after: "; ",
      owner: "driver",
      phases: ["project", "scenes"],
    },
    {
      id: "codex",
      text: "then Codex entities and relations",
      after: "; ",
      owner: "driver",
      phases: ["entities", "relations"],
    },
    {
      id: "scope",
      text: "then the Scope registry and every explicit Scene Scope",
      after: "; ",
      owner: "driver",
      phases: ["scope-registry", "scene-scope"],
    },
    {
      id: "foreshadows-and-pins",
      text: "then foreshadows, foreshadow Codex links and pins",
      after: ". ",
      owner: "driver",
      phases: ["foreshadows", "foreshadow-links", "pins"],
    },
    {
      id: "maintenance",
      text: "Before the first setupTimeline step, enable maintenance through the real runtime-policy setting (the product default is maintenance_enabled=0; never through SQL or injected state; precondition maintenance-enabled)",
      after: ". ",
      owner: "driver",
      phases: ["maintenance-enabled"],
    },
    {
      id: "setup-timeline",
      text: "Then follow setupTimeline in order: each revision is prepared against its review Scene and receives its declared decision, each mutation uses its normal writer, and the qualified-ir step creates every qualifiedIr through the normal fixture provider/Proposal/child/Decision route with optional story inputs disabled only through real planner settings",
      after: ". ",
      owner: "driver",
      phases: ["setup-timeline"],
    },
    {
      id: "freeze-after-first-revision",
      text: "Do not change tree order, registry or Scene Scope after the first typed revision is prepared",
      after: ". ",
      owner: "driver",
      phases: [],
      guard: "no-tree-registry-scope-write-after-first-typed-revision",
    },
    {
      id: "measurement-point",
      text: "Then wait for the variant measurementPoint",
      after: ", ",
      owner: "driver",
      phases: ["b-seal", "chronicle-index", "measurement-point"],
    },
    {
      id: "preconditions",
      text: "record whether each declared precondition holds",
      after: ", ",
      owner: "runner",
      phases: ["preconditions"],
    },
    {
      id: "compare",
      text: "and compare only the expectations that no unmet precondition blocks",
      after: ".",
      owner: "runner",
      phases: ["compare-expectations"],
    },
  ].map((row) => Object.freeze({ ...row, phases: Object.freeze(row.phases) })),
);

/**
 * G-01 has no `setupOrder`: its setup comes from the fixture's
 * `runtimeSetup` and candidate §7 (`docs/plans/nir1-c-scene-connection-candidate.md`
 * :207-223, quoted verbatim), in S2's `stepOrder.g01` order.
 */
export const G01_SETUP_SOURCES = Object.freeze(
  [
    {
      id: "runtime-setup",
      source: "fixture.measurementBoundary.runtimeSetup",
      text: "Requires normal Scene/Scope/Entity/Relation/pin writers and normal Chronicle provider/Proposal/child/Decision setup.",
      phases: [
        "project",
        "scenes",
        "entities",
        "relations",
        "scope-registry",
        "scene-scope",
        "pins",
        "qualified-ir",
      ],
    },
    {
      id: "explicit-scope",
      source: "candidate §7 :207-209",
      text: "全Sceneは同project、明示Scopeを通常writerで設定し、",
      phases: ["scope-registry", "scene-scope"],
    },
    {
      id: "typed-revision",
      source: "candidate §7 :217-218",
      text: "Option Bの通常prepareで上記Entity/Relationを`g01-review`の明示Scopeに束縛し、",
      phases: [
        "maintenance-enabled",
        "typed-revisions",
        "b-seal",
        "chronicle-index",
        "measurement-point",
      ],
    },
    {
      id: "only-pin",
      source: "candidate §7 :219-220",
      text: "唯一のpinは `g01-mira → g01-mira-entity`。通常pin writerで作る。",
      phases: ["pins"],
    },
    {
      id: "qualified-ir",
      source: "candidate §7 :221-223",
      text: "Chronicleのqualified IRは`g01-question`の1件だけ。通常fixture provider/Proposal/child/Decision経路で",
      phases: ["qualified-ir"],
    },
  ].map((row) => Object.freeze({ ...row, phases: Object.freeze(row.phases) })),
);

/** G-01's design (candidate §7), the source of its setup sentences. */
export const CANDIDATE_DOCUMENT_PATH =
  "docs/plans/nir1-c-scene-connection-candidate.md";

/** The candidate document's bytes as read from the repository (S1j P3). */
export function readCandidateDocument({ root }) {
  const bytes = readFileSync(path.join(root, CANDIDATE_DOCUMENT_PATH));
  return Object.freeze({
    path: CANDIDATE_DOCUMENT_PATH,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    text: bytes.toString("utf8"),
  });
}

/**
 * The correspondence of one fixture's setup text to the driver's phases.
 * `[precheck]` when the text is not exactly covered (a step the driver
 * cannot map).
 */
export function setupOrderCorrespondence({
  caseId,
  fixture,
  candidateDocument,
}) {
  if (caseId === "G-01") {
    if (
      fixture?.measurementBoundary?.runtimeSetup !== G01_SETUP_SOURCES[0].text
    )
      fail(
        "setup-order",
        "G-01's runtimeSetup is not the text the driver maps",
      );
    if (fixture.measurementBoundary.setupOrder !== undefined)
      fail("setup-order", "G-01 declares a setupOrder the driver does not map");
    // S1j P3: candidate §7 is read from its file and each quoted sentence is
    // matched character by character; the document's sha256 is kept.
    if (
      candidateDocument?.path !== CANDIDATE_DOCUMENT_PATH ||
      typeof candidateDocument.text !== "string" ||
      typeof candidateDocument.sha256 !== "string"
    )
      fail(
        "setup-order",
        `G-01's candidate §7 is not read from ${CANDIDATE_DOCUMENT_PATH}`,
      );
    return G01_SETUP_SOURCES.map((row) => {
      const fromCandidate = row.source.startsWith("candidate");
      if (fromCandidate && !candidateDocument.text.includes(row.text))
        fail(
          "setup-order",
          `G-01's ${row.id} (${row.source}) is not in ${CANDIDATE_DOCUMENT_PATH}`,
        );
      return {
        clauseId: row.id,
        source: row.source,
        text: row.text,
        after: "",
        owner: "driver",
        phases: [...row.phases],
        ...(fromCandidate
          ? {
              documentPath: CANDIDATE_DOCUMENT_PATH,
              documentSha256: candidateDocument.sha256,
            }
          : {}),
      };
    });
  }
  const text = fixture?.measurementBoundary?.setupOrder;
  const expected = SETUP_ORDER_CLAUSES.map((row) => row.text + row.after).join(
    "",
  );
  if (text !== expected) {
    const at =
      typeof text === "string"
        ? [...expected].findIndex((char, index) => text[index] !== char)
        : 0;
    fail(
      "setup-order",
      `${caseId}: the setupOrder is not covered by the driver's clauses (first difference at character ${at}${typeof text === "string" ? `: ${JSON.stringify(text.slice(Math.max(0, at - 20), at + 40))}` : ""})`,
    );
  }
  return SETUP_ORDER_CLAUSES.map((row) => ({
    clauseId: row.id,
    source: "fixture.measurementBoundary.setupOrder",
    text: row.text,
    after: row.after,
    owner: row.owner,
    phases: [...row.phases],
    ...(row.guard ? { guard: row.guard } : {}),
  }));
}

/** Phase name → the S2 categories (scope or forbids) it belongs to. */
const CATEGORY_RULES = Object.freeze([
  [
    /^(project|scenes|entities|relations|scope-registry|scene-scope|foreshadows|foreshadow-links|pins|seed-pin)$/u,
    ["setup-through-seed-pin-step"],
  ],
  [/^(setup-read-back|cold-database)$/u, ["product-db-read"]],
  [/^maintenance-enabled$/u, ["maintenance-enable"]],
  [/^setup-timeline:.+$/u, ["setup-timeline"]],
  [/^typed-revisions$/u, ["typed-revision-prepare"]],
  [/^qualified-ir$/u, ["setup-timeline"]],
  [/^b-seal(:.+)?$/u, ["b-graph-index-build"]],
  [/^chronicle-index(:.+)?$/u, ["chronicle-index-build"]],
  [/^(measurement-point|index-metadata(:.+)?)$/u, ["index-state-record"]],
  [/^(measurement-workspace|declaration)$/u, ["evaluation-run"]],
  [/^v10-ready-probe$/u, ["v10-ready-probe"]],
  [/^graph-arm(:.+)?$/u, ["graph-arm"]],
  [/^measure(:.+)?$/u, ["rir-query"]],
  [/^diagnostic(:.+)?$/u, ["diagnostic"]],
  [/^trace(:.+)?$/u, ["trace"]],
]);

/**
 * The categories of one phase name (a revision step of setupTimeline is also
 * a typed Revision prepare). `[precheck]` for a phase the driver does not know.
 */
export function phaseCategories(name, { timelineKind = null } = {}) {
  const rule = CATEGORY_RULES.find(([pattern]) => pattern.test(String(name)));
  if (!rule) fail("phase", `unknown phase ${String(name)}`);
  return timelineKind === "revision"
    ? [...rule[1], "typed-revision-prepare"]
    : [...rule[1]];
}

/** The harness choices the fixture does not declare (recorded, never tuned). */
const HARNESS_CHOICES = Object.freeze({
  "project-title": {
    value: "NIR-1 <caseId>/<variantId>",
    reason:
      "fixture は project の title を宣言しない。R／IR の query は問いの Scene の本文を読み、project の title を読まない",
  },
  "phase-resolution-mode": {
    value: "reading",
    reason:
      "dev の setup-driver と P harness と同じ。fixture は story time を設定しないので、前後は reading 順で決まる（README の secret／reveal 行）",
  },
  "relation-label": {
    value: "label = relation type",
    reason:
      "製品の relation.create は空でない label を要る。UI（CodexTypedRelationsSection）は入力の label から slugifyRelationType で型を作るので、型をそのまま label にすると UI と同じ行になる（fixture の型はどれも slugify で同じ文字列に戻る）",
  },
  "scene-runtime-ids": {
    value: "harness が UUID を発行して writer に渡し、受領書で対応付ける",
    reason:
      "README :36（runtime ID は setup receipt で対応付け、Gold には書かない）。S1 は G-01 の Scene の runtime ID を論理 ID と同じにしたが、K2/4 はそれを求めず（宣言は runtime の Scene ID に束縛され、addendum の Scene は論理 ID）、R／IR の score は本文から作り、G-01 の R と R+IR の期待値は 1 件なので ID の順に依らない（README :56）",
  },
  "ir-scene-folders": {
    value:
      "qualifiedIr を持つ Scene ごとに folder を 1 つ作る（論理 ID nir1-folder-<Scene の論理 ID>、title は包む Scene の title、位置はその Scene の読む順の位置、Scene は folder の中の a0）",
    reason:
      "fixture に folder は無く、folder の論理 ID と title は fixture の値ではない harness の値。製品の Chronicle の抽出は folder 単位で動き、決定論の provider は citation window が 1 つであることを要る（Scene 1 つだけの folder）。24 件の setup（scripts/quality/setup-nir1-retrieval.mjs の folder の作成）と S1（g01-question を nir1-folder-g01-question に置いた）と同じ型。tree は最初の typed Revision の前に作り終える。folder の title が Raw に効かないことは確かめていない",
  },
  "g01-query-title": {
    value: "Current query scene",
    reason:
      "G-01 の query は title を宣言しない。P harness（nir1-retrieval/renderer.ts）と同じ値。R／IR の query は問いの Scene の本文を読み、その title を読まない",
  },
  "g01-scope-refs": {
    value:
      "timeline:main / worldline:prime / layer:manuscript（S1 の SETUP_DECISIONS。holder と audience は reader）",
    reason:
      "K2/4 :413 は R と R+IR の setup に S1 の setup の選択（C14 (d) の SETUP_DECISIONS。Scope の ref、query の Scene の title など）を使うとする。値は S1 の報告 §2.2 の写し（registry editor の placeholder）。候補 §7 :207-209 は ref の文字列を宣言しない",
  },
  "g01-setup-order": {
    value:
      "project → Scene（g01-question は folder の中）→ registry と明示 A1 → Entity と Relation → 唯一の pin → seed の pin → maintenance → typed Revision → Chronicle の IR（承認を最後）→ B の seal",
    reason:
      "S1 の setup の順（session の seed → graph-input → graph-review → extract-and-review。S1 の SETUP_DECISIONS「書き込みの順序を固定し、Chronicle の承認を最後に置く」）に揃えた。唯一の pin と seed の pin を typed Revision の前に置くのは SP/1（確認済み）の置き場",
  },
  "g01-typed-revision": {
    value:
      "論理 ID g01-typed-revision（review Scene g01-review、Entity g01-orin と g01-mira-entity、Relation g01-handover、approved）",
    reason:
      "候補 §7 :217-218 の typed Revision を 1 件に写した（ID は harness の名前）",
  },
});

function choices(ids) {
  return ids.map((id) => ({ id, ...HARNESS_CHOICES[id] }));
}

const nonBlank = (value) =>
  typeof value === "string" && value.trim().length > 0;

/** Precheck descriptors of the steps no normal writer covers yet. */
const STEP_PRECHECKS = Object.freeze({
  "qualified-ir": {
    code: "qualified-ir-provider-undecided",
    reason:
      "fixture は qualifiedIr を「通常の fixture provider／Proposal／child／Decision の経路」で作るとするが、製品 Main の決定論の Journey provider（electron/main/productJourneyNir1Ai.ts）は nir1-retrieval の 24 件の corpus の本文にしか答えない。G-case の本文に答える対応表の置き場所は未決（README :227「決定論 provider の対応表の置き場所を決める」、K2/4 C14 (c)）",
    options: [
      "(A) setup 専用の Main で Journey provider の対応表だけを G-case の qualifiedIr に差し替える（K2/4 :352 は宣言の段以外の setup に許す。対応表の置き場所と review を integrator が決める）",
      "(B) 製品の Journey provider に G-case の対応表を足す（製品の変更。別の lane と承認）",
      "(C) 決めるまで完全な setup を作らない（⑤ は進まない。① は影響を受けない）",
    ],
  },
  "relation-type-writer-missing": {
    code: "relation-type-writer-missing",
    reason:
      "codex_mutate の Relation の操作は relation.create と relation.delete だけで、承認後の Relation の型を同じ行のまま変える通常の writer が無い（UI も型の編集を持たない）",
    options: [
      "(A) 型を変える writer が無いことを refused-at-setup として記録する（README 解釈 2「通常 writer が承認済み Relation の型編集を拒否したら refused-at-setup」を、writer が無い場合に読み替えてよいかを integrator が決める）",
      "(B) relation.delete と relation.create で別の行を作る（Relation の ID が変わり、g02-dace-link の論理 ID の対応が変わる。fixture の意図と違いうる）",
      "(C) 製品に型の編集の writer を足す（製品の変更）",
    ],
  },
  "ir-approval-withdrawal-writer-undecided": {
    code: "ir-approval-withdrawal-writer-undecided",
    reason:
      "IR の承認撤回の通常の writer（Decision の経路のどれを使うか）を S1i は特定していない。撤回する IR は qualified-ir の段が作るので、その段の決定にも依存する",
    options: [
      "(A) qualified-ir の provider を決めた後に、撤回の writer（Decision の経路）を integrator が指定する",
      "(B) 決めるまで G-08 の chronicle-index-unusable と both-indexes-unusable の完全な setup を作らない",
    ],
  },
  "index-state-holding-undesigned": {
    code: "index-state-holding-undesigned",
    reason:
      "unusable の variant は mutation の commit の後、再 build の前に測る（index-state-holding）。maintenance を有効にしたままその状態を通常の lifecycle の制御だけで保つ方法（setup の session の閉じ方と、測定の process の起動の順）を S1i は決めていない",
    options: [
      "(A) mutation の commit の直後に setup の session を閉じて cold DB を取り、測定の process で probe が宣言どおりの状態を示す間に測る（runner の側の設計を integrator が決める）",
      "(B) 保てなければ blocked:index-state-holding と記録する（README の規則。setup は変えない）",
    ],
  },
});

function timelineStep(fixture, step, indexes) {
  if (step?.kind === "qualified-ir")
    return {
      timelineKind: "qualified-ir",
      executor: "precheck",
      precheck: STEP_PRECHECKS["qualified-ir"],
      input: { id: step.id, rows: fixture.qualifiedIr ?? [] },
    };
  if (step?.kind === "revision") {
    const revision = indexes.revisions.get(step.id);
    if (!revision)
      fail("setup-timeline", `revision ${step.id} is not in revisions`);
    if (!["approved", "rejected", "none"].includes(revision.decision))
      fail(
        "setup-timeline",
        `revision ${step.id} declares decision ${String(revision.decision)}`,
      );
    return {
      timelineKind: "revision",
      executor: "typed-revision",
      input: {
        id: revision.id,
        reviewSceneId: revision.reviewSceneId,
        entityIds: [...revision.entityIds],
        relationIds: [...revision.relationIds],
        decision: revision.decision,
      },
    };
  }
  if (step?.kind === "mutation") {
    const mutation = indexes.mutations.get(step.id);
    if (!mutation)
      fail("setup-timeline", `mutation ${step.id} is not in mutations`);
    if (mutation.kind === "codex-entry-summary-edit")
      return {
        timelineKind: "mutation",
        executor: "codex-entry-summary-edit",
        input: {
          id: mutation.id,
          entityId: mutation.entityId,
          from: mutation.from,
          to: mutation.to,
        },
      };
    if (mutation.kind === "codex-relation-type-edit")
      return {
        timelineKind: "mutation",
        executor: "precheck",
        precheck: STEP_PRECHECKS["relation-type-writer-missing"],
        input: { ...mutation },
      };
    if (mutation.kind === "ir-approval-withdrawal")
      return {
        timelineKind: "mutation",
        executor: "precheck",
        precheck: STEP_PRECHECKS["ir-approval-withdrawal-writer-undecided"],
        input: { ...mutation },
      };
    fail(
      "setup-timeline",
      `mutation ${step.id} has kind ${String(mutation.kind)} that no normal writer maps`,
    );
  }
  fail("setup-timeline", `step kind ${String(step?.kind)} is not mapped`);
}

const appliesTo = (item, variantId) =>
  !item?.onlyInVariants || item.onlyInVariants.includes(variantId);

/** A Scope as the writer takes it, the holder and audience still logical. */
function scopeInput(scope) {
  const principal = (value) =>
    value?.kind === "character"
      ? { kind: "character", entityId: value.ref }
      : { kind: "reader" };
  return {
    queryIdentity: scope.queryIdentity,
    materialConstraint: scope.materialConstraint,
    knowledgeHolder: principal(scope.knowledgeHolder),
    audience: principal(scope.audience),
  };
}

const G01_SCOPE = Object.freeze({
  registry: {
    timelineRefs: ["timeline:main"],
    worldlineRefs: ["worldline:prime"],
    narrativeLayerRefs: ["layer:manuscript"],
  },
  default: {
    marker: "explicit",
    queryIdentity: {
      timeline: { kind: "exact", ref: "timeline:main" },
      worldline: { kind: "exact", ref: "worldline:prime" },
      narrativeLayer: { kind: "exact", ref: "layer:manuscript" },
    },
    materialConstraint: {
      timeline: { kind: "exact", ref: "timeline:main" },
      worldline: { kind: "exact", ref: "worldline:prime" },
      narrativeLayer: { kind: "exact", ref: "layer:manuscript" },
    },
    knowledgeHolder: { kind: "reader" },
    audience: { kind: "reader" },
  },
  overrides: {},
});

function sceneRowsOf(caseId, fixture) {
  const rows = [
    ...(fixture.scenes ?? []).map((scene) => ({
      logicalId: scene.id,
      title: scene.title,
      body: scene.body,
      readingOrder: scene.readingOrder,
      query: false,
    })),
    {
      logicalId: fixture.query?.sceneId,
      title:
        caseId === "G-01"
          ? HARNESS_CHOICES["g01-query-title"].value
          : fixture.query?.title,
      body: fixture.query?.body,
      readingOrder: fixture.query?.readingOrder,
      query: true,
    },
  ];
  for (const row of rows)
    if (
      !nonBlank(row.logicalId) ||
      !nonBlank(row.title) ||
      !nonBlank(row.body) ||
      !Number.isInteger(row.readingOrder)
    )
      fail("scenes", `${caseId}: Scene ${String(row.logicalId)} is incomplete`);
  if (new Set(rows.map((row) => row.readingOrder)).size !== rows.length)
    fail("scenes", `${caseId}: reading orders are not distinct`);
  if (new Set(rows.map((row) => row.logicalId)).size !== rows.length)
    fail("scenes", `${caseId}: Scene IDs are not distinct`);
  // The Chronicle extraction runs per folder with one citation window: each
  // Scene with a qualifiedIr row gets its own folder (harness values).
  const irScenes = new Set(
    (fixture.qualifiedIr ?? []).map((row) => row?.sceneId),
  );
  for (const sceneId of irScenes)
    if (!rows.some((row) => row.logicalId === sceneId && !row.query))
      fail(
        "scenes",
        `${caseId}: the qualifiedIr Scene ${String(sceneId)} is not a fixture Scene`,
      );
  const folderOf = (row) =>
    irScenes.has(row.logicalId)
      ? { logicalId: `${IR_FOLDER_PREFIX}${row.logicalId}`, title: row.title }
      : null;
  const folders = rows.filter(folderOf).map((row) => folderOf(row).logicalId);
  if (folders.some((id) => rows.some((row) => row.logicalId === id)))
    fail("scenes", `${caseId}: a folder ID is a Scene ID`);
  // S2 is not always last: G-07 reads Scenes after S2 (reading order 120).
  return [...rows]
    .sort((a, b) => a.readingOrder - b.readingOrder)
    .map((row) => ({ ...row, folder: folderOf(row) }));
}

function entityRowsOf(caseId, fixture) {
  const source =
    caseId === "G-01"
      ? [fixture.entitySeed, fixture.targetEntity]
      : (fixture.entities ?? []);
  return source.map((entity) => {
    if (
      !nonBlank(entity?.id) ||
      !nonBlank(entity.kind) ||
      !nonBlank(entity.label)
    )
      fail("entities", `${caseId}: Entity ${String(entity?.id)} is incomplete`);
    return {
      logicalId: entity.id,
      type: entity.kind,
      name: entity.label,
      summary: entity.summary ?? "",
    };
  });
}

function relationRowsOf(caseId, fixture) {
  const source =
    caseId === "G-01" ? [fixture.relation] : (fixture.relations ?? []);
  return source.map((relation) => {
    if (
      !nonBlank(relation?.id) ||
      !nonBlank(relation.type) ||
      !["directed", "symmetric"].includes(relation.direction)
    )
      fail(
        "relations",
        `${caseId}: Relation ${String(relation?.id)} is incomplete`,
      );
    return {
      logicalId: relation.id,
      fromEntityId: relation.fromEntityId,
      toEntityId: relation.toEntityId,
      relationType: relation.type,
      label: relation.type,
      directionality: relation.direction,
    };
  });
}

function sceneScopeInput(caseId, fixture, scenes) {
  const scoped = caseId === "G-01" ? { ...fixture, scope: G01_SCOPE } : fixture;
  const writes = [];
  const skipped = [];
  for (const scene of scenes) {
    const scope = effectiveScope(scoped, scene.logicalId);
    if (scope?.marker === "explicit")
      writes.push({ sceneId: scene.logicalId, scope: scopeInput(scope) });
    else
      skipped.push({
        sceneId: scene.logicalId,
        marker: String(scope?.marker),
        reason: "effective-scope-not-explicit",
      });
  }
  return { registry: scoped.scope.registry, writes, skipped };
}

function declarationOf(caseId, fixture, variant) {
  if (caseId === "G-01")
    return { sceneId: fixture.expectations?.graphPath?.sceneId ?? null };
  const cb4 = (variant.preconditions ?? []).find(
    (row) => row.id === "cb4-inputs",
  );
  return cb4 ? { sceneId: cb4.sceneId } : null;
}

/**
 * The plan of one variant. `stopsAt` is `seed-pin` (① the R5 check run:
 * the setup up to the seed pin step and its SP-P2 record) or `complete`
 * (⑤ the evaluation run's setup).
 */
export function frozenSetupPlan({
  caseId,
  variantId,
  fixture,
  stopsAt,
  candidateDocument = null,
}) {
  if (!Object.values(SETUP_STOPS).includes(stopsAt))
    fail(
      "stop",
      `stopsAt is ${Object.values(SETUP_STOPS).join(" or ")}, not ${String(stopsAt)}`,
    );
  const catalog = GRAPH_EVAL_VARIANTS.find(
    (row) => row.caseId === caseId && row.variantId === variantId,
  );
  if (!catalog) fail("variant", `${caseId}/${variantId} is not a CP-4 variant`);
  const g01 = caseId === "G-01";
  const variant = g01
    ? { id: "v1", measurementPoint: null, indexState: null, preconditions: [] }
    : (fixture.variants ?? []).find((row) => row.id === variantId);
  if (!variant) fail("variant", `${caseId} has no variant ${variantId}`);
  const correspondence = setupOrderCorrespondence({
    caseId,
    fixture,
    candidateDocument,
  });
  const seedPin = seedPinPlanFromFixture({ caseId, fixture }).find(
    (row) => row.variantId === variantId,
  );
  const scenes = sceneRowsOf(caseId, fixture);
  const steps = [];
  const add = (phase, input, extra = {}) =>
    steps.push({
      phase,
      session: "author",
      executor: extra.executor ?? phase,
      ...extra,
      input,
    });
  add("project", {
    title: `NIR-1 ${caseId}/${variantId}`,
    language: fixture.language,
    phaseResolutionMode: "reading",
  });
  add("scenes", { rows: scenes });
  const scope = sceneScopeInput(caseId, fixture, scenes);
  const codex = () => {
    add("entities", { rows: entityRowsOf(caseId, fixture) });
    add("relations", { rows: relationRowsOf(caseId, fixture) });
  };
  const scopeSteps = () => {
    add("scope-registry", { registry: scope.registry });
    add("scene-scope", { writes: scope.writes, skipped: scope.skipped });
  };
  // G-02〜G-08: setupOrder（Codex の後に Scope）。G-01: S1 の順（Scope の後に
  // Codex。harnessChoices の g01-setup-order）。
  if (g01) {
    scopeSteps();
    codex();
  } else {
    codex();
    scopeSteps();
  }
  if (!g01) {
    add("foreshadows", {
      rows: (fixture.foreshadows ?? []).map((row) => ({
        logicalId: row.id,
        title: row.title,
        secret: row.secret === true,
        payoffSceneId: row.payoffSceneId ?? null,
        payoffConfirmed: row.payoffConfirmed === true,
        abandoned: row.abandoned === true,
      })),
    });
    add("foreshadow-links", {
      rows: (fixture.foreshadows ?? []).flatMap((row) =>
        (row.linkedEntityIds ?? []).map((entityId) => ({
          foreshadowId: row.id,
          entityId,
        })),
      ),
    });
  }
  add("pins", {
    rows: (fixture.pins ?? []).map((pin) => ({
      sceneId: pin.sceneId,
      entityId: pin.entryId ?? pin.entityId,
    })),
  });
  add(SEED_PIN_PHASE, { ...seedPin });
  add("maintenance-enabled", { setting: "runtime-policy" });
  const skippedTimelineSteps = [];
  if (g01) {
    add(
      "typed-revisions",
      {
        rows: [
          {
            id: "g01-typed-revision",
            reviewSceneId: "g01-review",
            entityIds: [fixture.entitySeed.id, fixture.targetEntity.id],
            relationIds: [fixture.relation.id],
            decision: "approved",
          },
        ],
      },
      { executor: "typed-revision" },
    );
    add(
      "qualified-ir",
      { id: "g01-ir", rows: fixture.qualifiedIr ?? [] },
      { executor: "precheck", precheck: STEP_PRECHECKS["qualified-ir"] },
    );
    add("b-seal", {}, { session: "seal" });
    add("chronicle-index", {}, { session: "seal" });
  } else {
    const indexes = {
      revisions: new Map((fixture.revisions ?? []).map((row) => [row.id, row])),
      mutations: new Map((fixture.mutations ?? []).map((row) => [row.id, row])),
    };
    const timeline = [];
    for (const step of fixture.setupTimeline ?? []) {
      const item =
        step?.kind === "revision"
          ? indexes.revisions.get(step.id)
          : step?.kind === "mutation"
            ? indexes.mutations.get(step.id)
            : null;
      if (item && !appliesTo(item, variantId)) {
        skippedTimelineSteps.push({
          id: step.id,
          kind: step.kind,
          reason: "not-in-variant",
        });
        continue;
      }
      timeline.push({ step, mapped: timelineStep(fixture, step, indexes) });
    }
    // README :39: G-08 puts mutations after the IR to measure the unusable
    // state; the variant reaches its sealed generation before they commit.
    const irAt = timeline.findIndex((row) => row.step.kind === "qualified-ir");
    const afterIr = irAt >= 0 ? timeline.slice(irAt + 1) : [];
    const sealBefore =
      afterIr.length > 0 &&
      afterIr.every((row) => row.step.kind === "mutation");
    const sealAt = sealBefore ? irAt + 1 : timeline.length;
    timeline.forEach((row, at) => {
      if (at === sealAt) {
        add("b-seal", {}, { session: "seal" });
        add("chronicle-index", {}, { session: "seal" });
      }
      add(`setup-timeline:${row.step.id}`, row.mapped.input, {
        session: at >= sealAt ? "seal" : "author",
        timelineKind: row.mapped.timelineKind,
        executor: row.mapped.executor,
        ...(row.mapped.precheck ? { precheck: row.mapped.precheck } : {}),
      });
    });
    if (sealAt === timeline.length) {
      add("b-seal", {}, { session: "seal" });
      add("chronicle-index", {}, { session: "seal" });
    } else if (variant.measurementPoint === "after-maintenance-current") {
      add("b-seal:after-mutation", {}, { session: "seal", executor: "b-seal" });
      add(
        "chronicle-index:after-mutation",
        {},
        { session: "seal", executor: "chronicle-index" },
      );
    }
  }
  const holding =
    typeof variant.measurementPoint === "string" &&
    variant.measurementPoint.startsWith("while-");
  add(
    "measurement-point",
    {
      measurementPoint: variant.measurementPoint ?? null,
      indexState: variant.indexState ?? null,
    },
    holding
      ? {
          session: "seal",
          executor: "precheck",
          precheck: STEP_PRECHECKS["index-state-holding-undesigned"],
        }
      : { session: "seal" },
  );
  for (const step of steps)
    step.categories = phaseCategories(step.phase, {
      timelineKind: step.timelineKind ?? null,
    });
  const stopIndex =
    stopsAt === SETUP_STOPS.seedPin
      ? steps.findIndex((step) => step.phase === SEED_PIN_PHASE)
      : steps.length - 1;
  const declaration = catalog.declaration
    ? declarationOf(caseId, fixture, variant)
    : null;
  if (catalog.declaration && !nonBlank(declaration?.sceneId))
    fail("declaration", `${caseId}/${variantId} names no declaration Scene`);
  if (!catalog.declaration && declarationOf(caseId, fixture, variant) !== null)
    fail(
      "declaration",
      `${caseId}/${variantId} has an added Scene the catalog does not declare`,
    );
  const runnerSteps = [
    "measurement-workspace",
    ...(declaration ? ["declaration"] : []),
    "v10-ready-probe",
    "graph-arm",
  ].map((phase) => ({
    phase,
    session: "measurement",
    owner: "runner",
    categories: phaseCategories(phase),
  }));
  return deepFreeze({
    schema: FROZEN_SETUP_PLAN_SCHEMA,
    caseId,
    variantId,
    variantKey: `${caseId}/${variantId}`,
    fixturePath: catalog.fixturePath,
    fixtureSha256: catalog.fixtureSha256,
    fixtureId: fixture.fixtureId ?? null,
    stopsAt,
    run: stopsAt === SETUP_STOPS.seedPin ? R5_CHECK_RUN : "evaluation-setup",
    language: fixture.language,
    querySceneId: fixture.query.sceneId,
    measurementPoint: variant.measurementPoint ?? null,
    indexState: variant.indexState ?? null,
    correspondence,
    steps,
    stopIndex,
    seedPin,
    declaration,
    runnerSteps,
    skippedTimelineSteps,
    harnessChoices: choices([
      "project-title",
      "phase-resolution-mode",
      "relation-label",
      "scene-runtime-ids",
      "ir-scene-folders",
      ...(g01
        ? [
            "g01-query-title",
            "g01-scope-refs",
            "g01-setup-order",
            "g01-typed-revision",
          ]
        : []),
    ]),
  });
}

/** Every planned phase name, in order. */
export function plannedPhaseNames(plan) {
  return plan.steps.map((step) => step.phase);
}

/** The phase names the plan executes (through `stopIndex`). */
export function executedPhaseNames(plan) {
  return plan.steps.slice(0, plan.stopIndex + 1).map((step) => step.phase);
}

/**
 * The 13 variants' plans from the frozen fixtures, after the frozen bytes are
 * checked (SP-N8). Reads the declarations only; nothing runs.
 */
export function loadFrozenSetupPlans({ root, stopsAt }) {
  assertFrozenSetupBytes({ root });
  const candidateDocument = readCandidateDocument({ root });
  const fixtures = new Map();
  return deepFreeze(
    GRAPH_EVAL_VARIANTS.map((variant) => {
      if (!fixtures.has(variant.fixturePath))
        fixtures.set(
          variant.fixturePath,
          JSON.parse(
            readFileSync(path.join(root, variant.fixturePath), "utf8"),
          ),
        );
      return frozenSetupPlan({
        caseId: variant.caseId,
        variantId: variant.variantId,
        fixture: fixtures.get(variant.fixturePath),
        stopsAt,
        candidateDocument,
      });
    }),
  );
}

/**
 * ① (the R5 check run): the recorded phases are exactly the plan's phases
 * through the seed pin step, every one inside S2's scope, none in its
 * forbidden set. `[precheck]` otherwise.
 */
export function assertR5CheckPhases({ plan, phases }) {
  if (plan?.stopsAt !== SETUP_STOPS.seedPin || plan.run !== R5_CHECK_RUN)
    fail("r5-check", `${plan?.variantKey}: the plan is not ${R5_CHECK_RUN}`);
  const names = Array.isArray(phases) ? phases.map(String) : [];
  for (const name of names) {
    const categories = phaseCategories(name);
    const forbidden = categories.filter((category) =>
      R5_CHECK_FORBIDS.includes(category),
    );
    if (forbidden.length > 0)
      fail(
        "r5-check",
        `${plan.variantKey}: ${name} is forbidden in ${R5_CHECK_RUN} (${forbidden.join(", ")})`,
      );
    if (!categories.every((category) => R5_CHECK_SCOPE.includes(category)))
      fail(
        "r5-check",
        `${plan.variantKey}: ${name} is outside the scope of ${R5_CHECK_RUN}`,
      );
  }
  const expected = executedPhaseNames(plan);
  if (JSON.stringify(names) !== JSON.stringify(expected))
    fail(
      "r5-check",
      `${plan.variantKey}: the recorded phases ${names.join(",")} are not the plan's ${expected.join(",")}`,
    );
  return { ok: true, phases: names };
}

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
//   - S1j-2（DR-CP4-L-*、integrator の決定 B1〜B4）: 完全な setup の段の
//     executor と session。qualified-ir は setup 専用の Main の session（`ir`）、
//     G-02 の型の編集は relation.delete と同じ runtime ID での relation.create、
//     G-08 の IR の承認撤回は deferred の Decision、unusable の variant の状態は
//     session の分け方と seam の有無で保つ（`hold`、`reseal`）。測定の側の仕様
//     （one-shot など）は plan の `measurementSpec` に書き、runner への配線は S5。

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { effectiveScope } from "../nir1-graph/contract.mjs";
import { classifyGraphFixturePath } from "../nir1-retrieval/contract.mjs";
import { FROZEN_MATERIAL_SHA256, GRAPH_EVAL_VARIANTS } from "./constants.mjs";
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

/**
 * S1j-2: the sessions of a complete setup (DR-CP4-L-4). Each launches a fresh
 * Electron on the same workspace, in the plan's order: `main` names the Main
 * (`setup-ir` is the setup-only Main of setup-main-build.mjs, launched with
 * the deterministic Journey provider's env), `seam` whether the B-ROUTE
 * journey seam (the gated B build) is open. ① runs the author session only.
 */
export const SETUP_SESSIONS = Object.freeze({
  author: Object.freeze({ main: "product", seam: false }),
  ir: Object.freeze({ main: "setup-ir", seam: false }),
  seal: Object.freeze({ main: "product", seam: true }),
  hold: Object.freeze({ main: "product", seam: false }),
  reseal: Object.freeze({ main: "product", seam: true }),
});

/**
 * S1j-2 (B4): how the measurement process of a variant must run so that the
 * index state the setup left holds at the query (the runner's wiring is S5's;
 * recorded in the plan and the receipt before observation).
 */
const MEASUREMENT_SPECS = Object.freeze({
  "after-maintenance-current": {
    kind: "steady-state",
    maintenanceSeam: "as the runner's procedure (K6/2, K6/4)",
    warmUp: true,
    queriesPerProcess: "as the runner's procedure",
    freshColdCopyPerProcess: false,
  },
  "while-graph-index-unusable": {
    kind: "graph-held-unusable",
    maintenanceSeam: false,
    warmUp: true,
    queriesPerProcess: "as the runner's procedure",
    freshColdCopyPerProcess: false,
    note: "B は seam の無い process では作り直されない。C は query の経路で作り直される（setup の hold の session が作り直した後の状態）",
  },
  "while-chronicle-index-unusable": {
    kind: "one-shot",
    maintenanceSeam: false,
    warmUp: false,
    queriesPerProcess: 1,
    freshColdCopyPerProcess: true,
    note: "最初の query が C を作り直すので、cold DB の新しい byte copy ごとに process を起動し、query は 1 回だけ（warm-up なし）。K6/4 の warm-up の手順からの逸脱かは integrator とユーザーの確認点",
  },
  "while-both-indexes-unusable": {
    kind: "one-shot",
    maintenanceSeam: false,
    warmUp: false,
    queriesPerProcess: 1,
    freshColdCopyPerProcess: true,
    note: "chronicle-index-unusable と同じ one-shot。seam を開かないので B も作り直されない",
  },
});

export function measurementSpecOf(measurementPoint) {
  const spec =
    MEASUREMENT_SPECS[measurementPoint ?? "after-maintenance-current"];
  if (!spec)
    fail(
      "measurement-point",
      `no measurement spec for ${String(measurementPoint)}`,
    );
  return { measurementPoint: measurementPoint ?? null, ...spec };
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
  "setup-ir-main": {
    value:
      "qualified-ir は setup 専用の Main（dist-electron/main-setup-ir.cjs）の session だけで作る。製品の Main と同じ build の command で、productJourneyNir1Ai.ts の corpus の import だけを「24 件の corpus＋fixture の qualifiedIr の行」の表に向ける。env は GRIMODEX_PRODUCT_JOURNEY_FAKE_AI=deterministic-v1。AI 設定は 24 件の setup と同じ（provider ollama、model product-journey-model、endpoint 127.0.0.1:11434。決定論の provider が HTTP の edge を置き換える）",
    reason:
      "integrator の決定 B1 (i)（K2/4 :352 と :99）。ほかの session と測定は製品の Main。抽出は dialog の Analyze と同じ renderer の API（folder の配下の Scene、live の event catalog、言語は dialog と同じく指定しない）、child は secret を外す改訂、承認は card の承認",
  },
  "relation-type-edit": {
    value:
      "relation.delete の後、同じ runtime ID で relation.create（型と label は to）。同じ ID の再利用を製品が拒めば新しい ID（受領書の relationRecreations の mode）",
    reason:
      "integrator の決定 B2 (B')／(B'')。製品の codex_mutate に型の編集は無い。旧 Revision は Source token（version と updated_at）が変わって stale になる",
  },
  "ir-approval-withdrawal": {
    value:
      "qualified-ir の段が受領書に残した run・proposal・現行の child の revision に、recordChronicleProposalDecision で decision deferred（UI の「保留」と同じ payload）",
    reason: "integrator の決定 B3",
  },
  "index-state-holding": {
    value:
      "graph-index-unusable: seal の後に seam の無い hold の session で mutation と seed なしの query（C だけ作り直す）。chronicle-index-unusable: hold で撤回、seam の reseal で B の新しい generation を待ち query を出さない。both: hold で両方、query なし。graph-recovered: hold で mutation、reseal で B と C。probe は readIndexMetadata（read-only）と query の initialSnapshot",
    reason:
      "integrator の決定 B4 (c)(i)。通常の lifecycle の制御（起動の構成、閉じる、開く）と通常の query だけ。測定の側の one-shot は plan の measurementSpec（runner への配線は S5）",
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

/**
 * S1j-2: the four steps S1i left as `[precheck]` (DR-CP4-I-8) have executors
 * now (integrator's decisions B1〜B4, DR-CP4-L-*). A step no executor maps is
 * still refused when the plan is made.
 */
function qualifiedIrInput(id, fixture) {
  return {
    id,
    rows: (fixture.qualifiedIr ?? []).map((row) => ({
      sceneId: row.sceneId,
      folderId: `${IR_FOLDER_PREFIX}${row.sceneId}`,
      summary: row.summary,
      actuality: row.actuality,
      attribution: row.attribution,
      narrativeFrame: row.narrativeFrame,
    })),
  };
}

function timelineStep(fixture, step, indexes) {
  if (step?.kind === "qualified-ir")
    return {
      timelineKind: "qualified-ir",
      executor: "qualified-ir",
      input: qualifiedIrInput(step.id, fixture),
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
    if (mutation.kind === "codex-relation-type-edit") {
      const relation = (fixture.relations ?? []).find(
        (row) => row.id === mutation.relationId,
      );
      if (!relation || relation.type !== mutation.from)
        fail(
          "setup-timeline",
          `mutation ${step.id} edits ${String(mutation.relationId)}, not a Relation of type ${String(mutation.from)}`,
        );
      return {
        timelineKind: "mutation",
        executor: "codex-relation-type-edit",
        input: {
          id: mutation.id,
          relationId: mutation.relationId,
          from: mutation.from,
          to: mutation.to,
          // DR-CP4-I-4 (1): the label is the type.
          label: mutation.to,
        },
      };
    }
    if (mutation.kind === "ir-approval-withdrawal") {
      if (
        !(fixture.qualifiedIr ?? []).some(
          (row) => row.sceneId === mutation.sceneId,
        )
      )
        fail(
          "setup-timeline",
          `mutation ${step.id} withdraws an IR of ${String(mutation.sceneId)} that qualifiedIr does not create`,
        );
      return {
        timelineKind: "mutation",
        executor: "ir-approval-withdrawal",
        input: {
          id: mutation.id,
          sceneId: mutation.sceneId,
          decision: "deferred",
        },
      };
    }
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
  devCatalog = null,
}) {
  if (!Object.values(SETUP_STOPS).includes(stopsAt))
    fail(
      "stop",
      `stopsAt is ${Object.values(SETUP_STOPS).join(" or ")}, not ${String(stopsAt)}`,
    );
  // S1j-2: a dev graph-case fixture (loadDevGraphCasePlans) runs the same
  // plan for the dev fixture check in real Electron; never a CP-4 variant.
  const catalog =
    devCatalog === null
      ? GRAPH_EVAL_VARIANTS.find(
          (row) => row.caseId === caseId && row.variantId === variantId,
        )
      : DEV_CATALOGS.has(devCatalog) &&
          devCatalog.caseId === caseId &&
          devCatalog.variantId === variantId
        ? devCatalog
        : null;
  if (!catalog) fail("variant", `${caseId}/${variantId} is not a CP-4 variant`);
  // S1j-2: a dev shape fixture (dev-shape-fixture.mjs) takes the plan route
  // of the G-case whose structure it copies.
  const shape = devCatalog?.shape ?? caseId;
  const g01 = shape === "G-01";
  const variant = g01
    ? { id: "v1", measurementPoint: null, indexState: null, preconditions: [] }
    : (fixture.variants ?? []).find((row) => row.id === variantId);
  if (!variant) fail("variant", `${caseId} has no variant ${variantId}`);
  const correspondence = setupOrderCorrespondence({
    caseId: shape,
    fixture,
    candidateDocument,
  });
  const seedRow = seedPinPlanFromFixture({ caseId: shape, fixture }).find(
    (row) => row.variantId === variantId,
  );
  const seedPin =
    seedRow && shape !== caseId
      ? { ...seedRow, caseId, variantKey: `${caseId}/${variantId}` }
      : seedRow;
  const scenes = sceneRowsOf(shape, fixture);
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
  const scope = sceneScopeInput(shape, fixture, scenes);
  const codex = () => {
    add("entities", { rows: entityRowsOf(shape, fixture) });
    add("relations", { rows: relationRowsOf(shape, fixture) });
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
  const spec = measurementSpecOf(variant.measurementPoint ?? null);
  if (g01) {
    add(
      "typed-revisions",
      {
        rows: [
          {
            id: "g01-typed-revision",
            reviewSceneId:
              shape === caseId ? "g01-review" : fixture.g01ReviewSceneId,
            entityIds: [fixture.entitySeed.id, fixture.targetEntity.id],
            relationIds: [fixture.relation.id],
            decision: "approved",
          },
        ],
      },
      { executor: "typed-revision" },
    );
    add("qualified-ir", qualifiedIrInput("g01-ir", fixture), {
      session: "ir",
    });
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
    const irAt = timeline.findIndex((row) => row.step.kind === "qualified-ir");
    if (
      irAt < 0 ||
      timeline.filter((row) => row.step.kind === "qualified-ir").length !== 1
    )
      fail(
        "setup-timeline",
        `${caseId}: setupTimeline has no single qualified-ir step`,
      );
    const afterIr = timeline.slice(irAt + 1);
    if (afterIr.some((row) => row.step.kind !== "mutation"))
      fail(
        "setup-timeline",
        `${caseId}: only mutations follow the qualified-ir step (README :39)`,
      );
    const step = (row, session) =>
      add(`setup-timeline:${row.step.id}`, row.mapped.input, {
        session,
        timelineKind: row.mapped.timelineKind,
        executor: row.mapped.executor,
      });
    for (const row of timeline.slice(0, irAt)) step(row, "author");
    step(timeline[irAt], "ir");
    // README :39: G-08 commits its mutations after the IR, once the variant
    // reached its sealed generation (precondition maintenance-enabled).
    add("b-seal", {}, { session: "seal" });
    add("chronicle-index", {}, { session: "seal" });
    if (afterIr.length > 0) {
      // B4: the mutations commit in a session without the B-ROUTE seam (B is
      // not rebuilt there); a usable B after them needs a new seal session
      // (the workspace-opened wake), a usable C a query.
      const state = variant.indexState ?? {};
      if (
        !["usable", "unusable"].includes(state.graph) ||
        !["usable", "unusable"].includes(state.chronicle)
      )
        fail(
          "measurement-point",
          `${caseId}/${variantId}: mutations after the IR need a declared indexState`,
        );
      for (const row of afterIr) step(row, "hold");
      const after = state.graph === "usable" ? "reseal" : "hold";
      if (state.graph === "usable")
        add(
          "b-seal:after-mutation",
          {},
          { session: after, executor: "b-seal" },
        );
      if (state.chronicle === "usable")
        add(
          "chronicle-index:after-mutation",
          {},
          { session: after, executor: "chronicle-index" },
        );
    }
  }
  add(
    "measurement-point",
    {
      measurementPoint: variant.measurementPoint ?? null,
      indexState: variant.indexState ?? null,
      spec,
    },
    { session: steps.at(-1).session },
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
    ? declarationOf(shape, fixture, variant)
    : null;
  if (catalog.declaration && !nonBlank(declaration?.sceneId))
    fail("declaration", `${caseId}/${variantId} names no declaration Scene`);
  if (!catalog.declaration && declarationOf(shape, fixture, variant) !== null)
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
    fixtureKind: devCatalog === null ? "frozen" : "dev",
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
    // Review P2-2: the README preconditions the variant declares.
    preconditions: (variant.preconditions ?? []).map((row) => row.id),
    correspondence,
    steps,
    stopIndex,
    seedPin,
    declaration,
    runnerSteps,
    skippedTimelineSteps,
    sessions: [...new Set(steps.map((row) => row.session))].map((label) => ({
      label,
      ...SETUP_SESSIONS[label],
    })),
    measurementSpec: spec,
    harnessChoices: choices([
      "project-title",
      "phase-resolution-mode",
      "relation-label",
      "scene-runtime-ids",
      "ir-scene-folders",
      "setup-ir-main",
      ...(steps.some((row) => row.executor === "codex-relation-type-edit")
        ? ["relation-type-edit"]
        : []),
      ...(steps.some((row) => row.executor === "ir-approval-withdrawal")
        ? ["ir-approval-withdrawal"]
        : []),
      ...(steps.some((row) => row.session === "hold")
        ? ["index-state-holding"]
        : []),
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

/** S1j-2: the dev graph-case fixture's schema (never a G-case's). */
export const DEV_GRAPH_CASE_SCHEMA = "nir1-cp4-dev-graph-case/1";
const DEV_CATALOGS = new WeakSet();

/**
 * S1j-2: the plans of a dev graph-case fixture (the G-case shape with
 * synthetic material, for the dev fixture check of the complete setup in
 * real Electron). The path must classify as dev, be a regular file under
 * `root`, not be a copy of frozen material, and declare the dev schema, a
 * `DEV-` case and `frozen: false`. The plans carry `fixtureKind: "dev"`.
 */
export function loadDevGraphCasePlans({ root, fixturePath, stopsAt }) {
  if (classifyGraphFixturePath(fixturePath) !== "dev")
    fail(
      "dev-fixture",
      `${fixturePath} is not under the dev fixture directory`,
    );
  const realRoot = realpathSync(root);
  const full = path.join(realRoot, fixturePath);
  const metadata = lstatSync(full);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    realpathSync(full) !== full
  )
    fail("dev-fixture", `${fixturePath} must be a regular file`);
  const bytes = readFileSync(full);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (FROZEN_MATERIAL_SHA256.has(digest))
    fail("dev-fixture", `${fixturePath} is a copy of frozen material`);
  const fixture = JSON.parse(bytes);
  if (
    fixture?.schemaVersion !== DEV_GRAPH_CASE_SCHEMA ||
    fixture.kind !== "dev" ||
    fixture.frozen !== false ||
    !/^DEV-[A-Z0-9-]+$/u.test(fixture.caseId ?? "")
  )
    fail(
      "dev-fixture",
      `${fixturePath} is not a ${DEV_GRAPH_CASE_SCHEMA} fixture (kind dev, frozen false, a DEV- case)`,
    );
  const shape = fixture.shape ?? null;
  if (
    shape !== null &&
    !GRAPH_EVAL_VARIANTS.some((row) => row.caseId === shape)
  )
    fail(
      "dev-fixture",
      `${fixturePath} names an unknown shape ${String(shape)}`,
    );
  const candidateDocument =
    shape === "G-01" ? readCandidateDocument({ root }) : null;
  return deepFreeze(
    (fixture.variants ?? []).map((variant) => {
      const devCatalog = Object.freeze({
        kind: "dev",
        caseId: fixture.caseId,
        variantId: variant.id,
        key: `${fixture.caseId}/${variant.id}`,
        fixturePath,
        fixtureSha256: digest,
        shape,
        // As the catalog: G-01 and a variant with an added Scene declare.
        declaration:
          shape === "G-01" ||
          (variant.preconditions ?? []).some((row) => row.id === "cb4-inputs"),
      });
      DEV_CATALOGS.add(devCatalog);
      return frozenSetupPlan({
        caseId: fixture.caseId,
        variantId: variant.id,
        fixture,
        stopsAt,
        devCatalog,
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

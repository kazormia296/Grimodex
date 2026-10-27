// CP-4 S1j-2: dev fixtures with the structure of a frozen G-case (DR-CP4-L-21).
//
// ⑤ is the first run on the frozen material, and a harness defect found
// there means S4 again. So each G-case's shape is tried first on a dev
// fixture: the frozen fixture is read (never written, never launched) and
// its structure is copied — the setupOrder text, the setupTimeline, the
// qualifiedIr rows, the mutations, the Revision decisions, the variants,
// the Scope overrides, the pins and foreshadows — while every logical ID,
// title, body, name, summary and Relation type is replaced by synthetic
// material. `planShape` reduces a plan to its structure with the IDs and
// texts taken out, and the tests require the dev plan's shape to equal the
// frozen plan's for every variant.
//
//   node scripts/quality/nir1-graph-eval/dev-shape-fixture.mjs --case G-03

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { DEV_GRAPH_CASE_SCHEMA } from "./frozen-setup-plan.mjs";

export const DEV_SHAPE_ROOT = "scripts/quality/nir1-graph-eval/dev-fixtures";
/** The frozen fixtures whose shapes are copied, and the dev files. */
export const DEV_SHAPES = Object.freeze({
  "G-01": {
    source: "evals/nir1-g01/fixture.v1.json",
    file: `${DEV_SHAPE_ROOT}/dev-shape-g01.v1.json`,
  },
  "G-03": {
    source: "evals/nir1-graph/g03-bounded-two-hop.v1.json",
    file: `${DEV_SHAPE_ROOT}/dev-shape-g03.v1.json`,
  },
  "G-04": {
    source: "evals/nir1-graph/g04-scope-exact-unknown.v1.json",
    file: `${DEV_SHAPE_ROOT}/dev-shape-g04.v1.json`,
  },
  "G-06": {
    source: "evals/nir1-graph/g06-evidence-anchor-path.v1.json",
    file: `${DEV_SHAPE_ROOT}/dev-shape-g06.v1.json`,
  },
  "G-07": {
    source: "evals/nir1-graph/g07-reading-before-reveal.v1.json",
    file: `${DEV_SHAPE_ROOT}/dev-shape-g07.v1.json`,
  },
});

const WORDS = [
  "amber",
  "basket",
  "cedar",
  "dune",
  "ember",
  "fennel",
  "garnet",
  "hollow",
  "indigo",
  "juniper",
  "kestrel",
  "lantern",
  "meadow",
  "nutmeg",
  "orchard",
  "pebble",
  "quarry",
  "russet",
  "saffron",
  "thistle",
  "umber",
  "valley",
  "willow",
  "yarrow",
  "zephyr",
  "bramble",
  "copper",
  "drift",
  "fable",
  "gusty",
];

function word(seed, at) {
  const digest = createHash("sha256").update(`${seed}:${at}`).digest();
  return WORDS[digest[0] % WORDS.length];
}

/** The synthetic copy of one frozen G-case fixture (IDs and texts replaced). */
export function shapeFixture({ caseId, fixture }) {
  const tag = caseId.replace(/^G-0?/u, "").toLowerCase();
  const prefix = `dvs${tag}-`;
  const ids = new Map();
  const id = (value) => {
    if (typeof value !== "string") return value;
    if (!ids.has(value)) ids.set(value, `${prefix}${ids.size + 1}`);
    return ids.get(value);
  };
  const texts = new Map();
  const text = (value, kind) => {
    if (typeof value !== "string") return value;
    const key = `${kind}\u0000${value}`;
    if (!texts.has(key)) {
      const n = texts.size + 1;
      const words = Array.from({ length: 6 }, (_, at) =>
        word(`${caseId}:${n}`, at),
      ).join(" ");
      texts.set(
        key,
        kind === "name"
          ? `${word(`${caseId}:${n}`, 0)[0].toUpperCase()}${word(`${caseId}:${n}`, 1)}${n}`
          : kind === "type"
            ? `dev-type-${n}`
            : kind === "title"
              ? `Dev title ${n}`
              : `Dev ${caseId} text ${n}: the ${words} line.`,
      );
    }
    return texts.get(key);
  };
  const g01 = caseId === "G-01";
  const scene = (row) => ({
    id: id(row.id),
    readingOrder: row.readingOrder,
    title: text(row.title, "title"),
    body: text(row.body, "body"),
  });
  const entity = (row) => ({
    id: id(row.id),
    kind: row.kind,
    label: text(row.label, "name"),
    summary: text(row.summary, "summary"),
  });
  const relation = (row) => ({
    id: id(row.id),
    fromEntityId: id(row.fromEntityId),
    toEntityId: id(row.toEntityId),
    type: text(row.type, "type"),
    direction: row.direction,
  });
  const ir = (row) => ({
    sceneId: id(row.sceneId),
    summary: text(row.summary, "ir"),
    actuality: row.actuality,
    attribution: row.attribution,
    narrativeFrame: row.narrativeFrame,
  });
  const pin = (row) => ({
    sceneId: id(row.sceneId),
    entryId: id(row.entryId ?? row.entityId),
  });
  const principal = (value) =>
    value?.kind === "character" ? { ...value, ref: id(value.ref) } : value;
  const scopeRow = (row) => ({
    ...row,
    ...(row.knowledgeHolder
      ? { knowledgeHolder: principal(row.knowledgeHolder) }
      : {}),
    ...(row.audience ? { audience: principal(row.audience) } : {}),
  });
  const header = {
    schemaVersion: DEV_GRAPH_CASE_SCHEMA,
    kind: "dev",
    frozen: false,
    caseId: `DEV-SHAPE-${caseId.replace("-", "")}`,
    shape: caseId,
    fixtureId: `cp4-dev-shape-${tag}/1`,
    note: `Synthetic CP-4 S1j-2 development fixture with the structure of ${caseId} (generated by dev-shape-fixture.mjs: every ID, title, body, name, summary and Relation type is synthetic). Not a G-case, not frozen, not reviewed; never a CP-4 result.`,
    language: fixture.language,
  };
  const query = {
    sceneId: id(fixture.query.sceneId),
    readingOrder: fixture.query.readingOrder,
    ...(fixture.query.title
      ? { title: text(fixture.query.title, "title") }
      : {}),
    body: text(fixture.query.body, "body"),
  };
  if (g01) {
    const scenes = fixture.scenes.map(scene);
    return {
      ...header,
      query,
      scenes,
      entitySeed: { ...entity(fixture.entitySeed), manualSeed: true },
      targetEntity: entity(fixture.targetEntity),
      relation: relation(fixture.relation),
      pins: fixture.pins.map(pin),
      qualifiedIr: fixture.qualifiedIr.map(ir),
      g01ReviewSceneId: id("g01-review"),
      expectations: {
        graphPath: { sceneId: id(fixture.expectations.graphPath.sceneId) },
      },
      measurementBoundary: {
        runtimeSetup: fixture.measurementBoundary.runtimeSetup,
      },
      variants: [{ id: "v1" }],
    };
  }
  return {
    ...header,
    query,
    scenes: fixture.scenes.map(scene),
    scope: {
      registry: fixture.scope.registry,
      default: scopeRow(fixture.scope.default),
      overrides: Object.fromEntries(
        Object.entries(fixture.scope.overrides ?? {}).map(([key, row]) => [
          id(key),
          scopeRow(row),
        ]),
      ),
    },
    entities: fixture.entities.map(entity),
    relations: fixture.relations.map(relation),
    manualSeed: { entityId: id(fixture.manualSeed.entityId), manualSeed: true },
    pins: fixture.pins.map(pin),
    foreshadows: (fixture.foreshadows ?? []).map((row) => ({
      id: id(row.id),
      title: text(row.title, "title"),
      secret: row.secret,
      payoffSceneId: row.payoffSceneId === null ? null : id(row.payoffSceneId),
      payoffConfirmed: row.payoffConfirmed,
      abandoned: row.abandoned,
      linkedEntityIds: (row.linkedEntityIds ?? []).map(id),
    })),
    qualifiedIr: fixture.qualifiedIr.map(ir),
    revisions: fixture.revisions.map((row) => ({
      id: id(row.id),
      reviewSceneId: id(row.reviewSceneId),
      entityIds: row.entityIds.map(id),
      relationIds: row.relationIds.map(id),
      decision: row.decision,
      ...(row.onlyInVariants
        ? { onlyInVariants: [...row.onlyInVariants] }
        : {}),
    })),
    mutations: (fixture.mutations ?? []).map((row) => ({
      ...row,
      id: id(row.id),
      ...(row.entityId
        ? {
            entityId: id(row.entityId),
            from: text(row.from, "summary"),
            to: text(row.to, "summary"),
          }
        : {}),
      ...(row.relationId
        ? {
            relationId: id(row.relationId),
            from: text(row.from, "type"),
            to: text(row.to, "type"),
          }
        : {}),
      ...(row.sceneId ? { sceneId: id(row.sceneId) } : {}),
    })),
    setupTimeline: fixture.setupTimeline.map((row) => ({
      kind: row.kind,
      id: id(row.id),
    })),
    measurementBoundary: {
      setupOrder: fixture.measurementBoundary.setupOrder,
    },
    variants: fixture.variants.map((row) => ({
      id: row.id,
      measurementPoint: row.measurementPoint,
      indexState: row.indexState,
      preconditions: row.preconditions.map((entry) => ({
        ...entry,
        ...(entry.sceneId ? { sceneId: id(entry.sceneId) } : {}),
      })),
    })),
  };
}

/**
 * A plan's structure with the IDs and texts taken out: per step its phase
 * kind, session, executor, timeline kind, categories and the shape of its
 * input; per plan its sessions, measurement point and spec, index state,
 * the declaration's presence and the harness choices' IDs.
 */
export function planShape(plan) {
  const kindOf = (phase) =>
    phase.replace(/^setup-timeline:.*$/u, "setup-timeline");
  const rowsShape = (input) => {
    if (!input || typeof input !== "object") return null;
    const out = {};
    for (const [key, value] of Object.entries(input)) {
      if (Array.isArray(value))
        out[key] = value.map((row) =>
          row && typeof row === "object"
            ? Object.fromEntries(
                Object.entries(row)
                  .filter(([field]) =>
                    [
                      "readingOrder",
                      "query",
                      "decision",
                      "secret",
                      "payoffConfirmed",
                      "abandoned",
                      "directionality",
                      "marker",
                      "type",
                    ].includes(field),
                  )
                  .concat([
                    ["folder", Boolean(row.folder)],
                    [
                      "count",
                      ["entityIds", "relationIds"]
                        .map((field) => row[field]?.length ?? 0)
                        .join("/"),
                    ],
                  ]),
              )
            : typeof value,
        );
      else if (
        [
          "decision",
          "measurementPoint",
          "language",
          "phaseResolutionMode",
        ].includes(key)
      )
        out[key] = value;
      else if (key === "indexState" || key === "spec") out[key] = value;
    }
    return out;
  };
  return {
    sessions: plan.sessions,
    measurementPoint: plan.measurementPoint,
    indexState: plan.indexState,
    measurementSpec: plan.measurementSpec,
    preconditions: plan.preconditions,
    declaration: plan.declaration !== null,
    stopIndex: plan.stopIndex,
    skipped: plan.skippedTimelineSteps.map((row) => row.kind),
    harnessChoices: plan.harnessChoices.map((row) => row.id),
    steps: plan.steps.map((step) => ({
      phase: kindOf(step.phase),
      session: step.session,
      executor: step.executor,
      timelineKind: step.timelineKind ?? null,
      categories: step.categories,
      input: rowsShape(step.input),
    })),
  };
}

function main() {
  const at = process.argv.indexOf("--case");
  const caseId = process.argv[at + 1];
  const shape = DEV_SHAPES[caseId];
  if (at < 0 || !shape) throw new Error("--case G-01|G-03|G-04|G-06|G-07");
  const root = path.resolve(import.meta.dirname, "../../..");
  const fixture = JSON.parse(
    readFileSync(path.join(root, shape.source), "utf8"),
  );
  writeFileSync(
    path.join(root, shape.file),
    `${JSON.stringify(shapeFixture({ caseId, fixture }), null, 2)}\n`,
  );
  process.stdout.write(`${shape.file}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename)
  main();

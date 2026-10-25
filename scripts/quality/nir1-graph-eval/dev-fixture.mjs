// CP-4 S1c-2: the synthetic dev fixture (DR-CP4-S1C2-1).
//
// A dev fixture lives only under `scripts/quality/nir1-graph-eval/
// dev-fixtures/`, is never a copy of frozen material and is never a G-case.
// This module checks its shape and derives the setup plan; it reads only the
// dev fixture file (through the same path rule as the Graph arm guard) and
// never a frozen fixture.

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { classifyGraphFixturePath } from "../nir1-retrieval/contract.mjs";
import { FROZEN_MATERIAL_SHA256, devVariant } from "./constants.mjs";

export const DEV_FIXTURE_SCHEMA = "nir1-cp4-dev-fixture/1";
/** The setup steps a dev fixture may list, in their only allowed order. */
export const DEV_SETUP_STEPS = Object.freeze([
  "project",
  "maintenance-enabled",
  "scenes",
  "scope-registry",
  "scene-scope",
  "entities",
  "relations",
  "pins",
  "typed-revisions",
  "b-seal",
  "chronicle-index",
]);
const ID = /^cp4-dev-[a-z0-9-]+$/u;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fail(message) {
  throw new Error(`[precheck] dev fixture: ${message}`);
}

function unique(rows, label) {
  const ids = rows.map((row) => row.id);
  if (ids.some((id) => typeof id !== "string" || !ID.test(id)))
    fail(`${label} ids must be cp4-dev-… identifiers`);
  if (new Set(ids).size !== ids.length) fail(`duplicate ${label} id`);
  return new Set(ids);
}

/**
 * Validates a parsed dev fixture. Returns the scenes in reading order (the
 * query Scene last). Throws `[precheck]` on any shape error.
 */
export function validateDevFixture(fixture) {
  if (fixture?.schemaVersion !== DEV_FIXTURE_SCHEMA)
    fail(`schemaVersion must be ${DEV_FIXTURE_SCHEMA}`);
  if (fixture.kind !== "dev" || fixture.frozen !== false)
    fail("kind must be dev and frozen false");
  if (fixture.caseId !== null)
    fail("a dev fixture is not a G-case (caseId null)");
  if (!ID.test(fixture.project?.id ?? "")) fail("project.id");
  for (const axis of ["timeline", "worldline", "narrativeLayer"])
    if (!ID.test(fixture.scopeRefs?.[axis] ?? "")) fail(`scopeRefs.${axis}`);
  const scenes = [...(fixture.scenes ?? [])];
  const query = fixture.query;
  if (!ID.test(query?.sceneId ?? "") || typeof query.body !== "string")
    fail("query");
  const sceneIds = unique([...scenes, { id: query.sceneId }], "scene");
  for (const scene of scenes) {
    if (typeof scene.body !== "string" || scene.body.length === 0)
      fail(`scene ${scene.id} body`);
    if (
      !Number.isInteger(scene.readingOrder) ||
      scene.readingOrder < 0 ||
      scene.readingOrder >= query.readingOrder
    )
      fail(`scene ${scene.id} must be read before the query Scene`);
  }
  if (new Set(scenes.map((row) => row.readingOrder)).size !== scenes.length)
    fail("reading orders must be distinct");
  const entities = fixture.entities ?? [];
  const entityIds = unique(entities, "entity");
  if (entities.filter((row) => row.role === "seed").length !== 1)
    fail("exactly one seed entity");
  if (
    fixture.graphSeedEntityId !==
    entities.find((row) => row.role === "seed")?.id
  )
    fail("graphSeedEntityId must be the seed entity");
  for (const entity of entities)
    if (
      typeof entity.name !== "string" ||
      typeof entity.summary !== "string" ||
      typeof entity.type !== "string"
    )
      fail(`entity ${entity.id}`);
  const relations = fixture.relations ?? [];
  const relationIds = unique(relations, "relation");
  for (const relation of relations)
    if (
      !entityIds.has(relation.fromEntityId) ||
      !entityIds.has(relation.toEntityId) ||
      !["directed", "symmetric"].includes(relation.directionality)
    )
      fail(`relation ${relation.id}`);
  for (const pin of fixture.pins ?? [])
    if (!sceneIds.has(pin.sceneId) || !entityIds.has(pin.entityId))
      fail(`pin ${pin.sceneId}/${pin.entityId}`);
  unique(fixture.typedRevisions ?? [], "typed revision");
  for (const revision of fixture.typedRevisions ?? [])
    if (
      !sceneIds.has(revision.sceneId) ||
      !revision.entityIds.every((id) => entityIds.has(id)) ||
      !revision.relationIds.every((id) => relationIds.has(id))
    )
      fail(`typed revision ${revision.id}`);
  for (const row of fixture.declarations ?? [])
    if (!sceneIds.has(row.sceneId) || row.values !== "g01-subset")
      fail(`declaration ${row.sceneId}`);
  const order = fixture.measurementBoundary?.setupOrder;
  if (
    !Array.isArray(order) ||
    order.some((step) => !DEV_SETUP_STEPS.includes(step)) ||
    order.some(
      (step, at) =>
        at > 0 &&
        DEV_SETUP_STEPS.indexOf(order[at - 1]) >= DEV_SETUP_STEPS.indexOf(step),
    )
  )
    fail("measurementBoundary.setupOrder must follow DEV_SETUP_STEPS");
  const variants = fixture.variants ?? [];
  if (variants.length === 0) fail("variants");
  for (const variant of variants) {
    if (!Array.isArray(variant.expectations?.arms?.raw?.sceneIds))
      fail(`variant ${variant.id} expectations.arms.raw.sceneIds`);
    devVariant({
      key: `dev:x/${variant.id}`,
      expectedGraph: variant.expectations?.graph?.status,
    });
  }
  return [...scenes].sort((a, b) => a.readingOrder - b.readingOrder);
}

/**
 * Reads a dev fixture: the path must classify as `dev`, be a regular file
 * under `root` reached without a symlink, and not be a copy of frozen
 * material. Returns `{ path, sha256, bytes, fixture, ordered }`.
 */
export function loadDevFixture({ root, fixturePath }) {
  if (classifyGraphFixturePath(fixturePath) !== "dev")
    fail(`${fixturePath} is not under the dev fixture directory`);
  const realRoot = realpathSync(root);
  const full = path.join(realRoot, fixturePath);
  const metadata = lstatSync(full);
  if (metadata.isSymbolicLink() || !metadata.isFile())
    fail(`${fixturePath} must be a regular file`);
  if (realpathSync(full) !== full) fail(`${fixturePath} is behind a symlink`);
  const bytes = readFileSync(full);
  const digest = sha256(bytes);
  if (FROZEN_MATERIAL_SHA256.has(digest))
    fail(`${fixturePath} is a copy of frozen material`);
  const fixture = JSON.parse(bytes);
  const ordered = validateDevFixture(fixture);
  return { path: fixturePath, sha256: digest, bytes, fixture, ordered };
}

/** The dev variant row (`dev:<file base>/<variant>`) of a loaded fixture. */
export function devVariantOf(loaded, variantId) {
  const variant = loaded.fixture.variants.find((row) => row.id === variantId);
  if (!variant) fail(`variant ${variantId} not found`);
  return devVariant({
    key: `dev:${path.basename(loaded.path, ".json")}/${variantId}`,
    expectedGraph: variant.expectations.graph.status,
  });
}

/**
 * Scenes in reading order with the query Scene, as `tree_node_create` rows
 * (fractional sort keys are assigned by the caller).
 */
export function sceneRows(loaded) {
  const query = loaded.fixture.query;
  return [
    ...loaded.ordered,
    {
      id: query.sceneId,
      readingOrder: query.readingOrder,
      title: query.title ?? "Query scene",
      body: query.body,
    },
  ];
}

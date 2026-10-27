// CP-4 S1c-2 dev fixture and read-only workspace reads. The dev fixture is
// synthetic; no frozen G-case fixture is read here (N-16).
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  DEV_SETUP_STEPS,
  devVariantOf,
  loadDevFixture,
  sceneRows,
  validateDevFixture,
} from "./dev-fixture.mjs";
import {
  INDEX_KEYS,
  indexMetadataFromRows,
  readIndexMetadata,
  readRowCounts,
} from "./workspace-db.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const DEV = "scripts/quality/nir1-graph-eval/dev-fixtures/dev-lantern.v1.json";
const fixture = () => JSON.parse(readFileSync(path.join(ROOT, DEV), "utf8"));

test("the dev fixture is synthetic, ordered and keyed as a dev variant", () => {
  const loaded = loadDevFixture({ root: ROOT, fixturePath: DEV });
  assert.equal(loaded.fixture.kind, "dev");
  assert.equal(loaded.fixture.frozen, false);
  assert.equal(loaded.fixture.caseId, null);
  assert.deepEqual(
    loaded.ordered.map((row) => row.readingOrder),
    [...loaded.ordered.map((row) => row.readingOrder)].sort((a, b) => a - b),
  );
  assert.equal(sceneRows(loaded).at(-1).id, loaded.fixture.query.sceneId);
  assert.deepEqual(devVariantOf(loaded, "base"), {
    key: "dev:dev-lantern.v1/base",
    kind: "dev",
    expectedGraph: "available",
    declaration: false,
  });
  for (const step of loaded.fixture.measurementBoundary.setupOrder)
    assert.ok(DEV_SETUP_STEPS.includes(step), step);
});

test("a frozen path, an out-of-order setup or a Scene after the query is refused", () => {
  assert.throws(
    () =>
      loadDevFixture({
        root: ROOT,
        fixturePath: "evals/nir1-graph/g02-directed-relation.v1.json",
      }),
    /dev fixture directory/u,
  );
  const late = fixture();
  late.scenes[0].readingOrder = late.query.readingOrder;
  assert.throws(() => validateDevFixture(late), /read before the query/u);
  const order = fixture();
  order.measurementBoundary.setupOrder = ["scenes", "project"];
  assert.throws(() => validateDevFixture(order), /setupOrder/u);
  const seed = fixture();
  seed.graphSeedEntityId = "cp4-dev-tavi";
  assert.throws(() => validateDevFixture(seed), /seed entity/u);
  const caseId = fixture();
  caseId.caseId = "G-02";
  assert.throws(() => validateDevFixture(caseId), /not a G-case/u);
  const pin = fixture();
  pin.pins.push({ sceneId: "cp4-dev-nowhere", entityId: "cp4-dev-tavi" });
  assert.throws(() => validateDevFixture(pin), /pin/u);
});

test("a dev fixture file outside the repository rules is refused even under the dev directory", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cp4-dev-fixture-"));
  try {
    const dir = path.join(root, "scripts/quality/nir1-graph-eval/dev-fixtures");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "x.v1.json"),
      JSON.stringify({ schemaVersion: "other" }),
    );
    assert.throws(
      () =>
        loadDevFixture({
          root,
          fixturePath: "scripts/quality/nir1-graph-eval/dev-fixtures/x.v1.json",
        }),
      /schemaVersion/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Index metadata rows map to { generation, dirty } per Index", () => {
  assert.deepEqual(
    indexMetadataFromRows([
      { indexKey: INDEX_KEYS.b, generation: 2, dirty: 0, sourceDigest: "s" },
      { indexKey: INDEX_KEYS.chronicle, generation: 5, dirty: 1 },
      { indexKey: "other", generation: 9, dirty: 0 },
    ]),
    {
      b: {
        generation: 2,
        dirty: false,
        sourceDigest: "s",
        dependencySetDigest: null,
        producerId: null,
        producerVersion: null,
      },
      chronicle: {
        generation: 5,
        dirty: true,
        sourceDigest: null,
        dependencySetDigest: null,
        producerId: null,
        producerVersion: null,
      },
    },
  );
  assert.deepEqual(indexMetadataFromRows([]), { b: null, chronicle: null });
});

test("workspace reads are read-only and name only safe tables", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cp4-workspace-db-"));
  const file = path.join(dir, "grimodex.db");
  try {
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE narrative_semantic_index_metadata(project_id TEXT, index_key TEXT,
      generation INTEGER, dirty_cache_flag INTEGER, source_digest TEXT, dependency_set_digest TEXT,
      producer_id TEXT, producer_version TEXT);
      CREATE TABLE ai_audit_events(id INTEGER);
      INSERT INTO narrative_semantic_index_metadata VALUES('p','${INDEX_KEYS.b}',1,0,'d','e','f','g');
      INSERT INTO ai_audit_events VALUES(1),(2);`);
    db.close();
    assert.equal(readIndexMetadata(file, "p").b.generation, 1);
    assert.equal(readIndexMetadata(file, "q").b, null);
    assert.deepEqual(readRowCounts(file, ["ai_audit_events"]), {
      ai_audit_events: 2,
    });
    assert.throws(
      () => readRowCounts(file, ["x; DROP TABLE y"]),
      /unsafe table/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

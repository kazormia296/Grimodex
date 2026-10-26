// CP-4 S1c-2: read-only reads of a workspace `grimodex.db` from the harness
// process (DR-CP4-S1C2-5). Used for evidence only: the Index metadata
// (generation, dirty) before/after the declaration step and the sealed B
// generation, and the setup read-back. Each read opens its own read-only
// connection (`node:sqlite`, `readOnly: true`) and closes it; nothing writes.
// The measured samples never call this (the A3 record of a sample is the
// evaluation Native's own read-only connection).

import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";

/** The B (typed Entity/Relation Graph) and Chronicle Index keys. */
export const INDEX_KEYS = Object.freeze({
  b: "nir1-reviewed-entity-relation:v1",
  chronicle: "nir1-reviewed-chronicle:v1",
});

function withReadOnly(file, read) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/** Metadata rows → `{ b, chronicle }` with `{ generation, dirty, … }` or null. */
export function indexMetadataFromRows(rows) {
  const out = { b: null, chronicle: null };
  for (const [name, key] of Object.entries(INDEX_KEYS)) {
    const row = rows.find((entry) => entry.indexKey === key);
    out[name] = row
      ? {
          generation: Number(row.generation),
          dirty: Number(row.dirty) !== 0,
          sourceDigest: row.sourceDigest ?? null,
          dependencySetDigest: row.dependencySetDigest ?? null,
          producerId: row.producerId ?? null,
          producerVersion: row.producerVersion ?? null,
        }
      : null;
  }
  return out;
}

export function readIndexMetadata(file, projectId) {
  return withReadOnly(file, (db) =>
    indexMetadataFromRows(
      db
        .prepare(
          `SELECT index_key AS indexKey, generation, dirty_cache_flag AS dirty,
                  source_digest AS sourceDigest,
                  dependency_set_digest AS dependencySetDigest,
                  producer_id AS producerId, producer_version AS producerVersion
             FROM narrative_semantic_index_metadata WHERE project_id = ?`,
        )
        .all(projectId),
    ),
  );
}

/**
 * How often other connections commit to the workspace DB: polls
 * `PRAGMA data_version` on one read-only connection (it changes only when
 * another connection commits) every `intervalMs` for `durationMs`. Used to
 * disclose background writers (maintenance, Freshness) during a run; the
 * Graph worker's registration refuses when a commit lands inside it.
 */
export async function sampleCommitRate(file, { durationMs, intervalMs = 20 }) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const read = () =>
      Number(db.prepare("PRAGMA data_version").get().data_version);
    let last = read();
    const started = Date.now();
    const changes = [];
    while (Date.now() - started < durationMs) {
      await sleep(intervalMs);
      const now = read();
      if (now !== last) changes.push(Date.now() - started);
      last = now;
    }
    return {
      durationMs: Date.now() - started,
      intervalMs,
      commits: changes.length,
      atMs: changes,
    };
  } finally {
    db.close();
  }
}

/**
 * A long-lived read-only connection that reports `PRAGMA data_version`, which
 * changes only when another connection commits. The runner reads it at the
 * owner's READY, just before a query and after it, to attribute the commits
 * that land between the worker's READY snapshot and the query (disclosure).
 */
export function openDataVersionProbe(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  const statement = db.prepare("PRAGMA data_version");
  return {
    read: () => Number(statement.get().data_version),
    close: () => db.close(),
  };
}

/** Row counts of named tables (disclosure of the writers during a run). */
export function readRowCounts(file, tables) {
  return withReadOnly(file, (db) =>
    Object.fromEntries(
      tables.map((table) => {
        if (!/^[a-z_][a-z0-9_]*$/u.test(table))
          throw new Error(`[artifact] unsafe table name ${table}`);
        return [
          table,
          Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n),
        ];
      }),
    ),
  );
}

/** The setup read-back (ids only; no body text). */
export function readWorkspaceRows(file, projectId) {
  return withReadOnly(file, (db) => ({
    scenes: db
      .prepare(
        "SELECT id, sort_order AS sortOrder FROM tree_nodes WHERE project_id = ? AND node_type = 'scene' ORDER BY sort_order",
      )
      .all(projectId),
    codexEntries: db
      .prepare(
        "SELECT id, type FROM codex_entries WHERE project_id = ? ORDER BY id",
      )
      .all(projectId),
    codexRelations: db
      .prepare(
        "SELECT id, from_codex_id AS fromCodexId, to_codex_id AS toCodexId, relation_type AS relationType FROM codex_relations WHERE project_id = ? ORDER BY id",
      )
      .all(projectId),
    pins: db
      .prepare(
        "SELECT p.scene_id AS sceneId, p.entry_id AS entryId FROM scene_codex_pins p JOIN tree_nodes t ON t.id = p.scene_id WHERE t.project_id = ? ORDER BY p.scene_id, p.entry_id",
      )
      .all(projectId),
    metadata: indexMetadataFromRows(
      db
        .prepare(
          `SELECT index_key AS indexKey, generation, dirty_cache_flag AS dirty,
                  source_digest AS sourceDigest,
                  dependency_set_digest AS dependencySetDigest,
                  producer_id AS producerId, producer_version AS producerVersion
             FROM narrative_semantic_index_metadata WHERE project_id = ?`,
        )
        .all(projectId),
    ),
  }));
}

/** Reads readQuerySceneSeedPins returned (SP/1 SP-N13: never self-reported). */
const PRODUCT_DB_PIN_READS = new WeakSet();

export function isProductDbPinRead(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    PRODUCT_DB_PIN_READS.has(value)
  );
}

function sealPinRead(read) {
  for (const row of read.pins) Object.freeze(row);
  Object.freeze(read.pins);
  Object.freeze(read.source.db);
  Object.freeze(read.source);
  const sealed = Object.freeze(read);
  PRODUCT_DB_PIN_READS.add(sealed);
  return sealed;
}

/**
 * S1f (R5): the query Scene's pins as the product's seed reads them
 * (`selectNir1GraphSeed`, Native `read_nir1_graph_seed_in_tx`): whether the
 * Scene is a live Scene of the project, and each pin with whether its Codex
 * entry belongs to the project. seed-pin.mjs applies the order and the
 * first-pin rule. The result is frozen and sealed as read from the product
 * DB; a copy (a receipt's record) is not (SP/1 SP-N13).
 */
export function readQuerySceneSeedPins(file, projectId, sceneId) {
  // P2-1: the read is bound to the DB it read (resolved path, inode and the
  // bytes' digest before the read-only open), the project and the Scene.
  const resolved = realpathSync(file);
  const bytes = readFileSync(resolved);
  const info = statSync(resolved);
  const source = {
    db: {
      path: resolved,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      dev: info.dev,
      ino: info.ino,
    },
    projectId,
    sceneId,
  };
  return sealPinRead({
    ...readQuerySceneSeedPinsUnsealed(resolved, projectId, sceneId),
    source,
  });
}

function readQuerySceneSeedPinsUnsealed(file, projectId, sceneId) {
  return withReadOnly(file, (db) => {
    const scene = db
      .prepare(
        `SELECT 1 AS live FROM tree_nodes
          WHERE id = ? AND project_id = ? AND node_type = 'scene'
            AND archived_at IS NULL`,
      )
      .get(sceneId, projectId);
    const pins = db
      .prepare(
        `SELECT p.entry_id AS entryId, p.created_at AS createdAt,
                CASE WHEN c.id IS NULL THEN 0 ELSE 1 END AS inProject
           FROM scene_codex_pins p
           LEFT JOIN codex_entries c ON c.id = p.entry_id AND c.project_id = ?
          WHERE p.scene_id = ?
          ORDER BY p.created_at, p.entry_id`,
      )
      .all(projectId, sceneId);
    return {
      sceneLive: scene !== undefined,
      pins: pins.map((row) => ({
        entryId: String(row.entryId),
        createdAt: row.createdAt,
        entryInProject: Number(row.inProject) === 1,
      })),
    };
  });
}

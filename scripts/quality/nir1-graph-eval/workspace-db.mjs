// CP-4 S1c-2: read-only reads of a workspace `grimodex.db` from the harness
// process (DR-CP4-S1C2-5). Used for evidence only: the Index metadata
// (generation, dirty) before/after the declaration step and the sealed B
// generation, the setup read-back, and the Freshness feed state a measurement
// process waits on (DR-CP4-T-1). Each read opens its own read-only
// connection (`node:sqlite`, `readOnly: true`) and closes it; nothing writes.
// The measured samples never call this (the A3 record of a sample is the
// evaluation Native's own read-only connection).

import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";

/** The B (typed Entity/Relation Graph) and Chronicle Index keys. */
export const INDEX_KEYS = Object.freeze({
  b: "nir1-reviewed-entity-relation:v1",
  chronicle: "nir1-reviewed-chronicle:v1",
});

function withReadOnly(file, read, options = {}) {
  const db = new DatabaseSync(file, { readOnly: true, ...options });
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

/**
 * `options` are extra `DatabaseSync` options of the read-only connection
 * (TR: the trace's start seal passes `timeout: 0`, so a busy database makes
 * the read fail at once instead of waiting).
 */
export function readIndexMetadata(file, projectId, options = {}) {
  return withReadOnly(
    file,
    (db) =>
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
    options,
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

/** The product's Change Feed Freshness consumer (`narrative_extraction/mod.rs`). */
export const FRESHNESS_CONSUMER_ID = "narrative-incremental-freshness/v1";

/**
 * DR-CP4-T-1 (pure): one project's Freshness feed state from its reads — the
 * feed head (`COALESCE(MAX(canonical_sequence), 0)`), the consumer's cursor
 * row (or null) and the events past its acknowledged sequence.
 */
export function freshnessFeedState({
  head,
  cursor,
  pendingEvents,
  pendingSequences,
}) {
  return {
    consumerId: FRESHNESS_CONSUMER_ID,
    head: Number(head),
    cursor: cursor !== null && cursor !== undefined,
    acknowledged: cursor ? Number(cursor.acknowledged) : 0,
    activeRun:
      cursor?.activeRunId !== null && cursor?.activeRunId !== undefined,
    reserved: cursor?.reserved !== null && cursor?.reserved !== undefined,
    pendingEvents: Number(pendingEvents),
    pendingSequences: Number(pendingSequences),
  };
}

/**
 * DR-CP4-T-1 (pure): the product's Freshness has nothing left to do for the
 * project — its cursor reached the feed head and no run holds a reservation
 * (the selector `select_next_project`, `incremental_freshness.rs`). The ack
 * and the Index invalidation commit together, so a settled state has no
 * invalidation still to come from these events. Malformed reads never settle.
 */
export function freshnessSettled(state) {
  return (
    Number.isInteger(state?.head) &&
    Number.isInteger(state?.acknowledged) &&
    state.acknowledged >= state.head &&
    state.activeRun === false &&
    state.reserved === false
  );
}

/**
 * DR-CP4-T-1: one read-only read of the project's Freshness feed state on a
 * workspace DB the product has open (not immutable: it sees the product's
 * committed WAL). SELECT only; nothing writes.
 */
export function readFreshnessFeed(file, projectId, options = {}) {
  return withReadOnly(
    file,
    (db) => {
      const head = db
        .prepare(
          "SELECT COALESCE(MAX(canonical_sequence), 0) AS head FROM narrative_change_events WHERE project_id = ?",
        )
        .get(projectId).head;
      const cursor =
        db
          .prepare(
            `SELECT acknowledged_through_sequence AS acknowledged,
                    active_run_id AS activeRunId,
                    reserved_through_sequence AS reserved
               FROM narrative_change_cursors
              WHERE project_id = ? AND consumer_id = ?`,
          )
          .get(projectId, FRESHNESS_CONSUMER_ID) ?? null;
      const pending = db
        .prepare(
          `SELECT count(*) AS events, count(DISTINCT canonical_sequence) AS sequences
             FROM narrative_change_events
            WHERE project_id = ? AND canonical_sequence > ?`,
        )
        .get(projectId, cursor ? Number(cursor.acknowledged) : 0);
      return freshnessFeedState({
        head,
        cursor,
        pendingEvents: pending.events,
        pendingSequences: pending.sequences,
      });
    },
    options,
  );
}

/**
 * DR-CP4-T-1: polls `read` every `intervalMs` until the state is settled or
 * `limitMs` has passed. `now`／`sleep` are the caller's clock (the tests'
 * fakes). Returns the record the probe discloses.
 */
export async function waitFreshnessSettled({
  read,
  limitMs,
  intervalMs,
  now = () => performance.now(),
  sleep: pause = (ms) => sleep(ms),
}) {
  const started = now();
  const initial = read();
  let state = initial;
  let polls = 1;
  while (!freshnessSettled(state) && now() - started < limitMs) {
    await pause(intervalMs);
    state = read();
    polls += 1;
  }
  return {
    settled: freshnessSettled(state),
    waitedMs: now() - started,
    polls,
    limitMs,
    intervalMs,
    initial,
    final: state,
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

function tableExists(db, name) {
  return (
    db
      .prepare(
        "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name) !== undefined
  );
}

/**
 * S1i: the frozen setup's read-back of its cold DB (project-scoped rows the
 * logical → runtime check compares with the plan; ids, names and Scope only,
 * no body text). It reads no Index metadata (① forbids recording the Index
 * state), and the runtime policy row only to confirm maintenance stayed off.
 */
export function readFrozenSetupRows(file, projectId) {
  return withReadOnly(file, (db) => {
    const all = (sql, ...params) => db.prepare(sql).all(...params);
    const json = (text) => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    };
    const registry = db
      .prepare(
        `SELECT timeline_refs_json AS timelineRefs, worldline_refs_json AS worldlineRefs,
                narrative_layer_refs_json AS narrativeLayerRefs
           FROM narrative_scope_registries WHERE project_id = ?`,
      )
      .get(projectId);
    const policy = tableExists(db, "narrative_runtime_policy")
      ? all(
          "SELECT maintenance_enabled AS maintenanceEnabled FROM narrative_runtime_policy",
        )
      : [];
    return {
      projects: all("SELECT id FROM projects WHERE id = ?", projectId).map(
        (row) => String(row.id),
      ),
      scenes: all(
        `SELECT id, title, sort_order AS sortOrder, node_type AS nodeType,
                parent_id AS parentId, archived_at AS archivedAt,
                story_time_order AS storyTimeOrder, pov_character_id AS povCharacterId
           FROM tree_nodes WHERE project_id = ? ORDER BY sort_order, id`,
        projectId,
      ).map((row) => ({ ...row })),
      codexEntries: all(
        "SELECT id, type, name, summary FROM codex_entries WHERE project_id = ? ORDER BY id",
        projectId,
      ).map((row) => ({ ...row })),
      codexRelations: all(
        `SELECT id, from_codex_id AS fromCodexId, to_codex_id AS toCodexId,
                relation_type AS relationType, label, directionality
           FROM codex_relations WHERE project_id = ? ORDER BY id`,
        projectId,
      ).map((row) => ({ ...row })),
      foreshadows: all(
        `SELECT id, title, secret, payoff_scene_id AS payoffSceneId,
                payoff_confirmed AS payoffConfirmed, abandoned
           FROM foreshadows WHERE project_id = ? ORDER BY id`,
        projectId,
      ).map((row) => ({
        id: String(row.id),
        title: row.title,
        secret: Number(row.secret) === 1,
        payoffSceneId: row.payoffSceneId ?? null,
        payoffConfirmed: Number(row.payoffConfirmed) === 1,
        abandoned: Number(row.abandoned) === 1,
      })),
      foreshadowLinks: all(
        `SELECT l.foreshadow_id AS foreshadowId, l.codex_entry_id AS entryId
           FROM foreshadow_codex_links l JOIN foreshadows f ON f.id = l.foreshadow_id
          WHERE f.project_id = ? ORDER BY l.foreshadow_id, l.codex_entry_id`,
        projectId,
      ).map((row) => ({ ...row })),
      pins: all(
        `SELECT p.scene_id AS sceneId, p.entry_id AS entryId
           FROM scene_codex_pins p JOIN tree_nodes t ON t.id = p.scene_id
          WHERE t.project_id = ? ORDER BY p.scene_id, p.entry_id`,
        projectId,
      ).map((row) => ({ ...row })),
      registry: registry
        ? {
            timelineRefs: json(registry.timelineRefs),
            worldlineRefs: json(registry.worldlineRefs),
            narrativeLayerRefs: json(registry.narrativeLayerRefs),
          }
        : null,
      bindings: all(
        `SELECT scene_id AS sceneId, compatibility_marker AS marker,
                query_identity_json AS queryIdentity, material_constraint_json AS materialConstraint,
                knowledge_holder_json AS knowledgeHolder, audience_json AS audience
           FROM narrative_scene_scope_bindings WHERE project_id = ? ORDER BY scene_id`,
        projectId,
      ).map((row) => ({
        sceneId: String(row.sceneId),
        marker: row.marker,
        queryIdentity: json(row.queryIdentity),
        materialConstraint: json(row.materialConstraint),
        knowledgeHolder: json(row.knowledgeHolder),
        audience: json(row.audience),
      })),
      // The product default (no row) is maintenance off.
      maintenanceEnabled: policy.some(
        (row) => Number(row.maintenanceEnabled) === 1,
      ),
    };
  });
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

const parseJson = (text) => {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * S1j-2: the project's Chronicle extraction rows (read-only): each
 * `chronicle.extract` run with its proposals, every revision of those
 * proposals (the payload and the reconciliation envelope, parsed) and every
 * Decision in creation order. The setup's qualified-ir read-back.
 */
export function readChronicleSetupRows(file, projectId) {
  return withReadOnly(file, (db) => {
    const runs = db
      .prepare(
        `SELECT id AS runId FROM narrative_extraction_runs
          WHERE project_id = ? AND surface_path_id = 'chronicle.extract'
          ORDER BY id`,
      )
      .all(projectId)
      .map((row) => String(row.runId));
    return runs.map((runId) => {
      const proposals = db
        .prepare(
          `SELECT p.id AS proposalId, p.status, p.current_revision_id AS currentRevisionId
             FROM narrative_proposals p
             JOIN narrative_proposal_sets s ON s.id = p.proposal_set_id
            WHERE s.run_id = ? ORDER BY p.id`,
        )
        .all(runId)
        .map((proposal) => ({
          proposalId: String(proposal.proposalId),
          status: proposal.status,
          currentRevisionId:
            proposal.currentRevisionId === null
              ? null
              : String(proposal.currentRevisionId),
          revisions: db
            .prepare(
              `SELECT id AS revisionId, revision_number AS revisionNumber,
                      payload_json AS payloadJson,
                      reconciliation_envelope_json AS envelopeJson
                 FROM narrative_proposal_revisions
                WHERE proposal_id = ? ORDER BY revision_number`,
            )
            .all(proposal.proposalId)
            .map((row) => ({
              revisionId: String(row.revisionId),
              revisionNumber: Number(row.revisionNumber),
              payload: parseJson(row.payloadJson),
              envelope: parseJson(row.envelopeJson),
            })),
          decisions: db
            .prepare(
              `SELECT id AS decisionId, revision_id AS revisionId, decision,
                      created_by AS createdBy, created_at AS createdAt
                 FROM narrative_proposal_decisions
                WHERE proposal_id = ? ORDER BY created_at, id`,
            )
            .all(proposal.proposalId)
            .map((row) => ({
              decisionId: String(row.decisionId),
              revisionId: String(row.revisionId),
              decision: row.decision,
              createdBy: row.createdBy,
            })),
        }));
      return { runId, proposals };
    });
  });
}

/**
 * S1j-2 P-0: the project's extraction／maintenance runs created at or after
 * `sinceIso`, counted by surface and status (read-only). The seal attempts'
 * evidence of whether the maintenance cycle ran at all.
 */
export function readRunsSince(file, projectId, sinceIso) {
  return withReadOnly(file, (db) => {
    const exists = db
      .prepare(
        "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'narrative_extraction_runs'",
      )
      .get();
    if (!exists) return [];
    return db
      .prepare(
        `SELECT surface_path_id AS surface, status, count(*) AS n
           FROM narrative_extraction_runs
          WHERE project_id = ? AND created_at >= ?
          GROUP BY surface_path_id, status ORDER BY surface_path_id, status`,
      )
      .all(projectId, sinceIso)
      .map((row) => ({
        surface: row.surface,
        status: row.status,
        count: Number(row.n),
      }));
  });
}

/**
 * Review P2-3: a typed Revision's stored Source token of one Relation
 * (`narrative_revision_source_basis`, key `codex-relation:<id>`) and the
 * token the Relation's current row gives (`v<version>@<updated_at>:relation:
 * <id>`, the product's form; null when the row is gone). Read-only.
 */
export function readRelationSourceTokens(file, revisionId, relationId) {
  return withReadOnly(file, (db) => {
    const stored =
      db
        .prepare(
          "SELECT revision_token AS token FROM narrative_revision_source_basis WHERE revision_id = ? AND source_key = ?",
        )
        .get(revisionId, `codex-relation:${relationId}`)?.token ?? null;
    const row = db
      .prepare(
        "SELECT version, updated_at AS updatedAt FROM codex_relations WHERE id = ?",
      )
      .get(relationId);
    return {
      stored,
      current: row
        ? `v${row.version}@${row.updatedAt}:relation:${relationId}`
        : null,
    };
  });
}

/**
 * The columns of `table`, all of `wanted` (review P3 (d)): a column the
 * schema lacks stops the read instead of being skipped silently.
 */
function existingColumns(db, table, wanted) {
  const have = new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name),
  );
  const missing = wanted.filter((name) => !have.has(name));
  if (missing.length > 0)
    throw new Error(
      `[precheck] ${table} lacks ${missing.join(", ")}; the declaration invariants cannot be read`,
    );
  return wanted;
}

const digestRows = (rows) =>
  createHash("sha256")
    .update(JSON.stringify(rows.map((row) => ({ ...row }))))
    .digest("hex");

/**
 * S5-A (K2/4 :407, S3-P3-6): the values the declaration writer never writes,
 * as digests (read-only): the tree order, the project's registry, every
 * Scene binding's v1 columns (version, source token, updated_at) and its A1
 * columns (the explicit Scene Scope). The runner reads them just before and
 * just after the declaration step and compares.
 */
export function readDeclarationInvariants(file, projectId) {
  return withReadOnly(file, (db) => {
    const select = (table, wanted, where, order) => {
      const columns = existingColumns(db, table, wanted);
      return db
        .prepare(
          `SELECT ${columns.join(", ")} FROM ${table} WHERE ${where} ORDER BY ${order}`,
        )
        .all(projectId);
    };
    const tree = select(
      "tree_nodes",
      ["id", "parent_id", "sort_order", "node_type", "archived_at"],
      "project_id = ?",
      "id",
    );
    const registry = select(
      "narrative_scope_registries",
      [
        "registry_version",
        "timeline_refs_json",
        "worldline_refs_json",
        "narrative_layer_refs_json",
        "version",
        "source_token",
        "updated_at",
      ],
      "project_id = ?",
      "project_id",
    );
    const v1 = select(
      "narrative_scene_scope_bindings",
      ["scene_id", "version", "source_token", "updated_at"],
      "project_id = ?",
      "scene_id",
    );
    const a1 = select(
      "narrative_scene_scope_bindings",
      [
        "scene_id",
        "scene_incarnation_id",
        "compatibility_marker",
        "query_identity_json",
        "material_constraint_json",
        "knowledge_holder_json",
        "audience_json",
      ],
      "project_id = ?",
      "scene_id",
    );
    return {
      treeOrder: { rows: tree.length, sha256: digestRows(tree) },
      registry: { rows: registry.length, sha256: digestRows(registry) },
      sceneV1: { rows: v1.length, sha256: digestRows(v1) },
      a1: { rows: a1.length, sha256: digestRows(a1) },
    };
  });
}

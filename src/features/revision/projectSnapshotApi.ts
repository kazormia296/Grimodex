import { db } from "@/db/client";
import { invoke } from "@/lib/tauri";
import {
  projectSnapshots,
  projectSnapshotEntries,
  projectSnapshotTreeNodes,
  projectSnapshotCodexEntries,
  projectSnapshotSnippets,
  projectSnapshotAux,
  contentVersions,
  treeNodes,
  codexEntries,
  snippets,
} from "@/db/schema";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { createRevision } from "./api";
import type { EntityType } from "./api";
import { getCurrentProjectId } from "@/features/project/projectStore";
import {
  AUX_SCOPES,
  AUX_SCOPE_OWNER,
  AUX_TABLE,
  AUX_BODY_DEPENDENCY,
  AUX_CODEX_DEPENDENCY,
  emptySkipReport,
  fullRestoreScopeSet,
  parseAuxPayload,
  serializeAuxPayload,
  type AuxScope,
  type RawRow,
  type RestoreScope,
  type SkipReport,
} from "./projectSnapshotScopes";

export interface ProjectSnapshotMeta {
  id: string;
  name: string;
  description: string | null;
  entryCount: number;
  createdAt: string;
  isStructural: boolean;
}

export type RestoreFormat = "structural" | "legacy";

export interface RestoreResult {
  restoredCount: number;
  safetySnapshotId: string;
  format: RestoreFormat;
  skipped: SkipReport;
}

// ── raw SQL helpers ────────────────────────────────────────────────

type SqlParam = string | number | null;

interface BatchStmt {
  sql: string;
  params: SqlParam[];
  method: string;
}

async function rawAll(
  sqlText: string,
  params: SqlParam[] = [],
): Promise<RawRow[]> {
  const res = await invoke<{ rows: RawRow[] }>("db_execute", {
    sql: sqlText,
    params,
    method: "all",
  });
  return res.rows;
}

async function rawBatch(statements: BatchStmt[]): Promise<void> {
  if (statements.length === 0) return;
  await invoke("db_execute_batch", { statements });
}

function inPlaceholders(n: number): string {
  return n === 0 ? "NULL" : Array(n).fill("?").join(", ");
}

/**
 * Build an INSERT statement from an object's keys. Use `mode='replace'` to
 * generate `INSERT OR REPLACE` (handy for legacy-content overwrite where
 * cascade is acceptable); default `mode='insert'` is plain INSERT.
 *
 * For tables where conflict is expected (re-running into pre-existing rows),
 * use `mode='ignore'`.
 */
function buildInsert(
  table: string,
  row: Record<string, SqlParam>,
  mode: "insert" | "ignore" | "replace" = "insert",
): BatchStmt {
  const keys = Object.keys(row);
  const cols = keys.map((k) => `"${k}"`).join(", ");
  const ph = keys.map(() => "?").join(", ");
  const prefix =
    mode === "ignore"
      ? "INSERT OR IGNORE"
      : mode === "replace"
        ? "INSERT OR REPLACE"
        : "INSERT";
  return {
    sql: `${prefix} INTO "${table}" (${cols}) VALUES (${ph})`,
    params: keys.map((k) => row[k]),
    method: "run",
  };
}

// ── createProjectSnapshot ──────────────────────────────────────────

/** Get the latest revision ID for an entity, or create one if content differs. */
async function getOrCreateRevisionId(
  entityType: EntityType,
  entityId: string,
  content: string,
): Promise<string | null> {
  const rev = await createRevision({
    entityType,
    entityId,
    content,
    snapshotType: "manual",
  });
  if (rev) return rev.id;
  const rows = await db
    .select({ id: contentVersions.id })
    .from(contentVersions)
    .where(
      and(
        eq(contentVersions.entityType, entityType),
        eq(contentVersions.entityId, entityId),
      ),
    )
    .orderBy(desc(contentVersions.versionNumber))
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * Create a named project snapshot capturing the current state of every scope
 * (structural metadata + body content via content_versions pointer +
 * ancillary tables as aux JSON). Snapshot creation is not strictly
 * transactional — partial-failure leftovers in content_versions are harmless
 * and prunable. Restore *is* transactional.
 */
export async function createProjectSnapshot(params: {
  name: string;
  description?: string;
}): Promise<{ id: string; entryCount: number }> {
  const { name, description } = params;
  const PROJECT_ID = getCurrentProjectId();
  const snapshotId = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.insert(projectSnapshots).values({
    id: snapshotId,
    projectId: PROJECT_ID,
    name,
    description: description ?? null,
    createdAt: now,
  });

  // Capture tree_nodes (scenes / notes / folders).
  // Folders have empty content; getOrCreateRevisionId is skipped for them.
  const nodes = await db
    .select()
    .from(treeNodes)
    .where(eq(treeNodes.projectId, PROJECT_ID));

  const treeNodeRows: (typeof projectSnapshotTreeNodes.$inferInsert)[] = [];
  const versionIds: string[] = [];
  for (const node of nodes) {
    const isContentEntity =
      node.nodeType === "scene" || node.nodeType === "note";
    let bodyVersionId: string | null = null;
    if (isContentEntity && node.content && node.content !== "{}") {
      bodyVersionId = await getOrCreateRevisionId(
        node.nodeType as EntityType,
        node.id,
        node.content,
      );
      if (bodyVersionId) versionIds.push(bodyVersionId);
    }
    treeNodeRows.push({
      snapshotId,
      nodeId: node.id,
      parentId: node.parentId ?? null,
      nodeType: node.nodeType,
      title: node.title,
      synopsis: node.synopsis ?? null,
      sortOrder: node.sortOrder,
      storyTimeOrder: node.storyTimeOrder ?? null,
      storyTimeLabel: node.storyTimeLabel ?? null,
      povCharacterId: node.povCharacterId ?? null,
      locationId: node.locationId ?? null,
      status: node.status ?? null,
      bodyVersionId,
      unplacedBeatsDoc: node.unplacedBeatsDoc,
      charCount: node.charCount,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
    });
  }
  if (treeNodeRows.length > 0) {
    await db.insert(projectSnapshotTreeNodes).values(treeNodeRows);
  }

  // Capture codex_entries
  const codexRows = await db
    .select()
    .from(codexEntries)
    .where(eq(codexEntries.projectId, PROJECT_ID));

  const codexSnapRows: (typeof projectSnapshotCodexEntries.$inferInsert)[] = [];
  for (const entry of codexRows) {
    let bodyVersionId: string | null = null;
    if (entry.content && entry.content !== "{}") {
      bodyVersionId = await getOrCreateRevisionId(
        "codex_entry",
        entry.id,
        entry.content,
      );
      if (bodyVersionId) versionIds.push(bodyVersionId);
    }
    codexSnapRows.push({
      snapshotId,
      entryId: entry.id,
      type: entry.type,
      name: entry.name,
      parentId: entry.parentId ?? null,
      aliases: entry.aliases ?? null,
      excludedAliases: entry.excludedAliases ?? null,
      summary: entry.summary ?? null,
      icon: entry.icon ?? null,
      contextMode: entry.contextMode,
      childrenBudget: entry.childrenBudget,
      notes: entry.notes ?? null,
      bodyVersionId,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    });
  }
  if (codexSnapRows.length > 0) {
    await db.insert(projectSnapshotCodexEntries).values(codexSnapRows);
  }

  // Capture snippets
  const snippetRows = await db
    .select()
    .from(snippets)
    .where(eq(snippets.projectId, PROJECT_ID));

  const snippetSnapRows: (typeof projectSnapshotSnippets.$inferInsert)[] = [];
  for (const snippet of snippetRows) {
    let bodyVersionId: string | null = null;
    if (snippet.content && snippet.content !== "{}") {
      bodyVersionId = await getOrCreateRevisionId(
        "snippet",
        snippet.id,
        snippet.content,
      );
      if (bodyVersionId) versionIds.push(bodyVersionId);
    }
    snippetSnapRows.push({
      snapshotId,
      snippetId: snippet.id,
      title: snippet.title,
      sceneId: snippet.sceneId ?? null,
      sourceChatMessageId: snippet.sourceChatMessageId ?? null,
      bodyVersionId,
      createdAt: snippet.createdAt,
      updatedAt: snippet.updatedAt,
    });
  }
  if (snippetSnapRows.length > 0) {
    await db.insert(projectSnapshotSnippets).values(snippetSnapRows);
  }

  // Legacy mirror table: keep one row per body_version_id so older clients
  // can still derive entryCount and the "content-only" restore path works.
  if (versionIds.length > 0) {
    await db
      .insert(projectSnapshotEntries)
      .values(versionIds.map((versionId) => ({ snapshotId, versionId })));
  }

  // Aux scopes: one JSON row per aux scope, capturing every row of the
  // source table verbatim. Single-project app: SELECT * with no WHERE.
  // Some aux tables may not exist in the current DB (browser-mock omits
  // tables it doesn't need) — treat those as empty payloads rather than
  // failing the whole snapshot.
  const auxInserts: (typeof projectSnapshotAux.$inferInsert)[] = [];
  for (const scope of AUX_SCOPES) {
    const table = AUX_TABLE[scope];
    let rows: RawRow[];
    try {
      rows = await rawAll(`SELECT * FROM "${table}"`);
    } catch {
      // table likely doesn't exist in this DB; record an empty payload so
      // restore stays a no-op for this scope.
      rows = [];
    }
    auxInserts.push({
      snapshotId,
      scope,
      payloadJson: serializeAuxPayload({ rows }),
    });
  }
  if (auxInserts.length > 0) {
    await db.insert(projectSnapshotAux).values(auxInserts);
  }

  return { id: snapshotId, entryCount: versionIds.length };
}

// ── listProjectSnapshots ───────────────────────────────────────────

export async function listProjectSnapshots(): Promise<ProjectSnapshotMeta[]> {
  const PROJECT_ID = getCurrentProjectId();
  const snaps = await db
    .select()
    .from(projectSnapshots)
    .where(eq(projectSnapshots.projectId, PROJECT_ID))
    .orderBy(desc(projectSnapshots.createdAt));

  const results: ProjectSnapshotMeta[] = [];
  for (const snap of snaps) {
    const countRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(projectSnapshotEntries)
      .where(eq(projectSnapshotEntries.snapshotId, snap.id));
    // Structural snapshots always write at least one row to
    // project_snapshot_aux (every aux scope, even empty ones). Legacy
    // snapshots never touch aux. A codex-only or snippet-only project
    // would have zero project_snapshot_tree_nodes rows but still be
    // structural — so checking aux instead of tree_nodes is correct.
    const auxCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(projectSnapshotAux)
      .where(eq(projectSnapshotAux.snapshotId, snap.id));
    results.push({
      id: snap.id,
      name: snap.name,
      description: snap.description,
      entryCount: Number(countRows[0]?.count ?? 0),
      createdAt: snap.createdAt,
      isStructural: Number(auxCount[0]?.count ?? 0) > 0,
    });
  }
  return results;
}

// ── deleteProjectSnapshot (unchanged behaviour) ────────────────────

export async function deleteProjectSnapshot(snapshotId: string): Promise<void> {
  await db.delete(projectSnapshots).where(eq(projectSnapshots.id, snapshotId));
}

// ── restoreProjectSnapshot ─────────────────────────────────────────

export interface RestoreOptions {
  scopes?: ReadonlySet<RestoreScope>;
}

/**
 * Legacy path: only UPDATEs `content` for entities whose ID is still present.
 * Used for snapshots predating the structural-snapshot schema, and for the
 * regression test fixtures that pre-date this change.
 */
async function restoreLegacyContentOnly(snapshotId: string): Promise<number> {
  const entries = await db
    .select({ versionId: projectSnapshotEntries.versionId })
    .from(projectSnapshotEntries)
    .where(eq(projectSnapshotEntries.snapshotId, snapshotId));
  const versionIds = entries.map((e) => e.versionId);
  if (versionIds.length === 0) return 0;

  const versions = await db
    .select()
    .from(contentVersions)
    .where(inArray(contentVersions.id, versionIds));

  const now = new Date().toISOString();
  let restored = 0;
  for (const v of versions) {
    if (v.entityType === "scene" || v.entityType === "note") {
      await db
        .update(treeNodes)
        .set({ content: v.content, updatedAt: now })
        .where(eq(treeNodes.id, v.entityId));
    } else if (v.entityType === "codex_entry") {
      await db
        .update(codexEntries)
        .set({ content: v.content, updatedAt: now })
        .where(eq(codexEntries.id, v.entityId));
    } else if (v.entityType === "snippet") {
      await db
        .update(snippets)
        .set({ content: v.content, updatedAt: now })
        .where(eq(snippets.id, v.entityId));
    }
    restored++;
  }
  return restored;
}

/**
 * Structural restore. Builds a single transactional batch of statements:
 *
 *  1. `PRAGMA defer_foreign_keys = ON` — checks run at COMMIT, so INSERT
 *     order across FK edges doesn't matter.
 *  2. Pre-NULL cross-scope CASCADE FKs whose target scope is being wiped
 *     but whose source scope is not (otherwise CASCADE silently deletes the
 *     source rows during wipe — e.g. wiping body cascade-deletes
 *     map_node_positions even when the map scope was excluded).
 *  3. Wipe selected scopes (DELETE on each top-level table; CASCADE handles
 *     owned children).
 *  4. Restore selected scopes by INSERTing every snapshot row, applying
 *     skip / NULL rules from `AUX_BODY_DEPENDENCY` / `AUX_CODEX_DEPENDENCY`
 *     for cross-scope references that the user excluded.
 *  5. COMMIT — defer_foreign_keys is automatically reset.
 */
async function restoreStructural(
  snapshotId: string,
  scopes: ReadonlySet<RestoreScope>,
): Promise<{ restoredCount: number; skipped: SkipReport }> {
  const PROJECT_ID = getCurrentProjectId();
  const skipped = emptySkipReport();
  const stmts: BatchStmt[] = [];

  // Live table set: snapshots may carry data for aux tables that don't
  // exist in this DB instance (e.g. browser-mock omits some). Filter any
  // statement whose target table isn't present.
  const liveTables = new Set<string>();
  {
    const rows = await rawAll(
      `SELECT name FROM sqlite_master WHERE type = 'table'`,
    );
    for (const r of rows) {
      if (typeof r.name === "string") liveTables.add(r.name);
    }
  }
  function pushStmt(s: BatchStmt): void {
    const m =
      /(?:INSERT(?:\s+OR\s+(?:IGNORE|REPLACE))?\s+INTO|UPDATE|DELETE\s+FROM)\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i.exec(
        s.sql,
      );
    if (m && !liveTables.has(m[1])) return;
    stmts[stmts.length] = s;
  }

  // Pre-flight reads from snapshot tables
  const treeRows = await rawAll(
    `SELECT * FROM project_snapshot_tree_nodes WHERE snapshot_id = ?`,
    [snapshotId],
  );
  const codexRows = await rawAll(
    `SELECT * FROM project_snapshot_codex_entries WHERE snapshot_id = ?`,
    [snapshotId],
  );
  const snippetRows = await rawAll(
    `SELECT * FROM project_snapshot_snippets WHERE snapshot_id = ?`,
    [snapshotId],
  );
  const auxRows = await rawAll(
    `SELECT scope, payload_json FROM project_snapshot_aux WHERE snapshot_id = ?`,
    [snapshotId],
  );
  const auxByScope = new Map<AuxScope, RawRow[]>();
  for (const r of auxRows) {
    const scope = r.scope as AuxScope;
    const json = String(r.payload_json ?? "");
    auxByScope.set(scope, parseAuxPayload(json).rows);
  }

  // Resolve body content via content_versions
  const bodyVersionIds = [
    ...treeRows
      .map((r) => r.body_version_id)
      .filter((x): x is string => typeof x === "string"),
    ...codexRows
      .map((r) => r.body_version_id)
      .filter((x): x is string => typeof x === "string"),
    ...snippetRows
      .map((r) => r.body_version_id)
      .filter((x): x is string => typeof x === "string"),
  ];
  const contentById = new Map<string, string>();
  if (bodyVersionIds.length > 0) {
    const versions = await rawAll(
      `SELECT id, content FROM content_versions WHERE id IN (${inPlaceholders(bodyVersionIds.length)})`,
      bodyVersionIds,
    );
    for (const v of versions) {
      if (typeof v.id === "string" && typeof v.content === "string") {
        contentById.set(v.id, v.content);
      }
    }
  }

  // Live codex_entry ids that exist now — used when codex scope is not
  // selected to decide whether `pov_character_id` / `location_id` on
  // restored tree_nodes can keep their value or must be NULLed.
  const liveCodexIds = new Set<string>();
  if (!scopes.has("codex")) {
    const liveCodex = await rawAll(
      `SELECT id FROM codex_entries WHERE project_id = ?`,
      [PROJECT_ID],
    );
    for (const r of liveCodex) {
      if (typeof r.id === "string") liveCodexIds.add(r.id);
    }
  }

  // Live tree_node ids — used when body scope is not selected to decide
  // whether cross-scope FKs to tree_nodes can keep their value.
  const liveTreeNodeIds = new Set<string>();
  if (!scopes.has("body")) {
    const live = await rawAll(
      `SELECT id FROM tree_nodes WHERE project_id = ?`,
      [PROJECT_ID],
    );
    for (const r of live) {
      if (typeof r.id === "string") liveTreeNodeIds.add(r.id);
    }
  }

  // Live codex_tag ids — used by snippet_entry_tags / codex_entry_tags when
  // codex scope is not selected (the codex_tags row may have been removed
  // post-snapshot).
  const liveCodexTagIds = new Set<string>();
  if (!scopes.has("codex")) {
    const live = await rawAll(`SELECT id FROM codex_tags`);
    for (const r of live) {
      if (typeof r.id === "string") liveCodexTagIds.add(r.id);
    }
  }

  // ── 1. defer_foreign_keys ────────────────────────────────────
  stmts.push({
    sql: "PRAGMA defer_foreign_keys = ON",
    params: [],
    method: "run",
  });

  // ── 2. Pre-NULL cross-scope CASCADE FKs ─────────────────────
  // map_node_positions has CASCADE on tree_node_id and codex_entry_id.
  // If we wipe their target without rebuilding the map scope, the position
  // rows would silently disappear.
  if (scopes.has("body") && !scopes.has("map")) {
    pushStmt({
      sql: "UPDATE map_node_positions SET tree_node_id = NULL WHERE tree_node_id IS NOT NULL",
      params: [],
      method: "run",
    });
  }
  if (scopes.has("codex") && !scopes.has("map")) {
    pushStmt({
      sql: "UPDATE map_node_positions SET codex_entry_id = NULL WHERE codex_entry_id IS NOT NULL",
      params: [],
      method: "run",
    });
  }

  // ── 3. Wipe selected scopes ─────────────────────────────────
  if (scopes.has("body")) {
    pushStmt({
      sql: "DELETE FROM tree_nodes WHERE project_id = ?",
      params: [PROJECT_ID],
      method: "run",
    });
  }
  if (scopes.has("codex")) {
    pushStmt({
      sql: "DELETE FROM codex_entries WHERE project_id = ?",
      params: [PROJECT_ID],
      method: "run",
    });
    pushStmt({
      sql: "DELETE FROM codex_types WHERE project_id = ?",
      params: [PROJECT_ID],
      method: "run",
    });
    pushStmt({
      sql: "DELETE FROM codex_tags WHERE project_id = ?",
      params: [PROJECT_ID],
      method: "run",
    });
    pushStmt({
      sql: "DELETE FROM codex_detail_definitions WHERE project_id = ?",
      params: [PROJECT_ID],
      method: "run",
    });
  }
  if (scopes.has("snippet")) {
    pushStmt({
      sql: "DELETE FROM snippets WHERE project_id = ?",
      params: [PROJECT_ID],
      method: "run",
    });
  }
  if (scopes.has("map")) {
    pushStmt({
      sql: "DELETE FROM map_boards WHERE project_id = ?",
      params: [PROJECT_ID],
      method: "run",
    });
  }
  if (scopes.has("foreshadow")) {
    pushStmt({
      sql: "DELETE FROM foreshadows WHERE project_id = ?",
      params: [PROJECT_ID],
      method: "run",
    });
  }
  if (scopes.has("labels")) {
    pushStmt({
      sql: "DELETE FROM labels WHERE project_id = ?",
      params: [PROJECT_ID],
      method: "run",
    });
  }
  if (scopes.has("lint")) {
    pushStmt({
      sql: "DELETE FROM lint_ignored_diagnostics",
      params: [],
      method: "run",
    });
    pushStmt({
      sql: "DELETE FROM lint_term_dictionary",
      params: [],
      method: "run",
    });
  }

  // ── 4. Restore inserts ──────────────────────────────────────
  let restoredCount = 0;

  // codex
  if (scopes.has("codex")) {
    for (const row of auxByScope.get("codex_types") ?? []) {
      // built-in trigger may have already created some types; INSERT OR
      // REPLACE so we end up with the snapshot's exact set including
      // any user-customised colour/icon.
      pushStmt(buildInsert("codex_types", row, "replace"));
    }
    for (const row of codexRows) {
      const content = row.body_version_id
        ? (contentById.get(String(row.body_version_id)) ?? "{}")
        : "{}";
      const fallbackNow = new Date().toISOString();
      pushStmt(
        buildInsert("codex_entries", {
          id: row.entry_id as string,
          project_id: PROJECT_ID,
          parent_id: (row.parent_id as string | null) ?? null,
          type: row.type as string,
          name: row.name as string,
          aliases: (row.aliases as string | null) ?? null,
          excluded_aliases: (row.excluded_aliases as string | null) ?? null,
          summary: (row.summary as string | null) ?? null,
          content,
          icon: (row.icon as string | null) ?? null,
          tags_cache: null,
          context_mode: row.context_mode as string,
          children_budget: row.children_budget as string,
          source_chat_message_id: null,
          notes: (row.notes as string | null) ?? null,
          created_at: (row.created_at as string | null) ?? fallbackNow,
          updated_at: (row.updated_at as string | null) ?? fallbackNow,
        }),
      );
      restoredCount++;
    }
    for (const row of auxByScope.get("codex_tags") ?? []) {
      pushStmt(buildInsert("codex_tags", row));
    }
    for (const row of auxByScope.get("codex_detail_definitions") ?? []) {
      pushStmt(buildInsert("codex_detail_definitions", row));
    }
    for (const row of auxByScope.get("codex_entry_tags") ?? []) {
      pushStmt(buildInsert("codex_entry_tags", row));
    }
    for (const row of auxByScope.get("codex_detail_values") ?? []) {
      pushStmt(buildInsert("codex_detail_values", row));
    }
    for (const row of auxByScope.get("codex_entry_phases") ?? []) {
      pushStmt(buildInsert("codex_entry_phases", row));
    }
    for (const row of auxByScope.get("codex_phase_detail_overrides") ?? []) {
      pushStmt(buildInsert("codex_phase_detail_overrides", row));
    }
    for (const row of auxByScope.get("codex_quick_pins") ?? []) {
      pushStmt(buildInsert("codex_quick_pins", row));
    }
    for (const row of auxByScope.get("codex_dismissed_relations") ?? []) {
      pushStmt(buildInsert("codex_dismissed_relations", row));
    }
  }

  // body (tree_nodes + body-owned aux scopes)
  if (scopes.has("body")) {
    for (const row of treeRows) {
      const content = row.body_version_id
        ? (contentById.get(String(row.body_version_id)) ?? "{}")
        : "{}";
      // pov/location: if codex scope not selected and the codex entry no
      // longer exists in the live DB, NULL out the FK.
      const povId = (row.pov_character_id as string | null) ?? null;
      const locId = (row.location_id as string | null) ?? null;
      const safePov =
        scopes.has("codex") || povId === null || liveCodexIds.has(povId)
          ? povId
          : null;
      const safeLoc =
        scopes.has("codex") || locId === null || liveCodexIds.has(locId)
          ? locId
          : null;
      const fallbackNow = new Date().toISOString();
      pushStmt(
        buildInsert("tree_nodes", {
          id: row.node_id as string,
          project_id: PROJECT_ID,
          parent_id: (row.parent_id as string | null) ?? null,
          node_type: row.node_type as string,
          title: row.title as string,
          synopsis: (row.synopsis as string | null) ?? null,
          sort_order: row.sort_order as string,
          story_time_order: (row.story_time_order as string | null) ?? null,
          story_time_label: (row.story_time_label as string | null) ?? null,
          pov_character_id: safePov,
          location_id: safeLoc,
          status: (row.status as string | null) ?? null,
          content,
          unplaced_beats_doc: (row.unplaced_beats_doc as string | null) ?? "[]",
          char_count: (row.char_count as number | null) ?? 0,
          unplaced_beat_preview: null,
          placed_beat_preview: null,
          created_at: (row.created_at as string | null) ?? fallbackNow,
          updated_at: (row.updated_at as string | null) ?? fallbackNow,
        }),
      );
      restoredCount++;
    }
    // body-owned aux (each may FK to codex; filter when codex is excluded)
    for (const row of auxByScope.get("authorship_spans") ?? []) {
      pushStmt(buildInsert("authorship_spans", row));
    }
    for (const row of auxByScope.get("post_effect_annotations") ?? []) {
      // run_id refs post_effect_runs (not in any scope, may be NULL). All
      // other FKs are scene_id (CASCADE, nullable) — body scope itself.
      pushStmt(buildInsert("post_effect_annotations", row));
    }
    for (const row of auxByScope.get("post_effect_annotation_relations") ??
      []) {
      pushStmt(buildInsert("post_effect_annotation_relations", row));
    }
    for (const row of auxByScope.get("scene_codex_pins") ?? []) {
      if (
        !scopes.has("codex") &&
        typeof row.entry_id === "string" &&
        !liveCodexIds.has(row.entry_id)
      ) {
        skipped.sceneCodexPins++;
        continue;
      }
      pushStmt(buildInsert("scene_codex_pins", row));
    }
    for (const row of auxByScope.get("scene_codex_mentions") ?? []) {
      if (
        !scopes.has("codex") &&
        typeof row.codex_entry_id === "string" &&
        !liveCodexIds.has(row.codex_entry_id)
      ) {
        skipped.sceneCodexMentions++;
        continue;
      }
      pushStmt(buildInsert("scene_codex_mentions", row));
    }
    for (const row of auxByScope.get("scene_beat_pov_cache") ?? []) {
      if (
        !scopes.has("codex") &&
        typeof row.pov_character_id === "string" &&
        !liveCodexIds.has(row.pov_character_id)
      ) {
        skipped.sceneBeatPovCache++;
        continue;
      }
      pushStmt(buildInsert("scene_beat_pov_cache", row));
    }
  }

  // snippet
  if (scopes.has("snippet")) {
    for (const row of snippetRows) {
      const content = row.body_version_id
        ? (contentById.get(String(row.body_version_id)) ?? "{}")
        : "{}";
      const sceneId = (row.scene_id as string | null) ?? null;
      const safeScene =
        scopes.has("body") || sceneId === null || liveTreeNodeIds.has(sceneId)
          ? sceneId
          : null;
      const fallbackNow = new Date().toISOString();
      pushStmt(
        buildInsert("snippets", {
          id: row.snippet_id as string,
          project_id: PROJECT_ID,
          title: row.title as string,
          scene_id: safeScene,
          source_chat_message_id:
            (row.source_chat_message_id as string | null) ?? null,
          content,
          source_marker: null,
          created_at: (row.created_at as string | null) ?? fallbackNow,
          updated_at: (row.updated_at as string | null) ?? fallbackNow,
        }),
      );
      restoredCount++;
    }
    for (const row of auxByScope.get("snippet_entry_tags") ?? []) {
      // FK to codex_tags. If codex scope unselected and tag missing live, skip.
      if (
        !scopes.has("codex") &&
        typeof row.tag_id === "string" &&
        !liveCodexTagIds.has(row.tag_id)
      ) {
        continue; // not tracked individually in SkipReport
      }
      pushStmt(buildInsert("snippet_entry_tags", row));
    }
  }

  // labels
  if (scopes.has("labels")) {
    for (const row of auxByScope.get("labels") ?? []) {
      pushStmt(buildInsert("labels", row));
    }
    if (scopes.has("body")) {
      for (const row of auxByScope.get("tree_node_labels") ?? []) {
        pushStmt(buildInsert("tree_node_labels", row));
      }
    } else {
      const treeLabels = auxByScope.get("tree_node_labels") ?? [];
      // Restore rows whose node_id still exists in the live DB
      for (const row of treeLabels) {
        if (
          typeof row.node_id === "string" &&
          liveTreeNodeIds.has(row.node_id)
        ) {
          pushStmt(buildInsert("tree_node_labels", row));
        } else {
          skipped.treeNodeLabels++;
        }
      }
    }
  }

  // foreshadow
  if (scopes.has("foreshadow")) {
    for (const row of auxByScope.get("foreshadows") ?? []) {
      let payoffSceneId = (row.payoff_scene_id as string | null) ?? null;
      if (
        !scopes.has("body") &&
        typeof payoffSceneId === "string" &&
        !liveTreeNodeIds.has(payoffSceneId)
      ) {
        payoffSceneId = null;
        skipped.foreshadowPayoffSceneCleared++;
      }
      pushStmt(
        buildInsert("foreshadows", { ...row, payoff_scene_id: payoffSceneId }),
      );
    }
    for (const row of auxByScope.get("foreshadow_setups") ?? []) {
      // scene_id is NOT NULL FK. Body unselected and scene missing → skip.
      if (
        !scopes.has("body") &&
        typeof row.scene_id === "string" &&
        !liveTreeNodeIds.has(row.scene_id)
      ) {
        skipped.foreshadowSetups++;
        continue;
      }
      pushStmt(buildInsert("foreshadow_setups", row));
    }
    for (const row of auxByScope.get("foreshadow_codex_links") ?? []) {
      // codex_entry_id is NOT NULL FK. Codex unselected and missing → skip.
      if (
        !scopes.has("codex") &&
        typeof row.codex_entry_id === "string" &&
        !liveCodexIds.has(row.codex_entry_id)
      ) {
        skipped.foreshadowCodexLinks++;
        continue;
      }
      pushStmt(buildInsert("foreshadow_codex_links", row));
    }
  }

  // map
  if (scopes.has("map")) {
    for (const row of auxByScope.get("map_boards") ?? []) {
      pushStmt(buildInsert("map_boards", row));
    }
    for (const row of auxByScope.get("map_ai_branches") ?? []) {
      pushStmt(buildInsert("map_ai_branches", row));
    }
    for (const row of auxByScope.get("map_stickies") ?? []) {
      pushStmt(buildInsert("map_stickies", row));
    }
    for (const row of auxByScope.get("map_frames") ?? []) {
      pushStmt(buildInsert("map_frames", row));
    }
    for (const row of auxByScope.get("map_node_positions") ?? []) {
      let treeNodeId = (row.tree_node_id as string | null) ?? null;
      let codexEntryId = (row.codex_entry_id as string | null) ?? null;
      if (
        !scopes.has("body") &&
        typeof treeNodeId === "string" &&
        !liveTreeNodeIds.has(treeNodeId)
      ) {
        treeNodeId = null;
        skipped.mapNodePositionsLinkCleared++;
      }
      if (
        !scopes.has("codex") &&
        typeof codexEntryId === "string" &&
        !liveCodexIds.has(codexEntryId)
      ) {
        codexEntryId = null;
        skipped.mapNodePositionsLinkCleared++;
      }
      pushStmt(
        buildInsert("map_node_positions", {
          ...row,
          tree_node_id: treeNodeId,
          codex_entry_id: codexEntryId,
        }),
      );
    }
    for (const row of auxByScope.get("map_edges") ?? []) {
      pushStmt(buildInsert("map_edges", row));
    }
  }

  // lint
  if (scopes.has("lint")) {
    for (const row of auxByScope.get("lint_term_dictionary") ?? []) {
      pushStmt(buildInsert("lint_term_dictionary", row));
    }
    if (scopes.has("body")) {
      for (const row of auxByScope.get("lint_ignored_diagnostics") ?? []) {
        pushStmt(buildInsert("lint_ignored_diagnostics", row));
      }
    } else {
      const ign = auxByScope.get("lint_ignored_diagnostics") ?? [];
      for (const row of ign) {
        if (
          typeof row.scene_id === "string" &&
          liveTreeNodeIds.has(row.scene_id)
        ) {
          pushStmt(buildInsert("lint_ignored_diagnostics", row));
        } else {
          skipped.lintIgnoredDiagnostics++;
        }
      }
    }
  }

  await rawBatch(stmts);
  return { restoredCount, skipped };
}

/**
 * Restore a project snapshot. Saves a safety snapshot first so the user can
 * always undo. New (structural) snapshots restore tree structure + content
 * + ancillary tables; legacy snapshots fall back to content-only UPDATE.
 *
 * `options.scopes` selects which scopes to restore (default: all). For
 * legacy snapshots `options.scopes` is ignored because legacy snapshots
 * only capture content.
 */
export async function restoreProjectSnapshot(
  snapshotId: string,
  snapshotName: string,
  options: RestoreOptions = {},
): Promise<RestoreResult> {
  const scopes = options.scopes
    ? new Set<RestoreScope>(options.scopes)
    : fullRestoreScopeSet();

  // 1. Safety snapshot (always full). The ISO timestamp suffix keeps the
  // name unique per UNIQUE(project_id, name).
  const safety = await createProjectSnapshot({
    name: `Before restore to '${snapshotName}' (${new Date().toISOString()})`,
  });

  // 2. Detect format. New-format snapshots always write at least one row
  // to project_snapshot_aux (one per aux scope, even when empty). Legacy
  // snapshots have no aux rows. tree_nodes count alone misclassifies
  // codex-only / snippet-only projects.
  const structural = await rawAll(
    `SELECT 1 FROM project_snapshot_aux WHERE snapshot_id = ? LIMIT 1`,
    [snapshotId],
  );

  if (structural.length === 0) {
    const restoredCount = await restoreLegacyContentOnly(snapshotId);
    return {
      restoredCount,
      safetySnapshotId: safety.id,
      format: "legacy",
      skipped: emptySkipReport(),
    };
  }

  const { restoredCount, skipped } = await restoreStructural(
    snapshotId,
    scopes,
  );
  // Silence: AUX_SCOPE_OWNER / AUX_BODY_DEPENDENCY / AUX_CODEX_DEPENDENCY
  // are exported for tests and future tooling. Reference them here so an
  // unused-import lint doesn't trip during incremental development.
  void AUX_SCOPE_OWNER;
  void AUX_BODY_DEPENDENCY;
  void AUX_CODEX_DEPENDENCY;
  return {
    restoredCount,
    safetySnapshotId: safety.id,
    format: "structural",
    skipped,
  };
}

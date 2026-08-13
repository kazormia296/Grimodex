import { db } from "@/db/client";
import {
  projectSnapshots,
  projectSnapshotEntries,
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
  rebaselineEntitiesAtTail,
  type EntityBaselineRef,
} from "@/features/timelapse/toggle";
import { scheduleImeExportRefresh } from "@/features/ime/scheduler";
import { getRecorderSessionId } from "@/features/timelapse/recorder";
import { runTreeTopologyMutation } from "@/application/tree/treeTopologyMutationRegistry";
import {
  emptySkipReport,
  fullRestoreScopeSet,
  parseAuxPayload,
  type AuxScope,
  type RawRow,
  type RestoreScope,
  type SkipReport,
} from "./projectSnapshotScopes";
import {
  applyNativeProjectSnapshotRestore,
  createNativeProjectSnapshot,
  loadNativeProjectSnapshotRestoreContext,
  type ProjectSnapshotRestoreContext,
  type SnapshotInsertPlan,
  type SnapshotRestoreTable,
} from "./projectSnapshotNative";

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

/**
 * Build a typed restore-plan insert. SQL generation and execution stay in the
 * shared Rust snapshot domain; renderer only computes dependency-safe rows.
 */
function buildInsert(
  table: SnapshotRestoreTable,
  row: RawRow,
  mode: "insert" | "replace" = "insert",
): SnapshotInsertPlan {
  return { table, row, mode };
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
 * ancillary tables as aux JSON). The snapshot header row and every body row
 * (tree_nodes / codex / snippets / entries / aux) are written by the typed
 * native snapshot repository in one transaction, so a mid-write failure rolls
 * back the whole snapshot instead of leaving an incomplete restore candidate.
 * Body content is materialised into content_versions *before* the batch (via
 * getOrCreateRevisionId); those pointer rows are the only non-transactional
 * part, and any partial-failure leftovers there are harmless and prunable.
 * Restore *is* transactional too.
 */
export async function createProjectSnapshot(params: {
  name: string;
  description?: string;
}): Promise<{ id: string; entryCount: number }> {
  const { name, description } = params;
  const PROJECT_ID = getCurrentProjectId();
  const snapshotId = crypto.randomUUID();
  const now = new Date().toISOString();

  // Capture tree_nodes (scenes / notes / folders).
  // Folders have empty content; getOrCreateRevisionId is skipped for them.
  const nodes = await db
    .select()
    .from(treeNodes)
    .where(eq(treeNodes.projectId, PROJECT_ID));

  const treeNodeRows: RawRow[] = [];
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
      snapshot_id: snapshotId,
      node_id: node.id,
      parent_id: node.parentId ?? null,
      node_type: node.nodeType,
      title: node.title,
      synopsis: node.synopsis ?? null,
      intent: node.intent ?? null,
      sort_order: node.sortOrder,
      story_time_order: node.storyTimeOrder ?? null,
      story_time_label: node.storyTimeLabel ?? null,
      pov_character_id: node.povCharacterId ?? null,
      location_id: node.locationId ?? null,
      // Chronicle（作中暦日付）: events と同じ日付モデルをシーンにも保存。
      chronicle_start_time: node.chronicleStartTime ?? null,
      chronicle_start_minute: node.chronicleStartMinute ?? null,
      chronicle_start_granularity: node.chronicleStartGranularity ?? "none",
      chronicle_end_time: node.chronicleEndTime ?? null,
      chronicle_end_minute: node.chronicleEndMinute ?? null,
      chronicle_end_granularity: node.chronicleEndGranularity ?? "none",
      chronicle_precision: node.chroniclePrecision ?? "exact",
      status: node.status ?? null,
      body_version_id: bodyVersionId,
      unplaced_beats_doc: node.unplacedBeatsDoc,
      char_count: node.charCount,
      created_at: node.createdAt,
      updated_at: node.updatedAt,
    });
  }

  // Capture codex_entries
  const codexRows = await db
    .select()
    .from(codexEntries)
    .where(eq(codexEntries.projectId, PROJECT_ID));

  const codexSnapRows: RawRow[] = [];
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
      snapshot_id: snapshotId,
      entry_id: entry.id,
      type: entry.type,
      name: entry.name,
      parent_id: entry.parentId ?? null,
      aliases: entry.aliases ?? null,
      excluded_aliases: entry.excludedAliases ?? null,
      summary: entry.summary ?? null,
      icon: entry.icon ?? null,
      context_mode: entry.contextMode,
      children_budget: entry.childrenBudget,
      notes: entry.notes ?? null,
      body_version_id: bodyVersionId,
      created_at: entry.createdAt,
      updated_at: entry.updatedAt,
    });
  }

  // Capture snippets
  const snippetRows = await db
    .select()
    .from(snippets)
    .where(eq(snippets.projectId, PROJECT_ID));

  const snippetSnapRows: RawRow[] = [];
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
      snapshot_id: snapshotId,
      snippet_id: snippet.id,
      title: snippet.title,
      scene_id: snippet.sceneId ?? null,
      source_chat_message_id: snippet.sourceChatMessageId ?? null,
      body_version_id: bodyVersionId,
      created_at: snippet.createdAt,
      updated_at: snippet.updatedAt,
    });
  }

  await createNativeProjectSnapshot({
    projectId: PROJECT_ID,
    snapshotId,
    name,
    description: description ?? null,
    createdAt: now,
    treeRows: treeNodeRows,
    codexRows: codexSnapRows,
    snippetRows: snippetSnapRows,
    versionIds,
  });
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

  if (snaps.length === 0) return [];
  const snapshotIds = snaps.map((s) => s.id);

  // 旧実装はスナップショット毎に COUNT を 2 本発行し 2N 回 IPC していた。
  // GROUP BY で 1 本ずつ（計 2 本）に集約し N+1 を解消する。
  const entryCounts = await db
    .select({
      snapshotId: projectSnapshotEntries.snapshotId,
      count: sql<number>`count(*)`,
    })
    .from(projectSnapshotEntries)
    .where(inArray(projectSnapshotEntries.snapshotId, snapshotIds))
    .groupBy(projectSnapshotEntries.snapshotId);
  const entryCountById = new Map(
    entryCounts.map((r) => [r.snapshotId, Number(r.count)]),
  );

  // Structural snapshots always write at least one row to
  // project_snapshot_aux (every aux scope, even empty ones). Legacy
  // snapshots never touch aux. A codex-only or snippet-only project
  // would have zero project_snapshot_tree_nodes rows but still be
  // structural — so checking aux instead of tree_nodes is correct.
  const auxCounts = await db
    .select({
      snapshotId: projectSnapshotAux.snapshotId,
      count: sql<number>`count(*)`,
    })
    .from(projectSnapshotAux)
    .where(inArray(projectSnapshotAux.snapshotId, snapshotIds))
    .groupBy(projectSnapshotAux.snapshotId);
  const auxCountById = new Map(
    auxCounts.map((r) => [r.snapshotId, Number(r.count)]),
  );

  return snaps.map((snap) => ({
    id: snap.id,
    name: snap.name,
    description: snap.description,
    entryCount: entryCountById.get(snap.id) ?? 0,
    createdAt: snap.createdAt,
    isStructural: (auxCountById.get(snap.id) ?? 0) > 0,
  }));
}

// ── deleteProjectSnapshot (unchanged behaviour) ────────────────────

export async function deleteProjectSnapshot(snapshotId: string): Promise<void> {
  await db.delete(projectSnapshots).where(eq(projectSnapshots.id, snapshotId));
}

// ── restoreProjectSnapshot ─────────────────────────────────────────

export interface RestoreOptions {
  scopes?: ReadonlySet<RestoreScope>;
  /** Reuse this operation id only when retrying the exact same restore. */
  requestId?: string;
}

interface RestoreAuthority {
  requestId: string;
  sessionId: string;
}

/** Build the dependency-safe insert plan; Rust owns wipe + transaction SQL. */
async function restoreStructural(
  snapshotId: string,
  scopes: ReadonlySet<RestoreScope>,
  context: ProjectSnapshotRestoreContext,
  authority: RestoreAuthority,
): Promise<{
  restoredCount: number;
  skipped: SkipReport;
  canonicalSequence: number;
}> {
  const PROJECT_ID = getCurrentProjectId();
  const skipped = emptySkipReport();
  const inserts: SnapshotInsertPlan[] = [];

  // Live table set: snapshots may carry data for aux tables that don't
  // exist in this DB instance (e.g. browser-mock omits some). Filter any
  // insert whose target table isn't present.
  const liveTables = new Set(context.liveTables);
  function pushStmt(insert: SnapshotInsertPlan): void {
    if (!liveTables.has(insert.table)) return;
    inserts.push(insert);
  }

  const { treeRows, codexRows, snippetRows } = context;
  const auxByScope = new Map<AuxScope, RawRow[]>();
  for (const r of context.auxRows) {
    const scope = r.scope as AuxScope;
    auxByScope.set(scope, parseAuxPayload(r.payloadJson).rows);
  }

  const contentById = new Map(
    context.contentRows.map((row) => [row.id, row.content]),
  );

  // Live codex_entry ids that exist now — used when codex scope is not
  // selected to decide whether `pov_character_id` / `location_id` on
  // restored tree_nodes can keep their value or must be NULLed.
  const liveCodexIds = new Set(context.liveCodexIds);
  const liveCodexPhaseIds = new Set(context.liveCodexPhaseIds);

  // Live tree_node ids — used when body scope is not selected to decide
  // whether cross-scope FKs to tree_nodes can keep their value.
  const liveTreeNodeIds = new Set(context.liveTreeNodeIds);
  const liveSnippetIds = new Set(context.liveSnippetIds);
  const liveEventIds = new Set(context.liveEventIds);

  // Live codex_tag ids — used by snippet_entry_tags / codex_entry_tags when
  // codex scope is not selected (the codex_tags row may have been removed
  // post-snapshot).
  const liveCodexTagIds = new Set(context.liveCodexTagIds);

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
    for (const row of auxByScope.get("codex_detail_semantic_bindings") ?? []) {
      pushStmt(buildInsert("codex_detail_semantic_bindings", row));
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
    for (const row of auxByScope.get("codex_relations") ?? []) {
      pushStmt(buildInsert("codex_relations", row));
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
          intent: (row.intent as string | null) ?? null,
          sort_order: row.sort_order as string,
          story_time_order: (row.story_time_order as string | null) ?? null,
          story_time_label: (row.story_time_label as string | null) ?? null,
          pov_character_id: safePov,
          location_id: safeLoc,
          // Chronicle（作中暦日付）— 復元でシーン日付が消えないこと。
          // granularity / precision は NOT NULL のため coalesce で既定値を満たす。
          chronicle_start_time:
            (row.chronicle_start_time as number | null) ?? null,
          chronicle_start_minute:
            (row.chronicle_start_minute as number | null) ?? null,
          chronicle_start_granularity:
            (row.chronicle_start_granularity as string | null) ?? "none",
          chronicle_end_time: (row.chronicle_end_time as number | null) ?? null,
          chronicle_end_minute:
            (row.chronicle_end_minute as number | null) ?? null,
          chronicle_end_granularity:
            (row.chronicle_end_granularity as string | null) ?? "none",
          chronicle_precision:
            (row.chronicle_precision as string | null) ?? "exact",
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
    // plot threads → scene-links → branches (parent-first; markers/branches FK
    // tree_nodes which are inserted above + threads inserted just here, so the
    // order satisfies FKs even without deferral). Threads were wiped above.
    for (const row of auxByScope.get("plot_threads") ?? []) {
      pushStmt(buildInsert("plot_threads", row));
    }
    for (const row of auxByScope.get("plot_thread_scene_links") ?? []) {
      pushStmt(buildInsert("plot_thread_scene_links", row));
    }
    for (const row of auxByScope.get("plot_thread_branches") ?? []) {
      pushStmt(buildInsert("plot_thread_branches", row));
    }
    // Chronicle (作中年表): events → scene_events / event_participants /
    // event_relations → project_calendar. events is parent-first; its children
    // FK events (and tree_nodes / codex_entries), all inserted above or here.
    // events were wiped above. primary_codex_id / location_codex_id are
    // nullable FKs: when codex is excluded and the referenced entry is gone,
    // NULL them rather than dropping the event.
    for (const row of auxByScope.get("events") ?? []) {
      let primaryCodexId = (row.primary_codex_id as string | null) ?? null;
      let locationCodexId = (row.location_codex_id as string | null) ?? null;
      if (
        !scopes.has("codex") &&
        typeof primaryCodexId === "string" &&
        !liveCodexIds.has(primaryCodexId)
      ) {
        primaryCodexId = null;
        skipped.eventCodexRefCleared++;
      }
      if (
        !scopes.has("codex") &&
        typeof locationCodexId === "string" &&
        !liveCodexIds.has(locationCodexId)
      ) {
        locationCodexId = null;
        skipped.eventCodexRefCleared++;
      }
      // reveal_scene_id は tree_nodes(scene) を参照する FK。body 未選択かつ参照先
      // シーンが復元ツリーに無いと COMMIT 時 FK 失敗で復元全体が巻き戻る。codex/
      // payoffSceneId と同流儀で null 化（effectiveRevealSceneId が自動導出へ戻る）。
      let revealSceneId = (row.reveal_scene_id as string | null) ?? null;
      if (
        !scopes.has("body") &&
        typeof revealSceneId === "string" &&
        !liveTreeNodeIds.has(revealSceneId)
      ) {
        revealSceneId = null;
        skipped.eventRevealSceneCleared++;
      }
      pushStmt(
        buildInsert("events", {
          ...row,
          primary_codex_id: primaryCodexId,
          location_codex_id: locationCodexId,
          reveal_scene_id: revealSceneId,
        }),
      );
    }
    for (const row of auxByScope.get("scene_events") ?? []) {
      pushStmt(
        buildInsert("scene_events", {
          ...row,
          // A structural restore is a new physical association incarnation.
          // Never revive the captured token: an older journal could otherwise
          // mistake the restored row for the association it originally owned.
          incarnation_token: crypto.randomUUID(),
        }),
      );
    }
    for (const row of auxByScope.get("event_participants") ?? []) {
      // codex_entry_id is NOT NULL FK. Codex unselected and entry missing → skip.
      if (
        !scopes.has("codex") &&
        typeof row.codex_entry_id === "string" &&
        !liveCodexIds.has(row.codex_entry_id)
      ) {
        skipped.eventParticipants++;
        continue;
      }
      pushStmt(buildInsert("event_participants", row));
    }
    for (const row of auxByScope.get("event_relations") ?? []) {
      pushStmt(buildInsert("event_relations", row));
    }
    for (const row of auxByScope.get("project_calendar") ?? []) {
      // The restore backend replaces this placeholder with a generation
      // derived from trusted live/snapshot DB state. Snapshot versions are
      // history, not valid write tokens for the restored Calendar.
      pushStmt(buildInsert("project_calendar", { ...row, version: 0 }));
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
    const restoredSetupIds = new Set<string>();
    const restoredPayoffIds = new Set<string>();
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
      if (typeof row.id === "string") restoredSetupIds.add(row.id);
    }
    for (const row of auxByScope.get("foreshadow_payoffs") ?? []) {
      if (
        !scopes.has("body") &&
        typeof row.scene_id === "string" &&
        !liveTreeNodeIds.has(row.scene_id)
      ) {
        skipped.foreshadowPayoffs++;
        continue;
      }
      pushStmt(buildInsert("foreshadow_payoffs", row));
      if (typeof row.id === "string") restoredPayoffIds.add(row.id);
    }
    for (const row of auxByScope.get("foreshadow_setup_payoff_links") ?? []) {
      if (
        typeof row.setup_id !== "string" ||
        typeof row.payoff_id !== "string" ||
        !restoredSetupIds.has(row.setup_id) ||
        !restoredPayoffIds.has(row.payoff_id)
      ) {
        continue;
      }
      pushStmt(buildInsert("foreshadow_setup_payoff_links", row));
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
    for (const row of auxByScope.get("editor_stickies") ?? []) {
      const treeNodeId = (row.tree_node_id as string | null) ?? null;
      const codexEntryId = (row.codex_entry_id as string | null) ?? null;
      const phaseId = (row.phase_id as string | null) ?? null;
      const snippetId = (row.snippet_id as string | null) ?? null;
      const eventId = (row.chronicle_event_id as string | null) ?? null;
      const ownerUnavailable =
        (!scopes.has("body") &&
          treeNodeId !== null &&
          !liveTreeNodeIds.has(treeNodeId)) ||
        (!scopes.has("codex") &&
          codexEntryId !== null &&
          !liveCodexIds.has(codexEntryId)) ||
        (!scopes.has("codex") &&
          phaseId !== null &&
          !liveCodexPhaseIds.has(phaseId)) ||
        (!scopes.has("snippet") &&
          snippetId !== null &&
          !liveSnippetIds.has(snippetId)) ||
        (!scopes.has("body") && eventId !== null && !liveEventIds.has(eventId));
      if (ownerUnavailable) {
        skipped.editorStickies++;
        continue;
      }
      pushStmt(buildInsert("editor_stickies", row));
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

  const applyResult = await applyNativeProjectSnapshotRestore({
    requestId: authority.requestId,
    sessionId: authority.sessionId,
    projectId: PROJECT_ID,
    snapshotId,
    scopes: [...scopes],
    inserts,
  });
  return {
    restoredCount,
    skipped,
    canonicalSequence: applyResult.canonicalSequence,
  };
}

/**
 * Restore a project snapshot. Saves a safety snapshot first so the user can
 * always undo. New (structural) snapshots restore tree structure + content
 * + ancillary tables through one Native aggregate. Legacy content-only
 * snapshots are read-only until they gain the same atomic authority.
 *
 * `options.scopes` selects which scopes to restore (default: all). For
 * Legacy snapshots are listed and retained, but restore fails closed before
 * creating a safety snapshot or dispatching any domain write.
 */
/**
 * A project-snapshot restore rewrites tree_nodes/codex_entries/snippets content
 * directly in the DB — the editor never issues the corresponding doc.steps, so
 * the timelapse genesis baseline goes stale (a subsequent doc.step then
 * replays on the pre-restore doc and throws `RangeError: Position out of
 * range`). The Native restore now appends the canonical
 * `project.snapshot.restore` event in the same transaction as the domain
 * rewrite and Narrative Change Feed. Renderer only re-anchors editor
 * baselines at that committed chain tail. Runs BEFORE the caller's
 * `window.location.reload()` while the recorder is still bound to this
 * project.
 */
async function rebaselineAfterRestore(
  format: "legacy" | "structural",
  scopes: Set<RestoreScope>,
  committedSequence: number,
): Promise<void> {
  const projectId = getCurrentProjectId();
  if (!projectId) return;
  // Re-anchor the baseline of every entity whose body this restore rewrote.
  // A LEGACY restore replays content_versions for ALL entity types
  // (restoreLegacyContentOnly writes scene/note/codex_entry/snippet bodies), so
  // it must rebaseline codex/snippet too — not just scenes. A STRUCTURAL restore
  // only rewrites a scope's body when that scope is selected (scene→"body",
  // codex→"codex", snippet→"snippet"). A stale codex/snippet baseline throws the
  // same post-restore RangeError as scenes once the entity is edited again.
  const refs: EntityBaselineRef[] = [];
  if (format === "legacy" || scopes.has("body")) {
    const sceneRows = await db
      .select({ id: treeNodes.id })
      .from(treeNodes)
      .where(
        and(
          eq(treeNodes.projectId, projectId),
          eq(treeNodes.nodeType, "scene"),
        ),
      );
    refs.push(...sceneRows.map((r) => ({ kind: "scene" as const, id: r.id })));
  }
  if (format === "legacy" || scopes.has("codex")) {
    const codexRows = await db
      .select({ id: codexEntries.id })
      .from(codexEntries)
      .where(eq(codexEntries.projectId, projectId));
    refs.push(...codexRows.map((r) => ({ kind: "codex" as const, id: r.id })));
  }
  if (format === "legacy" || scopes.has("snippet")) {
    const snippetRows = await db
      .select({ id: snippets.id })
      .from(snippets)
      .where(eq(snippets.projectId, projectId));
    refs.push(
      ...snippetRows.map((r) => ({ kind: "snippet" as const, id: r.id })),
    );
  }
  await rebaselineEntitiesAtTail(projectId, refs, committedSequence);
}

export async function restoreProjectSnapshot(
  snapshotId: string,
  snapshotName: string,
  options: RestoreOptions = {},
): Promise<RestoreResult> {
  // Capture the authority tuple before the first await. Every dispatch made
  // by this operation (including an exact retry supplied via options) uses
  // one immutable request/session identity.
  const authority: RestoreAuthority = {
    requestId: options.requestId ?? crypto.randomUUID(),
    sessionId: getRecorderSessionId(),
  };
  return runTreeTopologyMutation(() =>
    restoreProjectSnapshotWithAuthority(
      snapshotId,
      snapshotName,
      options,
      authority,
    ),
  );
}

async function restoreProjectSnapshotWithAuthority(
  snapshotId: string,
  snapshotName: string,
  options: RestoreOptions,
  authority: RestoreAuthority,
): Promise<RestoreResult> {
  const scopes = options.scopes
    ? new Set<RestoreScope>(options.scopes)
    : fullRestoreScopeSet();

  // 1. Load the project-scoped restore context through the typed native
  // repository. The backend rejects snapshots owned by another project.
  const context = await loadNativeProjectSnapshotRestoreContext(
    getCurrentProjectId(),
    snapshotId,
    scopes,
  );

  if (!context.structural) {
    throw new Error(
      "PROJECT_SNAPSHOT_LEGACY_RESTORE_REQUIRES_NATIVE_AGGREGATE",
    );
  }

  // 2. Safety snapshot (always full). The ISO timestamp suffix keeps the
  // name unique per UNIQUE(project_id, name). This happens only after the
  // target has proven eligible for the atomic Native restore path.
  const safety = await createProjectSnapshot({
    name: `Before restore to '${snapshotName}' (${new Date().toISOString()})`,
  });

  const { restoredCount, skipped, canonicalSequence } = await restoreStructural(
    snapshotId,
    scopes,
    context,
    authority,
  );
  if (scopes.has("codex")) {
    scheduleImeExportRefresh(getCurrentProjectId());
  }
  await rebaselineAfterRestore("structural", scopes, canonicalSequence);
  return {
    restoredCount,
    safetySnapshotId: safety.id,
    format: "structural",
    skipped,
  };
}

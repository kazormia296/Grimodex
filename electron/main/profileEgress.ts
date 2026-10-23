import { randomUUID } from "node:crypto";

import {
  NAPI_COMMANDS,
  type CommandArgs,
  type NapiBackendLike,
} from "../shared/ipcContract.js";
import { parseWorkspaceRestoreOutcome } from "../shared/workspaceRestoreOutcome.js";

export const D2A_EGRESS_DENIED_MARKER = "D2A_EGRESS_DENIED:";

export interface MainIssuedCallerIdentity {
  readonly profileId: string;
  readonly callerId: string;
  readonly callerEpoch: number;
  readonly senderId: number;
  readonly workspaceId: string | null;
  readonly sessionId: string;
}

interface NativeProfileEgressStatus {
  profileId?: unknown;
  callerEpoch?: unknown;
  restricted?: unknown;
  handlesInvalidated?: unknown;
  inFlightStopped?: unknown;
  sqlPolicy?: unknown;
}

/** Native `sqlPolicy` wire version (K3/2 "表の台帳"). Unknown versions are unavailable. */
const PROFILE_EGRESS_POLICY_VERSION = 2;

/**
 * Whether Electron main routes `own-data-read` (the read-open reading of the
 * author's own data) as such in a restricted profile.  While `false` every
 * `own-data-read` classification is routed as `plaintext-publication`, i.e.
 * rejected, which is the a153743b behavior.  Native's matching switch is
 * `PROFILE_EGRESS_READ_OPEN_ENABLED` in `grimodex-db`'s
 * `profile_egress_policy.rs`; both were flipped by the single opening commit
 * (DR-DA1-35 in `docs/plans/nir1-lane-decisions/da1-decisions.md`), after the
 * renderer-isolation finding (Y-1) was closed by NC-1.
 */
export const D2A_OWN_DATA_READ_OPEN = true;

interface NativeProfileEgressPolicy {
  /** `closed`: neither readable nor writable through generic SQL. */
  readonly closedTables: ReadonlySet<string>;
  /** `read-open`: readable as `own-data-read` once opened; never writable. */
  readonly readOpenTables: ReadonlySet<string>;
  /** `table.column` references of read-open columns on unlisted tables. */
  readonly readOpenColumns: ReadonlySet<string>;
}

function emptyNativeProfileEgressPolicy(): NativeProfileEgressPolicy {
  return {
    closedTables: new Set(),
    readOpenTables: new Set(),
    readOpenColumns: new Set(),
  };
}

type MainProfileEgressBackend = NapiBackendLike & {
  /** Main-only N-API method; never part of the renderer command contract. */
  activateProfileEgress?: () => Promise<string>;
};

/**
 * Route classes (K3/2 "restricted 下の route 区分"). The five publication
 * classes are `nir1-publication`, `nir1-restricted-only`, `own-data-read`,
 * `license-control` and `plaintext-publication`; the rest are the existing
 * deny/allow classes.
 */
export type D2aRoute =
  | "old-external-ai"
  | "old-local-ai"
  | "plaintext-publication"
  | "nir1-publication"
  | "nir1-restricted-only"
  | "own-data-read"
  | "license-control"
  | "external-url"
  | "native-mutation"
  | "internal"
  | "unclassified";

/**
 * `own-data-read` (K3/2): typed reads of the author's own data that publish
 * nothing outside the profile.  39 commands, each checked by K3/2 to have no
 * write in its function body.  A command belongs here, in `DENIED_COMMANDS`,
 * in `INTERNAL_COMMANDS`, in the license ledger or in the typed-result
 * ledger, never two; adding or removing a command here needs a new draftRef.
 * Typed reads carry no Native re-authorization or Main completion check
 * (Q-1).  Unrestricted passes them unchecked.
 */
const OWN_DATA_READ_COMMANDS = [
  // Search (7)
  "fts_search",
  "semantic_search",
  "semantic_chunk_context",
  "semantic_debug_dump",
  "codex_semantic_search",
  "events_semantic_search",
  "chat_message_search",
  // Codex analysis (3)
  "codex_match_text",
  "extract_codex_candidates",
  "extract_codex_entity_seeds",
  // Foreshadows (9)
  "foreshadow_list_with_labels",
  "foreshadow_list_open_for_context",
  "foreshadow_get_scene_info",
  "foreshadow_get_scene_context",
  "foreshadow_list_by_codex_entry",
  "foreshadow_get_chapter_stats",
  "foreshadow_get_setup",
  "foreshadow_get",
  "foreshadow_list_linked_codex",
  // Plot (2)
  "plot_thread_list",
  "plot_thread_list_links",
  // Lint (3)
  "lint_ignore_list",
  "lint_ignore_list_scene",
  "lint_term_dictionary_list",
  // Trash and snapshot-restore context (2)
  "trash_bin_list",
  "project_snapshot_restore_context",
  // AI records (6)
  "ai_audit_read_snapshot",
  "ai_audit_verify",
  "list_post_effect_runs",
  "list_scene_lens_for_project",
  "list_annotations_for_scene",
  "list_annotations_for_project",
  // Extraction review and maintenance inbox (7)
  "narrative_extraction_get_run",
  "narrative_extraction_get_run_review_bundle",
  "narrative_extraction_list_resumable_runs",
  "narrative_extraction_is_run_resumable_for_review",
  "narrative_extraction_list_chronicle_task_resume_candidates",
  "narrative_extraction_get_commit_status",
  "narrative_maintenance_inbox_list",
] as const satisfies readonly (keyof typeof NAPI_COMMANDS)[];

/**
 * `nir1-publication` (K3/2): the NIR plaintext a restricted profile may still
 * publish to the renderer, each behind a Native admission at start and at
 * return (`publication_guard.rs`) and a Main completion check.  Related Scenes
 * R/IR and Evidence navigation (3) and the A2 review reads (3).  Unrestricted
 * passes them unchecked.  `related_scenes_release` and
 * `related_scenes_release_owner` carry no plaintext and stay `internal`; the
 * Graph listener is CP-3a.
 *
 * `nir1-restricted-only` is empty here: K5's D-dispatch commands are added by
 * DD-1.  Both ledgers are `satisfies`-bound to `NAPI_COMMANDS`, and a command
 * is in at most one ledger (`d2aRouteLedgersForTest`).
 */
const NIR1_PUBLICATION_COMMANDS = [
  // Related Scenes R/IR and Evidence navigation
  "related_scenes_begin",
  "related_scenes_continue",
  "nir1_evidence_qualify",
  // A2 review reads
  "nir1_entity_relation_revision_read",
  "nir1_entity_relation_revision_read_current",
  "nir1_entity_relation_revision_restore",
] as const satisfies readonly (keyof typeof NAPI_COMMANDS)[];
const NIR1_RESTRICTED_ONLY_COMMANDS =
  [] as const satisfies readonly (keyof typeof NAPI_COMMANDS)[];

/**
 * `license-control` (K3/2 L-1): the three license mutations carry no
 * manuscript, chat or AI plaintext (the only renderer-supplied value is the
 * `activate_license` key, which Native checks against an exact grammar while
 * restricted) and go to the fixed license origin only. They pass in both
 * unrestricted and restricted profiles and are refused while unavailable.
 * `get_license_state` stays `internal`. The `satisfies` check keeps a
 * stale/nonexistent command out of this ledger at compile time; a command
 * belongs here or in `DENIED_COMMANDS` / `INTERNAL_COMMANDS`, never two.
 */
const LICENSE_CONTROL_COMMANDS = [
  "activate_license",
  "revalidate_license",
  "deactivate_license",
] as const satisfies readonly (keyof typeof NAPI_COMMANDS)[];

const DENIED_COMMANDS = new Map<string, D2aRoute>([
  ["send_chat_message", "old-external-ai"],
  ["send_chat_message_stream", "old-external-ai"],
  ["send_inline_ai_stream", "old-local-ai"],
  ["send_agent_message", "old-external-ai"],
  ["list_ai_models", "old-external-ai"],
  ["test_ai_connection", "external-url"],
  ["start_post_effect_run", "old-external-ai"],
  ["start_post_effect_run_multi", "old-external-ai"],
  ["send_cli_chat_stream", "old-external-ai"],
  ["detect_cli_binary", "old-external-ai"],
  ["test_cli_connection", "external-url"],
  ["list_cli_models", "old-external-ai"],
  ["codex_app_test_connection", "external-url"],
  ["codex_app_list_models", "old-external-ai"],
  ["codex_app_start_turn", "old-external-ai"],
  ["codex_app_respond_to_request", "old-external-ai"],
  ["codex_app_get_status", "old-external-ai"],
  ["codex_app_update_history_revision", "old-external-ai"],
  ["codex_app_archive_session_thread", "old-external-ai"],
  ["codex_app_set_thread_name", "old-external-ai"],
  ["vivliostyle_build", "external-url"],
  ["vivliostyle_preview_start", "external-url"],
  // The CLI probe runs a login shell and the CLI's `--version` on a
  // restricted-restarted process, so it is as closed as build/preview.
  ["vivliostyle_detect", "external-url"],
  ["get_mcp_config", "old-external-ai"],
  ["narrative_extraction_claim_task", "plaintext-publication"],
  ["nir1_pack_context", "plaintext-publication"],
]);

const ALLOWED_STOP_COMMANDS = new Set([
  "abort_chat_stream",
  "abort_inline_ai_stream",
  "abort_post_effect_run",
  "abort_cli_chat_stream",
  "codex_app_interrupt_turn",
]);

// Every current non-egress command is classified explicitly. New commands
// stay denied until this ledger is reviewed and assigned a route.
const INTERNAL_COMMANDS = new Set([
  "abort_chat_stream",
  "abort_cli_chat_stream",
  "abort_inline_ai_stream",
  "abort_post_effect_run",
  "agent_accept_prose_stage",
  "agent_apply_undo_journal",
  "agent_chronicle_bulk_mutate",
  "agent_codex_create",
  "agent_codex_delete",
  "agent_codex_mutate",
  "agent_codex_update",
  "agent_discard_prose_stage",
  "agent_event_create",
  "agent_event_delete",
  "agent_event_relation_add",
  "agent_event_relation_remove",
  "agent_event_set_participants",
  "agent_event_update",
  "agent_foreshadow_create",
  "agent_foreshadow_update",
  "agent_propose_scene_body",
  "agent_scene_event_link",
  "agent_scene_event_link_batch",
  "agent_scene_event_unlink",
  "agent_snippet_create",
  "agent_write_bundle",
  "ai_audit_append_batch",
  "ai_tree_plan_apply",
  "ai_tree_plan_undo",
  "authorship_replace_lane",
  "capture_current_chat_input",
  "cancel_current_chat_input",
  "retire_current_chat_input",
  "chat_index_status",
  // Derived-index updates (K3/2 "派生 index の更新"): they take ids only and
  // return counts only, like `semantic_index_scene` and the `*_reindex_all`
  // commands, so they publish no plaintext and stay available while restricted.
  "chat_index_message",
  "codex_index_entry",
  "events_index_entry",
  "chat_reindex_all",
  "chronicle_bulk_mutate",
  "codex_create",
  "codex_delete",
  "codex_index_status",
  "codex_mutate",
  "codex_rebuild_matcher",
  "codex_reindex_all",
  "codex_rename_apply",
  "codex_rename_undo",
  "codex_update",
  "db_execute",
  "db_execute_batch",
  "delete_api_key",
  "editor_sticky_create",
  "editor_sticky_delete",
  "editor_sticky_list",
  "editor_sticky_update",
  "entity_tags_set",
  "event_create",
  "event_delete",
  "event_get_version",
  "event_participants_set",
  "event_relation_add",
  "event_relation_remove",
  "event_set_participants",
  "event_update",
  "events_index_status",
  "events_reindex_all",
  "export_safe_mode_diagnostics",
  "export_save_bytes",
  "export_save_text",
  "external_mount_file_mtime",
  "external_mount_read_file",
  "external_mount_register",
  "external_mount_scan",
  "external_mount_unregister",
  "external_mount_write_file",
  "foreshadow_create",
  "foreshadow_delete",
  "foreshadow_link_codex",
  "foreshadow_resolve_orphan",
  "foreshadow_save_anchors_for_scene",
  // This typed reader returns only opaque anchor ids, document positions, and
  // aggregate OCC versions. It is the minimal projection needed to keep
  // ordinary scene saves valid while protected foreshadow prose stays closed.
  "foreshadow_load_anchors_for_scene",
  "foreshadow_set_setup_strength",
  "foreshadow_setup_create_ai",
  "foreshadow_unlink_codex",
  "foreshadow_update",
  "foreshadow_update_setup",
  "fts_optimize",
  "fts_rebuild",
  "fts_rebuild_en",
  "get_ai_settings",
  "get_global_settings",
  "get_license_state",
  "get_narrative_backfill_status",
  "has_api_key",
  "ime_export_clear_all",
  "ime_export_get_status",
  "ime_export_refresh",
  "ime_export_remove_project",
  "ime_export_set_active_project",
  "import_web_editor_workspace",
  "integrity_check",
  "lint_ignore_copy",
  "lint_ignore_create",
  "lint_ignore_delete",
  "lint_ignore_move",
  "lint_term_dictionary_delete",
  "lint_term_dictionary_insert",
  "lint_term_dictionary_set_enabled",
  "lint_term_dictionary_update",
  "lint_text",
  "list_backups",
  "list_recovery_candidates",
  "list_system_fonts",
  "map_write_bundle",
  "mozkey_download_and_install",
  "narrative_extraction_append_decision",
  "narrative_extraction_append_human_decision",
  "narrative_extraction_append_revision",
  "narrative_extraction_apply_commit",
  "narrative_extraction_cancel_run",
  "narrative_extraction_capture_workspace_binding",
  "narrative_extraction_create_human_derived_revision",
  "narrative_extraction_create_run",
  "narrative_extraction_fail_task",
  "narrative_extraction_finish_task",
  "narrative_extraction_prepare_commit",
  "narrative_extraction_redo_commit",
  "narrative_extraction_revise_and_decide",
  "narrative_extraction_revise_and_decide_as_human",
  "narrative_extraction_save_proposal_set",
  "narrative_extraction_set_human_field_lock",
  "narrative_extraction_undo_commit",
  "narrative_maintenance_attention_clear",
  "narrative_maintenance_attention_set",
  "narrative_runtime_policy_get",
  "narrative_runtime_policy_set",
  // Scene body declaration (CB-2, K3/2 "宣言 UI"): internal. Native's entry
  // checks the registered caller and workspace while restricted and only the
  // workspace while unrestricted. The declaration needs Main's one-time
  // grant (`GRANT_REQUIRED_COMMANDS`); the revoke entry needs none (K2-3).
  // The state entry (CB-3) only reads the author's Scene and needs none.
  "narrative_scene_body_declaration_declare",
  "narrative_scene_body_declaration_revoke",
  "narrative_scene_body_declaration_state",
  "narrative_scene_scope_read",
  "narrative_scene_scope_registry_update",
  "narrative_scene_scope_update",
  "nir1_entity_relation_revision_create",
  // Prepare resolves live identities and persists only a typed draft. The
  // renderer receives an opaque metadata receipt; qualified material is read
  // through the separately gated current-reader command.
  "nir1_entity_relation_revision_prepare",
  "open_log_dir",
  "open_workspace",
  "plot_thread_branch_create",
  "plot_thread_branch_delete",
  "plot_thread_branch_update",
  "plot_thread_create",
  "plot_thread_delete",
  "plot_thread_delete_snapshot",
  "plot_thread_link_create",
  "plot_thread_link_delete",
  "plot_thread_link_update",
  "plot_thread_move_marker_bundle",
  "plot_thread_restore_snapshot",
  "plot_thread_update",
  "project_calendar_upsert",
  "project_create",
  "project_delete",
  "project_patch",
  "project_snapshot_apply_restore",
  "project_snapshot_create",
  "quarantine_live_database",
  "rebuild_narrative_derived_state",
  "related_scenes_release",
  "repair_integrity",
  "repair_narrative_dependency_declarations",
  "reply_to_annotation",
  "restore_backup",
  "restore_recovery_candidate",
  "retry_narrative_legacy_backfill",
  "revision_scene_restore",
  "runtime_performance_seed",
  "save_ai_settings",
  "save_api_key",
  "save_global_settings",
  "save_post_effect_annotations",
  "save_scene_body_bundle",
  "scan_staging_project_create",
  "scan_staging_project_publish",
  "scene_event_link",
  "scene_event_link_batch",
  "scene_event_unlink",
  "seed_sample_workspace",
  "segment_bunsetsu",
  "semantic_cancel_background",
  "semantic_download_model",
  "semantic_index_scene",
  "semantic_index_status",
  "semantic_reindex_all",
  "semantic_reranker_shadow_record",
  "semantic_reranker_shadow_score",
  "snippet_create",
  "snippet_delete",
  "snippet_update",
  "temporal_scene_patch",
  "timelapse_append_batch",
  "timelapse_body_baselines_append",
  "timelapse_enabled_set",
  "timelapse_genesis_baselines_append",
  "timelapse_history_purge",
  "timelapse_layout_snapshot_record",
  "trash_bin_clear_all",
  "trash_bin_create",
  "trash_bin_delete",
  "trash_bin_prune",
  "trash_bin_restore",
  "tree_node_create",
  "tree_node_delete",
  "tree_node_patch",
  "update_annotation_status",
  "updater_check",
  "updater_download",
  "updater_install",
  "vacuum_database",
  "validate_workspace_path",
  "verify_narrative_dependency_graph",
  "verify_recovery_candidate",
  "vivliostyle_abort_build",
  "vivliostyle_preview_stop",
  "vivliostyle_save_output",
]);

function normalizeSqlTableName(reference: string): string | undefined {
  const parts = reference.split(".");
  const table = parts.at(-1)?.trim();
  if (!table) return undefined;
  return table.replace(/^(?:["`]|\[)|(?:["`]|\])$/g, "").toLowerCase();
}

function sqlTableNames(sql: string): Array<string | undefined> {
  return [
    ...sql.matchAll(
      /\b(?:from|join|into|update|delete\s+from)\s+((?:[\w]+|"[^"]+"|`[^`]+`|\[[^\]]+\])(?:\s*\.\s*(?:[\w]+|"[^"]+"|`[^`]+`|\[[^\]]+\]))?)/gi,
    ),
  ].map((match) => normalizeSqlTableName(match[1] ?? ""));
}

function hasReadOpenColumnReference(
  sql: string,
  tableNames: ReadonlyArray<string | undefined>,
  policy: NativeProfileEgressPolicy,
): boolean {
  // This is an early route classification only. Native's SQLite authorizer
  // consumes the same policy and remains the enforcement authority.
  return [...policy.readOpenColumns].some((reference) => {
    const [table, column] = reference.split(".");
    if (!table || !column) return false;
    if (!tableNames.some((name) => name === table)) return false;
    if (/\bselect\s+\*/i.test(sql)) return true;
    const escapedColumn = column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escapedColumn}\\b`, "i").test(sql);
  });
}

/**
 * Early classification of one generic-SQL statement (K3/2 "区分の規則" 汎用 DB).
 * Main only advises; Native's authorizer and, for `own-data-read`, its
 * read-only check are the authority.
 *
 *  - touches a `closed` table: `plaintext-publication`
 *  - touches a `read-open` table or column:
 *      - SELECT / WITH (decided by the first keyword, so `WITH ... INSERT` is
 *        also here and Native's checks reject the write): `own-data-read`
 *      - anything else (DML on the ledger, a comment-prefixed statement,
 *        EXPLAIN, ...): `plaintext-publication`
 *  - otherwise the pre-D2a classification (`internal` / `native-mutation` /
 *    `unclassified`).
 * The classification deliberately is not "reads only read-open tables": Main's
 * extraction cannot tell a read from a write target.
 *
 * While the own-data-read opening is off, `own-data-read` is reported as
 * `plaintext-publication`, which is what every read-open reference was.
 */
function dbStatementRoute(
  sql: unknown,
  hasBoundCaller: boolean,
  policy: NativeProfileEgressPolicy,
  ownDataReadOpen: boolean,
): D2aRoute {
  if (typeof sql !== "string") return "unclassified";
  const tableNames = sqlTableNames(sql);
  if (tableNames.some((table) => table && policy.closedTables.has(table))) {
    return "plaintext-publication";
  }
  const touchesReadOpen =
    tableNames.some((table) => table && policy.readOpenTables.has(table)) ||
    hasReadOpenColumnReference(sql, tableNames, policy);
  if (touchesReadOpen) {
    if (/^\s*(?:select|with)\b/i.test(sql)) {
      return ownDataReadOpen ? "own-data-read" : "plaintext-publication";
    }
    return "plaintext-publication";
  }
  if (/^\s*(?:select|pragma|with)\b/i.test(sql)) {
    return tableNames.length > 0 && hasBoundCaller
      ? "internal"
      : "unclassified";
  }
  if (
    /^\s*(insert|update|delete|replace|create|alter|drop)\b/i.test(sql) &&
    hasBoundCaller &&
    tableNames.length > 0
  ) {
    return "native-mutation";
  }
  return "unclassified";
}

const ALLOWED_BACKEND_EVENTS = new Set([
  "backend:ready",
  "workspace:opened",
  "workspace:lifecycle-state",
  "license:state_changed",
  "semantic:model_download_progress",
  "semantic:reindex_progress",
  "related-scenes:invalidated",
  "related-scenes:index-ready",
  "vivliostyle:log",
  "vivliostyle:preview-exited",
  "external-mount://file-added",
  "external-mount://file-changed",
  "external-mount://file-removed",
  "external-mount://file-renamed",
  "vivliostyle:done",
  "vivliostyle:error",
]);

/** Reports an `own-data-read` route as `plaintext-publication` while closed. */
function effectiveRoute(route: D2aRoute, ownDataReadOpen: boolean): D2aRoute {
  return route === "own-data-read" && !ownDataReadOpen
    ? "plaintext-publication"
    : route;
}

function commandRoute(
  command: string,
  args: CommandArgs,
  policy: NativeProfileEgressPolicy,
  ownDataReadOpen: boolean,
): D2aRoute {
  const explicit = DENIED_COMMANDS.get(command);
  if (explicit) return explicit;
  if ((LICENSE_CONTROL_COMMANDS as readonly string[]).includes(command)) {
    return "license-control";
  }
  if ((OWN_DATA_READ_COMMANDS as readonly string[]).includes(command)) {
    return effectiveRoute("own-data-read", ownDataReadOpen);
  }
  if ((NIR1_PUBLICATION_COMMANDS as readonly string[]).includes(command)) {
    return "nir1-publication";
  }
  if ((NIR1_RESTRICTED_ONLY_COMMANDS as readonly string[]).includes(command)) {
    return "nir1-restricted-only";
  }
  if (ALLOWED_STOP_COMMANDS.has(command)) return "native-mutation";
  const hasBoundCaller =
    args.callerIdentity !== undefined && args.callerIdentity !== null;
  if (command === "db_execute") {
    return dbStatementRoute(args.sql, hasBoundCaller, policy, ownDataReadOpen);
  }
  if (command === "db_execute_batch") {
    const statements = args.statements;
    if (!Array.isArray(statements)) return "unclassified";
    const routes = statements.map((statement) => {
      if (statement === null || typeof statement !== "object") {
        return "unclassified" as const;
      }
      const sql = (statement as Record<string, unknown>).sql;
      return dbStatementRoute(sql, hasBoundCaller, policy, ownDataReadOpen);
    });
    if (routes.some((route) => route === "plaintext-publication")) {
      return "plaintext-publication";
    }
    if (routes.some((route) => route === "unclassified")) return "unclassified";
    return routes.some((route) => route === "own-data-read")
      ? "own-data-read"
      : "native-mutation";
  }
  return INTERNAL_COMMANDS.has(command) ? "internal" : "unclassified";
}

/**
 * Per-statement `own-data-read` classification of a generic DB command, for
 * Native's read-only check.  Computed by Main from the gate's own policy and
 * attached by the router; a value a renderer sends is never used.
 */
function dbOwnDataReadClassification(
  command: string,
  args: CommandArgs,
  policy: NativeProfileEgressPolicy,
): boolean | boolean[] | undefined {
  if (command === "db_execute") {
    return dbStatementRoute(args.sql, true, policy, true) === "own-data-read";
  }
  if (command === "db_execute_batch") {
    const statements = args.statements;
    if (!Array.isArray(statements)) return undefined;
    return statements.map((statement) => {
      if (statement === null || typeof statement !== "object") return false;
      return (
        dbStatementRoute(
          (statement as Record<string, unknown>).sql,
          true,
          policy,
          true,
        ) === "own-data-read"
      );
    });
  }
  return undefined;
}

/**
 * Read-only view of the route ledgers for the "no command is in two ledgers"
 * invariant test (K3/2 Negative (20)). Not used by production code.
 */
export function d2aRouteLedgersForTest(): {
  readonly denied: readonly string[];
  readonly internal: readonly string[];
  readonly licenseControl: readonly string[];
  readonly ownDataRead: readonly string[];
  readonly nir1Publication: readonly string[];
  readonly nir1RestrictedOnly: readonly string[];
  readonly stop: readonly string[];
} {
  return {
    denied: [...DENIED_COMMANDS.keys()],
    internal: [...INTERNAL_COMMANDS],
    licenseControl: [...LICENSE_CONTROL_COMMANDS],
    ownDataRead: [...OWN_DATA_READ_COMMANDS],
    nir1Publication: [...NIR1_PUBLICATION_COMMANDS],
    nir1RestrictedOnly: [...NIR1_RESTRICTED_ONLY_COMMANDS],
    stop: [...ALLOWED_STOP_COMMANDS],
  };
}

/**
 * The route a command takes under `policy` with the own-data-read opening in
 * the given state. Exposed for tests so the ledger and the SQL classifier can
 * be pinned without a gate.
 */
export function d2aCommandRouteForTest(
  command: string,
  args: CommandArgs,
  policy: {
    readonly closedTables: readonly string[];
    readonly readOpenTables: readonly string[];
    readonly readOpenColumns: readonly string[];
  },
  ownDataReadOpen: boolean,
): D2aRoute {
  return commandRoute(
    command,
    args,
    {
      closedTables: new Set(policy.closedTables),
      readOpenTables: new Set(policy.readOpenTables),
      readOpenColumns: new Set(policy.readOpenColumns),
    },
    ownDataReadOpen,
  );
}

export interface D2aRouteCondition {
  readonly restricted: boolean;
  readonly unavailable: boolean;
  /** A first-restricted activation is in flight (its Native step is pending). */
  readonly activating: boolean;
  /** The call carries a caller identity Main issued and still holds. */
  readonly identityIssued: boolean;
}

export type D2aRouteDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string };

/**
 * Invoke-time decision for one route (K3/2 "区分の意味"). One exhaustive
 * switch: adding a route class without deciding it is a compile error.
 *
 *  - unrestricted: everything passes except `nir1-restricted-only`
 *  - unavailable: only `internal` and `native-mutation` pass
 *  - restricted: `internal`, `native-mutation`, `license-control` pass; the
 *    three identity-bound classes pass only with a Main-issued identity and
 *    outside an activation; the rest are refused
 */
export function d2aRouteDecision(
  route: D2aRoute,
  condition: D2aRouteCondition,
): D2aRouteDecision {
  const allow: D2aRouteDecision = { allow: true };
  const refuse = (reason: string): D2aRouteDecision => ({
    allow: false,
    reason,
  });
  const localOnly = "is unavailable in profile local-only mode";
  const closed = condition.restricted || condition.unavailable;
  if (!closed) {
    return route === "nir1-restricted-only"
      ? refuse("is only available in profile local-only mode")
      : allow;
  }
  switch (route) {
    case "internal":
    case "native-mutation":
      return allow;
    case "license-control":
      return condition.unavailable
        ? refuse("is unavailable until the Native profile gate is ready")
        : allow;
    case "own-data-read":
    case "nir1-publication":
    case "nir1-restricted-only":
      if (condition.unavailable) {
        return refuse("is unavailable until the Native profile gate is ready");
      }
      if (condition.activating) {
        return refuse("is unavailable while the profile is being restricted");
      }
      if (!condition.identityIssued) {
        return refuse("requires a main-issued caller identity");
      }
      return allow;
    case "old-external-ai":
    case "old-local-ai":
    case "plaintext-publication":
    case "external-url":
    case "unclassified":
      return refuse(localOnly);
    default: {
      const exhaustive: never = route;
      return refuse(`unknown route ${String(exhaustive)}`);
    }
  }
}

function denied(route: D2aRoute, detail: string): Error {
  return new Error(`${D2A_EGRESS_DENIED_MARKER} ${route}: ${detail}`);
}

export interface ProfileEgressGate {
  readonly restricted: boolean;
  readonly unavailable: boolean;
  issueCallerIdentity(senderId: number): MainIssuedCallerIdentity;
  assertInvoke(command: string, args: CommandArgs): void;
  /**
   * `own-data-read` classification of a generic DB command, for Native's
   * read-only check: `true` / `false` for `db_execute`, one flag per statement
   * for `db_execute_batch`. `undefined` when no classification applies (not a
   * generic DB command, an unrestricted or unavailable profile, or the
   * own-data-read opening is off). Call after `assertInvoke` succeeded.
   */
  classifyOwnDataRead?(
    command: string,
    args: CommandArgs,
  ): boolean | boolean[] | undefined;
  /** Re-authorize a result admitted before profile restriction began. */
  assertPlaintextPublication(command: string, args: CommandArgs): void;
  allowsBackendEvent(channel: string): boolean;
  assertExternalUrl(): void;
  /** Main-only lifecycle participants; never exposed through renderer IPC. */
  registerMainEgressParticipant(
    name: string,
    quiesce: () => Promise<void>,
  ): void;
  activateFirstRestrictedPublication?(): Promise<void>;
  observeBackendEvent?(channel: string, payload: unknown): void;
  /** Main-only proof from a Native restore result; never exposed to renderer. */
  observeWorkspaceLifecycleResult?(payload: unknown): void;
  /** Trusted successful Native Open result plus the main-validated target. */
  observeWorkspaceOpenResult?(payload: unknown, workspacePath: string): void;
}

interface ReadyWorkspaceBinding {
  readonly bindingToken: string;
  readonly workspaceId: string;
  readonly revision: number;
}

class NativeBoundProfileEgressGate implements ProfileEgressGate {
  private _restricted: boolean;
  private _unavailable: boolean;
  private profileId: string;
  private callerEpoch: number;
  private readonly registerCaller:
    | ((identity: MainIssuedCallerIdentity) => void)
    | null;
  private readonly invalidateCallers: (() => void) | null;
  private policy: NativeProfileEgressPolicy;
  private readonly activateProfileEgress: (() => Promise<string>) | null;
  private activationPromise: Promise<void> | null = null;
  private activationCompleted = false;
  private mainEgressRegistrationOpen = true;
  private readonly mainEgressParticipants = new Map<
    string,
    () => Promise<void>
  >();
  private workspaceId: string | null = null;
  // Safe Mode/restore-only keeps a restricted authorization target even while
  // no Ready database binding exists. This is intentionally separate from the
  // normal Ready workspace so lifecycle projection cannot erase the target
  // needed by list/verify/restore/explicit-open commands.
  private recoveryWorkspaceId: string | null = null;
  private lifecycleRevision = -1;
  private lifecycleBindingToken: string | null = null;
  private lifecycleStatus: string | null = null;
  private lifecycleActivation: string | null = null;
  /**
   * The last normal Ready observation is the only source from which a failed
   * Restore may recover main authorization.  It is deliberately retained
   * through Transition, but never used without an operation-scoped
   * Unchanged proof.
   */
  private lastReadyWorkspaceBinding: ReadyWorkspaceBinding | null = null;
  private pendingUnchangedWorkspaceBinding: ReadyWorkspaceBinding | null = null;
  private pendingOpenedWorkspaceBinding: ReadyWorkspaceBinding | null = null;
  private readonly identities = new Map<number, MainIssuedCallerIdentity>();
  private readonly registrationErrors = new Map<number, string>();

  get restricted(): boolean {
    return this._restricted;
  }

  get unavailable(): boolean {
    return this._unavailable;
  }

  private readonly ownDataReadOpen: boolean;

  constructor(
    status: NativeProfileEgressStatus | null,
    unavailable: boolean,
    policy: NativeProfileEgressPolicy,
    registerCaller?: (identity: MainIssuedCallerIdentity) => void,
    invalidateCallers?: () => void,
    activateProfileEgress?: () => Promise<string>,
    ownDataReadOpen: boolean = D2A_OWN_DATA_READ_OPEN,
  ) {
    this.ownDataReadOpen = ownDataReadOpen;
    const profileId = status?.profileId;
    const callerEpoch = status?.callerEpoch;
    this._restricted = unavailable || status?.restricted === true;
    this._unavailable = unavailable;
    this.policy = policy;
    this.registerCaller = registerCaller ?? null;
    this.invalidateCallers = invalidateCallers ?? null;
    this.activateProfileEgress = activateProfileEgress ?? null;
    this.profileId =
      typeof profileId === "string" &&
      profileId.trim() === profileId &&
      profileId
        ? profileId
        : randomUUID();
    this.callerEpoch =
      typeof callerEpoch === "number" &&
      Number.isSafeInteger(callerEpoch) &&
      callerEpoch >= 0
        ? callerEpoch
        : 0;
  }

  issueCallerIdentity(senderId: number): MainIssuedCallerIdentity {
    const existing = this.identities.get(senderId);
    const identity =
      existing ??
      ({
        profileId: this.profileId,
        callerId: randomUUID(),
        callerEpoch: this.callerEpoch,
        senderId,
        workspaceId: this.workspaceId ?? this.recoveryWorkspaceId,
        sessionId: randomUUID(),
      } satisfies MainIssuedCallerIdentity);
    if (!existing) this.identities.set(senderId, identity);
    // Native invalidates registrations during every workspace open/restore.
    // Do not re-register an unchanged JS identity on the next invoke: an IPC
    // event may be queued behind that invoke, and re-registering here would
    // reopen the old workspace/session tuple before the event can rotate it.
    // Registration failures remain retryable without weakening this rule.
    if (
      this.restricted &&
      !this.activationPromise &&
      this.registerCaller &&
      (!existing || this.registrationErrors.has(senderId))
    ) {
      try {
        this.registerCaller(identity);
        this.registrationErrors.delete(senderId);
      } catch (error) {
        this.registrationErrors.set(
          senderId,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return identity;
  }

  assertInvoke(command: string, args: CommandArgs): void {
    if (!this.restricted && !this.unavailable) {
      // Unrestricted: nothing is checked, except that a restricted-only
      // command is refused (K3/2 `nir1-restricted-only`). Decided by command
      // name so ordinary SQL is not classified on the unrestricted hot path.
      if (
        (NIR1_RESTRICTED_ONLY_COMMANDS as readonly string[]).includes(command)
      ) {
        const decision = d2aRouteDecision("nir1-restricted-only", {
          restricted: false,
          unavailable: false,
          activating: false,
          identityIssued: false,
        });
        if (!decision.allow) {
          throw denied(
            "nir1-restricted-only",
            `route ${command} ${decision.reason}`,
          );
        }
      }
      return;
    }
    if (
      this.unavailable &&
      (command === "db_execute" || command === "db_execute_batch")
    ) {
      throw denied(
        "unclassified",
        `route ${command} is unavailable until the Native profile gate is ready`,
      );
    }
    const route = this.route(command, args);
    const callerIdentity = args.callerIdentity;
    const requiresBoundCaller =
      command === "db_execute" || command === "db_execute_batch";
    if (
      requiresBoundCaller &&
      (callerIdentity === undefined || callerIdentity === null)
    ) {
      throw denied(
        "unclassified",
        `route ${command} requires a main-issued caller identity`,
      );
    }
    this.assertIssuedCallerIdentity(callerIdentity, command);
    const decision = d2aRouteDecision(route, {
      restricted: this.restricted,
      unavailable: this.unavailable,
      activating: this.activationPromise !== null,
      identityIssued: callerIdentity !== undefined && callerIdentity !== null,
    });
    if (!decision.allow) {
      throw denied(route, `route ${command} ${decision.reason}`);
    }
  }

  classifyOwnDataRead(
    command: string,
    args: CommandArgs,
  ): boolean | boolean[] | undefined {
    if (!this.ownDataReadOpen || !this.restricted || this.unavailable) {
      return undefined;
    }
    return dbOwnDataReadClassification(command, args, this.policy);
  }

  private route(command: string, args: CommandArgs): D2aRoute {
    return commandRoute(command, args, this.policy, this.ownDataReadOpen);
  }

  assertPlaintextPublication(command: string, args: CommandArgs): void {
    const route = this.route(command, args);
    if (route === "own-data-read") {
      // Q-1: a typed read of the author's own data publishes nothing outside
      // the profile, so a result admitted before activation may complete
      // after it. No Native re-authorization and no completion check.
      return;
    }
    if (route === "nir1-publication" || route === "nir1-restricted-only") {
      // The issued identity must still be the one the request was admitted
      // with: activation and workspace changes clear/rotate it.
      this.assertIssuedCallerIdentity(args.callerIdentity, command);
      if (!this.restricted && !this.unavailable) return;
      if (
        this.unavailable ||
        this.activationPromise !== null ||
        args.callerIdentity === undefined ||
        args.callerIdentity === null
      ) {
        throw denied(
          route,
          `route ${command} completed after profile restriction began`,
        );
      }
      return;
    }
    if (route !== "plaintext-publication") {
      return;
    }

    // Reuse the exact identity captured before dispatch. In particular, do not
    // call issueCallerIdentity here: an old request must not be rebound to the
    // post-activation epoch just because its Native read completed later.
    this.assertIssuedCallerIdentity(args.callerIdentity, command);
    if (!this.restricted && !this.unavailable) return;
    throw denied(
      "plaintext-publication",
      `route ${command} completed after profile restriction began`,
    );
  }

  private assertIssuedCallerIdentity(
    callerIdentity: unknown,
    command: string,
  ): void {
    if (callerIdentity === undefined || callerIdentity === null) return;
    if (
      typeof callerIdentity !== "object" ||
      Array.isArray(callerIdentity) ||
      typeof (callerIdentity as Record<string, unknown>).senderId !== "number"
    ) {
      throw denied("unclassified", "caller identity is malformed");
    }
    const senderId = (callerIdentity as Record<string, number>).senderId;
    const issued = this.identities.get(senderId);
    const candidate = callerIdentity as Partial<MainIssuedCallerIdentity>;
    if (
      !issued ||
      issued.profileId !== candidate.profileId ||
      issued.callerId !== candidate.callerId ||
      issued.callerEpoch !== candidate.callerEpoch ||
      issued.senderId !== candidate.senderId ||
      issued.workspaceId !== candidate.workspaceId ||
      issued.sessionId !== candidate.sessionId
    ) {
      throw denied(
        "unclassified",
        `caller identity is not issued for sender ${senderId}`,
      );
    }
    const registrationError = this.registrationErrors.get(senderId);
    if (registrationError && !ALLOWED_STOP_COMMANDS.has(command)) {
      throw denied(
        "unclassified",
        `caller registration failed for sender ${senderId}: ${registrationError}`,
      );
    }
  }

  allowsBackendEvent(channel: string): boolean {
    if (!this.restricted && !this.unavailable) return true;
    if (
      channel.startsWith("chat:stream-") ||
      channel.startsWith("inline-ai:stream-") ||
      channel.startsWith("cli:stream-") ||
      channel.startsWith("codex-app:")
    ) {
      return false;
    }
    return ALLOWED_BACKEND_EVENTS.has(channel);
  }

  assertExternalUrl(): void {
    if (!this.restricted && !this.unavailable) return;
    throw denied("external-url", "external URL opening is disabled");
  }

  registerMainEgressParticipant(
    name: string,
    quiesce: () => Promise<void>,
  ): void {
    if (name.trim() !== name || name.length === 0) {
      throw new Error("main egress participant name must be non-empty");
    }
    if (this.activationPromise) {
      throw new Error("main egress activation has already started");
    }
    if (this.activationCompleted || this.unavailable) {
      throw new Error("main egress activation has already completed");
    }
    if (!this.mainEgressRegistrationOpen) {
      throw new Error("main egress activation has already started");
    }
    if (this.mainEgressParticipants.has(name)) {
      throw new Error(`main egress participant is already registered: ${name}`);
    }
    this.mainEgressParticipants.set(name, quiesce);
  }

  async activateFirstRestrictedPublication(): Promise<void> {
    if (this.activationPromise) return this.activationPromise;
    if (this.unavailable) {
      throw denied("unclassified", "profile egress activation is unavailable");
    }
    if (this.restricted) return;

    // Close all egress synchronously while Native performs the durable
    // transition and quiescence barrier. No invoke/event/url can slip through
    // the activation window.
    this.mainEgressRegistrationOpen = false;
    this._restricted = true;
    const activate = this.activateProfileEgress;
    this.activationPromise = (async () => {
      try {
        const participants = [...this.mainEgressParticipants.entries()];
        if (participants.length > 0) {
          const results = await Promise.allSettled(
            participants.map(async ([name, quiesce]) => {
              try {
                await quiesce();
              } catch (error) {
                throw new Error(
                  `main egress participant failed to drain: ${name}: ${error instanceof Error ? error.message : String(error)}`,
                  { cause: error },
                );
              }
            }),
          );
          const failed = results.find(
            (result): result is PromiseRejectedResult =>
              result.status === "rejected",
          );
          if (failed) throw failed.reason;
        }
        if (!activate) {
          throw denied(
            "unclassified",
            "profile egress activation is unavailable",
          );
        }
        const raw = await activate();
        const status = JSON.parse(raw) as NativeProfileEgressStatus;
        const policy = parseNativeProfileEgressPolicy(status);
        if (!isValidNativeProfileEgressStatus(status, policy, true)) {
          throw denied(
            "unclassified",
            "profile egress activation returned an invalid restricted status",
          );
        }
        if (
          typeof status.profileId !== "string" ||
          typeof status.callerEpoch !== "number" ||
          !policy
        ) {
          throw denied(
            "unclassified",
            "profile egress activation returned an invalid restricted status",
          );
        }
        this.profileId = status.profileId;
        this.callerEpoch = status.callerEpoch;
        this.policy = policy;
        this.identities.clear();
        this.registrationErrors.clear();
        this.activationCompleted = true;
      } catch (error) {
        this._unavailable = true;
        this._restricted = true;
        throw error;
      } finally {
        this.activationPromise = null;
      }
    })();
    return this.activationPromise;
  }

  /**
   * Consume the trusted result of the legacy Restore command.  Native's
   * Unchanged outcome carries the opaque lifecycle token and revision that
   * prove the exact old authority survived.  A Ready snapshot alone is not
   * enough: after Transition it may describe a new instance or an unrelated
   * recovery projection.  The proof is therefore either applied immediately
   * when its terminal Ready snapshot was observed first, or held until that
   * exact snapshot arrives through the event bus.
   */
  observeWorkspaceLifecycleResult(payload: unknown): void {
    let outcome: ReturnType<typeof parseWorkspaceRestoreOutcome>;
    try {
      outcome = parseWorkspaceRestoreOutcome(payload);
    } catch {
      return;
    }
    if (outcome.status !== "unchanged") return;
    const token = outcome.lifecycle.bindingToken;
    const lastReady = this.lastReadyWorkspaceBinding;
    if (
      token === null ||
      lastReady === null ||
      token !== lastReady.bindingToken ||
      outcome.lifecycle.status !== "ready" ||
      outcome.lifecycle.activation !== "ready" ||
      outcome.lifecycle.revision <= lastReady.revision ||
      this.recoveryWorkspaceId !== null ||
      this.lifecycleRevision > outcome.lifecycle.revision
    ) {
      return;
    }

    const proof: ReadyWorkspaceBinding = {
      bindingToken: token,
      workspaceId: lastReady.workspaceId,
      revision: outcome.lifecycle.revision,
    };

    // A successful replacement or a different workspace event supersedes an
    // old proof.  Never overwrite that binding with the retained old target.
    if (this.workspaceId !== null && this.workspaceId !== proof.workspaceId) {
      this.pendingUnchangedWorkspaceBinding = null;
      return;
    }

    if (
      this.lifecycleStatus === "ready" &&
      this.lifecycleBindingToken === proof.bindingToken &&
      // Apply immediately only after the exact terminal Ready snapshot has
      // already been observed.  A queued Transition/Ready pair may overtake
      // this result callback; treating an older Ready observation as terminal
      // would let that delayed Transition clear the restored binding and the
      // delayed Ready would then have no proof left to apply.
      this.lifecycleRevision === proof.revision
    ) {
      this.restoreNormalWorkspaceBinding(proof);
      return;
    }
    if (
      this.lifecycleStatus === "transition" ||
      this.lifecycleStatus === "ready"
    ) {
      this.pendingUnchangedWorkspaceBinding = proof;
    }
  }

  observeWorkspaceOpenResult(payload: unknown, workspacePath: string): void {
    let value: unknown = payload;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value) as unknown;
      } catch {
        return;
      }
    }
    if (value === null || typeof value !== "object") return;
    const result = value as Record<string, unknown>;
    if (result.status !== "ready" && result.status !== "migrated") return;
    const snapshot = result.lifecycle;
    if (snapshot === null || typeof snapshot !== "object") return;
    const lifecycle = snapshot as Record<string, unknown>;
    if (
      workspacePath.trim() === "" ||
      lifecycle.schemaVersion !== 1 ||
      !Number.isSafeInteger(lifecycle.revision) ||
      (lifecycle.revision as number) < 0 ||
      lifecycle.status !== "ready" ||
      lifecycle.activation !== "ready" ||
      typeof lifecycle.bindingToken !== "string" ||
      lifecycle.bindingToken.trim() === "" ||
      (lifecycle.revision as number) < this.lifecycleRevision ||
      ((lifecycle.revision as number) === this.lifecycleRevision &&
        lifecycle.bindingToken !== this.lifecycleBindingToken)
    ) {
      return;
    }
    if (
      this.lifecycleRevision === lifecycle.revision &&
      this.lifecycleStatus === "ready" &&
      this.lifecycleActivation === "ready" &&
      this.workspaceId === workspacePath
    ) {
      return;
    }

    // Native publishes Opened then Ready through one nonblocking event bus;
    // its Promise result can overtake those callbacks. Bind before replying,
    // so renderer hydration cannot mint readers that those queued callbacks
    // immediately revoke. The next terminal Ready or newer lifecycle closes
    // this single acknowledgement; genuine replacement still revokes.
    this.observeBackendEvent("workspace:opened", { path: workspacePath });
    this.observeBackendEvent("workspace:lifecycle-state", lifecycle);
    this.pendingOpenedWorkspaceBinding = {
      workspaceId: workspacePath,
      bindingToken: lifecycle.bindingToken,
      revision: lifecycle.revision as number,
    };
  }

  private restoreNormalWorkspaceBinding(proof: ReadyWorkspaceBinding): void {
    if (this.recoveryWorkspaceId !== null) {
      this.pendingUnchangedWorkspaceBinding = null;
      return;
    }
    if (this.workspaceId !== null && this.workspaceId !== proof.workspaceId) {
      this.pendingUnchangedWorkspaceBinding = null;
      return;
    }
    const senderIds = [...this.identities.keys()];
    if (senderIds.length > 0) {
      try {
        this.invalidateCallers?.();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        for (const senderId of senderIds) {
          this.registrationErrors.set(senderId, detail);
        }
      }
    }
    this.identities.clear();
    this.registrationErrors.clear();
    this.workspaceId = proof.workspaceId;
    this.lastReadyWorkspaceBinding = proof;
    this.pendingUnchangedWorkspaceBinding = null;
  }

  observeBackendEvent(channel: string, payload: unknown): void {
    if (channel === "workspace:lifecycle-state") {
      if (payload === null || typeof payload !== "object") return;
      const record = payload as Record<string, unknown>;
      if (
        !Number.isSafeInteger(record.revision) ||
        typeof record.status !== "string" ||
        typeof record.activation !== "string" ||
        (record.bindingToken !== null &&
          typeof record.bindingToken !== "string")
      ) {
        return;
      }
      const revision = record.revision as number;
      if (revision < this.lifecycleRevision) return;
      if (
        this.pendingOpenedWorkspaceBinding !== null &&
        revision >= this.pendingOpenedWorkspaceBinding.revision
      ) {
        this.pendingOpenedWorkspaceBinding = null;
      }
      const token =
        typeof record.bindingToken === "string" ? record.bindingToken : null;
      const bindingChanged =
        token !== this.lifecycleBindingToken ||
        record.status !== this.lifecycleStatus ||
        record.activation !== this.lifecycleActivation;
      const changed = revision > this.lifecycleRevision || bindingChanged;
      this.lifecycleRevision = revision;
      this.lifecycleBindingToken = token;
      this.lifecycleStatus = record.status;
      this.lifecycleActivation = record.activation;

      // A result callback may arrive before the nonblocking lifecycle event
      // for the same operation.  Apply the proof at the exact Ready revision
      // even when the event is revision-only (same token/status); otherwise a
      // delayed Transition can clear the binding and the final Ready event
      // would be mistaken for an already-observed snapshot.
      const pending = this.pendingUnchangedWorkspaceBinding;
      const pendingReadyMatches =
        pending !== null &&
        record.status === "ready" &&
        record.activation === "ready" &&
        token === pending.bindingToken &&
        revision === pending.revision;
      if (pendingReadyMatches) {
        this.restoreNormalWorkspaceBinding(pending);
      }
      if (!changed) return;
      if (
        this.pendingUnchangedWorkspaceBinding !== null &&
        revision >= this.pendingUnchangedWorkspaceBinding.revision &&
        (record.status !== "ready" ||
          token !== this.pendingUnchangedWorkspaceBinding.bindingToken ||
          revision !== this.pendingUnchangedWorkspaceBinding.revision)
      ) {
        // A newer or differently bound observation makes the operation proof
        // stale.  In particular, a NotAdmitted result never arms this slot.
        this.pendingUnchangedWorkspaceBinding = null;
      }
      // A descriptor recovery that is unrelated to the currently Ready
      // workspace advances the shared lifecycle revision while preserving the
      // same renderer binding token/status.  Revision is still published for
      // freshness, but it is not proof that caller authorization changed.
      // Keep in-flight W2 profile work alive in this revision-only case.
      if (!bindingChanged) return;
      const senderIds = [...this.identities.keys()];
      try {
        this.invalidateCallers?.();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        for (const senderId of senderIds) {
          this.registrationErrors.set(senderId, detail);
        }
      }
      // `workspace:opened` is emitted by Native before the terminal Ready
      // lifecycle snapshot. Preserve a trusted recovery target across both
      // the requires-open projection and the Transition emitted while a Safe
      // Mode restore is in progress. Transition closes ordinary workspace
      // access, but it must not erase the target that authorizes the next
      // descriptor-bound recovery/Open. All caller identities are
      // invalidated and must re-register against the retained target.
      if (record.status === "ready" && record.activation === "ready") {
        this.recoveryWorkspaceId = null;
        if (
          token !== null &&
          this.workspaceId !== null &&
          this.recoveryWorkspaceId === null
        ) {
          this.lastReadyWorkspaceBinding = {
            bindingToken: token,
            workspaceId: this.workspaceId,
            revision,
          };
        }
      } else if (
        record.status === "recovery-required" ||
        record.activation === "requires-open"
      ) {
        this.workspaceId = this.recoveryWorkspaceId;
      } else if (
        record.status === "transition" &&
        this.recoveryWorkspaceId !== null
      ) {
        this.workspaceId = null;
      } else {
        this.workspaceId = null;
        this.recoveryWorkspaceId = null;
      }
      if (record.status === "closed") {
        this.lastReadyWorkspaceBinding = null;
        this.pendingUnchangedWorkspaceBinding = null;
      }
      this.identities.clear();
      this.registrationErrors.clear();
      return;
    }
    if (
      channel !== "workspace:opened" ||
      payload === null ||
      typeof payload !== "object"
    ) {
      return;
    }
    const record = payload as Record<string, unknown>;
    const workspace = record.workspace;
    const nestedWorkspaceId =
      workspace !== null && typeof workspace === "object"
        ? (workspace as Record<string, unknown>).workspaceId
        : undefined;
    // Native's existing workspace event carries the trusted active path while
    // the open command's result carries the UUID. Accept both shapes so the
    // profile binding also rotates on restore/open without changing the event
    // contract or exposing renderer-supplied identity.
    const workspaceId = nestedWorkspaceId ?? record.workspaceId ?? record.path;
    if (typeof workspaceId !== "string" || workspaceId.trim() === "") return;
    const pendingOpened = this.pendingOpenedWorkspaceBinding;
    this.pendingOpenedWorkspaceBinding = null;
    if (
      record.restoreOnly !== true &&
      pendingOpened !== null &&
      workspaceId === pendingOpened.workspaceId &&
      this.workspaceId === pendingOpened.workspaceId &&
      this.lifecycleRevision === pendingOpened.revision &&
      this.lifecycleBindingToken === pendingOpened.bindingToken &&
      this.lifecycleStatus === "ready" &&
      this.lifecycleActivation === "ready"
    ) {
      return;
    }

    if (workspaceId !== this.workspaceId || this.identities.size > 0) {
      const senderIds = [...this.identities.keys()];
      try {
        this.invalidateCallers?.();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        for (const senderId of senderIds) {
          this.registrationErrors.set(senderId, detail);
        }
      }
      this.identities.clear();
      this.registrationErrors.clear();
    }
    const restoreOnly = record.restoreOnly === true;
    this.pendingUnchangedWorkspaceBinding = null;
    this.workspaceId = workspaceId;
    this.recoveryWorkspaceId = restoreOnly ? workspaceId : null;
  }
}

function parseNativeProfileEgressPolicy(
  status: NativeProfileEgressStatus,
): NativeProfileEgressPolicy | null {
  if (
    status.sqlPolicy === null ||
    typeof status.sqlPolicy !== "object" ||
    Array.isArray(status.sqlPolicy)
  ) {
    return null;
  }
  const policy = status.sqlPolicy as Record<string, unknown>;
  // Unknown keys and unknown versions are unavailable (fail closed).
  if (
    Object.keys(policy).some(
      (key) =>
        key !== "version" &&
        key !== "closedTables" &&
        key !== "readOpenTables" &&
        key !== "readOpenColumns",
    )
  ) {
    return null;
  }
  if (policy.version !== PROFILE_EGRESS_POLICY_VERSION) return null;

  const closedTables = parseTableSet(policy.closedTables);
  const readOpenTables = parseTableSet(policy.readOpenTables);
  if (closedTables === null || readOpenTables === null) return null;
  // A table is declared in exactly one class.
  for (const table of readOpenTables) {
    if (closedTables.has(table)) return null;
  }

  if (!Array.isArray(policy.readOpenColumns)) return null;
  const readOpenColumns = new Set<string>();
  for (const value of policy.readOpenColumns) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).some((key) => key !== "table" && key !== "column")
    ) {
      return null;
    }
    const table = record.table;
    const column = record.column;
    if (
      typeof table !== "string" ||
      typeof column !== "string" ||
      table.trim() !== table ||
      column.trim() !== column ||
      table === "" ||
      column === ""
    ) {
      return null;
    }
    const key = `${table.toLowerCase()}.${column.toLowerCase()}`;
    if (readOpenColumns.has(key)) return null;
    readOpenColumns.add(key);
  }
  return { closedTables, readOpenTables, readOpenColumns };
}

function parseTableSet(value: unknown): Set<string> | null {
  if (!Array.isArray(value)) return null;
  const tables = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim() !== entry || entry === "") {
      return null;
    }
    const normalized = entry.toLowerCase();
    if (tables.has(normalized)) return null;
    tables.add(normalized);
  }
  return tables.size === 0 ? null : tables;
}

function isValidNativeProfileEgressStatus(
  status: NativeProfileEgressStatus,
  policy: NativeProfileEgressPolicy | null,
  requireRestricted: boolean,
): boolean {
  return (
    (status.restricted === true || status.restricted === false) &&
    (!requireRestricted || status.restricted === true) &&
    status.inFlightStopped === true &&
    status.handlesInvalidated === status.restricted &&
    typeof status.profileId === "string" &&
    status.profileId.trim() === status.profileId &&
    status.profileId.length > 0 &&
    typeof status.callerEpoch === "number" &&
    Number.isSafeInteger(status.callerEpoch) &&
    status.callerEpoch >= 0 &&
    policy !== null
  );
}

export interface ProfileEgressGateOptions {
  /**
   * Test seam for the own-data-read opening. Production code does not pass it:
   * the gate follows `D2A_OWN_DATA_READ_OPEN`.
   */
  readonly ownDataReadOpen?: boolean;
}

export async function createProfileEgressGate(
  backend: MainProfileEgressBackend | null,
  options: ProfileEgressGateOptions = {},
): Promise<ProfileEgressGate> {
  const ownDataReadOpen = options.ownDataReadOpen ?? D2A_OWN_DATA_READ_OPEN;
  if (
    !backend?.initializeProfileEgress ||
    !backend.registerProfileEgressCaller ||
    !backend.invalidateProfileEgressCallers
  ) {
    return new NativeBoundProfileEgressGate(
      null,
      true,
      emptyNativeProfileEgressPolicy(),
      undefined,
      undefined,
      undefined,
      ownDataReadOpen,
    );
  }
  try {
    const raw = await backend.initializeProfileEgress!();
    const status = JSON.parse(raw) as NativeProfileEgressStatus;
    const policy = parseNativeProfileEgressPolicy(status);
    if (!isValidNativeProfileEgressStatus(status, policy, false)) {
      return new NativeBoundProfileEgressGate(
        null,
        true,
        emptyNativeProfileEgressPolicy(),
        undefined,
        undefined,
        undefined,
        ownDataReadOpen,
      );
    }
    if (!policy) {
      return new NativeBoundProfileEgressGate(
        null,
        true,
        emptyNativeProfileEgressPolicy(),
        undefined,
        undefined,
        undefined,
        ownDataReadOpen,
      );
    }
    return new NativeBoundProfileEgressGate(
      status,
      false,
      policy,
      (identity) => {
        backend.registerProfileEgressCaller!(JSON.stringify(identity));
      },
      () => backend.invalidateProfileEgressCallers!(),
      backend.activateProfileEgress
        ? () => backend.activateProfileEgress!()
        : undefined,
      ownDataReadOpen,
    );
  } catch (error) {
    console.error(
      `[grimodex-electron] D2a profile egress startup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return new NativeBoundProfileEgressGate(
      null,
      true,
      emptyNativeProfileEgressPolicy(),
      undefined,
      undefined,
      undefined,
      ownDataReadOpen,
    );
  }
}

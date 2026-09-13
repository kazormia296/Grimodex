import { randomUUID } from "node:crypto";

import type { CommandArgs, NapiBackendLike } from "../shared/ipcContract.js";

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
}

type D2aRoute =
  | "old-external-ai"
  | "old-local-ai"
  | "plaintext-publication"
  | "external-url"
  | "native-mutation"
  | "internal"
  | "unclassified";

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
  ["get_mcp_config", "old-external-ai"],
  ["reply_to_annotation", "old-external-ai"],
  ["narrative_extraction_get_run_review_bundle", "plaintext-publication"],
  ["ai_audit_read_snapshot", "plaintext-publication"],
  ["ai_audit_verify", "plaintext-publication"],
  ["list_post_effect_runs", "plaintext-publication"],
  ["list_scene_lens_for_project", "plaintext-publication"],
  ["list_annotations_for_scene", "plaintext-publication"],
  ["list_annotations_for_project", "plaintext-publication"],
  ["codex_index_entry", "plaintext-publication"],
  ["codex_semantic_search", "plaintext-publication"],
  ["codex_match_text", "plaintext-publication"],
  ["extract_codex_candidates", "plaintext-publication"],
  ["extract_codex_entity_seeds", "plaintext-publication"],
  ["semantic_search", "plaintext-publication"],
  ["semantic_chunk_context", "plaintext-publication"],
  ["semantic_debug_dump", "plaintext-publication"],
  ["fts_search", "plaintext-publication"],
  ["nir1_evidence_qualify", "plaintext-publication"],
  ["nir1_pack_context", "plaintext-publication"],
  ["related_scenes_begin", "plaintext-publication"],
  ["related_scenes_continue", "plaintext-publication"],
  ["events_index_entry", "plaintext-publication"],
  ["events_semantic_search", "plaintext-publication"],
  ["chat_index_message", "plaintext-publication"],
  ["chat_message_search", "plaintext-publication"],
  ["plot_thread_list", "plaintext-publication"],
  ["plot_thread_list_links", "plaintext-publication"],
  ["foreshadow_list_with_labels", "plaintext-publication"],
  ["foreshadow_list_open_for_context", "plaintext-publication"],
  ["foreshadow_get_scene_info", "plaintext-publication"],
  ["foreshadow_get_scene_context", "plaintext-publication"],
  ["foreshadow_list_by_codex_entry", "plaintext-publication"],
  ["foreshadow_get_chapter_stats", "plaintext-publication"],
  ["foreshadow_get_setup", "plaintext-publication"],
  ["foreshadow_get", "plaintext-publication"],
  ["foreshadow_list_linked_codex", "plaintext-publication"],
  ["foreshadow_load_anchors_for_scene", "plaintext-publication"],
  ["narrative_extraction_get_run", "plaintext-publication"],
  ["narrative_extraction_list_resumable_runs", "plaintext-publication"],
  ["narrative_extraction_is_run_resumable_for_review", "plaintext-publication"],
  [
    "narrative_extraction_list_chronicle_task_resume_candidates",
    "plaintext-publication",
  ],
  ["narrative_extraction_get_commit_status", "plaintext-publication"],
  ["narrative_maintenance_inbox_list", "plaintext-publication"],
  ["trash_bin_list", "plaintext-publication"],
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
  "activate_license",
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
  "chat_index_status",
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
  "deactivate_license",
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
  "lint_ignore_list",
  "lint_ignore_list_scene",
  "lint_ignore_move",
  "lint_term_dictionary_delete",
  "lint_term_dictionary_insert",
  "lint_term_dictionary_list",
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
  "narrative_extraction_claim_task",
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
  "nir1_entity_relation_revision_create",
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
  "project_snapshot_restore_context",
  "quarantine_live_database",
  "rebuild_narrative_derived_state",
  "related_scenes_release",
  "repair_integrity",
  "repair_narrative_dependency_declarations",
  "restore_backup",
  "restore_recovery_candidate",
  "retry_narrative_legacy_backfill",
  "revalidate_license",
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
  "vivliostyle_build",
  "vivliostyle_detect",
  "vivliostyle_preview_start",
  "vivliostyle_preview_stop",
  "vivliostyle_save_output",
]);

const PROTECTED_DB_TABLES = new Set([
  "chat_messages",
  "chat_message_prompts",
  "chat_sessions",
  "messages",
  "ai_audit_events",
  "narrative_extraction_artifacts",
  "narrative_extraction_runs",
  "narrative_proposal_revisions",
  "narrative_proposal_decisions",
  "post_effect_runs",
  "post_effect_annotations",
]);

const LOCAL_DB_TABLES = new Set([
  "app_settings",
  "change_events",
  "codex_entries",
  "codex_relations",
  "codex_types",
  "events",
  "projects",
  "scene_events",
  "tree_nodes",
]);

function dbReadRoute(sql: unknown): D2aRoute {
  if (typeof sql !== "string") return "unclassified";
  const tableNames = [
    ...sql.matchAll(/\b(?:from|join|into|update)\s+([\w.]+)/gi),
  ].map((match) => match[1]?.split(".").at(-1)?.toLowerCase());
  if (tableNames.some((table) => table && PROTECTED_DB_TABLES.has(table))) {
    return "plaintext-publication";
  }
  if (
    /^\s*(?:select|pragma|with)\b/i.test(sql) &&
    tableNames.length > 0 &&
    tableNames.every((table) => table && LOCAL_DB_TABLES.has(table))
  ) {
    return "internal";
  }
  return "unclassified";
}

function dbStatementRoute(sql: unknown): D2aRoute {
  if (typeof sql !== "string") return "unclassified";
  if (/^\s*(select|pragma|with)\b/i.test(sql)) return dbReadRoute(sql);
  return /^\s*(insert|update|delete|replace|create|alter|drop|vacuum|attach|detach)\b/i.test(
    sql,
  )
    ? "native-mutation"
    : "unclassified";
}

const ALLOWED_BACKEND_EVENTS = new Set([
  "backend:ready",
  "workspace:opened",
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

function commandRoute(command: string, args: CommandArgs): D2aRoute {
  const explicit = DENIED_COMMANDS.get(command);
  if (explicit) return explicit;
  if (ALLOWED_STOP_COMMANDS.has(command)) return "native-mutation";
  if (command === "db_execute") {
    const method = args.method;
    return method === "run" ? "native-mutation" : dbReadRoute(args.sql);
  }
  if (command === "db_execute_batch") {
    const statements = args.statements;
    if (!Array.isArray(statements)) return "unclassified";
    const routes = statements.map((statement) => {
      if (statement === null || typeof statement !== "object") {
        return "unclassified" as const;
      }
      const sql = (statement as Record<string, unknown>).sql;
      return dbStatementRoute(sql);
    });
    if (routes.some((route) => route === "plaintext-publication")) {
      return "plaintext-publication";
    }
    return routes.some((route) => route === "unclassified")
      ? "unclassified"
      : "native-mutation";
  }
  return INTERNAL_COMMANDS.has(command) ? "internal" : "unclassified";
}

function denied(route: D2aRoute, detail: string): Error {
  return new Error(`${D2A_EGRESS_DENIED_MARKER} ${route}: ${detail}`);
}

export interface ProfileEgressGate {
  readonly restricted: boolean;
  readonly unavailable: boolean;
  issueCallerIdentity(senderId: number): MainIssuedCallerIdentity;
  assertInvoke(command: string, args: CommandArgs): void;
  allowsBackendEvent(channel: string): boolean;
  assertExternalUrl(): void;
  observeBackendEvent?(channel: string, payload: unknown): void;
}

class NativeBoundProfileEgressGate implements ProfileEgressGate {
  readonly restricted = true;
  readonly unavailable: boolean;
  private readonly profileId: string;
  private readonly callerEpoch: number;
  private workspaceId: string | null = null;
  private readonly identities = new Map<number, MainIssuedCallerIdentity>();

  constructor(status: NativeProfileEgressStatus | null, unavailable: boolean) {
    const profileId = status?.profileId;
    const callerEpoch = status?.callerEpoch;
    this.unavailable = unavailable;
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
    if (existing) return existing;
    const identity: MainIssuedCallerIdentity = {
      profileId: this.profileId,
      callerId: randomUUID(),
      callerEpoch: this.callerEpoch,
      senderId,
      workspaceId: this.workspaceId,
      sessionId: randomUUID(),
    };
    this.identities.set(senderId, identity);
    return identity;
  }

  assertInvoke(command: string, args: CommandArgs): void {
    const route = commandRoute(command, args);
    if (
      route === "old-external-ai" ||
      route === "old-local-ai" ||
      route === "plaintext-publication" ||
      route === "external-url" ||
      route === "unclassified"
    ) {
      throw denied(
        route,
        `route ${command} is unavailable in profile local-only mode`,
      );
    }
  }

  allowsBackendEvent(channel: string): boolean {
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
    throw denied("external-url", "external URL opening is disabled");
  }

  observeBackendEvent(channel: string, payload: unknown): void {
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
    if (workspaceId !== this.workspaceId) {
      this.workspaceId = workspaceId;
      this.identities.clear();
    }
  }
}

export async function createProfileEgressGate(
  backend: NapiBackendLike | null,
): Promise<ProfileEgressGate> {
  if (!backend?.initializeProfileEgress) {
    return new NativeBoundProfileEgressGate(null, true);
  }
  try {
    const raw = await backend.initializeProfileEgress();
    const status = JSON.parse(raw) as NativeProfileEgressStatus;
    if (
      status.restricted !== true ||
      status.handlesInvalidated !== true ||
      status.inFlightStopped !== true
    ) {
      return new NativeBoundProfileEgressGate(null, true);
    }
    return new NativeBoundProfileEgressGate(status, false);
  } catch (error) {
    console.error(
      `[grimodex-electron] D2a profile egress startup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return new NativeBoundProfileEgressGate(null, true);
  }
}

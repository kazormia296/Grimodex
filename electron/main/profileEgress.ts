import { randomUUID } from "node:crypto";

import {
  NAPI_COMMANDS,
  type CommandArgs,
  type NapiBackendLike,
} from "../shared/ipcContract.js";

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

const PROFILE_EGRESS_POLICY_VERSION = 1;

interface NativeProfileEgressPolicy {
  readonly protectedTables: ReadonlySet<string>;
  readonly protectedColumns: ReadonlySet<string>;
}

type MainProfileEgressBackend = NapiBackendLike & {
  /** Main-only N-API method; never part of the renderer command contract. */
  activateProfileEgress?: () => Promise<string>;
};

type D2aRoute =
  | "old-external-ai"
  | "old-local-ai"
  | "plaintext-publication"
  | "external-url"
  | "native-mutation"
  | "internal"
  | "unclassified";

/**
 * Renderer-visible typed results that are not safe to expose while D2a is
 * restricted.  The `satisfies` key check makes adding a stale/nonexistent
 * command to this small exception ledger a compile-time error; all other
 * commands remain covered by the route ledger below.
 */
export type D2aTypedResultPolicy = "plaintext-publication";
export const D2A_TYPED_RESULT_POLICY = {
  project_snapshot_restore_context: "plaintext-publication",
  lint_ignore_list: "plaintext-publication",
  lint_ignore_list_scene: "plaintext-publication",
  lint_term_dictionary_list: "plaintext-publication",
  nir1_entity_relation_revision_read: "plaintext-publication",
  nir1_entity_relation_revision_read_current: "plaintext-publication",
} as const satisfies Partial<
  Record<keyof typeof NAPI_COMMANDS, D2aTypedResultPolicy>
>;

const DENIED_COMMANDS = new Map<string, D2aRoute>([
  ["send_chat_message", "old-external-ai"],
  ["send_chat_message_stream", "old-external-ai"],
  ["send_inline_ai_stream", "old-local-ai"],
  ["send_agent_message", "old-external-ai"],
  ["list_ai_models", "old-external-ai"],
  ["test_ai_connection", "external-url"],
  ["activate_license", "external-url"],
  ["revalidate_license", "external-url"],
  ["deactivate_license", "external-url"],
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
  ["get_mcp_config", "old-external-ai"],
  ["narrative_extraction_claim_task", "plaintext-publication"],
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

function hasProtectedColumnReference(
  sql: string,
  tableNames: ReadonlyArray<string | undefined>,
  policy: NativeProfileEgressPolicy,
): boolean {
  // This is an early route classification only. Native's SQLite authorizer
  // consumes the same policy and remains the enforcement authority.
  return [...policy.protectedColumns].some((reference) => {
    const [table, column] = reference.split(".");
    if (!table || !column) return false;
    if (!tableNames.some((name) => name === table)) return false;
    if (/\bselect\s+\*/i.test(sql)) return true;
    const escapedColumn = column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escapedColumn}\\b`, "i").test(sql);
  });
}

function dbReadRoute(
  sql: unknown,
  hasBoundCaller = false,
  policy: NativeProfileEgressPolicy,
): D2aRoute {
  if (typeof sql !== "string") return "unclassified";
  const tableNames = sqlTableNames(sql);
  if (
    tableNames.some((table) => table && policy.protectedTables.has(table)) ||
    hasProtectedColumnReference(sql, tableNames, policy)
  ) {
    return "plaintext-publication";
  }
  if (
    /^\s*(?:select|pragma|with)\b/i.test(sql) &&
    tableNames.length > 0 &&
    hasBoundCaller
  ) {
    return "internal";
  }
  return "unclassified";
}

function dbStatementRoute(
  sql: unknown,
  hasBoundCaller = false,
  policy: NativeProfileEgressPolicy,
): D2aRoute {
  if (typeof sql !== "string") return "unclassified";
  const tableNames = sqlTableNames(sql);
  if (
    tableNames.some((table) => table && policy.protectedTables.has(table)) ||
    hasProtectedColumnReference(sql, tableNames, policy)
  ) {
    return "plaintext-publication";
  }
  if (/^\s*(select|pragma|with)\b/i.test(sql)) {
    return dbReadRoute(sql, hasBoundCaller, policy);
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

function typedResultRoute(command: string): D2aRoute | undefined {
  return D2A_TYPED_RESULT_POLICY[
    command as keyof typeof D2A_TYPED_RESULT_POLICY
  ];
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

function commandRoute(
  command: string,
  args: CommandArgs,
  policy: NativeProfileEgressPolicy,
): D2aRoute {
  const typedResult = typedResultRoute(command);
  if (typedResult) return typedResult;
  const explicit = DENIED_COMMANDS.get(command);
  if (explicit) return explicit;
  if (ALLOWED_STOP_COMMANDS.has(command)) return "native-mutation";
  const hasBoundCaller =
    args.callerIdentity !== undefined && args.callerIdentity !== null;
  if (command === "db_execute") {
    return dbStatementRoute(args.sql, hasBoundCaller, policy);
  }
  if (command === "db_execute_batch") {
    const statements = args.statements;
    if (!Array.isArray(statements)) return "unclassified";
    const routes = statements.map((statement) => {
      if (statement === null || typeof statement !== "object") {
        return "unclassified" as const;
      }
      const sql = (statement as Record<string, unknown>).sql;
      return dbStatementRoute(sql, hasBoundCaller, policy);
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
  private readonly identities = new Map<number, MainIssuedCallerIdentity>();
  private readonly registrationErrors = new Map<number, string>();

  get restricted(): boolean {
    return this._restricted;
  }

  get unavailable(): boolean {
    return this._unavailable;
  }

  constructor(
    status: NativeProfileEgressStatus | null,
    unavailable: boolean,
    policy: NativeProfileEgressPolicy,
    registerCaller?: (identity: MainIssuedCallerIdentity) => void,
    invalidateCallers?: () => void,
    activateProfileEgress?: () => Promise<string>,
  ) {
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
        workspaceId: this.workspaceId,
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
    if (!this.restricted && !this.unavailable) return;
    if (
      this.unavailable &&
      (command === "db_execute" || command === "db_execute_batch")
    ) {
      throw denied(
        "unclassified",
        `route ${command} is unavailable until the Native profile gate is ready`,
      );
    }
    const route = commandRoute(command, args, this.policy);
    const callerIdentity = args.callerIdentity;
    const requiresBoundCaller =
      command === "db_execute" ||
      command === "db_execute_batch";
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

  assertPlaintextPublication(command: string, args: CommandArgs): void {
    if (commandRoute(command, args, this.policy) !== "plaintext-publication") {
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
      throw denied(
        "unclassified",
        "profile egress activation is unavailable",
      );
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
      this.workspaceId = workspaceId;
      this.identities.clear();
      this.registrationErrors.clear();
    }
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
  if (
    Object.keys(policy).some(
      (key) =>
        key !== "version" &&
        key !== "protectedTables" &&
        key !== "protectedColumns",
    )
  ) {
    return null;
  }
  if (policy.version !== PROFILE_EGRESS_POLICY_VERSION) return null;
  if (!Array.isArray(policy.protectedTables)) return null;
  if (!Array.isArray(policy.protectedColumns)) return null;

  const protectedTables = new Set<string>();
  for (const value of policy.protectedTables) {
    if (typeof value !== "string" || value.trim() !== value || value === "") {
      return null;
    }
    const normalized = value.toLowerCase();
    if (protectedTables.has(normalized)) return null;
    protectedTables.add(normalized);
  }
  if (protectedTables.size === 0) return null;

  const protectedColumns = new Set<string>();
  for (const value of policy.protectedColumns) {
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
    if (protectedColumns.has(key)) return null;
    protectedColumns.add(key);
  }
  return { protectedTables, protectedColumns };
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

export async function createProfileEgressGate(
  backend: MainProfileEgressBackend | null,
): Promise<ProfileEgressGate> {
  if (
    !backend?.initializeProfileEgress ||
    !backend.registerProfileEgressCaller ||
    !backend.invalidateProfileEgressCallers
  ) {
    return new NativeBoundProfileEgressGate(null, true, {
      protectedTables: new Set(),
      protectedColumns: new Set(),
    });
  }
  try {
    const raw = await backend.initializeProfileEgress!();
    const status = JSON.parse(raw) as NativeProfileEgressStatus;
    const policy = parseNativeProfileEgressPolicy(status);
    if (!isValidNativeProfileEgressStatus(status, policy, false)) {
      return new NativeBoundProfileEgressGate(null, true, {
        protectedTables: new Set(),
        protectedColumns: new Set(),
      });
    }
    if (!policy) {
      return new NativeBoundProfileEgressGate(null, true, {
        protectedTables: new Set(),
        protectedColumns: new Set(),
      });
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
    );
  } catch (error) {
    console.error(
      `[grimodex-electron] D2a profile egress startup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return new NativeBoundProfileEgressGate(null, true, {
      protectedTables: new Set(),
      protectedColumns: new Set(),
    });
  }
}

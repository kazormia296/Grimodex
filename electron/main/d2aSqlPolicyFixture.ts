// Test fixture: the Native `sqlPolicy` (version 2) exactly as
// `grimodex_db::profile_egress_policy::sql_policy_for_status()` publishes it.
// `d2aOwnDataRead.pipeline.spec.ts` compares this against the real Native
// status so the fixture cannot drift from the ledger.

export const NATIVE_CLOSED_TABLES: readonly string[] = [
  "narrative_apply_commits",
  "narrative_apply_operations",
  "narrative_commit_journals",
  "narrative_consumer_freshness",
  "narrative_extraction_artifacts",
  "narrative_extraction_attempts",
  "narrative_extraction_runs",
  "narrative_extraction_stage_model_bindings",
  "narrative_extraction_stage_receipts",
  "narrative_extraction_tasks",
  "narrative_maintenance_attention",
  "narrative_maintenance_finding_lifecycle",
  "narrative_maintenance_finding_observations",
  "narrative_proposal_applications",
  "narrative_proposal_decisions",
  "narrative_proposal_revisions",
  "narrative_proposal_sets",
  "narrative_proposals",
  "nir1_chat_input_captures",
  "nir1_chat_input_submission_keys",
  "nir1_generation_attempts",
  "nir1_generation_input_refs",
  "nir1_generation_message_versions",
  "nir1_generation_qualification_refs",
  "idempotency_requests",
  "messages",
];

export const NATIVE_READ_OPEN_TABLES: readonly string[] = [
  "ab_comparison_runs",
  "ab_comparisons",
  "ai_audit_events",
  "chat_message_chunks",
  "chat_messages_fts",
  "chat_messages_fts_en",
  "chat_message_prompts",
  "chat_messages",
  "chat_runtime_threads",
  "chat_sessions",
  "chat_summaries",
  "generation_logs",
  "project_snapshot_tree_nodes",
  "project_snapshot_codex_entries",
  "project_snapshot_snippets",
  "project_snapshot_aux",
  "content_versions",
  "post_effect_annotation_relations",
  "post_effect_annotations",
  "post_effect_annotations_fts",
  "post_effect_annotations_fts_en",
  "post_effect_runs",
  "impact_review_baselines",
  "scene_lens_data",
  "scene_chunks",
  "codex_chunks",
  "event_chunks",
  "undo_journal",
  "prose_staging",
  "trash_items",
  "foreshadows",
  "foreshadow_setups",
  "foreshadow_payoffs",
  "foreshadow_setup_payoff_links",
  "foreshadow_codex_links",
  "plot_threads",
  "plot_thread_scene_links",
  "plot_thread_branches",
  "lint_ignored_diagnostics",
  "lint_term_dictionary",
  "chat_messages_fts_config",
  "chat_messages_fts_data",
  "chat_messages_fts_docsize",
  "chat_messages_fts_idx",
  "chat_messages_fts_en_config",
  "chat_messages_fts_en_content",
  "chat_messages_fts_en_data",
  "chat_messages_fts_en_docsize",
  "chat_messages_fts_en_idx",
  "post_effect_annotations_fts_config",
  "post_effect_annotations_fts_data",
  "post_effect_annotations_fts_docsize",
  "post_effect_annotations_fts_idx",
  "post_effect_annotations_fts_en_config",
  "post_effect_annotations_fts_en_content",
  "post_effect_annotations_fts_en_data",
  "post_effect_annotations_fts_en_docsize",
  "post_effect_annotations_fts_en_idx",
];

export const NATIVE_READ_OPEN_COLUMNS: ReadonlyArray<{
  table: string;
  column: string;
}> = [
  { table: "change_events", column: "payload" },
  { table: "state_snapshots", column: "payload" },
];

export function nativeSqlPolicyV2(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 2,
    closedTables: [...NATIVE_CLOSED_TABLES],
    readOpenTables: [...NATIVE_READ_OPEN_TABLES],
    readOpenColumns: NATIVE_READ_OPEN_COLUMNS.map((column) => ({ ...column })),
    ...overrides,
  };
}

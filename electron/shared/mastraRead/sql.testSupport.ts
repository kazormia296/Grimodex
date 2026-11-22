/**
 * The table set the grammar tests of `checkReadSql` hand it (`sql.test.ts`,
 * `sql.drizzle.test.ts`). Those tests are about the checker's reading of a
 * statement, which names many tables; they are not about the production
 * allowlist (`tables.ts`, which is what the core touches and is pinned by
 * `tables.test.ts` and `core.static.test.ts`). It is the 21 tables of the K-6
 * survey (MP-4b PR-1), kept here so that narrowing the allowlist does not
 * narrow what the grammar tests exercise.
 */
export const CHECKER_FIXTURE_TABLE_SET: ReadonlySet<string> = new Set([
  "codex_detail_definitions",
  "codex_detail_values",
  "codex_entries",
  "codex_entry_phases",
  "codex_entry_tags",
  "codex_phase_detail_overrides",
  "codex_tags",
  "event_participants",
  "event_relations",
  "events",
  "foreshadow_codex_links",
  "foreshadow_setups",
  "foreshadows",
  "plot_thread_branches",
  "plot_thread_scene_links",
  "plot_threads",
  "project_calendar",
  "projects",
  "scene_events",
  "snippets",
  "tree_nodes",
]);

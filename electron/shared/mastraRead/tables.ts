/**
 * The tables Electron main's read port may name in a statement it sends to
 * Native (Mastra migration MP-4b, DR-MP4-21 rule 4). An allowlist, not a
 * denylist: a denylist of closed tables would not catch another table of the
 * workspace (the audit ledger, settings, other chat history) that a later
 * change mixed into a read.
 *
 * What is here is an UPPER BOUND of what the read tools of main (the read
 * side of the tool executors, the chronicle read tools and the APIs they call)
 * touch, taken from the K-6 table of the MP-4b plan, which includes entries it
 * marks unconfirmed (`foreshadow_codex_links`, the phase tables, the detail
 * definitions whose only user may be a tool outside main's set):
 *   - the codex: entries, tags, detail definitions and values, phases and the
 *     phase detail overrides;
 *   - the manuscript: the tree, and the snippets;
 *   - the chronicle: events, participants, relations, scene events, calendar;
 *   - plot threads and foreshadows (these are the tables the profile ledger
 *     classes as `read-open`, an own-data-read);
 *   - `projects`, for the AI policy of a project (DR-MP4-26).
 * It leaves out: the three tables the schema pulls in only as foreign-key
 * targets (`chat_sessions`, `chat_messages`, `codex_types`), every closed table
 * (`narrative_*`, `nir1_*`, the chat IR tables, the audit ledger, messages)
 * and settings.
 *
 * The list is pinned by `tables.test.ts`. PR-4 (the core) pins it again to the
 * tables its Drizzle selects actually name; a table that enters or leaves is a
 * visible diff of this file and of that test.
 */
export const MAIN_READ_TABLES: readonly string[] = Object.freeze([
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

/** The same names as a set, for `checkReadSql` (lower case). */
export const MAIN_READ_TABLE_SET: ReadonlySet<string> = new Set(
  MAIN_READ_TABLES,
);

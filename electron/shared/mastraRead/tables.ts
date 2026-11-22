/**
 * The tables Electron main's read port may name in a statement it sends to
 * Native (Mastra migration MP-4b, DR-MP4-21 rule 4). An allowlist, not a
 * denylist: a denylist of closed tables would not catch another table of the
 * workspace (the audit ledger, settings, other chat history) that a later
 * change mixed into a read.
 *
 * What is here is EXACTLY the set of tables the Drizzle selects of the shared
 * read core name in `from` and in joins (PR-4: the tools of groups B1 and B2; PR-6: the rows of the hidden and
 * chronicle-secret inputs; PR-5a: the search tools of group B3; PR-5b: the
 * foreshadow tools of group B4).
 * `readDomain/core/core.static.test.ts` scans the core's sources and requires
 * the two to be equal, so a table the core starts to touch (a later PR moving
 * more tools) fails that test until it is added here, and a table that no
 * longer appears fails it until it is removed. Either way the change is a
 * visible diff of this file and of `tables.test.ts`.
 *   - the manuscript tree: `tree_nodes` (the chapter and scene tools, and the
 *     scene bodies);
 *   - the codex tags: `codex_tags`, `codex_entry_tags` (`list_codex_tags`);
 *   - plot threads: `plot_threads`, `plot_thread_scene_links`,
 *     `plot_thread_branches`;
 *   - `projects` (PR-6: only `phase_resolution_mode`, read by
 *     `readDomain/core/readInputsReader.ts`);
 *   - `snippets` (PR-5a: `search_snippets`);
 *   - `foreshadows`, `foreshadow_setups` (PR-5b: `get_foreshadow_detail`;
 *     `list_open_foreshadows` reads through Native's typed read and names no
 *     table of its own).
 * It leaves out every table no core tool reads yet (the codex entries, phases
 * and details, the chronicle, `foreshadow_codex_links`), the three
 * tables the schema pulls in only as foreign-key targets (`chat_sessions`,
 * `chat_messages`, `codex_types`), every closed table (`narrative_*`, `nir1_*`,
 * the chat IR tables, the audit ledger, messages) and settings.
 *
 * The list is a table-level allowlist: the checker (`sql.ts`) reads the names
 * of the tables in a statement, not its columns or its conditions. A statement
 * Main sends through the adapter may therefore read every row of every table
 * here, `snippets` bodies included (DR-MP4-34), and the `secret = 1` rows and
 * the `notes` of `foreshadows` (DR-MP4-35; `get_foreshadow_detail` already shows
 * them, DR-MP4-24). What a tool shows of them is that tool's own condition, in
 * the core.
 *
 * The list is pinned by `tables.test.ts`.
 */
export const MAIN_READ_TABLES: readonly string[] = Object.freeze([
  "codex_entry_tags",
  "codex_tags",
  "foreshadow_setups",
  "foreshadows",
  "plot_thread_branches",
  "plot_thread_scene_links",
  "plot_threads",
  "projects",
  "snippets",
  "tree_nodes",
]);

/** The same names as a set, for `checkReadSql` (lower case). */
export const MAIN_READ_TABLE_SET: ReadonlySet<string> = new Set(
  MAIN_READ_TABLES,
);

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
 * foreshadow tools of group B4; PR-7a: the chronicle tools of group B6; PR-8a:
 * the Codex visibility decision).
 * `readDomain/core/core.static.test.ts` は core の source を走査し、実際の参照表がこの一覧と
 * 一致することを検査する。`codex_detail_definitions` だけは、PR-10b で移す entry tool 用に
 * PR-10a で先行許可する。
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
 *     table of its own);
 *   - the chronicle (PR-7a): `events`, `event_participants`, `scene_events`,
 *     `event_relations`, `project_calendar` (`list_events`, `get_event_detail`,
 *     `get_character_timeline`, `get_chronicle_state`);
 *   - Codex 詳細（PR-10a）：`codex_detail_definitions`,
 *     `codex_detail_values`, `codex_phase_detail_overrides`;
 *   - `codex_entries` (PR-7a: only `id` and `name`, for the names the chronicle
 *     tools show; see below for what the table-level rule lets through);
 *   - `codex_entry_phases` (PR-8a: every column of the phases of the entries the
 *     Codex visibility decision asks about, `readDomain/core/codexReaders.ts`).
 * core tool がまだ読まず、次 lane の先行許可もない表（`foreshadow_codex_links`）、schema が
 * 外部キー先としてだけ参照する 3 表（`chat_sessions`,
 * `chat_messages`, `codex_types`), every closed table (`narrative_*`, `nir1_*`,
 * the chat IR tables, the audit ledger, messages) and settings.
 *
 * The list is a table-level allowlist: the checker (`sql.ts`) reads the names
 * of the tables in a statement, not its columns or its conditions. A statement
 * Main sends through the adapter may therefore read every row of every table
 * here, of every project: `snippets` bodies included (DR-MP4-34), and all of
 * `foreshadows` (the `secret = 1` rows and the `notes` too) and of
 * `foreshadow_setups` (every column, the AI's `ai_reasoning`/`ai_rationale` and
 * the `from_pos`/`to_pos` of a secret foreshadowing's setups too) (DR-MP4-35;
 * `get_foreshadow_detail` already shows a foreshadowing's own, DR-MP4-24), and
 * all of `events` (the `secret` events with their `note`, `detail` and
 * `reveal_scene_id`), `event_participants`, `scene_events`, `event_relations` and
 * `project_calendar` (DR-MP4-37), and all of `codex_entries` (every column of every
 * entry of every project, the hidden entries and the private `notes` included:
 * the chronicle tools read only `id` and `name`, and the select cannot be
 * enforced here). The renderer can already read the same tables with a generic
 * `db_execute`, and nothing in Main reaches a reader of `codex_entries` until
 * the flag L is opened (the 4c-1 wiring: `readCodexNames` is called from Main's
 * chronicle context, `chronicleMainContext.ts`; PR-8 reads the same table too,
 * for the hidden-entry rule). What a tool shows of them is that tool's own
 * condition, in the core.
 *
 * `codex_detail_definitions` は PR-10b 向けに先行許可し、全 project の定義の全行・全列
 * （`field_config` を含む）を読める。`codex_detail_values` は hidden 項目の値も含む全 project
 * の raw 値、`codex_phase_detail_overrides` は hidden text を含む全 project の Phase 詳細値を
 * 読める。SQL checker は選択列や条件を検査しない。reader には project 条件で読んだ項目・Phase
 * の id だけを渡す。renderer は既に generic な経路でこれらの表を読める。この PR では Main の
 * tool から reader を呼ばない。
 *
 * `codex_entry_phases` (PR-8a, DR-MP4-39) is the same kind of entry: a statement
 * Main sends may read every phase of every entry of every project, every column
 * (`summary_override` and `content_override`, which can be the private text of a
 * hidden entry's phase, `context_mode_override`, `anchor_node_id`, `label` and
 * the times and the version). The reader selects every column because the
 * resolver's input type is the whole row, and the table has no `project_id`
 * column, so the project is kept by passing only the ids of entries read under a
 * project condition. The renderer can already read the table with a generic
 * `db_execute`, and nothing in Main reaches the reader until the flag L is opened.
 *
 * The list is pinned by `tables.test.ts`.
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

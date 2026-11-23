import { describe, expect, it } from "vitest";

import { MAIN_READ_TABLE_SET, MAIN_READ_TABLES } from "./tables.js";

/**
 * The list is pinned, so a table that enters or leaves it is a diff of this
 * test too. It is the set of tables the shared core's Drizzle selects name
 * (`readDomain/core/core.static.test.ts` requires the two to be equal): PR-4
 * had it at the 21 tables the K-6 survey bounded, and fixed it to the 6 the
 * seven tools of groups B1 and B2 touch; PR-6 adds `projects` (the reader of
 * the hidden and chronicle-secret inputs); PR-5a adds `snippets` (`search_snippets`); PR-5b adds `foreshadows` and
 * `foreshadow_setups` (`get_foreshadow_detail`); PR-7a adds `events`, `event_participants`,
 * `scene_events`, `event_relations`, `project_calendar` and `codex_entries` (the chronicle tools); PR-8a adds
 * `codex_entry_phases`（Codex の可視性判定）；PR-10a は詳細の3表を先行許可し、そのうち2表を
 * 可視性 core が読み、残る1表は PR-10b で移す entry tool 用にする。
 */
const PINNED = [
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
];

/**
 * どの lane も core への許可を出していない表。これを含む文は拒否される（schema 全表ではなく
 * 閉じた allowlist であることを示す negative control）。
 */
const NOT_YET = ["foreshadow_codex_links"];

describe("the read allowlist of tables", () => {
  it("is the pinned list, sorted, in lower case, without a duplicate", () => {
    expect([...MAIN_READ_TABLES]).toEqual(PINNED);
    expect([...MAIN_READ_TABLES]).toEqual([...MAIN_READ_TABLES].sort());
    expect(MAIN_READ_TABLE_SET.size).toBe(MAIN_READ_TABLES.length);
    for (const name of MAIN_READ_TABLES) expect(name).toBe(name.toLowerCase());
  });

  it("holds none of the tables that no core tool reads yet", () => {
    for (const name of NOT_YET)
      expect(MAIN_READ_TABLE_SET.has(name)).toBe(false);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(MAIN_READ_TABLES)).toBe(true);
  });

  it("holds no closed, chat, audit, settings or foreign-key-only table", () => {
    for (const name of MAIN_READ_TABLES) {
      expect(name, name).not.toMatch(
        /^(narrative_|nir1_|chat_|ai_audit|app_settings|codex_types$|messages$|sqlite_)/u,
      );
    }
  });
});

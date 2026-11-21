import { describe, expect, it } from "vitest";

import { MAIN_READ_TABLE_SET, MAIN_READ_TABLES } from "./tables.js";

/**
 * The list is pinned, so a table that enters or leaves it is a diff of this
 * test too. PR-4 (the core) pins it again to the tables its selects name.
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
];

describe("the read allowlist of tables", () => {
  it("is the pinned list, sorted, in lower case, without a duplicate", () => {
    expect([...MAIN_READ_TABLES]).toEqual(PINNED);
    expect([...MAIN_READ_TABLES]).toEqual([...MAIN_READ_TABLES].sort());
    expect(MAIN_READ_TABLE_SET.size).toBe(MAIN_READ_TABLES.length);
    for (const name of MAIN_READ_TABLES) expect(name).toBe(name.toLowerCase());
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

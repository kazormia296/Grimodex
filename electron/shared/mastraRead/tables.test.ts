import { describe, expect, it } from "vitest";

import { MAIN_READ_TABLE_SET, MAIN_READ_TABLES } from "./tables.js";

/**
 * The list is pinned, so a table that enters or leaves it is a diff of this
 * test too. It is the set of tables the shared core's Drizzle selects name
 * (`readDomain/core/core.static.test.ts` requires the two to be equal): PR-4
 * had it at the 21 tables the K-6 survey bounded, and fixed it to the 6 the
 * seven tools of groups B1 and B2 touch; PR-6 adds `projects` (the reader of
 * the hidden and chronicle-secret inputs).
 */
const PINNED = [
  "codex_entry_tags",
  "codex_tags",
  "plot_thread_branches",
  "plot_thread_scene_links",
  "plot_threads",
  "projects",
  "tree_nodes",
];

/**
 * Tables a later PR adds when a tool that reads them moves into the core. A
 * statement that names one is refused today (the negative control of the
 * allowlist: it is a closed set, not "every table of the schema").
 */
const NOT_YET = [
  "codex_entries",
  "codex_detail_definitions",
  "codex_detail_values",
  "codex_entry_phases",
  "codex_phase_detail_overrides",
  "event_participants",
  "event_relations",
  "events",
  "foreshadow_codex_links",
  "foreshadow_setups",
  "foreshadows",
  "project_calendar",
  "scene_events",
  "snippets",
];

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

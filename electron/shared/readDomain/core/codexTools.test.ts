// MP-4b PR-8b: the four Codex read tools of the shared core (`search_codex`, `list_codex_by_type`,
// `search_codex_by_tags`, `find_related_entries`), run on a real SQLite (node:sqlite) through Main's
// checked path (every statement passes `checkReadSql` first). The golden of the four tools over the
// renderer's seed is `src/features/chat/agent/readCore.mainAdapter.test.ts`; this file fixes what the core
// itself promises: the order of the checks and reads, the statements, the hidden decision's place, the
// fail-closed narrowing of the two Native wires, and that a failure of a port is not caught. Relative
// imports only (the electron vitest config has no `@` alias).
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import {
  CoreProjectRequiredError,
  type CoreCodexReadContext,
  type CoreReadDbClient,
} from "../../mastraRead/ports.js";
import { checkReadSql } from "../../mastraRead/sql.js";
import { MAIN_READ_TABLE_SET } from "../../mastraRead/tables.js";
import { fuseCodexHybrid } from "../features/chat/agent/codexHybridSearch.js";
import { CHRONICLE_READ_TOOL_NAMES } from "./chronicleReadExecutors.js";
import {
  CODEX_READ_TOOL_NAMES,
  createCodexReadExecutors,
} from "./codexReadExecutors.js";
import {
  findRelatedEntries,
  listCodexByType,
  narrowCodexDenseHits,
  searchCodex,
  searchCodexByTags,
} from "./codexTools.js";
import { createMainCodexVisibilityPorts } from "./codexMainContext.js";
import { createCoreReadDb } from "./readDb.js";
import { buildReadInputs } from "./readInputs.js";
import { CORE_READ_TOOL_NAMES } from "./readExecutors.js";
import { ftsHitIds } from "./searchHelpers.js";

const T = "2026-01-01T00:00:00.000Z";

const COLUMNS =
  "id, project_id, parent_id, type, name, aliases, excluded_aliases, readings, summary, content, icon, tags_cache, context_mode, children_budget, source_chat_message_id, notes, created_at, updated_at, version";

interface Entry {
  readonly id: string;
  readonly project?: string;
  readonly type?: string;
  readonly name: string;
  readonly aliases?: string | null;
  readonly summary?: string | null;
  readonly tags?: string | null;
  readonly mode?: string;
}

function makeSqlite(entries: readonly Entry[]): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    create table codex_entries (
      id text primary key, project_id text not null, parent_id text,
      type text not null default 'character', name text not null,
      aliases text, excluded_aliases text, readings text, summary text,
      content text not null default '{}', icon text, tags_cache text,
      context_mode text not null default 'mentioned',
      children_budget text not null default 'compact',
      source_chat_message_id text, notes text,
      created_at text not null, updated_at text not null,
      version integer not null default 0
    );
    create table codex_tags (
      id text primary key, project_id text not null, name text not null,
      color text, type_filter text, created_at text not null
    );
    create table codex_entry_tags (entry_id text not null, tag_id text not null);
    create table codex_entry_phases (
      id text primary key, entry_id text not null, anchor_node_id text,
      label text not null default '', summary_override text,
      content_override text, context_mode_override text,
      created_at text not null, updated_at text not null,
      version integer not null default 0
    );
  `);
  const insert = sqlite.prepare(
    `insert into codex_entries (${COLUMNS}) values (?, ?, null, ?, ?, ?, null, null, ?, '{}', null, ?, ?, 'compact', null, null, ?, ?, 0)`,
  );
  for (const e of entries) {
    insert.run(
      e.id,
      e.project ?? "p-a",
      e.type ?? "character",
      e.name,
      e.aliases ?? null,
      e.summary ?? null,
      e.tags ?? null,
      e.mode ?? "mentioned",
      T,
      T,
    );
  }
  return sqlite;
}

const ENTRIES: readonly Entry[] = [
  { id: "pub", name: "Pub", summary: "pub about the dragon" },
  { id: "dragon", name: "Dragon", summary: "dragon", type: "creature" },
  { id: "hid", name: "Hidden dragon", summary: "secret", mode: "hidden" },
  {
    id: "rel",
    name: "Released",
    summary: "base summary",
    mode: "hidden",
  },
  { id: "hide-later", name: "Late", summary: "late dragon" },
  { id: "b-pub", project: "p-b", name: "Other dragon", summary: "other" },
];

function seedPhases(sqlite: DatabaseSync): void {
  const insert = sqlite.prepare(
    "insert into codex_entry_phases (id, entry_id, anchor_node_id, label, summary_override, content_override, context_mode_override, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  // `rel` is hidden at base and released by a phase at s3; `hide-later` is public and hidden from s2.
  insert.run(
    "ph-rel",
    "rel",
    "s3",
    "r",
    "phase summary",
    null,
    "mentioned",
    T,
    T,
  );
  insert.run("ph-hide", "hide-later", "s2", "h", null, null, "hidden", T, T);
}

function seedTags(sqlite: DatabaseSync): void {
  sqlite.exec(`
    insert into codex_tags values
      ('t-magic', 'p-a', 'magic', null, null, '${T}'),
      ('t-other', 'p-b', 'magic', null, null, '${T}');
    insert into codex_entry_tags values
      ('pub', 't-magic'), ('hid', 't-magic'), ('hide-later', 't-magic'), ('b-pub', 't-other');
  `);
}

const treeRows = ["s1", "s2", "s3"].map((id, i) => ({
  id,
  parentId: null,
  nodeType: "scene",
  sortOrder: `a${i}`,
  storyTimeOrder: null,
  archivedAt: null,
}));

interface Harness {
  readonly ctx: CoreCodexReadContext;
  readonly sqlite: DatabaseSync;
  /** Every statement sent, in order. */
  readonly sent: Array<{ sql: string; params: unknown[] }>;
  /** The order of everything the tools touch. */
  readonly log: string[];
  readonly state: { scene: string | null; projectId: string };
  readonly fts: ReturnType<typeof vi.fn>;
  readonly dense: ReturnType<typeof vi.fn>;
  readonly onSql: { current: ((sql: string) => void) | null };
}

function harness(
  options: {
    entries?: readonly Entry[];
    projectId?: string;
    scene?: string | null;
    fts?: (args: unknown) => unknown;
    dense?: (args: unknown) => unknown;
    tags?: boolean;
  } = {},
): Harness {
  const sqlite = makeSqlite(options.entries ?? ENTRIES);
  seedPhases(sqlite);
  if (options.tags !== false) seedTags(sqlite);
  const sent: Harness["sent"] = [];
  const log: string[] = [];
  const onSql: Harness["onSql"] = { current: null };
  const state = {
    scene: "scene" in options ? (options.scene ?? null) : "s1",
    projectId: options.projectId ?? "p-a",
  };
  const client: CoreReadDbClient = async (sql, params, method) => {
    const checked = checkReadSql(sql, MAIN_READ_TABLE_SET);
    if (!checked.ok) throw new Error(`refused: ${checked.code}`);
    if (method !== "all" && method !== "values") {
      throw new Error(`method ${method}`);
    }
    sent.push({ sql, params });
    log.push(`sql:${checked.tables.join(",")}`);
    onSql.current?.(sql);
    const rows = sqlite.prepare(sql).all(...(params as never[]));
    return { rows: rows.map((r) => Object.values(r as object)) };
  };
  const db = createCoreReadDb(client);
  const ports = createMainCodexVisibilityPorts({
    db,
    inputs: buildReadInputs({
      projectId: "p-a",
      treeRows,
      project: { phaseResolutionMode: "reading" },
      currentSceneId: "s1",
    }),
  });
  const fts = vi.fn(async (args: unknown) => {
    log.push("fts");
    return options.fts ? options.fts(args) : [];
  });
  const dense = vi.fn(async (args: unknown) => {
    log.push("dense");
    return options.dense ? options.dense(args) : [];
  });
  const ctx: CoreCodexReadContext = {
    ...ports,
    getTreeState: () => {
      log.push("tree");
      return {
        projectId: state.projectId,
        nodes: [],
        activeSceneId: state.scene,
      };
    },
    countTokens: (text) => text.length,
    native: {
      fts: fts as never,
      codexSemantic: dense as never,
    },
  };
  return { ctx, sqlite, sent, log, state, fts, dense, onSql };
}

const ids = (result: { content: unknown }): string[] =>
  (result.content as Array<{ id: string }>).map((r) => r.id);

describe("the order of the checks: arguments, then the project, then the reads", () => {
  it("an empty query, tag list or id is answered before the project is looked at (no tree read, nothing sent)", async () => {
    const h = harness({ projectId: "" });
    for (const [run, params, summary] of [
      [searchCodex, { query: "  " }, "0 entries found"],
      [searchCodex, {}, "0 entries found"],
      [searchCodexByTags, { tags: [] }, "No tags provided"],
      [searchCodexByTags, { tags: "magic" }, "No tags provided"],
      [findRelatedEntries, { id: " " }, "No id provided"],
    ] as const) {
      const result = await run(h.ctx, params);
      expect(result.summary).toBe(summary);
      expect(result.content).toEqual([]);
      expect(result.tokensUsed).toBe(0);
    }
    expect(h.log).toEqual([]);
  });

  it("with the arguments valid and no project, every tool throws CoreProjectRequiredError before it reads anything (list_codex_by_type checks no argument)", async () => {
    for (const run of [
      (c: CoreCodexReadContext) => searchCodex(c, { query: "dragon" }),
      (c: CoreCodexReadContext) => listCodexByType(c, { type: "character" }),
      (c: CoreCodexReadContext) => listCodexByType(c, {}),
      (c: CoreCodexReadContext) => searchCodexByTags(c, { tags: ["magic"] }),
      (c: CoreCodexReadContext) => findRelatedEntries(c, { id: "pub" }),
    ]) {
      const h = harness({ projectId: "" });
      await expect(run(h.ctx)).rejects.toBeInstanceOf(CoreProjectRequiredError);
      expect(h.sent).toEqual([]);
      expect(h.fts).not.toHaveBeenCalled();
      expect(h.dense).not.toHaveBeenCalled();
    }
  });

  it("the project is read once, before the first await (a switch during the reads does not change it)", async () => {
    const h = harness({ scene: "s1" });
    h.onSql.current = () => {
      h.state.projectId = "p-b";
    };
    const result = await listCodexByType(h.ctx, { type: "character" });
    // The statements were for p-a (the project read at the start); the scene is read again afterwards, the
    // project is not.
    expect(h.sent[0]!.params[0]).toBe("p-a");
    expect(ids(result)).toContain("pub");
    expect(h.log.filter((entry) => entry === "tree")).toHaveLength(2);
  });
});

describe("result strings and shape", () => {
  it("search_codex: key order name, type, summary after the ids; tokensUsed counts the JSON", async () => {
    const h = harness({
      fts: () => [{ sourceType: "codex", id: "pub", title: "", excerpt: "" }],
    });
    const result = await searchCodex(h.ctx, { query: "  Pub dragon " });
    expect(result.name).toBe("search_codex");
    expect(result.summary).toBe("1 entries found");
    expect(result.content).toEqual([
      {
        id: "pub",
        name: "Pub",
        type: "character",
        summary: "pub about the dragon",
      },
    ]);
    expect(result.tokensUsed).toBe(JSON.stringify(result.content).length);
    expect(Object.keys((result.content as object[])[0]!)).toEqual([
      "id",
      "name",
      "type",
      "summary",
    ]);
  });

  it("list_codex_by_type: id, name, summary, tags; the summary is the empty string when null; type is trimmed and a missing one is ''", async () => {
    const h = harness({
      entries: [
        { id: "x", name: "X", tags: '[{"name":"a","color":null},"b"]' },
        { id: "y", name: "Y", type: "" },
      ],
    });
    const result = await listCodexByType(h.ctx, { type: " character " });
    expect(result.summary).toBe("1 entries of type 'character'");
    expect(result.content).toEqual([
      { id: "x", name: "X", summary: "", tags: ["a", "b"] },
    ]);
    const missing = await listCodexByType(h.ctx, {});
    expect(missing.summary).toBe("1 entries of type ''");
    expect(ids(missing)).toEqual(["y"]);
  });

  it("search_codex_by_tags: elements are String()'d and neither trimmed nor deduplicated; one row per entry (DISTINCT)", async () => {
    const h = harness();
    const result = await searchCodexByTags(h.ctx, { tags: ["magic", "magic"] });
    // hid is hidden at base; hide-later is public at s1. b-pub is another project's.
    expect(ids(result).sort()).toEqual(["hide-later", "pub"]);
    expect(ids(await searchCodexByTags(h.ctx, { tags: [" magic"] }))).toEqual(
      [],
    );
    expect(h.sent.some((s) => /select distinct/iu.test(s.sql))).toBe(true);
    expect(h.sent[0]!.params).toEqual(["p-a", "magic", "magic"]);
  });
});

describe("search_codex", () => {
  it("asks fts for scope codex with limit 20 and the trimmed query, then the dense read with limit 30 and the same project, in that order; fts hits of other source types are dropped and the rows follow the hit order", async () => {
    const h = harness({
      fts: () => [
        { sourceType: "scene", id: "s1", title: "", excerpt: "" },
        { sourceType: "codex", id: "dragon", title: "", excerpt: "" },
        { sourceType: "codex", id: "pub", title: "", excerpt: "" },
      ],
    });
    const result = await searchCodex(h.ctx, { query: "  dragon  " });
    expect(h.fts).toHaveBeenCalledWith({
      projectId: "p-a",
      query: "dragon",
      scope: "codex",
      limit: 20,
    });
    expect(h.dense).toHaveBeenCalledWith({
      projectId: "p-a",
      query: "dragon",
      limit: 30,
    });
    expect(ids(result)).toEqual(["dragon", "pub"]);
    // project, fts, the rows, dense, the scene, then the decision's statements.
    expect(h.log.slice(0, 5)).toEqual([
      "tree",
      "fts",
      "sql:codex_entries",
      "dense",
      "tree",
    ]);
  });

  it("a query with one short token never calls fts: it goes to the LIKE-OR over name, summary, tags_cache, aliases and content with limit 20", async () => {
    const h = harness();
    const result = await searchCodex(h.ctx, { query: "dragon ab" });
    expect(h.fts).not.toHaveBeenCalled();
    expect(h.sent[0]!.sql).toMatch(/like/iu);
    expect(h.sent[0]!.sql).toMatch(/limit \?$/iu);
    expect(h.sent[0]!.params).toEqual([
      "p-a",
      ...["dragon", "ab"].flatMap((t) =>
        Array.from({ length: 5 }, () => `%${t}%`),
      ),
      20,
    ]);
    expect(ids(result)).toContain("pub");
  });

  it("with no fts hit, entries are not read and no decision statement is sent, and the dense read is still called once", async () => {
    const h = harness();
    const result = await searchCodex(h.ctx, { query: "dragon" });
    expect(result.content).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(h.dense).toHaveBeenCalledTimes(1);
  });

  it("the scene for the decision is read after the dense read (a switch during it is seen); the cut comes before the drop, so hidden entries leave fewer than 20", async () => {
    const h = harness({
      scene: "s1",
      fts: () =>
        ["hid", "rel", "hide-later", "pub"].map((id) => ({
          sourceType: "codex",
          id,
          title: "",
          excerpt: "",
        })),
      dense: () => {
        h.state.scene = "s2";
        return [];
      },
    });
    const result = await searchCodex(h.ctx, { query: "dragon" });
    // s2: hide-later is hidden by its phase; hid and rel are hidden at base.
    expect(ids(result)).toEqual(["pub"]);
    expect(result.summary).toBe("1 entries found");
  });

  it("hidden entries take their places in the fusion and the cut, and are dropped after: 20 fts hits (3 hidden) and 5 dense hits give 17 rows, not 20 (dropping first would let more through)", async () => {
    const hiddenIds = ["h1", "h2", "h3"];
    const visibleIds = Array.from(
      { length: 17 },
      (_, i) => `v${String(i + 1).padStart(2, "0")}`,
    );
    const denseIds = ["d1", "d2", "d3", "d4", "d5"];
    const h = harness({
      entries: [
        ...hiddenIds.map((id) => ({ id, name: id, mode: "hidden" })),
        ...visibleIds.map((id) => ({ id, name: id })),
        ...denseIds.map((id) => ({ id, name: id })),
      ],
      fts: () =>
        [...hiddenIds, ...visibleIds].map((id) => ({
          sourceType: "codex",
          id,
          title: "",
          excerpt: "",
        })),
      dense: () =>
        denseIds.map((id, i) => ({
          entryId: id,
          entryName: id,
          entryType: "character",
          summary: "",
          score: 0.9 - i / 100,
        })),
    });
    const result = await searchCodex(h.ctx, { query: "dragon" });
    // The union is 25; the cut keeps the 20 best by rank (the 5 dense hits, the 3 hidden, and the first
    // 12 visible sparse rows), then the 3 hidden are dropped.
    expect(ids(result)).toHaveLength(17);
    expect(ids(result)).toEqual(expect.arrayContaining(denseIds));
    expect(ids(result)).not.toContain("v17");
    expect(ids(result)).not.toContain("h1");
  });

  it("a dense hit that is not in the database is hidden; a dense summary is returned as it is for an entry that was not released; a released entry has the phase's summary", async () => {
    const h = harness({
      scene: "s3",
      fts: () => [{ sourceType: "codex", id: "pub", title: "", excerpt: "" }],
      dense: () => [
        {
          entryId: "ghost",
          entryName: "Ghost",
          entryType: "character",
          summary: "g",
          score: 0.9,
        },
        {
          entryId: "dragon",
          entryName: "Dragon",
          entryType: "creature",
          summary: "dense summary",
          score: 0.8,
        },
        {
          entryId: "rel",
          entryName: "Released",
          entryType: "character",
          summary: "base summary",
          score: 0.7,
        },
      ],
    });
    const result = await searchCodex(h.ctx, { query: "dragon" });
    const rows = result.content as Array<{ id: string; summary: string }>;
    expect(rows.map((r) => r.id).sort()).toEqual(["dragon", "pub", "rel"]);
    expect(rows.find((r) => r.id === "dragon")!.summary).toBe("dense summary");
    expect(rows.find((r) => r.id === "rel")!.summary).toBe("phase summary");
  });

  it("the dense wire is narrowed fail closed: not an array, a row that is not an object, no string entryId, a score that is neither a number nor null all throw; null is read as 0 and gives the same ranking as 0", async () => {
    for (const bad of [
      "x",
      null,
      { entryId: "a" },
      [1],
      [null],
      [{ entryName: "n" }],
      [{ entryId: 1, score: 1 }],
      [{ entryId: "a", score: "0.5" }],
      [{ entryId: "a" }],
    ]) {
      expect(() => narrowCodexDenseHits(bad), JSON.stringify(bad)).toThrow();
      const h = harness({ fts: () => [], dense: () => bad });
      await expect(searchCodex(h.ctx, { query: "dragon" })).rejects.toThrow(
        /codex_semantic_search/u,
      );
    }
    const wire = [
      {
        entryId: "a",
        entryName: "A",
        entryType: "t",
        summary: "s",
        score: null,
      },
      {
        entryId: "b",
        entryName: "B",
        entryType: "t",
        summary: "s",
        score: 0.4,
      },
      {
        entryId: "c",
        entryName: "C",
        entryType: "t",
        summary: "s",
        score: null,
      },
    ];
    expect(narrowCodexDenseHits(wire).map((hit) => hit.score)).toEqual([
      0, 0.4, 0,
    ]);
    const zeros = wire.map((hit) => ({ ...hit, score: hit.score ?? 0 }));
    expect(fuseCodexHybrid(narrowCodexDenseHits(wire), [], 10)).toEqual(
      fuseCodexHybrid(zeros, [], 10),
    );
  });

  it("the fts wire is narrowed fail closed (a malformed row throws and is not 0 found), and a failure of either Native read is not caught", async () => {
    for (const bad of [
      {},
      [null],
      [{ id: "pub" }],
      [{ sourceType: "codex" }],
    ]) {
      const h = harness({ fts: () => bad });
      await expect(searchCodex(h.ctx, { query: "dragon" })).rejects.toThrow(
        /fts_search/u,
      );
      expect(h.dense).not.toHaveBeenCalled();
    }
    expect(() =>
      ftsHitIds(
        [
          { sourceType: "codex", id: "a" },
          { sourceType: "scene", id: "b" },
        ],
        "codex",
      ),
    ).not.toThrow();
    const failing = harness({
      fts: () => [],
      dense: () => {
        throw new Error("dense down");
      },
    });
    await expect(searchCodex(failing.ctx, { query: "dragon" })).rejects.toThrow(
      "dense down",
    );
    const ftsDown = harness({
      fts: () => {
        throw new Error("fts down");
      },
    });
    await expect(searchCodex(ftsDown.ctx, { query: "dragon" })).rejects.toThrow(
      "fts down",
    );
  });

  it("a hit of another project's entry is not an entry of this project (the project condition is in the statement): it is hidden", async () => {
    const h = harness({
      fts: () => [{ sourceType: "codex", id: "b-pub", title: "", excerpt: "" }],
    });
    const result = await searchCodex(h.ctx, { query: "dragon" });
    expect(result.content).toEqual([]);
    expect(h.sent[0]!.params).toEqual(["p-a", "b-pub"]);
  });
});

describe("the hidden decision in list_codex_by_type, search_codex_by_tags and find_related_entries", () => {
  it("list_codex_by_type: the scene is read after the database read; hidden entries and entries that a phase hides at the scene are dropped; a released entry shows the phase's summary", async () => {
    const h = harness({ scene: "s1" });
    h.onSql.current = (sql) => {
      if (/"codex_entries"\."type" = \?/u.test(sql)) h.state.scene = "s3";
    };
    const result = await listCodexByType(h.ctx, { type: "character" });
    // s3: rel is released; hide-later is hidden from s2; hid is hidden.
    expect(ids(result).sort()).toEqual(["pub", "rel"]);
    expect(
      (result.content as Array<{ id: string; summary: string }>).find(
        (r) => r.id === "rel",
      )!.summary,
    ).toBe("phase summary");
  });

  it("no scene or a scene the reading order lacks: an entry that a phase hides is hidden (DR-MP4-41)", async () => {
    for (const scene of [null, "", "s-missing"]) {
      const h = harness({ scene });
      expect(
        ids(await listCodexByType(h.ctx, { type: "character" })).sort(),
        String(scene),
      ).toEqual(["pub"]);
    }
  });

  it("search_codex_by_tags: hidden entries are dropped after the join", async () => {
    const h = harness({ scene: "s2" });
    expect(ids(await searchCodexByTags(h.ctx, { tags: ["magic"] }))).toEqual([
      "pub",
    ]);
  });

  it("nothing is cached: a second call reads the entries and the phases again", async () => {
    const h = harness();
    await listCodexByType(h.ctx, { type: "character" });
    const first = h.sent.length;
    await listCodexByType(h.ctx, { type: "character" });
    expect(h.sent.length).toBe(first * 2);
  });

  it("an empty result reads no decision statement (nothing to judge)", async () => {
    const h = harness();
    await listCodexByType(h.ctx, { type: "none" });
    expect(h.sent).toHaveLength(1);
  });
});

describe("find_related_entries", () => {
  const dragonEntries: Entry[] = [
    {
      id: "src",
      name: "Dragon",
      aliases: '["Wyrm", 5, null, "", "  "]',
      summary: "the source",
    },
    { id: "r1", name: "Lair", summary: "home of the Dragon", type: "place" },
    { id: "r2", name: "Rider", summary: "rides the Wyrm" },
    { id: "r3", name: "Late", summary: "Dragon fan" },
    { id: "src-hid", name: "Hidden source", summary: "x", mode: "hidden" },
  ];

  it("a source that does not exist (or is another project's) answers `Entry not found` with one statement and no scene read: neither the scene nor the decision's statements are read", async () => {
    const h = harness({ entries: dragonEntries });
    const result = await findRelatedEntries(h.ctx, { id: "nope" });
    expect(result.summary).toBe("Entry not found");
    expect(h.sent).toHaveLength(1);
    expect(h.log.filter((entry) => entry === "tree")).toHaveLength(1);
    const other = harness({
      entries: [...dragonEntries, { id: "b-src", project: "p-b", name: "B" }],
    });
    expect((await findRelatedEntries(other.ctx, { id: "b-src" })).summary).toBe(
      "Entry not found",
    );
  });

  it("a hidden source answers like a missing id; the decision reads the body column (withContent) and is judged at the current scene", async () => {
    const h = harness({ entries: dragonEntries });
    const result = await findRelatedEntries(h.ctx, { id: "src-hid" });
    expect(result.summary).toBe("Entry not found");
    expect(result.tokensUsed).toBe(0);
    expect(h.sent[1]!.sql).toMatch(
      /^select "id", "summary", "context_mode", "content" from/u,
    );
  });

  it("the search terms are the name and the string aliases (non-strings, empty and blank ones drop); a type filter is trimmed and goes into the summary", async () => {
    const h = harness({ entries: dragonEntries });
    const result = await findRelatedEntries(h.ctx, {
      id: "src",
      type: " place ",
    });
    const related = h.sent.find((s) => /like/iu.test(s.sql))!;
    expect(related.params).toEqual([
      "p-a",
      "src",
      ...["Dragon", "Wyrm"].flatMap((t) =>
        Array.from({ length: 4 }, () => `%${t}%`),
      ),
      "place",
      20,
    ]);
    expect(ids(result)).toEqual(["r1"]);
    expect(result.summary).toBe("1 related to Dragon (type=place)");
    const none = await findRelatedEntries(
      harness({ entries: dragonEntries }).ctx,
      { id: "src" },
    );
    expect(ids(none).sort()).toEqual(["r1", "r2", "r3"]);
    expect(none.summary).toBe("3 related to Dragon");
  });

  it("a blank name and no aliases: `Source entry has no searchable name`, and the related select is not sent", async () => {
    const h = harness({ entries: [{ id: "blank", name: "   " }] });
    const result = await findRelatedEntries(h.ctx, { id: "blank" });
    expect(result.summary).toBe("Source entry has no searchable name");
    expect(h.sent.some((s) => /like/iu.test(s.sql))).toBe(false);
  });

  it("the scene is read twice: once for the source (after its select) and once for the result (after the related select)", async () => {
    const h = harness({ entries: dragonEntries, scene: "s1" });
    const result = await findRelatedEntries(h.ctx, { id: "src" });
    expect(result.summary).toBe("3 related to Dragon");
    const trees = h.log.filter((entry) => entry === "tree");
    expect(trees).toHaveLength(3); // project, source, result
    const firstLike = h.log.findIndex(
      (entry, i) => entry.startsWith("sql:") && i > 2,
    );
    expect(firstLike).toBeGreaterThan(0);
  });

  it("the related select has limit 20", async () => {
    const many: Entry[] = [
      { id: "src", name: "Stone" },
      ...Array.from({ length: 25 }, (_, i) => ({
        id: `m${i}`,
        name: `Stone ${i}`,
      })),
    ];
    const h = harness({ entries: many });
    const result = await findRelatedEntries(h.ctx, { id: "src" });
    expect(ids(result)).toHaveLength(20);
  });
});

describe("createCodexReadExecutors", () => {
  it("is a fourth table of names, disjoint from the other three, frozen, and reads nothing when made", () => {
    const h = harness();
    const executors = createCodexReadExecutors(h.ctx);
    expect(Object.keys(executors).sort()).toEqual(
      [...CODEX_READ_TOOL_NAMES].sort(),
    );
    expect(Object.isFrozen(executors)).toBe(true);
    for (const name of CODEX_READ_TOOL_NAMES) {
      expect((CORE_READ_TOOL_NAMES as readonly string[]).includes(name)).toBe(
        false,
      );
      expect(
        (CHRONICLE_READ_TOOL_NAMES as readonly string[]).includes(name),
      ).toBe(false);
    }
    expect(h.log).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it("each executor runs its tool and returns the tool's name", async () => {
    const h = harness();
    const executors = createCodexReadExecutors(h.ctx);
    for (const [name, params] of [
      ["search_codex", { query: "" }],
      ["list_codex_by_type", { type: "character" }],
      ["search_codex_by_tags", { tags: ["magic"] }],
      ["find_related_entries", { id: "pub" }],
    ] as const) {
      expect((await executors[name](params)).name).toBe(name);
    }
  });
});

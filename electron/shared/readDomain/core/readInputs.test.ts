// MP-4b PR-6: the rows-to-inputs function and its Drizzle reader. Relative
// imports only (the electron vitest config has no `@` alias). The parity with
// the renderer's store is `src/features/chat/agent/readInputs.parity.test.ts`.
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import { checkReadSql } from "../../mastraRead/sql.js";
import { MAIN_READ_TABLE_SET } from "../../mastraRead/tables.js";
import type { CoreReadDbClient } from "../../mastraRead/ports.js";
import {
  buildChronicleNodes,
  buildReadInputs,
  normalizeCurrentSceneId,
  resolveReadInputMode,
  type ReadChronicleTreeRow,
  type ReadInputTreeRow,
} from "./readInputs.js";
import { createCoreReadDb } from "./readDb.js";
import {
  readChronicleReadInputs,
  readProjectModeRow,
  readReadInputs,
  readTreeRows,
} from "./readInputsReader.js";

const row = (
  id: string,
  parentId: string | null,
  nodeType: string,
  sortOrder: string,
  extra: Partial<ReadInputTreeRow> = {},
): ReadInputTreeRow => ({
  id,
  parentId,
  nodeType,
  sortOrder,
  storyTimeOrder: null,
  archivedAt: null,
  ...extra,
});

// part1 > (ch1 > (s1, s2), ch2 > (s3)), then note1, then s-late at the root.
// Sort keys are per sibling group, so they are not monotonic across the tree.
const ROWS: ReadInputTreeRow[] = [
  row("part1", null, "folder", "a0"),
  row("ch1", "part1", "folder", "a0"),
  row("s1", "ch1", "scene", "a0", { storyTimeOrder: "a3" }),
  row("s2", "ch1", "scene", "a1", { storyTimeOrder: "a1" }),
  row("ch2", "part1", "folder", "a1"),
  row("s3", "ch2", "scene", "a0"),
  row("note1", null, "note", "a1"),
  row("s-late", null, "scene", "a2", { storyTimeOrder: "  a2 " }),
];

describe("buildReadInputs", () => {
  it("reads the tree depth first, one sibling group at a time", () => {
    const inputs = buildReadInputs({
      projectId: "p",
      treeRows: ROWS,
      project: { phaseResolutionMode: "reading" },
      currentSceneId: "s2",
    });
    expect([...inputs.readingOrder.entries()]).toEqual([
      ["s1", 0],
      ["s2", 1],
      ["s3", 2],
      ["s-late", 3],
    ]);
    expect(inputs.readingOrder).toBe(inputs.sceneTimeIndex.readingOrder);
    expect(inputs.sceneTimeIndex.revision).toBe(0);
    expect(inputs.sceneTimeIndex.liveSceneCount).toBe(4);
    expect(inputs.sceneTimeIndex.scheduledSceneCount).toBe(3);
    // The explicit key is trimmed; the inherited one is forward-filled.
    expect([...inputs.sceneTimeIndex.explicitStoryOrder.entries()]).toEqual([
      ["s1", "a3"],
      ["s2", "a1"],
      ["s-late", "a2"],
    ]);
    expect([...inputs.sceneTimeIndex.inheritedStoryOrder.entries()]).toEqual([
      ["s1", "a3"],
      ["s2", "a1"],
      ["s3", "a1"],
      ["s-late", "a2"],
    ]);
    expect(inputs.resolutionMode).toEqual({
      kind: "resolved",
      mode: "reading",
    });
    expect(inputs.currentSceneId).toBe("s2");
  });

  it("does not depend on the order of the rows", () => {
    const expected = [
      ...buildReadInputs({
        projectId: "p",
        treeRows: ROWS,
        project: null,
        currentSceneId: null,
      }).readingOrder.entries(),
    ];
    for (const rows of [
      [...ROWS].reverse(),
      [...ROWS.slice(3), ...ROWS.slice(0, 3)],
    ]) {
      const inputs = buildReadInputs({
        projectId: "p",
        treeRows: rows,
        project: null,
        currentSceneId: null,
      });
      expect([...inputs.readingOrder.entries()]).toEqual(expected);
    }
  });

  it("orders siblings with the same sort key by id (localeCompare, as the renderer does)", () => {
    // Lower-case hex and hyphen ids only: an upper-case letter or `_` can sort
    // differently under another locale (K-4), and this test must not depend on
    // the machine's locale.
    const rows = [
      row("0b7e-3", null, "scene", "a0"),
      row("0a11-9", null, "scene", "a0"),
      row("f003-1", null, "scene", "a0"),
      row("0a11-10", null, "scene", "a0"),
    ];
    const expected = ["0a11-10", "0a11-9", "0b7e-3", "f003-1"];
    expect(
      [...rows.map((r) => r.id)].sort((a, b) => a.localeCompare(b)),
    ).toEqual(expected);
    const inputs = buildReadInputs({
      projectId: "p",
      treeRows: rows,
      project: null,
      currentSceneId: null,
    });
    expect([...inputs.readingOrder.keys()]).toEqual(expected);
    // The same result for any input order.
    const reversed = buildReadInputs({
      projectId: "p",
      treeRows: [...rows].reverse(),
      project: null,
      currentSceneId: null,
    });
    expect([...reversed.readingOrder.keys()]).toEqual(expected);
  });

  it("leaves out an archived row, and a live row whose parent folder is archived", () => {
    const rows = [
      row("f", null, "folder", "a0"),
      row("s-in-f", "f", "scene", "a0"),
      row("s-arch", null, "scene", "a1", {
        archivedAt: "2026-02-01T00:00:00Z",
      }),
      row("f-arch", null, "folder", "a2", {
        archivedAt: "2026-02-01T00:00:00Z",
      }),
      // Live, but its parent is archived: the DFS cannot reach it.
      row("s-orphan", "f-arch", "scene", "a0"),
    ];
    const inputs = buildReadInputs({
      projectId: "p",
      treeRows: rows,
      project: null,
      currentSceneId: null,
    });
    expect([...inputs.readingOrder.keys()]).toEqual(["s-in-f"]);
    // The count still holds every live scene row, as in the renderer.
    expect(inputs.sceneTimeIndex.liveSceneCount).toBe(2);
  });

  it("is empty for a project with no rows", () => {
    const inputs = buildReadInputs({
      projectId: "p",
      treeRows: [],
      project: null,
      currentSceneId: "s1",
    });
    expect(inputs.readingOrder.size).toBe(0);
    expect(inputs.currentSceneId).toBeNull();
    expect(inputs.resolutionMode).toEqual({
      kind: "unresolved",
      reason: "project-missing",
    });
  });
});

describe("the current scene", () => {
  const order = new Map([
    ["s1", 0],
    ["s2", 1],
  ]);
  it.each([
    ["a live scene of the order", "s2", "s2"],
    ["an empty id", "", null],
    ["a nonexistent id", "nope", null],
    ["another project's scene", "x-s1", null],
    ["a folder", "ch1", null],
    ["a note", "note1", null],
    ["null", null, null],
    ["undefined", undefined, null],
    ["a non-string", 3, null],
  ])("%s", (_label, input, expected) => {
    expect(normalizeCurrentSceneId(order, input)).toBe(expected);
  });

  it("is null for an archived scene and for a live scene under an archived folder", () => {
    const rows = [
      row("f-arch", null, "folder", "a0", {
        archivedAt: "2026-02-01T00:00:00Z",
      }),
      row("s-orphan", "f-arch", "scene", "a0"),
      row("s-arch", null, "scene", "a1", {
        archivedAt: "2026-02-01T00:00:00Z",
      }),
      row("s-ok", null, "scene", "a2"),
    ];
    for (const [id, expected] of [
      ["s-orphan", null],
      ["s-arch", null],
      ["f-arch", null],
      ["s-ok", "s-ok"],
    ] as const) {
      expect(
        buildReadInputs({
          projectId: "p",
          treeRows: rows,
          project: null,
          currentSceneId: id,
        }).currentSceneId,
      ).toBe(expected);
    }
  });
});

describe("the resolution mode", () => {
  it.each(["reading", "story", "auto"] as const)("%s is resolved", (mode) => {
    expect(resolveReadInputMode({ phaseResolutionMode: mode })).toEqual({
      kind: "resolved",
      mode,
    });
  });

  it("has no default: nothing becomes `reading` or `auto`", () => {
    expect(resolveReadInputMode(null)).toEqual({
      kind: "unresolved",
      reason: "project-missing",
    });
    expect(resolveReadInputMode({ phaseResolutionMode: null })).toEqual({
      kind: "unresolved",
      reason: "mode-null",
    });
    expect(resolveReadInputMode({ phaseResolutionMode: undefined })).toEqual({
      kind: "unresolved",
      reason: "mode-null",
    });
    for (const value of [
      "",
      "Reading",
      " reading",
      "readng",
      "manual",
      1,
      {},
    ]) {
      expect(resolveReadInputMode({ phaseResolutionMode: value })).toEqual({
        kind: "unresolved",
        reason: "mode-unknown",
      });
    }
  });
});

// ---- the reader, against a real SQLite -------------------------------------

function makeDb(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    create table projects (id text primary key, phase_resolution_mode text);
    create table tree_nodes (
      id text primary key, project_id text not null, parent_id text,
      node_type text not null, sort_order text not null,
      story_time_order text, archived_at text,
      title text not null,
      chronicle_start_time integer, chronicle_start_minute integer,
      chronicle_start_granularity text not null,
      chronicle_precision text not null
    );
    insert into projects values ('p-a', 'story'), ('p-b', 'auto');
    insert into tree_nodes values
      ('a-f', 'p-a', null, 'folder', 'a0', null, null,
        'Part', null, null, 'none', 'exact'),
      ('a-s1', 'p-a', 'a-f', 'scene', 'a0', 'a2', null,
        'First', 12, 30, 'minute', 'approx'),
      ('a-s2', 'p-a', 'a-f', 'scene', 'a1', null, null,
        'Second', null, null, 'none', 'exact'),
      ('a-arch', 'p-a', null, 'scene', 'a1', null, '2026-02-01T00:00:00Z',
        'Gone', 5, null, 'day', 'exact'),
      ('b-s1', 'p-b', null, 'scene', 'a0', 'a1', null,
        'Other', 7, null, 'day', 'exact');
  `);
  return sqlite;
}

/** The read port's client over a real SQLite; every statement is checked first, as `createMainReadDb` does. */
function clientOver(sqlite: DatabaseSync) {
  const sent: { sql: string; params: unknown[]; method: string }[] = [];
  const client: CoreReadDbClient = async (sql, params, method) => {
    const checked = checkReadSql(sql, MAIN_READ_TABLE_SET);
    if (!checked.ok) throw new Error(`refused: ${checked.code}`);
    if (method !== "all" && method !== "values") {
      throw new Error(`method ${method}`);
    }
    sent.push({ sql, params, method });
    const rows = sqlite.prepare(sql).all(...(params as never[]));
    return { rows: rows.map((r) => Object.values(r as object)) };
  };
  return { client, sent };
}

describe("the reader", () => {
  it("selects only this project's live rows, and its statements pass the pre-send check", async () => {
    const { client, sent } = clientOver(makeDb());
    const rows = await readTreeRows(createCoreReadDb(client), "p-a");
    expect(rows.map((r) => r.id).sort()).toEqual(["a-f", "a-s1", "a-s2"]);
    expect(rows.find((r) => r.id === "a-s1")).toEqual({
      id: "a-s1",
      parentId: "a-f",
      nodeType: "scene",
      sortOrder: "a0",
      storyTimeOrder: "a2",
      archivedAt: null,
      title: "First",
      chronicleStartTime: 12,
      chronicleStartMinute: 30,
      chronicleStartGranularity: "minute",
      chroniclePrecision: "approx",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.params).toEqual(["p-a"]);
    const checked = checkReadSql(sent[0]!.sql, MAIN_READ_TABLE_SET);
    expect(checked).toMatchObject({ ok: true, tables: ["tree_nodes"] });
    expect(sent[0]!.sql.toLowerCase()).toContain('archived_at" is null');
  });

  it("reads the mode row, and null for a project that has none", async () => {
    const { client, sent } = clientOver(makeDb());
    expect(await readProjectModeRow(createCoreReadDb(client), "p-b")).toEqual({
      phaseResolutionMode: "auto",
    });
    expect(
      await readProjectModeRow(createCoreReadDb(client), "p-none"),
    ).toBeNull();
    for (const call of sent) {
      expect(checkReadSql(call.sql, MAIN_READ_TABLE_SET)).toMatchObject({
        ok: true,
        tables: ["projects"],
      });
    }
  });

  it("pins the columns each select sends (a column added to either select fails here)", async () => {
    const { client, sent } = clientOver(makeDb());
    await readTreeRows(createCoreReadDb(client), "p-a");
    await readProjectModeRow(createCoreReadDb(client), "p-a");
    expect(sent).toHaveLength(2);
    const tree = sent[0]!.sql.toLowerCase();
    const treeColumns = tree.slice(
      tree.indexOf("select ") + "select ".length,
      tree.indexOf(" from "),
    );
    expect(
      treeColumns
        .split(",")
        .map((c) => c.trim())
        .sort(),
    ).toEqual(
      [
        '"archived_at"',
        '"id"',
        '"node_type"',
        '"parent_id"',
        '"sort_order"',
        '"story_time_order"',
        '"title"',
        '"chronicle_start_time"',
        '"chronicle_start_minute"',
        '"chronicle_start_granularity"',
        '"chronicle_precision"',
      ].sort(),
    );
    // The mode select asks for that one column and nothing else.
    expect(
      sent[1]!.sql.startsWith(
        'select "phase_resolution_mode" from "projects" where',
      ),
    ).toBe(true);
    expect(sent[1]!.sql.slice(0, sent[1]!.sql.indexOf(" from "))).toBe(
      'select "phase_resolution_mode"',
    );
  });

  it("composes both, and ignores another project's current scene", async () => {
    const { client } = clientOver(makeDb());
    const inputs = await readReadInputs(createCoreReadDb(client), {
      projectId: "p-a",
      currentSceneId: "b-s1",
    });
    expect([...inputs.readingOrder.keys()]).toEqual(["a-s1", "a-s2"]);
    expect(inputs.currentSceneId).toBeNull();
    expect(inputs.resolutionMode).toEqual({ kind: "resolved", mode: "story" });
    const own = await readReadInputs(createCoreReadDb(client), {
      projectId: "p-a",
      currentSceneId: "a-s2",
    });
    expect(own.currentSceneId).toBe("a-s2");
    const archived = await readReadInputs(createCoreReadDb(client), {
      projectId: "p-a",
      currentSceneId: "a-arch",
    });
    expect(archived.currentSceneId).toBeNull();
  });

  it("treats a project that does not exist as empty and unresolved", async () => {
    const { client } = clientOver(makeDb());
    const inputs = await readReadInputs(createCoreReadDb(client), {
      projectId: "p-none",
      currentSceneId: "a-s1",
    });
    expect(inputs.readingOrder.size).toBe(0);
    expect(inputs.currentSceneId).toBeNull();
    expect(inputs.resolutionMode).toEqual({
      kind: "unresolved",
      reason: "project-missing",
    });
  });

  it("refuses an empty or non-string project id before anything is sent", async () => {
    const client = vi.fn<CoreReadDbClient>(async () => ({ rows: [] }));
    for (const projectId of ["", "  ", undefined, null, 1]) {
      await expect(
        readTreeRows(createCoreReadDb(client), projectId as never),
      ).rejects.toThrow("projectId is required");
      await expect(
        readProjectModeRow(createCoreReadDb(client), projectId as never),
      ).rejects.toThrow("projectId is required");
      await expect(
        readReadInputs(createCoreReadDb(client), {
          projectId: projectId as never,
          currentSceneId: null,
        }),
      ).rejects.toThrow("projectId is required");
    }
    expect(client).not.toHaveBeenCalled();
  });

  it("sends the method `all` (never `get`) and no second statement", async () => {
    const { client, sent } = clientOver(makeDb());
    await readReadInputs(createCoreReadDb(client), {
      projectId: "p-a",
      currentSceneId: null,
    });
    expect(sent.map((s) => s.method)).toEqual(["all", "all"]);
  });
});

describe("readChronicleReadInputs and buildChronicleNodes (PR-7a)", () => {
  const chronicleRow = (
    id: string,
    extra: Partial<ReadChronicleTreeRow> = {},
  ): ReadChronicleTreeRow => ({
    ...row(id, null, "scene", "a0"),
    title: `title-${id}`,
    chronicleStartTime: null,
    chronicleStartMinute: null,
    chronicleStartGranularity: "none",
    chroniclePrecision: "exact",
    ...extra,
  });

  it("buildChronicleNodes carries the title and the four chronicle columns, keeps the row order, and does not narrow the node type", () => {
    const rows = [
      chronicleRow("z", {
        chronicleStartTime: 3,
        chronicleStartMinute: 4,
        chronicleStartGranularity: "minute",
        chroniclePrecision: "approx",
      }),
      chronicleRow("a", { nodeType: "note", archivedAt: "x" }),
    ];
    const nodes = buildChronicleNodes(rows);
    expect(nodes.map((n) => n.id)).toEqual(["z", "a"]);
    expect(nodes[0]).toEqual({
      id: "z",
      parentId: null,
      nodeType: "scene",
      title: "title-z",
      sortOrder: "a0",
      storyTimeOrder: null,
      archivedAt: null,
      chronicleStartTime: 3,
      chronicleStartMinute: 4,
      chronicleStartGranularity: "minute",
      chroniclePrecision: "approx",
    });
    expect(nodes[1]).toMatchObject({ nodeType: "note", archivedAt: "x" });
  });

  it("reads the nodes and the read inputs from ONE tree select (two statements in all, the second is the mode)", async () => {
    const { client, sent } = clientOver(makeDb());
    const { inputs, nodes } = await readChronicleReadInputs(
      createCoreReadDb(client),
      { projectId: "p-a", currentSceneId: "a-s2" },
    );
    expect(sent).toHaveLength(2);
    expect(sent[0]!.sql.toLowerCase()).toContain('from "tree_nodes"');
    expect(sent[1]!.sql.toLowerCase()).toContain('from "projects"');
    expect(nodes.map((n) => n.id).sort()).toEqual(["a-f", "a-s1", "a-s2"]);
    expect(nodes.find((n) => n.id === "a-s1")).toMatchObject({
      title: "First",
      chronicleStartTime: 12,
      chronicleStartMinute: 30,
      chronicleStartGranularity: "minute",
      chroniclePrecision: "approx",
    });
    // The reading order and the nodes are from the same rows.
    expect([...inputs.readingOrder.keys()]).toEqual(["a-s1", "a-s2"]);
    for (const id of inputs.readingOrder.keys()) {
      expect(nodes.some((n) => n.id === id)).toBe(true);
    }
    expect(inputs.currentSceneId).toBe("a-s2");
    expect(inputs.resolutionMode).toEqual({ kind: "resolved", mode: "story" });
    for (const call of sent) {
      expect(checkReadSql(call.sql, MAIN_READ_TABLE_SET).ok).toBe(true);
    }
  });

  it("gives the same read inputs as readReadInputs, and no node of another project or an archived scene", async () => {
    const { client } = clientOver(makeDb());
    const db = createCoreReadDb(client);
    const args = { projectId: "p-a", currentSceneId: "a-s1" } as const;
    const both = await readChronicleReadInputs(db, args);
    const only = await readReadInputs(db, args);
    expect([...both.inputs.readingOrder]).toEqual([...only.readingOrder]);
    expect(both.inputs.currentSceneId).toBe(only.currentSceneId);
    expect(both.inputs.resolutionMode).toEqual(only.resolutionMode);
    expect(both.nodes.map((n) => n.id)).not.toContain("b-s1");
    expect(both.nodes.map((n) => n.id)).not.toContain("a-arch");
  });

  it("refuses an empty project id before anything is sent", async () => {
    const client = vi.fn<CoreReadDbClient>(async () => ({ rows: [] }));
    await expect(
      readChronicleReadInputs(createCoreReadDb(client), {
        projectId: "",
        currentSceneId: null,
      }),
    ).rejects.toThrow("projectId is required");
    expect(client).not.toHaveBeenCalled();
  });
});

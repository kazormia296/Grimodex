// MP-4b PR-8a: the Codex visibility decision over the read core's ports, run on a
// real SQLite (node:sqlite) through Main's checked path (every statement passes
// `checkReadSql` first). Relative imports only (the electron vitest config has no
// `@` alias).
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  CoreProjectRequiredError,
  type CoreCodexVisibilityPorts,
  type CoreReadDbClient,
} from "../../mastraRead/ports.js";
import { checkReadSql } from "../../mastraRead/sql.js";
import { MAIN_READ_TABLE_SET } from "../../mastraRead/tables.js";
import { createMainCodexVisibilityPorts } from "./codexMainContext.js";
import { readCodexPhases } from "./codexReaders.js";
import {
  dropHiddenCodexRows,
  listHiddenCodexIds,
  resolveCodexAiVisibility,
} from "./codexVisibility.js";
import { buildReadInputs, type ReadInputs } from "./readInputs.js";
import { createCoreReadDb } from "./readDb.js";

const T = "2026-01-01T00:00:00.000Z";

interface Seeded {
  readonly sqlite: DatabaseSync;
}

function makeDb(extra?: (sqlite: DatabaseSync) => void): Seeded {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    create table codex_entries (
      id text primary key, project_id text not null, summary text,
      context_mode text not null, content text not null default ''
    );
    create table codex_entry_phases (
      id text primary key, entry_id text not null, anchor_node_id text,
      label text not null default '', summary_override text,
      content_override text, context_mode_override text,
      created_at text not null, updated_at text not null,
      version integer not null default 0
    );
    insert into codex_entries values
      ('pub', 'p-a', 'pub summary', 'mentioned', 'pub content'),
      ('hid', 'p-a', 'hid summary', 'hidden', 'hid content'),
      ('rel', 'p-a', 'base summary', 'hidden', 'base content'),
      ('hide-later', 'p-a', 'hl summary', 'mentioned', 'hl content'),
      ('b-pub', 'p-b', 'b summary', 'mentioned', 'b content'),
      ('b-hid', 'p-b', 'b hidden', 'hidden', 'b hidden content');
    insert into codex_entry_phases
      (id, entry_id, anchor_node_id, label, summary_override, content_override, context_mode_override, created_at, updated_at) values
      ('ph-rel', 'rel', 's3', 'revealed', 'phase summary', 'phase content', 'mentioned', '${T}', '${T}'),
      ('ph-hide', 'hide-later', 's2', 'hidden from s2', null, null, 'hidden', '${T}', '${T}'),
      ('ph-b', 'b-hid', 's1', 'another project', null, null, 'mentioned', '${T}', '${T}');
  `);
  extra?.(sqlite);
  return { sqlite };
}

type Log = string[];

function clientOver(sqlite: DatabaseSync, log: Log = []) {
  const sent: { sql: string; params: unknown[]; method: string }[] = [];
  const client: CoreReadDbClient = async (sql, params, method) => {
    const checked = checkReadSql(sql, MAIN_READ_TABLE_SET);
    if (!checked.ok) throw new Error(`refused: ${checked.code}`);
    if (method !== "all" && method !== "values") {
      throw new Error(`method ${method}`);
    }
    sent.push({ sql, params, method });
    log.push(`sql:${checked.tables.join(",")}`);
    const rows = sqlite.prepare(sql).all(...(params as never[]));
    return { rows: rows.map((r) => Object.values(r as object)) };
  };
  return { client, sent };
}

const treeRows = [
  { id: "s1", sortOrder: "a0" },
  { id: "s2", sortOrder: "a1" },
  { id: "s3", sortOrder: "a2" },
].map((r) => ({
  ...r,
  parentId: null,
  nodeType: "scene",
  storyTimeOrder: null,
  archivedAt: null,
}));

const inputsOf = (
  projectId: string,
  project: { phaseResolutionMode: unknown } | null = {
    phaseResolutionMode: "reading",
  },
): ReadInputs =>
  buildReadInputs({ projectId, treeRows, project, currentSceneId: "s1" });

function setup(
  projectId = "p-a",
  project: { phaseResolutionMode: unknown } | null = {
    phaseResolutionMode: "reading",
  },
  extra?: (sqlite: DatabaseSync) => void,
) {
  const { sqlite } = makeDb(extra);
  const log: Log = [];
  const { client, sent } = clientOver(sqlite, log);
  const db = createCoreReadDb(client);
  const ports = createMainCodexVisibilityPorts({
    db,
    inputs: inputsOf(projectId, project),
  });
  return { sqlite, db, ports, sent, log };
}

/** The ports with a log of the order of the three awaits. */
function logged(
  ports: CoreCodexVisibilityPorts,
  log: Log,
): CoreCodexVisibilityPorts {
  return {
    getDb: ports.getDb,
    getPhaseState: () => {
      log.push("state");
      return ports.getPhaseState();
    },
    codex: {
      listPhases: (ids) => {
        log.push(`listPhases(${ids.join(",")})`);
        return ports.codex.listPhases(ids);
      },
    },
  };
}

const ask = (
  ports: CoreCodexVisibilityPorts,
  entryIds: string[],
  sceneId: string | null | undefined = "s1",
  projectId = "p-a",
  withContent = false,
) =>
  resolveCodexAiVisibility(ports, {
    projectId,
    entryIds,
    sceneId,
    withContent,
  });

describe("resolveCodexAiVisibility", () => {
  it("decides hidden and texts from the project's entries and phases at the current scene", async () => {
    const { ports } = setup();
    const ids = ["pub", "hid", "rel", "hide-later", "gone"];

    const s1 = await ask(ports, ids, "s1");
    expect([...s1.hidden].sort()).toEqual(["gone", "hid", "rel"]);
    expect([...s1.texts.keys()].sort()).toEqual(["hide-later", "pub"]);

    const s2 = await ask(ports, ids, "s2");
    expect([...s2.hidden].sort()).toEqual(["gone", "hid", "hide-later", "rel"]);

    const s3 = await ask(ports, ids, "s3");
    expect([...s3.hidden].sort()).toEqual(["gone", "hid", "hide-later"]);
    expect(s3.texts.get("rel")).toEqual({
      summary: "phase summary",
      // Not asked for the body, a released entry still has the phase's text.
      content: "phase content",
      released: true,
      mode: "mentioned",
    });
  });

  it("a scene id that the reading order does not have, and no scene, hide an entry that a phase hides (DR-MP4-41, Q1)", async () => {
    const { ports } = setup();
    const ids = ["pub", "hid", "rel", "hide-later"];

    // Archived, in the trash, deleted, or another project's scene: given, but not in the reading order.
    for (const sceneId of ["s-archived", "  s-archived  "]) {
      const missing = await ask(ports, ids, sceneId);
      expect([...missing.hidden].sort(), sceneId).toEqual([
        "hid",
        "hide-later",
        "rel",
      ]);
      expect([...missing.texts.keys()], sceneId).toEqual(["pub"]);
    }

    // No scene cannot be resolved either (DR-MP4-41 Q1): the phase that hides `hide-later` is not
    // applied, so `hide-later` is hidden too. (Before Q1: hidden = [hid, rel], texts = [hide-later, pub].)
    // (`ask` defaults an undefined scene to "s1", so undefined goes through the function directly.)
    for (const sceneId of [null, undefined, "", "   "]) {
      const none = await resolveCodexAiVisibility(ports, {
        projectId: "p-a",
        entryIds: ids,
        sceneId,
        withContent: false,
      });
      expect([...none.hidden].sort(), String(sceneId)).toEqual([
        "hid",
        "hide-later",
        "rel",
      ]);
      expect([...none.texts.keys()], String(sceneId)).toEqual(["pub"]);
    }

    // `listHiddenCodexIds` is the same decision.
    const hiddenIds = await listHiddenCodexIds(ports, {
      projectId: "p-a",
      entryIds: ids,
      sceneId: "s-archived",
    });
    expect(hiddenIds.has("hide-later")).toBe(true);
    const hiddenIdsNoScene = await listHiddenCodexIds(ports, {
      projectId: "p-a",
      entryIds: ids,
      sceneId: null,
    });
    expect([...hiddenIdsNoScene].sort()).toEqual(["hid", "hide-later", "rel"]);
  });

  it("reads the body only when asked, and a released entry then has the phase's text", async () => {
    const { ports, sent } = setup();
    const without = await ask(ports, ["pub"], "s1");
    expect(without.texts.get("pub")?.content).toBe("");
    expect(sent[0]!.sql).not.toContain('"content"');

    sent.length = 0;
    const withContent = await ask(ports, ["pub", "rel"], "s3", "p-a", true);
    expect(sent[0]!.sql).toContain('"content"');
    expect(withContent.texts.get("pub")?.content).toBe("pub content");
    expect(withContent.texts.get("rel")).toMatchObject({
      released: true,
      content: "phase content",
    });
  });

  it("awaits in the renderer's order: the entries, then the phases, and only then the phase state", async () => {
    const { ports, log } = setup();
    await ask(logged(ports, log), ["pub", "hid"]);
    expect(log).toEqual([
      "sql:codex_entries",
      "listPhases(hid,pub)", // the order the database returned the entries in
      "sql:codex_entry_phases",
      "state",
    ]);
  });

  it("returns before reading anything for no ids, and before the phases when no id is an entry of the project", async () => {
    const { ports, log, sent } = setup();
    const none = await ask(logged(ports, log), []);
    expect(none.hidden.size + none.texts.size).toBe(0);
    expect(log).toEqual([]);

    const gone = await ask(logged(ports, log), ["gone-1", "gone-1", "b-pub"]);
    expect([...gone.hidden]).toEqual(["gone-1", "b-pub"]);
    expect(gone.texts.size).toBe(0);
    expect(log).toEqual(["sql:codex_entries"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.params).toEqual(["p-a", "gone-1", "b-pub"]);
  });

  it("drops a repeated id, and keeps the missing ids first, in the order given, then the decided ones", async () => {
    const { ports } = setup();
    const r = await ask(ports, ["hid", "gone-1", "pub", "gone-2", "hid"]);
    expect([...r.hidden]).toEqual(["gone-1", "gone-2", "hid"]);
  });

  it("keeps the project in the statement: an id of another project is an id the project has no entry for", async () => {
    const { ports, sent } = setup();
    const r = await ask(ports, ["b-pub", "b-hid", "pub"]);
    expect([...r.hidden].sort()).toEqual(["b-hid", "b-pub"]);
    expect(sent[0]!.sql).toMatch(/"project_id" = \?/u);
    expect(sent[0]!.params).toEqual(["p-a", "b-pub", "b-hid", "pub"]);
    // Only the ids the project has an entry for reach the phases select.
    expect(sent[1]!.params).toEqual(["pub"]);
  });

  it("every statement passes the pre-send check and is a select; the phases select names the allowlisted table", async () => {
    const { ports, sent } = setup();
    await ask(ports, ["pub", "rel"], "s3");
    expect(sent).toHaveLength(2);
    for (const s of sent) {
      expect(s.sql.trim().toLowerCase().startsWith("select ")).toBe(true);
      expect(checkReadSql(s.sql, MAIN_READ_TABLE_SET).ok).toBe(true);
    }
    expect(checkReadSql(sent[1]!.sql, MAIN_READ_TABLE_SET)).toMatchObject({
      tables: ["codex_entry_phases"],
    });
  });

  it("throws before reading anything when the project is empty", async () => {
    const { ports, sent } = setup();
    for (const projectId of ["", "  "]) {
      await expect(ask(ports, ["pub"], "s1", projectId)).rejects.toBeInstanceOf(
        CoreProjectRequiredError,
      );
      // Even for no ids: the guard comes first.
      await expect(ask(ports, [], "s1", projectId)).rejects.toBeInstanceOf(
        CoreProjectRequiredError,
      );
    }
    expect(sent).toEqual([]);
  });

  it("does not cache: every call reads the entries and the phases again", async () => {
    const { ports, sent, sqlite } = setup();
    const first = await ask(ports, ["pub"], "s1");
    expect([...first.hidden]).toEqual([]);
    expect(sent).toHaveLength(2);
    // The author turns the entry hidden between two calls.
    sqlite.exec(
      "update codex_entries set context_mode = 'hidden' where id = 'pub'",
    );
    const second = await ask(ports, ["pub"], "s1");
    expect([...second.hidden]).toEqual(["pub"]);
    expect(sent).toHaveLength(4);
  });

  it("splits more than 500 ids into statements of at most 500, for the entries and for the phases, and decides over all of them", async () => {
    const { ports, sent, log } = setup("p-a", undefined, (sqlite) => {
      const insert = sqlite.prepare(
        "insert into codex_entries values (?, 'p-a', 's', 'mentioned', '')",
      );
      for (let i = 0; i < 1100; i += 1) insert.run(`bulk-${i}`);
      // The last entry's phase hides it from s1.
      sqlite.exec(
        `insert into codex_entry_phases (id, entry_id, anchor_node_id, context_mode_override, created_at, updated_at) values ('ph-bulk', 'bulk-1099', 's1', 'hidden', '${T}', '${T}')`,
      );
    });
    const ids = Array.from({ length: 1100 }, (_, i) => `bulk-${i}`);
    const r = await ask(logged(ports, log), [...ids, "gone"], "s1");
    expect([...r.hidden].sort()).toEqual(["bulk-1099", "gone"]);
    expect(r.texts.size).toBe(1099);
    const entrySql = sent.filter((s) => s.sql.includes("codex_entries"));
    const phaseSql = sent.filter((s) => s.sql.includes("codex_entry_phases"));
    expect(entrySql.map((s) => s.params.length - 1)).toEqual([500, 500, 101]);
    expect(phaseSql.map((s) => s.params.length)).toEqual([500, 500, 100]);
    // One phase state read, after every select.
    expect(log.filter((l) => l === "state")).toHaveLength(1);
    expect(log[log.length - 1]).toBe("state");
  });

  it("propagates a failure of a port (it is not caught, so nothing reaches the AI)", async () => {
    const { ports } = setup();
    await expect(
      ask(
        {
          ...ports,
          codex: { listPhases: () => Promise.reject(new Error("phases down")) },
        },
        ["pub"],
      ),
    ).rejects.toThrow("phases down");
    await expect(
      ask(
        {
          ...ports,
          getPhaseState: () => {
            throw new Error("state down");
          },
        },
        ["pub"],
      ),
    ).rejects.toThrow("state down");
  });

  describe("the phase state's project", () => {
    it("refuses a phase state that belongs to another project", async () => {
      // `hide-later` is public and a phase hides it from s2. The reading order of
      // another project would skip that phase and leave it public.
      const { ports } = setup("p-b");
      await expect(ask(ports, ["hide-later"], "s2", "p-a")).rejects.toThrow(
        /different project/u,
      );
      await expect(
        listHiddenCodexIds(ports, {
          projectId: "p-a",
          entryIds: ["pub"],
          sceneId: "s2",
        }),
      ).rejects.toThrow(/different project/u);
      await expect(
        dropHiddenCodexRows(ports, [{ id: "pub" }], {
          projectId: "p-a",
          sceneId: "s2",
        }),
      ).rejects.toThrow(/different project/u);
    });

    it("accepts a phase state of the same project, and one that names no project (the renderer's)", async () => {
      const { ports } = setup("p-a");
      expect([...(await ask(ports, ["hide-later"], "s2")).hidden]).toEqual([
        "hide-later",
      ]);
      const { projectId: _omitted, ...stateWithoutProject } =
        ports.getPhaseState();
      const anonymous: CoreCodexVisibilityPorts = {
        ...ports,
        getPhaseState: () => stateWithoutProject,
      };
      expect([...(await ask(anonymous, ["hide-later"], "s2")).hidden]).toEqual([
        "hide-later",
      ]);
    });

    it("does not read the phase state at all when no entry was found (nothing to decide)", async () => {
      const { ports } = setup("p-b");
      const r = await ask(ports, ["gone"], "s1", "p-a");
      expect([...r.hidden]).toEqual(["gone"]);
    });
  });

  describe("unresolved", () => {
    it("hides every entry that was found, after the same reads (a missing project row is the only way to reach it)", async () => {
      const { ports, log } = setup("p-a", null);
      expect(ports.getPhaseState().resolutionMode).toMatchObject({
        kind: "unresolved",
      });
      const r = await ask(logged(ports, log), ["pub", "rel", "gone"], "s3");
      expect([...r.hidden].sort()).toEqual(["gone", "pub", "rel"]);
      expect(r.texts.size).toBe(0);
      expect(log).toEqual([
        "sql:codex_entries",
        "listPhases(pub,rel)",
        "sql:codex_entry_phases",
        "state",
      ]);
    });

    it.each([
      ["a null mode", { phaseResolutionMode: null }],
      ["an unknown mode", { phaseResolutionMode: "sometimes" }],
      ["an empty mode", { phaseResolutionMode: "" }],
    ])("hides every entry for %s", async (_label, project) => {
      const { ports } = setup("p-a", project);
      const r = await ask(ports, ["pub", "hid", "rel"], "s3");
      expect([...r.hidden].sort()).toEqual(["hid", "pub", "rel"]);
      expect(r.texts.size).toBe(0);
    });
  });
});

// Characterization of a known hole (DR-MP4-46 closes it in the next commit): a Phase that hides
// an entry but whose anchor the resolver cannot place (null, or a scene the reading order does
// not have) is skipped, so at a scene the reading order has the entry is read as base: public.
describe("a hiding Phase that lost its anchor (known hole, fixed by DR-MP4-46)", () => {
  const withOrphans = (sqlite: DatabaseSync) => {
    sqlite.exec(`
      insert into codex_entries values
        ('orph-null', 'p-a', 'on summary', 'mentioned', 'on content'),
        ('orph-gone', 'p-a', 'og summary', 'mentioned', 'og content');
      insert into codex_entry_phases
        (id, entry_id, anchor_node_id, label, summary_override, content_override, context_mode_override, created_at, updated_at) values
        ('ph-on', 'orph-null', null, 'null anchor', null, null, 'hidden', '${T}', '${T}'),
        ('ph-og', 'orph-gone', 's-deleted', 'deleted anchor', null, null, 'hidden', '${T}', '${T}');
    `);
  };

  it("leaves both entries public at every scene the reading order has, in resolveCodexAiVisibility, listHiddenCodexIds and dropHiddenCodexRows", async () => {
    const { ports } = setup("p-a", undefined, withOrphans);
    const ids = ["orph-gone", "orph-null"];
    for (const sceneId of ["s1", "s2", "s3"]) {
      const r = await ask(ports, ids, sceneId);
      expect([...r.hidden], sceneId).toEqual([]);
      expect([...r.texts.keys()].sort(), sceneId).toEqual(ids);
      const hidden = await listHiddenCodexIds(ports, {
        projectId: "p-a",
        entryIds: ids,
        sceneId,
      });
      expect([...hidden], sceneId).toEqual([]);
      const rows = await dropHiddenCodexRows(
        ports,
        ids.map((id) => ({ id })),
        { projectId: "p-a", sceneId },
      );
      expect(
        rows.map((row) => row.id),
        sceneId,
      ).toEqual(ids);
    }
  });
});

describe("listHiddenCodexIds", () => {
  it("is the hidden set of the same decision, and does not tell a hidden id from one the project has no entry for", async () => {
    const { ports } = setup();
    const ids = ["pub", "hid", "gone", "rel", "b-pub"];
    const hidden = await listHiddenCodexIds(ports, {
      projectId: "p-a",
      entryIds: ids,
      sceneId: "s1",
    });
    const decided = await ask(ports, ids, "s1");
    expect([...hidden]).toEqual([...decided.hidden]);
    expect(hidden.has("hid")).toBe(true);
    expect(hidden.has("gone")).toBe(true);
    expect(hidden.has("b-pub")).toBe(true);
    expect(hidden.has("pub")).toBe(false);
  });

  it("takes the scene from the caller and not from anything else: the same ids differ between two scenes", async () => {
    const { ports } = setup();
    const at = (sceneId: string) =>
      listHiddenCodexIds(ports, {
        projectId: "p-a",
        entryIds: ["hide-later", "rel"],
        sceneId,
      });
    expect([...(await at("s1"))].sort()).toEqual(["rel"]);
    expect([...(await at("s2"))].sort()).toEqual(["hide-later", "rel"]);
    expect([...(await at("s3"))].sort()).toEqual(["hide-later"]);
  });
});

describe("dropHiddenCodexRows", () => {
  it("drops the hidden rows, keeps the order, and gives a released row that has a summary the summary after the phase", async () => {
    const { ports } = setup();
    const rows = [
      { id: "hid", summary: "x" },
      { id: "rel", summary: "base summary" },
      { id: "pub", summary: "pub summary" },
      { id: "gone", summary: "y" },
    ];
    const kept = await dropHiddenCodexRows(ports, rows, {
      projectId: "p-a",
      sceneId: "s3",
    });
    expect(kept).toEqual([
      { id: "rel", summary: "phase summary" },
      { id: "pub", summary: "pub summary" },
    ]);
    // The row that was not released is the same object.
    expect(kept[1]).toBe(rows[2]);
  });

  it("leaves a released row that has no summary key as it is", async () => {
    const { ports } = setup();
    const rows = [{ id: "rel", name: "n" }];
    const kept = await dropHiddenCodexRows(ports, rows, {
      projectId: "p-a",
      sceneId: "s3",
    });
    expect(kept).toEqual([{ id: "rel", name: "n" }]);
    expect(kept[0]).toBe(rows[0]);
  });

  it("reads nothing for no rows (it does not even check the project)", async () => {
    const { ports, sent } = setup();
    expect(
      await dropHiddenCodexRows(ports, [], { projectId: "", sceneId: "s1" }),
    ).toEqual([]);
    expect(sent).toEqual([]);
  });
});

describe("readCodexPhases", () => {
  it("reads every column of the phases of the given entries, oldest first, and nothing for no ids", async () => {
    const { db, sent } = setup();
    expect(await readCodexPhases(db, [])).toEqual([]);
    expect(sent).toEqual([]);
    const rows = await readCodexPhases(db, ["rel", "hide-later"]);
    expect(rows.map((r) => r.id).sort()).toEqual(["ph-hide", "ph-rel"]);
    expect(Object.keys(rows[0]!).sort()).toEqual([
      "anchorNodeId",
      "contentOverride",
      "contextModeOverride",
      "createdAt",
      "entryId",
      "id",
      "label",
      "summaryOverride",
      "updatedAt",
      "version",
    ]);
    expect(sent[0]!.sql.toLowerCase()).toContain(
      'order by "codex_entry_phases"."created_at"',
    );
  });

  it("has no project column to condition on: it returns the phases of any entry id it is given (the caller passes only entries read under a project)", async () => {
    const { db } = setup();
    const rows = await readCodexPhases(db, ["b-hid"]);
    expect(rows.map((r) => r.id)).toEqual(["ph-b"]);
  });
});

describe("a live store's project epoch (PR-8b, DR-MP4-41 (b) carried into the core)", () => {
  const withEpoch = (
    ports: CoreCodexVisibilityPorts,
    epoch: () => number,
    log: Log,
  ): CoreCodexVisibilityPorts => ({
    ...logged(ports, log),
    getProjectEpoch: () => {
      log.push("epoch");
      return epoch();
    },
  });

  it("notes the epoch before the first read and compares it after the phase state is read: an unchanged epoch changes nothing", async () => {
    const { ports, log } = setup();
    const result = await ask(
      withEpoch(ports, () => 7, log),
      ["pub", "hid"],
    );
    expect([...result.hidden]).toEqual(["hid"]);
    expect([...result.texts.keys()]).toEqual(["pub"]);
    expect(log).toEqual([
      "epoch",
      "sql:codex_entries",
      "listPhases(hid,pub)",
      "sql:codex_entry_phases",
      "state",
      "epoch",
    ]);
  });

  it("a different epoch after the reads hides every id that was asked about (the ones the database lacks and the public ones too) and returns no text", async () => {
    const { ports } = setup();
    let epoch = 0;
    const log: Log = [];
    const deps = withEpoch(ports, () => epoch, log);
    const switching: CoreCodexVisibilityPorts = {
      ...deps,
      codex: {
        listPhases: async (ids) => {
          const phases = await deps.codex.listPhases(ids);
          epoch += 1; // the project was switched during the phases read
          return phases;
        },
      },
    };
    const result = await ask(switching, ["pub", "hid", "gone", "pub"]);
    expect([...result.hidden].sort()).toEqual(["gone", "hid", "pub"]);
    expect(result.texts.size).toBe(0);
    // dropHiddenCodexRows and listHiddenCodexIds go through the same decision.
    epoch = 0;
    expect(
      await dropHiddenCodexRows(switching, [{ id: "pub" }], {
        projectId: "p-a",
        sceneId: "s1",
      }),
    ).toEqual([]);
    epoch = 0;
    expect([
      ...(await listHiddenCodexIds(switching, {
        projectId: "p-a",
        entryIds: ["pub"],
        sceneId: "s1",
      })),
    ]).toEqual(["pub"]);
  });

  it("reads no epoch when there is nothing to ask about, and does not compare one when no entry was found (nothing was read that a switch could spoil)", async () => {
    const { ports, log } = setup();
    const deps = withEpoch(ports, () => 0, log);
    await ask(deps, []);
    expect(log).toEqual([]);
    await ask(deps, ["gone"]);
    expect(log).toEqual(["epoch", "sql:codex_entries"]);
  });

  it("ports with no getProjectEpoch (Main's) are decided as before", async () => {
    const { ports } = setup();
    expect(ports.getProjectEpoch).toBeUndefined();
    const result = await ask(ports, ["pub", "hid"]);
    expect([...result.hidden]).toEqual(["hid"]);
  });
});

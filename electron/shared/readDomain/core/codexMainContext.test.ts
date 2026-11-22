// MP-4b PR-8a: Main's ports of the Codex visibility decision. Relative imports only.
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { CoreReadDbClient } from "../../mastraRead/ports.js";
import { createMainCodexVisibilityPorts } from "./codexMainContext.js";
import { resolveCodexAiVisibility } from "./codexVisibility.js";
import { buildReadInputs } from "./readInputs.js";
import { createCoreReadDb } from "./readDb.js";

const T = "2026-01-01T00:00:00.000Z";

function dbOver(): { client: CoreReadDbClient; sqlite: DatabaseSync } {
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
    insert into codex_entries values ('e1', 'p-a', 's', 'mentioned', '');
    insert into codex_entry_phases
      (id, entry_id, anchor_node_id, context_mode_override, created_at, updated_at)
      values ('ph1', 'e1', 's2', 'hidden', '${T}', '${T}');
  `);
  const client: CoreReadDbClient = async (sql, params) => ({
    rows: sqlite
      .prepare(sql)
      .all(...(params as never[]))
      .map((r) => Object.values(r as object)),
  });
  return { client, sqlite };
}

const rowsOf = (ids: string[]) =>
  ids.map((id, i) => ({
    id,
    parentId: null,
    nodeType: "scene",
    sortOrder: `a${i}`,
    storyTimeOrder: null,
    archivedAt: null,
  }));

describe("createMainCodexVisibilityPorts", () => {
  it("builds the phase state from the turn's inputs: its project, reading order and mode", () => {
    const { client } = dbOver();
    const inputs = buildReadInputs({
      projectId: "p-a",
      treeRows: rowsOf(["s1", "s2"]),
      project: { phaseResolutionMode: "story" },
      currentSceneId: "s1",
    });
    const ports = createMainCodexVisibilityPorts({
      db: createCoreReadDb(client),
      inputs,
    });
    const state = ports.getPhaseState();
    expect(state.projectId).toBe("p-a");
    expect(state.resolutionMode).toEqual({ kind: "resolved", mode: "story" });
    expect(state.sceneTimeIndex).toBe(inputs.sceneTimeIndex);
    expect([...state.sceneTimeIndex.readingOrder.keys()]).toEqual(["s1", "s2"]);
    // The same object each time: the state is fixed for the turn.
    expect(ports.getPhaseState()).toBe(state);
  });

  it("carries an unresolved mode as it is", () => {
    const { client } = dbOver();
    const ports = createMainCodexVisibilityPorts({
      db: createCoreReadDb(client),
      inputs: buildReadInputs({
        projectId: "p-a",
        treeRows: [],
        project: null,
        currentSceneId: null,
      }),
    });
    expect(ports.getPhaseState().resolutionMode).toMatchObject({
      kind: "unresolved",
      reason: "project-missing",
    });
  });

  it("two turns of two projects do not see each other (no module-level state)", async () => {
    const { client } = dbOver();
    const db = createCoreReadDb(client);
    // Turn A has a reading order with s2; turn B (another project) does not have it.
    const a = createMainCodexVisibilityPorts({
      db,
      inputs: buildReadInputs({
        projectId: "p-a",
        treeRows: rowsOf(["s1", "s2"]),
        project: { phaseResolutionMode: "reading" },
        currentSceneId: "s1",
      }),
    });
    const b = createMainCodexVisibilityPorts({
      db,
      inputs: buildReadInputs({
        projectId: "p-b",
        treeRows: rowsOf(["x1"]),
        project: { phaseResolutionMode: "auto" },
        currentSceneId: "x1",
      }),
    });
    expect(a.getPhaseState().projectId).toBe("p-a");
    expect(b.getPhaseState().projectId).toBe("p-b");
    expect(a.getPhaseState().sceneTimeIndex.readingOrder.has("x1")).toBe(false);
    expect(b.getPhaseState().sceneTimeIndex.readingOrder.has("s2")).toBe(false);

    // Interleaved: A's decision uses A's reading order, and B's request for A's project is refused.
    const [hiddenA, refusedB] = await Promise.allSettled([
      resolveCodexAiVisibility(a, {
        projectId: "p-a",
        entryIds: ["e1"],
        sceneId: "s2",
      }),
      resolveCodexAiVisibility(b, {
        projectId: "p-a",
        entryIds: ["e1"],
        sceneId: "s2",
      }),
    ]);
    expect(hiddenA.status).toBe("fulfilled");
    expect(
      hiddenA.status === "fulfilled" ? [...hiddenA.value.hidden] : [],
    ).toEqual(["e1"]);
    expect(refusedB.status).toBe("rejected");
  });

  it("reads the phases from the database on every call (nothing cached)", async () => {
    const { client, sqlite } = dbOver();
    const ports = createMainCodexVisibilityPorts({
      db: createCoreReadDb(client),
      inputs: buildReadInputs({
        projectId: "p-a",
        treeRows: rowsOf(["s1", "s2"]),
        project: { phaseResolutionMode: "reading" },
        currentSceneId: "s1",
      }),
    });
    expect((await ports.codex.listPhases(["e1"])).map((p) => p.id)).toEqual([
      "ph1",
    ]);
    sqlite.exec("delete from codex_entry_phases");
    expect(await ports.codex.listPhases(["e1"])).toEqual([]);
  });
});

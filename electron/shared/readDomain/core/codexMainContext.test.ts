// MP-4b PR-8a: Main's ports of the Codex visibility decision. Relative imports only.
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { CoreReadDbClient } from "../../mastraRead/ports.js";
import {
  createMainCodexEntryContext,
  createMainCodexReadContext,
  createMainCodexVisibilityPorts,
} from "./codexMainContext.js";
import {
  resolveCodexAiVisibility,
  resolveCodexAiVisibilityWithDetails,
} from "./codexVisibility.js";
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
    create table codex_detail_values (
      id text primary key, entry_id text not null, definition_id text not null,
      value text, version integer not null default 0,
      created_at text, updated_at text
    );
    create table codex_phase_detail_overrides (
      phase_id text not null, definition_id text not null, value text
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

describe("createMainCodexReadContext (PR-8b)", () => {
  const native = {
    fts: async () => [],
    codexSemantic: async () => [],
  };

  it("takes the project, the current scene and the phase state from one turn's inputs; a scene the reading order lacks is null; it has no live store's epoch", () => {
    const { client } = dbOver();
    const db = createCoreReadDb(client);
    const inputs = buildReadInputs({
      projectId: "p-a",
      treeRows: rowsOf(["s1", "s2"]),
      project: { phaseResolutionMode: "reading" },
      currentSceneId: "s2",
    });
    const ctx = createMainCodexReadContext({
      db,
      inputs,
      countTokens: (text) => text.length,
      native,
    });
    expect(ctx.getTreeState()).toEqual({
      projectId: "p-a",
      nodes: [],
      activeSceneId: "s2",
    });
    expect(ctx.getTreeState()).toBe(ctx.getTreeState());
    expect(ctx.getPhaseState().projectId).toBe("p-a");
    expect(ctx.getProjectEpoch).toBeUndefined();
    expect(ctx.native).toBe(native);
    expect(ctx.countTokens("abc")).toBe(3);
    const missing = createMainCodexReadContext({
      db,
      inputs: buildReadInputs({
        projectId: "p-a",
        treeRows: rowsOf(["s1"]),
        project: { phaseResolutionMode: "reading" },
        currentSceneId: "s-archived",
      }),
      countTokens: (text) => text.length,
      native,
    });
    expect(missing.getTreeState().activeSceneId).toBeNull();
  });

  it("two turns do not see each other (module-level state is none)", () => {
    const { client } = dbOver();
    const db = createCoreReadDb(client);
    const make = (projectId: string, scene: string) =>
      createMainCodexReadContext({
        db,
        inputs: buildReadInputs({
          projectId,
          treeRows: rowsOf(["s1", "s2"]),
          project: { phaseResolutionMode: "reading" },
          currentSceneId: scene,
        }),
        countTokens: (text) => text.length,
        native,
      });
    const a = make("p-a", "s1");
    const b = make("p-b", "s2");
    expect(a.getTreeState()).toMatchObject({
      projectId: "p-a",
      activeSceneId: "s1",
    });
    expect(b.getTreeState()).toMatchObject({
      projectId: "p-b",
      activeSceneId: "s2",
    });
    expect(a.getPhaseState().projectId).toBe("p-a");
    expect(b.getPhaseState().projectId).toBe("p-b");
  });
});

describe("createMainCodexEntryContext", () => {
  it("turn の入力と main reader から詳細を解決し、live epoch は持たない", async () => {
    const { client, sqlite } = dbOver();
    sqlite.exec(`
      insert into codex_entries values ('rel', 'p-a', 'base summary', 'hidden', 'base body');
      insert into codex_entry_phases
        (id, entry_id, anchor_node_id, summary_override, content_override, context_mode_override, created_at, updated_at)
        values ('ph-rel', 'rel', 's1', 'phase summary', 'phase body', 'mentioned', '${T}', '${T}');
      insert into codex_detail_values (id, entry_id, definition_id, value)
        values ('v1', 'rel', 'd-value', 'base detail'), ('v2', 'rel', 'd-clear', 'base clear'),
          ('v3', 'rel', 'd-base', 'base only');
      insert into codex_phase_detail_overrides (phase_id, definition_id, value)
        values ('ph-rel', 'd-value', 'phase detail'), ('ph-rel', 'd-clear', null);
    `);
    const db = createCoreReadDb(client);
    const inputs = buildReadInputs({
      projectId: "p-a",
      treeRows: rowsOf(["s1", "s2"]),
      project: { phaseResolutionMode: "reading" },
      currentSceneId: "s2",
    });
    const ctx = createMainCodexEntryContext({
      db,
      inputs,
      countTokens: (text) => text.length,
      extractPlainText: (json) => `text:${json}`,
    });
    expect(ctx.getTreeState()).toEqual({
      projectId: "p-a",
      nodes: [],
      activeSceneId: "s2",
    });
    expect(ctx.getProjectEpoch).toBeUndefined();
    expect(ctx.countTokens("本文")).toBe(2);
    expect(ctx.extractPlainText("{}")).toBe("text:{}");

    const result = await resolveCodexAiVisibilityWithDetails(ctx, {
      projectId: "p-a",
      entryIds: ["rel"],
      sceneId: ctx.getTreeState().activeSceneId,
      withContent: true,
    });
    expect([...result.hidden]).toEqual([]);
    expect(result.texts.get("rel")).toMatchObject({
      summary: "phase summary",
      content: "phase body",
      released: true,
    });
    expect(result.texts.get("rel")?.detailValues?.get("d-value")).toBe(
      "phase detail",
    );
    expect(result.texts.get("rel")?.detailValues?.get("d-clear")).toBeNull();
    expect(result.texts.get("rel")?.detailValues?.get("d-base")).toBe(
      "base only",
    );
  });
});

import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAgentApprovalExchange,
  type AgentApprovalExchangeDependencies,
  type AgentApprovalRequest,
  type AgentApprovalRunHandle,
} from "./agentApprovalExchange.js";
import { AGENT_APPROVAL_PROTECTED_TOOLS } from "./agentApprovalProtectedTools.js";
import { FakeAgentRunApprovalPort } from "./agentRunApprovalPort.fake.js";
import type {
  AgentRunLedgerEntry,
  AgentRunState,
} from "./agentRunRecorderPort.js";
import { createAgentApprovalTargetReader } from "./agentApprovalTargetReader.js";
import type { CoreReadDbClient } from "../shared/mastraRead/ports.js";
import { checkReadSql } from "../shared/mastraRead/sql.js";
import { MAIN_READ_TABLE_SET } from "../shared/mastraRead/tables.js";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function makeDb() {
  const sqlite = new DatabaseSync(":memory:");
  databases.push(sqlite);
  sqlite.exec(`
    CREATE TABLE codex_entries (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
      version INTEGER NOT NULL
    );
    CREATE TABLE foreshadows (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
      version INTEGER NOT NULL
    );
    CREATE TABLE events (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
      version INTEGER NOT NULL
    );
    CREATE TABLE tree_nodes (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
      version INTEGER NOT NULL
    );
    CREATE TABLE scene_events (
      scene_id TEXT NOT NULL, event_id TEXT NOT NULL,
      incarnation_token TEXT NOT NULL, PRIMARY KEY(scene_id, event_id)
    );
    CREATE TABLE event_relations (
      project_id TEXT NOT NULL, cause_event_id TEXT NOT NULL,
      effect_event_id TEXT NOT NULL,
      PRIMARY KEY(cause_event_id, effect_event_id)
    );
  `);
  sqlite.exec(`
    INSERT INTO codex_entries VALUES ('entry-1', 'p1', 'Character', 3);
    INSERT INTO codex_entries VALUES ('entry-other', 'p2', 'Other character', 3);
    INSERT INTO foreshadows VALUES ('foreshadow-1', 'p1', 'Foreshadow', 4);
    INSERT INTO events VALUES ('event-1', 'p1', 'First event', 7);
    INSERT INTO events VALUES ('event-2', 'p1', 'Second event', 8);
    INSERT INTO events VALUES ('event-other', 'p2', 'Other event', 9);
    INSERT INTO tree_nodes VALUES ('scene-1', 'p1', 'Scene one', 5);
    INSERT INTO tree_nodes VALUES ('scene-other', 'p2', 'Other scene', 6);
  `);
  const statements: string[] = [];
  const readDb: CoreReadDbClient = async (sql, params, method) => {
    const checked = checkReadSql(sql, MAIN_READ_TABLE_SET);
    if (!checked.ok) throw new Error(`unchecked SQL: ${checked.code}`);
    if (method !== "all") throw new Error(`unsupported method: ${method}`);
    statements.push(sql);
    const rows = sqlite.prepare(sql).all(...(params as never[]));
    return {
      rows: rows.map((row) => Object.values(row as Record<string, unknown>)),
    };
  };
  return { sqlite, statements, readDb };
}

function inputFor(toolName: string): Record<string, unknown> {
  switch (toolName) {
    case "create_codex_entry":
      return { type: "character", name: "New character" };
    case "update_codex_entry":
      return { id: "entry-1", name: "Changed" };
    case "create_foreshadow":
      return { title: "New foreshadow" };
    case "update_foreshadow":
      return { id: "foreshadow-1", baseVersion: 4 };
    case "create_snippet":
      return { title: "New snippet" };
    case "create_event":
      return { title: "New event" };
    case "update_event":
    case "delete_event":
    case "set_event_participants":
      return { eventId: "event-1", codexEntryIds: [] };
    case "stamp_scene_event":
    case "unstamp_scene_event":
      return { sceneId: "scene-1", eventId: "event-1" };
    case "add_event_relation":
    case "remove_event_relation":
      return { causeEventId: "event-1", effectEventId: "event-2" };
    case "apply_ai_tree_plan":
      return { ops: [{ op: "move", nodeId: "scene-1" }] };
    default:
      throw new Error(`missing test input for ${toolName}`);
  }
}

function requestFor(
  projectId: string,
  toolName: string,
  modelInput: Record<string, unknown>,
) {
  return { projectId, toolName, modelInput };
}

function insertNode(
  sqlite: DatabaseSync,
  id: string,
  title = "Node",
  version = 1,
  projectId = "p1",
): void {
  sqlite
    .prepare(
      "INSERT INTO tree_nodes (id, project_id, title, version) VALUES (?, ?, ?, ?)",
    )
    .run(id, projectId, title, version);
}

describe("createAgentApprovalTargetReader", () => {
  it("reads every protected tool and emits only checked SQL", async () => {
    const db = makeDb();
    const readTarget = createAgentApprovalTargetReader({ readDb: db.readDb });
    expect(AGENT_APPROVAL_PROTECTED_TOOLS.size).toBe(14);
    for (const toolName of AGENT_APPROVAL_PROTECTED_TOOLS) {
      await expect(
        readTarget(requestFor("p1", toolName, inputFor(toolName))),
      ).resolves.not.toBeNull();
    }
    expect(await readTarget(requestFor("p1", "not_protected", {}))).toBeNull();
    expect(db.statements).toHaveLength(10);
    expect(
      db.statements.every((sql) => checkReadSql(sql, MAIN_READ_TABLE_SET).ok),
    ).toBe(true);
  });

  it("returns the same observation twice and changes basis when the target changes", async () => {
    const { sqlite, readDb } = makeDb();
    const readTarget = createAgentApprovalTargetReader({ readDb });
    const read = (toolName: string, input: Record<string, unknown>) =>
      readTarget(requestFor("p1", toolName, input));

    const first = await read("update_codex_entry", { id: "entry-1" });
    expect(await read("update_codex_entry", { id: "entry-1" })).toEqual(first);
    sqlite.exec("UPDATE codex_entries SET version = 4 WHERE id = 'entry-1'");
    expect(
      (await read("update_codex_entry", { id: "entry-1" }))?.basis,
    ).not.toEqual(first?.basis);

    const linkAbsent = await read("stamp_scene_event", {
      sceneId: "scene-1",
      eventId: "event-1",
    });
    sqlite.exec("INSERT INTO scene_events VALUES ('scene-1', 'event-1', '')");
    const linkPresent = await read("stamp_scene_event", {
      sceneId: "scene-1",
      eventId: "event-1",
    });
    expect(linkPresent?.expected).toMatchObject({
      kind: "scene_event_link",
      linkIncarnation: "",
    });
    expect(linkPresent?.basis).not.toEqual(linkAbsent?.basis);
    // 付け直し（有無と版は同じで識別子だけが違う）も basis に出る。再起動後の出し直しが照らす。
    sqlite.exec("UPDATE scene_events SET incarnation_token = 'relinked'");
    const relinked = await read("stamp_scene_event", {
      sceneId: "scene-1",
      eventId: "event-1",
    });
    expect(relinked?.basis).not.toEqual(linkPresent?.basis);
    sqlite.exec("UPDATE scene_events SET incarnation_token = ''");
    sqlite.exec("UPDATE events SET version = 8 WHERE id = 'event-1'");
    const linkVersionChanged = await read("stamp_scene_event", {
      sceneId: "scene-1",
      eventId: "event-1",
    });
    expect(linkVersionChanged?.basis).not.toEqual(linkPresent?.basis);
    sqlite.exec("UPDATE events SET version = 7 WHERE id = 'event-1'");
    sqlite.exec(
      "DELETE FROM scene_events WHERE scene_id = 'scene-1' AND event_id = 'event-1'",
    );
    const linkRemoved = await read("stamp_scene_event", {
      sceneId: "scene-1",
      eventId: "event-1",
    });
    expect(linkRemoved?.expected).toMatchObject({
      kind: "scene_event_link",
      linkIncarnation: null,
    });
    expect(linkRemoved?.basis).toEqual(linkAbsent?.basis);

    const relationAbsent = await read("add_event_relation", {
      causeEventId: "event-1",
      effectEventId: "event-2",
    });
    sqlite.exec(
      "INSERT INTO event_relations VALUES ('p1', 'event-1', 'event-2')",
    );
    const relationPresent = await read("add_event_relation", {
      causeEventId: "event-1",
      effectEventId: "event-2",
    });
    expect(relationPresent?.expected).toMatchObject({
      kind: "event_relation",
      related: true,
    });
    expect(relationPresent?.basis).not.toEqual(relationAbsent?.basis);
    sqlite.exec("UPDATE events SET version = 9 WHERE id = 'event-2'");
    const relationVersionChanged = await read("add_event_relation", {
      causeEventId: "event-1",
      effectEventId: "event-2",
    });
    expect(relationVersionChanged?.basis).not.toEqual(relationPresent?.basis);
    sqlite.exec("UPDATE events SET version = 8 WHERE id = 'event-2'");
    sqlite.exec(
      "DELETE FROM event_relations WHERE cause_event_id = 'event-1' AND effect_event_id = 'event-2'",
    );
    expect(
      (
        await read("add_event_relation", {
          causeEventId: "event-1",
          effectEventId: "event-2",
        })
      )?.basis,
    ).toEqual(relationAbsent?.basis);

    const treeBefore = await read("apply_ai_tree_plan", {
      ops: [{ op: "move", nodeId: "scene-1" }],
    });
    sqlite.exec("UPDATE tree_nodes SET version = 6 WHERE id = 'scene-1'");
    const treeAfter = await read("apply_ai_tree_plan", {
      ops: [{ op: "move", nodeId: "scene-1" }],
    });
    expect(treeAfter?.basis).not.toEqual(treeBefore?.basis);
  });

  it("rejects cross-project, missing, unsafe-version, and oversized-id targets", async () => {
    const { sqlite, readDb } = makeDb();
    const readTarget = createAgentApprovalTargetReader({ readDb });
    await expect(
      readTarget(requestFor("p1", "update_codex_entry", { id: "entry-other" })),
    ).resolves.toBeNull();
    await expect(
      readTarget(requestFor("p2", "update_codex_entry", { id: "entry-1" })),
    ).resolves.toBeNull();
    await expect(
      readTarget(requestFor("p1", "update_event", { eventId: "missing" })),
    ).resolves.toBeNull();
    await expect(
      readTarget(requestFor("p1", "update_event", { eventId: "event-other" })),
    ).resolves.toBeNull();
    await expect(
      readTarget(
        requestFor("p1", "update_codex_entry", { id: "x".repeat(257) }),
      ),
    ).resolves.toBeNull();
    await expect(
      readTarget(
        requestFor("p1", "update_codex_entry", { id: "é".repeat(129) }),
      ),
    ).resolves.toBeNull();
    sqlite.exec(
      "UPDATE events SET version = 9007199254740992 WHERE id = 'event-1'",
    );
    await expect(
      readTarget(requestFor("p1", "update_event", { eventId: "event-1" })),
    ).resolves.toBeNull();
  });

  it("requires both scene and event ends to belong to the requested project", async () => {
    const { readDb } = makeDb();
    const readTarget = createAgentApprovalTargetReader({ readDb });
    await expect(
      readTarget(
        requestFor("p1", "stamp_scene_event", {
          sceneId: "scene-1",
          eventId: "event-other",
        }),
      ),
    ).resolves.toBeNull();
    await expect(
      readTarget(
        requestFor("p1", "add_event_relation", {
          causeEventId: "event-1",
          effectEventId: "event-other",
        }),
      ),
    ).resolves.toBeNull();
    await expect(
      readTarget(
        requestFor("p1", "add_event_relation", {
          causeEventId: "event-1",
          effectEventId: "event-1",
        }),
      ),
    ).resolves.toBeNull();
  });

  it("keeps create-only tree plans empty and requires every changed node", async () => {
    const { readDb } = makeDb();
    const readTarget = createAgentApprovalTargetReader({ readDb });
    await expect(
      readTarget(
        requestFor("p1", "apply_ai_tree_plan", {
          ops: [{ op: "create", tempId: "tmp:1" }],
        }),
      ),
    ).resolves.toMatchObject({
      basis: null,
      baseVersions: null,
      expected: null,
    });
    await expect(
      readTarget(
        requestFor("p1", "apply_ai_tree_plan", {
          ops: [{ op: "move", nodeId: "missing-node" }],
        }),
      ),
    ).resolves.toBeNull();
    const tooMany = Array.from({ length: 2001 }, (_, i) => ({
      op: "rename",
      nodeId: `node-${i}`,
    }));
    await expect(
      readTarget(requestFor("p1", "apply_ai_tree_plan", { ops: tooMany })),
    ).resolves.toBeNull();
  });

  it("collapses tree basis at 65 rows and when 64 rows exceed 32 KiB", async () => {
    const { sqlite, readDb } = makeDb();
    const readTarget = createAgentApprovalTargetReader({ readDb });
    const ids65 = Array.from({ length: 65 }, (_, i) => `node-${i}`);
    for (const id of ids65) insertNode(sqlite, id);
    const target65 = await readTarget(
      requestFor("p1", "apply_ai_tree_plan", {
        ops: ids65.map((nodeId) => ({ op: "move", nodeId })),
      }),
    );
    expect(target65?.basis).toHaveLength(1);
    expect(target65?.basis?.[0]?.sourceKind).toBe("tree_node_set");
    expect(target65?.baseVersions).toHaveLength(65);

    const longIds = Array.from(
      { length: 64 },
      (_, i) => `${"\\".repeat(250)}${String(i).padStart(6, "0")}`,
    );
    expect(
      new TextEncoder().encode(
        JSON.stringify(
          longIds.map((id) => ({
            sourceKind: "tree_node",
            sourceId: id,
            version: "1",
          })),
        ),
      ).byteLength,
    ).toBeGreaterThan(32 * 1024);
    for (const id of longIds) insertNode(sqlite, id);
    const target32k = await readTarget(
      requestFor("p1", "apply_ai_tree_plan", {
        ops: longIds.map((nodeId) => ({ op: "rename", nodeId })),
      }),
    );
    expect(target32k?.basis).toHaveLength(1);
    expect(target32k?.basis?.[0]?.sourceKind).toBe("tree_node_set");
    expect(target32k?.baseVersions).toHaveLength(64);
  });

  it("never puts a stored name into the target of any tool", async () => {
    const { sqlite, readDb } = makeDb();
    sqlite.exec(`
      UPDATE codex_entries SET name = 'zz-stored-name';
      UPDATE foreshadows SET title = 'zz-stored-name';
      UPDATE events SET title = 'zz-stored-name';
      UPDATE tree_nodes SET title = 'zz-stored-name';
    `);
    const readTarget = createAgentApprovalTargetReader({ readDb });
    for (const toolName of AGENT_APPROVAL_PROTECTED_TOOLS) {
      const result = await readTarget(
        requestFor("p1", toolName, inputFor(toolName)),
      );
      expect(result, toolName).not.toBeNull();
      expect(JSON.stringify(result), toolName).not.toContain("zz-stored-name");
    }
  });

  it("bounds summaries with many escaped node ids", async () => {
    const { sqlite, readDb } = makeDb();
    const readTarget = createAgentApprovalTargetReader({ readDb });
    const ids = Array.from(
      { length: 60 },
      (_, i) => `${"\u0001".repeat(250)}${String(i).padStart(6, "0")}`,
    );
    for (const id of ids) insertNode(sqlite, id);
    const result = await readTarget(
      requestFor("p1", "apply_ai_tree_plan", {
        ops: ids.map((nodeId) => ({ op: "move", nodeId })),
      }),
    );
    expect(result).not.toBeNull();
    expect(
      new TextEncoder().encode(result!.summary).byteLength,
    ).toBeLessThanOrEqual(64 * 1024);
    const parsed = JSON.parse(result!.summary) as {
      count: number;
      targets: { kind: string; id: string }[];
      omitted: number;
    };
    expect(parsed.count).toBe(60);
    expect(parsed.targets.length).toBeLessThanOrEqual(50);
    expect(parsed.targets.length + parsed.omitted).toBe(60);
    expect(Object.keys(parsed.targets[0]!)).toEqual(["kind", "id"]);
  });

  it("passes the same reader observation through the real exchange to pending for all 14 tools", async () => {
    const { readDb } = makeDb();
    const readTarget = createAgentApprovalTargetReader({ readDb });
    for (const toolName of AGENT_APPROVAL_PROTECTED_TOOLS) {
      const modelInput = inputFor(toolName);
      const target = await readTarget(requestFor("p1", toolName, modelInput));
      expect(target).not.toBeNull();
      const observed = {
        basis: target!.basis,
        baseVersions: target!.baseVersions,
        expected: target!.expected,
      };
      const runId = `run-${toolName}`;
      const callId = `call-${toolName}`;
      const interactionId = `interaction-${toolName}`;
      const port = new FakeAgentRunApprovalPort();
      let version = port.createRunningRun(runId).version;
      const run: AgentApprovalRunHandle = {
        runId,
        async transact<T extends AgentRunState>(
          op: (version: number) => Promise<T>,
        ): Promise<T> {
          const state = await op(version);
          version = state.version;
          return state;
        },
      };
      const controller = new AbortController();
      const request: AgentApprovalRequest = {
        senderId: 11,
        projectId: "p1",
        executionId: `execution-${toolName}`,
        chatMessageId: `message-${toolName}`,
        toolCallId: callId,
        toolName,
        model: "test-model",
        modelInput,
        observed,
        run,
        signal: controller.signal,
      };
      const entry: AgentRunLedgerEntry = {
        toolCallId: callId,
        name: toolName,
        canonicalArgs: modelInput,
        argsDigest: "digest",
        executionId: request.executionId,
        chatMessageId: request.chatMessageId,
        mainOwnedProvenanceId: "",
        model: "test-model",
        capabilityState: "not_issued",
        executionState: "pending",
      };
      await port.appendToolCalls(runId, [entry]);
      let pendingSeen = false;
      const dependencies: AgentApprovalExchangeDependencies<{
        readonly mainOwnedProvenanceId: string;
      }> = {
        port,
        isPolicyAllowed: () => true,
        inputDigest: () => "digest",
        readTarget,
        prepareCapability: () => null,
        onPending: () => {
          pendingSeen = true;
        },
        setTimer: () => () => undefined,
        newId: () => interactionId,
      };
      const exchange = createAgentApprovalExchange(dependencies);
      const completion = exchange.request(request);
      await vi.waitFor(() => expect(pendingSeen).toBe(true));
      expect(port.readInteraction(interactionId)?.status).toBe("pending");
      expect(
        port.readToolCall(runId, {
          executionId: request.executionId,
          toolCallId: callId,
        }),
      ).toMatchObject({
        capabilityState: "awaiting_approval",
        executionState: "pending",
      });
      controller.abort();
      await expect(completion).resolves.toMatchObject({ kind: "aborted" });
    }
  });
});

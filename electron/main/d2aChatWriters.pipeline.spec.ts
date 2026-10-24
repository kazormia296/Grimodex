// NIR-1 DA-2b ST4-A (K3/2 Positive (8), Negative (27), the M and T rules;
// DR-DA2-50..53): the nine typed Native writers through the real router, the
// real profile gate and the real Native addon.
//
// * Unrestricted and restricted (after an activation through Main's product
//   path) give the same results for the same calls (D-11 (a)).
// * Restricted keeps the generic-SQL DML these writers replace closed, while
//   the RETURNING-free DML on tables outside the ledger (Map, Label, Prompt
//   template, the pin's children) passes (D-12 (a), DR-DA2-52).
// * The CW entries need the issued identity and the open workspace; an
//   unterminated generation attempt refuses every deletion.
// * During an activation in flight and while unavailable the route stays
//   `internal`; what Native answers is pinned below.
//
// The real addon is needed, so only `vitest.electron-native.config.ts` runs it.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import type { Envelope, NapiBackendLike } from "../shared/ipcContract.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.0-test",
    getPath: () => os.tmpdir(),
    getGPUFeatureStatus: () => ({}),
  },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
    getAllWindows: () => [],
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    },
    on: vi.fn(),
  },
}));
vi.mock("./windows.js", () => ({
  focusPanelWindow: () => false,
  hasPanelWindow: () => false,
  openPanelWindow: () => undefined,
}));

const ROOT = path.resolve(__dirname, "..", "..");
const ADDON = path.join(
  ROOT,
  "electron",
  "native",
  "grimodex-node",
  "grimodex-node.node",
);
const require = createRequire(import.meta.url);
type NativeBackendInstance = NapiBackendLike & Record<string, any>;
const { Backend: NativeBackend } = require(ADDON) as {
  Backend: new (appData: string) => NativeBackendInstance;
};
const backends: NativeBackendInstance[] = [];
const roots: string[] = [];

/**
 * `open_workspace` spawns the detached workspace maintenance worker; join it
 * through the Native lifecycle shutdown before deleting the fixture.
 */
afterAll(async () => {
  for (const backend of backends) {
    const wire = await backend.shutdownWorkspaceLifecycle!();
    expect(JSON.parse(wire).status).toBe("closed");
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const MARKER = "D2A_EGRESS_DENIED";

interface Rig {
  route: (cmd: string, args?: Record<string, unknown>) => Promise<Envelope>;
  gate: Awaited<
    ReturnType<(typeof import("./profileEgress.js"))["createProfileEgressGate"]>
  >;
  native: NativeBackendInstance;
  activate: () => Promise<void>;
}

async function startMain(
  appData: string,
  options: {
    holdActivation?: Promise<void>;
    unavailable?: boolean;
  } = {},
): Promise<Rig> {
  vi.resetModules();
  mocks.handlers.clear();
  const backend = new NativeBackend(appData);
  backends.push(backend);
  const proxied = new Proxy(backend, {
    get(target, property) {
      if (options.unavailable && property === "initializeProfileEgress") {
        return undefined;
      }
      if (options.holdActivation && property === "profileActivationCommit") {
        return async () => {
          await options.holdActivation;
          return target.profileActivationCommit!();
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const { createProfileEgressGate } = await import("./profileEgress.js");
  const { activateThroughMain } =
    await import("./profileActivation.test.support.js");
  const { registerEventBus } = await import("./events.js");
  const { registerIpcRouter } = await import("./ipc.js");
  const { IPC } = await import("../shared/ipcContract.js");

  const gate = await createProfileEgressGate(proxied as NapiBackendLike);
  registerEventBus(proxied as NapiBackendLike, undefined, gate);
  registerIpcRouter(
    proxied as NapiBackendLike,
    {} as never,
    undefined,
    undefined,
    { active: false } as never,
    gate,
  );
  const handler = mocks.handlers.get(IPC.invoke) as (
    event: unknown,
    cmd: unknown,
    args: unknown,
  ) => Promise<Envelope>;
  const event = {
    sender: { id: 7, isDestroyed: () => false, once: () => undefined },
  };
  return {
    gate,
    native: backend,
    activate: async () => {
      expect(
        await activateThroughMain(proxied as NapiBackendLike, gate),
      ).toEqual({ status: "activated" });
    },
    route: (cmd, args) => handler(event, cmd, args ?? {}),
  };
}

function newAppData(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "grimodex-d2b-writers-"));
  roots.push(root);
  const appData = path.join(realpathSync(root), "app-data");
  mkdirSync(appData, { recursive: true });
  return appData;
}

function ok<T>(envelope: Envelope): T {
  if (!envelope.ok) throw new Error(`expected ok, got: ${envelope.error}`);
  return envelope.value as T;
}

/** The rows of a `db_execute` read (`{ rows }`). */
function dbRows<T = unknown>(envelope: Envelope): T[] {
  return ok<{ rows: T[] }>(envelope).rows;
}

function failureOf(envelope: Envelope): string {
  expect(envelope.ok).toBe(false);
  return envelope.ok ? "" : envelope.error;
}

interface Workspace {
  path: string;
  projectId: string;
  sceneId: string;
  codexId: string;
}

const BASELINE_STORED =
  '{"allPhaseIds":["a"],"restrictedPhaseIds":[],"visibilityProvenanceVersion":1}';
const BASELINE_NEXT =
  '{"allPhaseIds":["a"],"restrictedPhaseIds":["a"],"visibilityProvenanceVersion":1,"visibleDeletedPhaseIds":[]}';

/** The renderer's `stableHash` (impactBaselineVisibility.ts). */
function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Sample workspace + chat, baseline, snapshot and Map rows, written while unrestricted. */
async function seedWorkspace(rig: Rig): Promise<Workspace> {
  const seeded = ok<{ path: string; projectId: string }>(
    await rig.route("seed_sample_workspace", {
      language: "ja",
      aiPolicy: '{"preset":"full"}',
    }),
  );
  ok(await rig.route("open_workspace", { path: seeded.path }));
  const run = async (sql: string, params: unknown[] = []) =>
    ok(await rig.route("db_execute", { sql, params, method: "run" }));
  const one = async (sql: string, params: unknown[]): Promise<string> => {
    const [row] = dbRows<Record<string, string>>(
      await rig.route("db_execute", { sql, params, method: "all" }),
    );
    return Object.values(row)[0];
  };
  const projectId = seeded.projectId;
  const sceneId = await one(
    "SELECT id FROM tree_nodes WHERE project_id = ? AND node_type = 'scene' ORDER BY id LIMIT 1",
    [projectId],
  );
  const codexId = await one(
    "SELECT id FROM codex_entries WHERE project_id = ? ORDER BY id LIMIT 1",
    [projectId],
  );
  for (const id of ["cw-a", "cw-b", "cw-c"]) {
    await run(
      "INSERT INTO chat_sessions(id, project_id, title) VALUES (?, ?, ?)",
      [id, projectId, `session ${id}`],
    );
  }
  for (const [id, session, role, metadata] of [
    ["cw-m1", "cw-a", "user", null],
    ["cw-m2", "cw-a", "assistant", '{"thinking_blocks":[{"t":1}],"k":"v"}'],
    ["cw-m3", "cw-b", "user", null],
    ["cw-m4", "cw-c", "user", null],
  ] as const) {
    await run(
      "INSERT INTO chat_messages(id, session_id, role, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [id, session, role, `本文 ${id}`, metadata, "2026-10-24T00:00:00.000Z"],
    );
  }
  await run(
    "INSERT INTO chat_session_pinned_codex(id, session_id, codex_entry_id) VALUES ('cw-pin', 'cw-c', ?)",
    [codexId],
  );
  await run(
    "INSERT INTO impact_review_baselines(entry_id, project_id, snapshot_json, content_hash) VALUES (?, ?, ?, ?)",
    [codexId, projectId, BASELINE_STORED, stableHash(BASELINE_STORED)],
  );
  await run(
    "INSERT INTO project_snapshots(id, project_id, name) VALUES ('cw-snap', ?, 'snap')",
    [projectId],
  );
  await run(
    "INSERT INTO project_snapshot_aux(snapshot_id, scope, payload_json) VALUES ('cw-snap', 'labels', '[]')",
  );
  await run("INSERT INTO map_boards(id, project_id) VALUES ('cw-board', ?)", [
    projectId,
  ]);
  return { path: seeded.path, projectId, sceneId, codexId };
}

/** The writer calls in order, with their results and the rows they leave. */
async function runWriters(rig: Rig, ws: Workspace): Promise<unknown[]> {
  const call = async (cmd: string, payload: Record<string, unknown>) =>
    ok<Record<string, unknown>>(await rig.route(cmd, { payload }));
  const cw = (extra: Record<string, unknown>) => ({
    expectedWorkspacePath: ws.path,
    projectId: ws.projectId,
    ...extra,
  });
  const rows = async (sql: string, params: unknown[]) =>
    dbRows(await rig.route("db_execute", { sql, params, method: "all" }));
  const outcomes: unknown[] = [];
  const revision = (content: string) =>
    call("revision_create", {
      projectId: ws.projectId,
      entityType: "scene",
      entityId: ws.sceneId,
      content,
      snapshotType: "auto",
    });
  for (const content of ['{"a":1}', '{"a":1}', '{"a":2}']) {
    const { created, versionNumber, id, createdAt } = await revision(content);
    expect(typeof id).toBe("string");
    expect(typeof createdAt).toBe("string");
    outcomes.push({ created, versionNumber });
  }
  outcomes.push(
    await call("revision_prune", {
      projectId: ws.projectId,
      entityType: "scene",
      entityId: ws.sceneId,
      keepCount: 1,
    }),
  );
  outcomes.push(
    await rows(
      "SELECT version_number, snapshot_type FROM content_versions WHERE entity_id = ? ORDER BY version_number",
      [ws.sceneId],
    ),
  );
  outcomes.push(
    await call("chat_session_rename", cw({ sessionId: "cw-a", title: "改名" })),
  );
  outcomes.push(
    await call(
      "chat_message_metadata_record",
      cw({ messageId: "cw-m2", patch: { extractedCodex: [ws.codexId] } }),
    ),
  );
  outcomes.push(
    await call(
      "chat_messages_delete",
      cw({ sessionId: "cw-a", messageIds: ["cw-m1"] }),
    ),
  );
  outcomes.push(await call("chat_session_delete", cw({ sessionId: "cw-b" })));
  outcomes.push(
    await rows(
      "SELECT s.id, s.title, s.title_manual, m.id AS message, m.metadata FROM chat_sessions s LEFT JOIN chat_messages m ON m.session_id = s.id WHERE s.id LIKE 'cw-%' ORDER BY s.id, m.id",
      [],
    ),
  );
  outcomes.push(
    await call("impact_review_baseline_update_visibility", {
      projectId: ws.projectId,
      entryId: ws.codexId,
      expectedContentHash: stableHash(BASELINE_STORED),
      snapshotJson: BASELINE_NEXT,
      contentHash: stableHash(BASELINE_NEXT),
    }),
  );
  outcomes.push(
    await rows(
      "SELECT snapshot_json, content_hash FROM impact_review_baselines WHERE entry_id = ?",
      [ws.codexId],
    ),
  );
  outcomes.push(
    await call("project_snapshot_delete", {
      projectId: ws.projectId,
      snapshotId: "cw-snap",
    }),
  );
  outcomes.push(
    await rows(
      "SELECT (SELECT count(*) FROM project_snapshots WHERE id = 'cw-snap') AS snapshots, (SELECT count(*) FROM project_snapshot_aux WHERE snapshot_id = 'cw-snap') AS aux",
      [],
    ),
  );
  outcomes.push(await call("chat_project_history_clear", cw({})));
  outcomes.push(
    await rows(
      "SELECT count(*) AS sessions FROM chat_sessions WHERE project_id = ?",
      [ws.projectId],
    ),
  );
  return outcomes;
}

/** Insert an unterminated attempt from a separate process (a closed table). */
function insertPendingAttempt(ws: Workspace, sessionId: string): void {
  const script = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("PRAGMA busy_timeout = 10000");
db.prepare("INSERT INTO nir1_generation_attempts (id, project_id, session_id, binding_json, payload_digest, input_digest, created_at_ms, expires_at_ms) VALUES ('cw-pending', ?, ?, '{}', 'pd', 'id', 1, 2)").run(process.argv[2], process.argv[3]);
db.close();
`;
  execFileSync(
    process.execPath,
    [
      "--no-warnings",
      "-e",
      script,
      path.join(ws.path, "grimodex.db"),
      ws.projectId,
      sessionId,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
}

describe("DA-2b typed writers through the real router, gate and Native", () => {
  it("unrestricted and restricted give the same results (D-11 (a))", async () => {
    const results: Record<string, unknown[]> = {};
    for (const mode of ["unrestricted", "restricted"] as const) {
      const rig = await startMain(newAppData());
      const ws = await seedWorkspace(rig);
      if (mode === "restricted") {
        await rig.activate();
        expect(rig.gate.restricted).toBe(true);
      } else {
        expect(rig.gate.restricted).toBe(false);
      }
      results[mode] = await runWriters(rig, ws);
    }
    expect(results.restricted).toEqual(results.unrestricted);
    // Sanity: the writers did their work.
    // The sample scene already has versions: the new one is the next number.
    const [first, same, next, pruned] = results.unrestricted as Array<
      Record<string, unknown>
    >;
    expect(first.created).toBe(true);
    expect(same).toEqual({ created: false, versionNumber: first.versionNumber });
    expect(next).toEqual({
      created: true,
      versionNumber: (first.versionNumber as number) + 1,
    });
    expect((pruned.deleted as number) >= 1).toBe(true);
    // The sample's own sessions and the two left of the seeded three.
    const cleared = results.unrestricted.at(-2) as { deletedSessions: number };
    expect(cleared.deletedSessions >= 2).toBe(true);
    expect(results.unrestricted.at(-1)).toEqual([{ sessions: 0 }]);
  });

  it("restricted keeps the replaced generic DML closed and RETURNING-free DML outside the ledger open", async () => {
    const rig = await startMain(newAppData());
    const ws = await seedWorkspace(rig);
    await rig.activate();
    const sql = (statement: string, params: unknown[] = []) =>
      rig.route("db_execute", { sql: statement, params, method: "run" });
    for (const [statement, params] of [
      ["DELETE FROM chat_messages WHERE id = ?", ["cw-m1"]],
      ["DELETE FROM chat_sessions WHERE id = ?", ["cw-b"]],
      ["DELETE FROM chat_sessions WHERE project_id = ?", [ws.projectId]],
      [
        "UPDATE chat_sessions SET title = 'x', title_manual = 1 WHERE id = ?",
        ["cw-a"],
      ],
      ["UPDATE chat_messages SET metadata = '{}' WHERE id = ?", ["cw-m2"]],
      [
        "INSERT INTO content_versions(id, entity_type, entity_id, content, version_number) VALUES ('g', 'scene', ?, '{}', 9)",
        [ws.sceneId],
      ],
      ["DELETE FROM project_snapshots WHERE id = ?", ["cw-snap"]],
      [
        "UPDATE impact_review_baselines SET snapshot_json = '{}' WHERE entry_id = ?",
        [ws.codexId],
      ],
      [
        "INSERT INTO map_stickies(id, board_id, body) VALUES ('r', 'cw-board', '{}') RETURNING id",
        [],
      ],
      [
        "UPDATE chat_session_pinned_codex SET with_children = 1 WHERE id = 'cw-pin' RETURNING id",
        [],
      ],
    ] as const) {
      expect(failureOf(await sql(statement, [...params])), statement).toContain(
        MARKER,
      );
    }
    // Map (a sticky whose FK parent is a chat message), Label, Prompt
    // template and the pin's children: no RETURNING, then a re-read.
    for (const [statement, params] of [
      [
        "INSERT INTO map_stickies(id, board_id, body, source_chat_message_id) VALUES ('cw-sticky', 'cw-board', '{}', 'cw-m2')",
        [],
      ],
      ["UPDATE map_stickies SET title = 't' WHERE id = 'cw-sticky'", []],
      [
        "UPDATE chat_session_pinned_codex SET with_children = 1 WHERE id = 'cw-pin'",
        [],
      ],
      [
        "INSERT INTO labels(id, project_id, name, color) VALUES ('cw-label', ?, 'L', '#fff')",
        [ws.projectId],
      ],
      ["UPDATE labels SET name = 'L2' WHERE id = 'cw-label'", []],
      [
        "INSERT INTO prompt_templates(id, project_id, title, content) VALUES ('cw-prompt', ?, 't', 'c')",
        [ws.projectId],
      ],
      [
        "UPDATE prompt_templates SET usage_count = usage_count + 1 WHERE id = 'cw-prompt'",
        [],
      ],
      ["DELETE FROM map_stickies WHERE id = 'cw-sticky'", []],
    ] as const) {
      ok(await sql(statement, [...params]));
    }
    const reread = dbRows(
      await rig.route("db_execute", {
        sql: "SELECT (SELECT name FROM labels WHERE id = 'cw-label') AS label, (SELECT usage_count FROM prompt_templates WHERE id = 'cw-prompt') AS uses, (SELECT with_children FROM chat_session_pinned_codex WHERE id = 'cw-pin') AS children",
        params: [],
        method: "all",
      }),
    );
    expect(reread).toEqual([{ label: "L2", uses: 1, children: 1 }]);
    // The refused statements changed nothing.
    const unchanged = dbRows(
      await rig.route("db_execute", {
        sql: "SELECT (SELECT count(*) FROM chat_messages WHERE id LIKE 'cw-%') AS messages, (SELECT count(*) FROM project_snapshots WHERE id = 'cw-snap') AS snapshots, (SELECT content_hash FROM impact_review_baselines WHERE entry_id = ?) AS hash",
        params: [ws.codexId],
        method: "all",
      }),
    );
    expect(unchanged).toEqual([
      { messages: 4, snapshots: 1, hash: stableHash(BASELINE_STORED) },
    ]);
  });

  it("CW needs the issued identity and the open workspace while restricted", async () => {
    const rig = await startMain(newAppData());
    const ws = await seedWorkspace(rig);
    await rig.activate();
    const payload = {
      expectedWorkspacePath: ws.path,
      projectId: ws.projectId,
      sessionId: "cw-b",
    };
    // Straight into Native without Main's identity: refused, nothing deleted.
    await expect(rig.native.chatSessionDelete(payload)).rejects.toThrow(MARKER);
    // Another existing directory is not the open workspace.
    expect(
      failureOf(
        await rig.route("chat_session_delete", {
          payload: { ...payload, expectedWorkspacePath: os.tmpdir() },
        }),
      ),
    ).toBe("CHAT_WRITE_REFUSED:workspace-mismatch");
    // A session of the project, but a foreign project id.
    expect(
      failureOf(
        await rig.route("chat_session_delete", {
          payload: { ...payload, projectId: "another-project" },
        }),
      ),
    ).toBe("CHAT_WRITE_REFUSED:scope-mismatch");
    // A key outside the three record keys.
    expect(
      failureOf(
        await rig.route("chat_message_metadata_record", {
          payload: {
            expectedWorkspacePath: ws.path,
            projectId: ws.projectId,
            messageId: "cw-m2",
            patch: { thinking_blocks: [] },
          },
        }),
      ),
    ).toMatch(/^CHAT_WRITE_REFUSED:metadata-key-not-allowed/);
    expect(ok(await rig.route("chat_session_delete", { payload }))).toEqual({
      deleted: 1,
    });
  });

  it("an unterminated generation attempt refuses every deletion and deletes nothing", async () => {
    const rig = await startMain(newAppData());
    const ws = await seedWorkspace(rig);
    await rig.activate();
    insertPendingAttempt(ws, "cw-a");
    const cw = (extra: Record<string, unknown>) => ({
      payload: {
        expectedWorkspacePath: ws.path,
        projectId: ws.projectId,
        ...extra,
      },
    });
    for (const [cmd, extra] of [
      ["chat_messages_delete", { sessionId: "cw-a", messageIds: ["cw-m1"] }],
      ["chat_session_delete", { sessionId: "cw-a" }],
      ["chat_project_history_clear", {}],
    ] as const) {
      expect(failureOf(await rig.route(cmd, cw(extra))), cmd).toBe(
        "CHAT_WRITE_REFUSED:generation-pending",
      );
    }
    // Rename and the record still work; another session can be deleted.
    expect(
      ok(
        await rig.route(
          "chat_session_rename",
          cw({ sessionId: "cw-a", title: "t" }),
        ),
      ),
    ).toEqual({ updated: 1 });
    expect(
      ok(
        await rig.route(
          "chat_message_metadata_record",
          cw({ messageId: "cw-m1", patch: { insertedToEditor: true } }),
        ),
      ),
    ).toEqual({ updated: 1 });
    expect(
      ok(await rig.route("chat_session_delete", cw({ sessionId: "cw-b" }))),
    ).toEqual({ deleted: 1 });
    const left = dbRows(
      await rig.route("db_execute", {
        sql: "SELECT id FROM chat_messages WHERE session_id = 'cw-a' ORDER BY id",
        params: [],
        method: "all",
      }),
    );
    expect(left).toEqual([{ id: "cw-m1" }, { id: "cw-m2" }]);
  });

  it("while an activation is in flight and while unavailable the route stays internal", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rig = await startMain(newAppData(), { holdActivation: held });
    const ws = await seedWorkspace(rig);
    const activation = rig.activate();
    await vi.waitFor(() => expect(rig.gate.activating).toBe(true));
    // Stages 2 and 3 are done, stage 4 is held: Native is still
    // unrestricted, so the internal writers answer with counts only.
    expect(
      ok(
        await rig.route("chat_session_rename", {
          payload: {
            expectedWorkspacePath: ws.path,
            projectId: ws.projectId,
            sessionId: "cw-a",
            title: "途中",
          },
        }),
      ),
    ).toEqual({ updated: 1 });
    expect(
      ok(
        await rig.route("project_snapshot_delete", {
          payload: { projectId: ws.projectId, snapshotId: "cw-snap" },
        }),
      ),
    ).toEqual({ deleted: 1 });
    release();
    await activation;
    expect(rig.gate.restricted).toBe(true);

    // An unavailable gate (startup could not build it): Main still routes the
    // writers as internal; with no workspace open Native refuses them without
    // a D2a reason and writes nothing.
    const unavailable = await startMain(newAppData(), { unavailable: true });
    expect(unavailable.gate.unavailable).toBe(true);
    const refusal = failureOf(
      await unavailable.route("revision_create", {
        payload: {
          projectId: "p",
          entityType: "scene",
          entityId: "s",
          content: "{}",
          snapshotType: "auto",
        },
      }),
    );
    expect(refusal).not.toContain(MARKER);
    expect(refusal).toContain("No workspace is open");
  });
});

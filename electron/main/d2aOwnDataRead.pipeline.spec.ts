// NIR-1 DA-1 ST3 (K3/2 Positive (1) の表示、Negative (2)(3)(18)〜(22)):
// own-data-read を、実 router + 実 gate + 実 Native を通して固定する。
//
// 開放（D2A_OWN_DATA_READ_OPEN と grimodex-db の PROFILE_EGRESS_READ_OPEN_ENABLED）
// の状態で期待値を選ぶ。
//   - 開いている（現在。DR-DA1-35 の開放 commit で true にした）: restricted で
//     unrestricted と同じ内容が返り、各 command の呼出しの前後で保存データの
//     digest は変わらず、credential は返らず、DML / closed の表 / 台帳にない
//     書込みは拒否される。
//   - 閉じている（定数を false に戻した場合の分岐）: restricted の own-data-read は
//     plaintext-publication と同じく invoke の時点で拒否され、Native も
//     read-open の読取を拒否する。
//
// 実 Native の addon が要るので `vitest.electron-native.config.ts` だけが拾う。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import type { Envelope, NapiBackendLike } from "../shared/ipcContract.js";
import {
  NATIVE_CLOSED_TABLES,
  NATIVE_READ_OPEN_COLUMNS,
  NATIVE_READ_OPEN_TABLES,
} from "./d2aSqlPolicyFixture.js";

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
/** Every Backend a test makes, so afterAll can prove Closed before deleting. */
const backends: NativeBackendInstance[] = [];
/**
 * Backends standing for a process that has exited: a later Backend in this
 * test process opened the same workspace. The maintenance path fence is
 * process-wide and a shut-down Backend keeps its exclusive fence until the
 * fixture is deleted, so shutting down both would leave the second one waiting
 * forever (a real Main has one Backend). The later Backend's shutdown fences
 * the shared path and waits for any worker on it, including this one's.
 */
const exited = new Set<NativeBackendInstance>();
function newBackend(appData: string): NativeBackendInstance {
  const backend = new NativeBackend(appData);
  backends.push(backend);
  return backend;
}

/**
 * `open_workspace` spawns the detached workspace maintenance worker (auto
 * backup: `backups/*.db.gz.sqlite.tmp` -> `*.db.gz`). Deleting the root while
 * it still writes fails with ENOTEMPTY (seen on hosted CI), so join it through
 * the Native lifecycle shutdown, the same as the native node tests.
 */
async function closeBackends(): Promise<void> {
  for (const backend of backends) {
    if (exited.has(backend)) continue;
    const wire = await backend.shutdownWorkspaceLifecycle!();
    expect(JSON.parse(wire).status).toBe("closed");
  }
}

const MARKER = "D2A_EGRESS_DENIED:";
const OWN_VERSIONED_SCENE = "own-versioned-scene";
const OWN_RUN_ID = "own-run";
const OWN_SNAPSHOT_ID = "own-snapshot";
/** A credential that exists in the profile; no read may return it. */
const CREDENTIAL_SENTINEL = "sk-d2a-own-data-read-CREDENTIAL-SENTINEL";
const roots: string[] = [];
afterAll(async () => {
  await closeBackends();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface Rig {
  route: (
    cmd: string,
    args?: Record<string, unknown>,
    senderId?: number,
  ) => Promise<Envelope>;
  gate: Awaited<
    ReturnType<(typeof import("./profileEgress.js"))["createProfileEgressGate"]>
  >;
  open: boolean;
  /**
   * The activation through Main's product path (DA-2): the entry is opened
   * the way the journey seam opens it, then preview → approved dialog →
   * issue → consume → stages 2 to 7. Resolves when `activated`.
   */
  activate: () => Promise<void>;
  nativeDbExecute: NapiBackendLike["dbExecute"];
  /** Straight into Native, for reading back what a route wrote. */
  nativeForeshadowAnchors: (sceneId: string) => Promise<string>;
  /** This process exits; a later start on the same workspace replaces it. */
  exit: () => void;
}

/** A fresh module graph + router on `appData`, as a Main process would start. */
async function startMain(
  appData: string,
  options: {
    /** Delay the Native activation until released (an activation in flight). */
    holdActivation?: Promise<void>;
    /** Hide the profile-egress startup surface: an unavailable gate. */
    unavailable?: boolean;
  } = {},
): Promise<Rig> {
  vi.resetModules();
  mocks.handlers.clear();
  const backend = newBackend(appData);
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
  const { createProfileEgressGate, D2A_OWN_DATA_READ_OPEN } =
    await import("./profileEgress.js");
  // The same module graph as the gate (the consumed token is per module).
  const { activateThroughMain } = await import(
    "./profileActivation.test.support.js"
  );
  const { registerEventBus } = await import("./events.js");
  const { registerIpcRouter } = await import("./ipc.js");
  const { IPC } = await import("../shared/ipcContract.js");

  const gate = await createProfileEgressGate(proxied as NapiBackendLike);
  registerEventBus(proxied as NapiBackendLike, undefined, gate);
  registerIpcRouter(
    proxied as NapiBackendLike,
    {} as never,
    {
      resolveApiKeyForRequest: () => CREDENTIAL_SENTINEL,
      getApiKeyForRequest: () => CREDENTIAL_SENTINEL,
    } as never,
    undefined,
    { active: false },
    gate,
  );
  const handler = mocks.handlers.get(IPC.invoke) as (
    event: unknown,
    cmd: unknown,
    args: unknown,
  ) => Promise<Envelope>;
  const sender = (id: number) => ({
    sender: { id, isDestroyed: () => false, once: () => undefined },
  });
  return {
    gate,
    open: D2A_OWN_DATA_READ_OPEN,
    activate: async () => {
      const result = await activateThroughMain(proxied as NapiBackendLike, gate);
      expect(result).toEqual({ status: "activated" });
    },
    route: (cmd, args, senderId = 7) =>
      handler(sender(senderId), cmd, args ?? {}),
    nativeDbExecute: backend.dbExecute.bind(backend),
    nativeForeshadowAnchors: (sceneId) =>
      backend.foreshadowLoadAnchorsForScene(sceneId) as Promise<string>,
    exit: () => {
      exited.add(backend);
    },
  };
}

function newAppData(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "grimodex-own-data-read-"));
  roots.push(root);
  const appData = path.join(root, "app-data");
  mkdirSync(appData, { recursive: true });
  // A credential in the profile's AI settings, to prove no read returns it.
  writeFileSync(
    path.join(appData, "ai-settings.json"),
    JSON.stringify({
      provider: "openai-compatible",
      model: "mock-model",
      openaiCompatibleEndpoints: [
        {
          id: "test",
          baseUrl: "http://127.0.0.1:9",
          apiKey: CREDENTIAL_SENTINEL,
          headers: { Authorization: `Bearer ${CREDENTIAL_SENTINEL}` },
        },
      ],
      activeOpenaiCompatibleEndpointId: "test",
    }),
  );
  return appData;
}

function ok<T>(envelope: Envelope): T {
  if (!envelope.ok) throw new Error(`expected ok, got: ${envelope.error}`);
  return envelope.value as T;
}

function failureOf(envelope: Envelope): string {
  expect(envelope.ok).toBe(false);
  return envelope.ok ? "" : envelope.error;
}

interface Workspace {
  path: string;
  projectId: string;
  /** An extraction run saved while unrestricted (review / inbox reads). */
  runId: string;
  /** A project snapshot created while unrestricted (restore-context read). */
  snapshotId: string;
}

/** Sample workspace + a chat session with messages, written while unrestricted. */
async function seedWorkspace(rig: Rig): Promise<Workspace> {
  const seeded = ok<{ path: string; projectId: string }>(
    await rig.route("seed_sample_workspace", {
      language: "ja",
      aiPolicy: '{"preset":"full"}',
    }),
  );
  ok(await rig.route("open_workspace", { path: seeded.path }));
  const run = (sql: string, params: unknown[]) =>
    rig.route("db_execute", { sql, params, method: "run" });
  ok(
    await run("INSERT INTO chat_sessions(id, project_id) VALUES (?, ?)", [
      "own-session",
      seeded.projectId,
    ]),
  );
  for (const [id, role, content] of [
    ["own-m1", "user", "第一章の続きを書きたい"],
    ["own-m2", "assistant", "了解しました。灯台の場面から始めましょう"],
  ]) {
    ok(
      await run(
        "INSERT INTO chat_messages(id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
        [id, "own-session", role, content, "2026-10-18T00:00:00.000Z"],
      ),
    );
  }
  // 版の過去の本文（content_versions）。
  for (const [versionNumber, content] of [
    [1, "灯台の灯はまだ点いていた。"],
    [2, "灯台の灯が消えた夜。"],
  ] as const) {
    ok(
      await run(
        "INSERT INTO content_versions(id, entity_type, entity_id, content, version_number, snapshot_type, created_at) VALUES (?, 'scene', ?, ?, ?, 'manual', ?)",
        [
          `own-version-${versionNumber}`,
          OWN_VERSIONED_SCENE,
          content,
          versionNumber,
          "2026-10-18T00:00:00.000Z",
        ],
      ),
    );
  }
  // 抽出の run と proposal set（review bundle、resumable runs、inbox の読取用）。
  const binding = ok<Record<string, unknown>>(
    await rig.route("narrative_extraction_capture_workspace_binding", {
      expectedWorkspacePath: seeded.path,
    }),
  );
  const runRef = {
    runId: OWN_RUN_ID,
    projectId: seeded.projectId,
    surfacePathId: "chronicle.extract",
  };
  ok(
    await rig.route("narrative_extraction_create_run", {
      payload: {
        ...runRef,
        scopeJson: {},
        specJson: { kind: "legacy-review-test@1" },
        specDigest: "sha256:test-spec",
        tasks: [],
      },
      workspaceBinding: binding,
    }),
  );
  ok(
    await rig.route("narrative_extraction_save_proposal_set", {
      payload: {
        runId: OWN_RUN_ID,
        projectId: seeded.projectId,
        proposalSetId: "own-set",
        setKind: "chronicle.extract.review@1",
        proposals: [
          {
            proposalId: "own-proposal",
            proposalKey: "proposal:key",
            kind: "chronicle.create-event@1",
            payloadJson: {},
          },
        ],
      },
      workspaceBinding: binding,
    }),
  );
  // snapshot（restore 文脈の読取用）。
  ok(
    await rig.route("project_snapshot_create", {
      payload: {
        projectId: seeded.projectId,
        snapshotId: OWN_SNAPSHOT_ID,
        name: "own snapshot",
        description: null,
        createdAt: "2026-10-18T00:00:00.000Z",
        treeRows: [],
        codexRows: [],
        snippetRows: [],
        versionIds: [],
      },
    }),
  );
  return {
    path: seeded.path,
    projectId: seeded.projectId,
    runId: OWN_RUN_ID,
    snapshotId: OWN_SNAPSHOT_ID,
  };
}

interface ReadCall {
  name: string;
  cmd: string;
  args: Record<string, unknown>;
  /**
   * The command needs a resource this test environment may lack (the
   * embedding model of `semantic_search`). Its unrestricted error is then the
   * baseline: restricted must produce the identical outcome, never
   * D2A_EGRESS_DENIED, and the stored data must still be unchanged.
   */
  unavailableIsBaseline?: boolean;
}

/** What a read returned: its value, or (when tolerated) its typed error. */
function readOutcome(call: ReadCall, envelope: Envelope): unknown {
  if (envelope.ok) return envelope.value;
  if (call.unavailableIsBaseline && !envelope.error.includes(MARKER)) {
    return { unavailable: envelope.error };
  }
  return ok(envelope);
}

/** Representative own-data-read calls (typed commands and generic SQL). */
function readCalls(ws: Workspace): ReadCall[] {
  const sql = (name: string, query: string, params: unknown[] = []) => ({
    name,
    cmd: "db_execute",
    args: { sql: query, params, method: "all" },
  });
  return [
    sql(
      "chat history",
      "SELECT id, role, content FROM chat_messages WHERE session_id = ? ORDER BY id",
      ["own-session"],
    ),
    sql(
      "chat sessions",
      "SELECT id, project_id FROM chat_sessions ORDER BY id",
    ),
    sql(
      "chat join",
      "SELECT s.id, count(m.id) AS n FROM chat_sessions s JOIN chat_messages m ON m.session_id = s.id GROUP BY s.id",
    ),
    sql(
      "WITH over chat",
      "WITH m AS (SELECT content FROM chat_messages) SELECT count(*) AS n FROM m",
    ),
    sql(
      "change feed payload",
      "SELECT sequence, payload FROM change_events ORDER BY sequence LIMIT 5",
    ),
    {
      name: "batch of reads",
      cmd: "db_execute_batch",
      args: {
        statements: [
          {
            sql: "SELECT count(*) AS n FROM chat_sessions",
            params: [],
            method: "all",
          },
          {
            sql: "SELECT count(*) AS n FROM chat_messages",
            params: [],
            method: "all",
          },
        ],
      },
    },
    {
      name: "lint dictionary",
      cmd: "lint_term_dictionary_list",
      args: { projectId: ws.projectId },
    },
    {
      name: "lint ignore",
      cmd: "lint_ignore_list",
      args: { projectId: ws.projectId },
    },
    { name: "trash", cmd: "trash_bin_list", args: { projectId: ws.projectId } },
    {
      name: "foreshadows",
      cmd: "foreshadow_list_with_labels",
      args: { projectId: ws.projectId },
    },
    {
      name: "plot threads",
      cmd: "plot_thread_list",
      args: { projectId: ws.projectId },
    },
    {
      name: "post-effect runs",
      cmd: "list_post_effect_runs",
      args: { projectId: ws.projectId },
    },
    {
      name: "annotations",
      cmd: "list_annotations_for_project",
      args: { projectId: ws.projectId },
    },
    {
      name: "scene lens",
      cmd: "list_scene_lens_for_project",
      args: { projectId: ws.projectId },
    },
    {
      name: "full-text search",
      cmd: "fts_search",
      args: { projectId: ws.projectId, query: "灯台", scope: "all", limit: 5 },
    },
    {
      name: "codex highlight",
      cmd: "codex_match_text",
      args: { text: "灯台の場面", excludeEntryIds: [] },
    },
    {
      name: "audit verify",
      cmd: "ai_audit_verify",
      args: { expectedWorkspacePath: ws.path, projectId: ws.projectId },
    },
    // 開放の commit の完了条件（da1-decisions.md の P3）: 版の過去の本文、
    // 意味検索、抽出の review／maintenance inbox、snapshot の復元の文脈。
    sql(
      "version history body (content_versions)",
      "SELECT version_number, snapshot_type, content FROM content_versions WHERE entity_type = 'scene' AND entity_id = ? ORDER BY version_number",
      [OWN_VERSIONED_SCENE],
    ),
    {
      name: "semantic search",
      cmd: "semantic_search",
      args: {
        expectedWorkspacePath: ws.path,
        projectId: ws.projectId,
        query: "灯台",
        limit: 5,
      },
      unavailableIsBaseline: true,
    },
    {
      name: "extraction run",
      cmd: "narrative_extraction_get_run",
      args: { payload: { runId: ws.runId, projectId: ws.projectId } },
    },
    {
      name: "extraction run review bundle",
      cmd: "narrative_extraction_get_run_review_bundle",
      args: { payload: { runId: ws.runId, projectId: ws.projectId } },
    },
    {
      name: "extraction resumable runs",
      cmd: "narrative_extraction_list_resumable_runs",
      args: { payload: { projectId: ws.projectId } },
    },
    {
      name: "extraction commit status",
      cmd: "narrative_extraction_get_commit_status",
      args: { payload: { projectId: ws.projectId, requestId: "own-request" } },
    },
    {
      name: "maintenance inbox",
      cmd: "narrative_maintenance_inbox_list",
      args: { payload: { projectId: ws.projectId } },
    },
    {
      name: "snapshot restore context",
      cmd: "project_snapshot_restore_context",
      args: {
        projectId: ws.projectId,
        snapshotId: ws.snapshotId,
        scopes: ["labels"],
      },
    },
  ];
}

/** Writes and denied reads the restricted profile must keep refusing. */
function refusedCalls(ws: Workspace): ReadCall[] {
  const sql = (
    name: string,
    query: string,
    params: unknown[] = [],
    method = "run",
  ) => ({
    name,
    cmd: "db_execute",
    args: { sql: query, params, method },
  });
  return [
    // closed tables (reads), by the ledger's own names
    ...NATIVE_CLOSED_TABLES.map((table) =>
      sql(
        `closed read ${table}`,
        `SELECT * FROM "${table}" LIMIT 1`,
        [],
        "all",
      ),
    ),
    sql(
      "closed read mixed with a read-open table",
      "SELECT c.content FROM chat_messages c JOIN narrative_proposals p ON 1 = 1",
      [],
      "all",
    ),
    // DML on the read-open class (Negative (18))
    sql(
      "chat_sessions insert",
      "INSERT INTO chat_sessions(id, project_id) VALUES ('x', 'y')",
    ),
    sql(
      "chat_sessions update",
      "UPDATE chat_sessions SET project_id = 'z' WHERE id = 'own-session'",
    ),
    sql(
      "chat_sessions update node_id",
      "UPDATE chat_sessions SET node_id = NULL",
    ),
    sql(
      "chat_sessions delete",
      "DELETE FROM chat_sessions WHERE id = 'own-session'",
    ),
    sql(
      "chat_messages update (reads columns)",
      "UPDATE chat_messages SET content = content || '!' WHERE id = 'own-m1'",
    ),
    sql(
      "chat_messages update (constants)",
      "UPDATE chat_messages SET is_starred = 1",
    ),
    sql(
      "chat_messages delete",
      "DELETE FROM chat_messages WHERE id = 'own-m1'",
    ),
    sql(
      "cte insert into the ledger",
      "WITH s AS (SELECT 1 AS n) INSERT INTO chat_sessions(id, project_id) SELECT 'x', 'y' FROM s",
    ),
    sql(
      "cte delete from the ledger",
      "WITH s AS (SELECT id FROM chat_messages) DELETE FROM chat_messages WHERE id IN (SELECT id FROM s)",
    ),
    sql(
      "upsert into the ledger",
      "INSERT INTO chat_sessions(id, project_id) VALUES ('own-session', 'p') ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id",
    ),
    sql("feed table delete", "DELETE FROM change_events"),
    // RETURNING, and a write dressed as a read to a table outside the ledger
    sql(
      "returning",
      "INSERT INTO app_settings(key, value) VALUES ('k', 'v') RETURNING value",
      [],
      "all",
    ),
    sql(
      "cte write elsewhere reading the ledger",
      "WITH s AS (SELECT content FROM chat_messages) INSERT INTO app_settings(key, value) SELECT 'leak', content FROM s",
    ),
    {
      name: "batch with a ledger write",
      cmd: "db_execute_batch",
      args: {
        statements: [
          {
            sql: "SELECT count(*) AS n FROM chat_sessions",
            params: [],
            method: "all",
          },
          { sql: "DELETE FROM chat_sessions", params: [], method: "run" },
        ],
      },
    },
    // not in the own-data-read ledger
    {
      name: "claim_task",
      cmd: "narrative_extraction_claim_task",
      args: { payload: {} },
    },
    {
      name: "pack_context",
      cmd: "nir1_pack_context",
      args: { projectId: ws.projectId },
    },
  ];
}

/**
 * A digest of every table of the workspace database. It is computed in a
 * separate process: opening the same SQLite file from a second library inside
 * this process (next to Native's connection) can drop Native's POSIX locks and
 * crash the worker.
 */
const DIGEST_SCRIPT = `
const { DatabaseSync } = require("node:sqlite");
const { createHash } = require("node:crypto");
const db = new DatabaseSync(process.argv[1], { readOnly: true });
const hash = createHash("sha256");
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all();
for (const { name } of tables) {
  // Native's own ai audit appends are out of scope for "the author's data".
  if (name === "ai_audit_events") continue;
  hash.update(name);
  for (const row of db.prepare('SELECT * FROM "' + name + '"').all()) {
    hash.update(JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? String(v) : v)));
  }
}
process.stdout.write(hash.digest("hex"));
db.close();
`;

function dataDigest(workspacePath: string): string | null {
  try {
    return execFileSync(
      process.execPath,
      [
        "--no-warnings",
        "-e",
        DIGEST_SCRIPT,
        path.join(workspacePath, "grimodex.db"),
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
  } catch {
    return null;
  }
}

/** Rows of the workspace database, read in a separate process (see above). */
function queryRows(workspacePath: string, sql: string): unknown[] {
  const script = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1], { readOnly: true });
process.stdout.write(JSON.stringify(db.prepare(process.argv[2]).all(), (_k, v) => (typeof v === "bigint" ? String(v) : v)));
db.close();
`;
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--no-warnings",
        "-e",
        script,
        path.join(workspacePath, "grimodex.db"),
        sql,
      ],
      { encoding: "utf8", timeout: 30_000 },
    ),
  ) as unknown[];
}

function leavesNoCredential(envelope: Envelope): void {
  expect(JSON.stringify(envelope)).not.toContain(CREDENTIAL_SENTINEL);
  expect(JSON.stringify(envelope).toLowerCase()).not.toContain("bearer ");
}

describe("own-data-read through the real router, gate and Native", () => {
  it("the test fixture policy is exactly what Native publishes", async () => {
    const appData = newAppData();
    const first = newBackend(appData);
    const status = JSON.parse(await first.initializeProfileEgress!()) as {
      sqlPolicy: Record<string, unknown>;
    };
    expect(status.sqlPolicy).toEqual({
      version: 2,
      closedTables: [...NATIVE_CLOSED_TABLES],
      readOpenTables: [...NATIVE_READ_OPEN_TABLES],
      readOpenColumns: NATIVE_READ_OPEN_COLUMNS,
    });
  });

  it("restricted reads follow the opening; writes, closed tables and credentials never open", async () => {
    const appData = newAppData();
    const rig = await startMain(appData);
    expect(rig.gate.restricted).toBe(false);
    const ws = await seedWorkspace(rig);

    // The baseline: what an unrestricted profile returns for each read.
    const baseline = new Map<string, unknown>();
    for (const call of readCalls(ws)) {
      const envelope = await rig.route(call.cmd, call.args);
      baseline.set(call.name, readOutcome(call, envelope));
      leavesNoCredential(envelope);
    }
    expect(
      JSON.stringify(baseline.get("chat history")),
      "the baseline holds the author's own chat",
    ).toContain("灯台");
    const digestBefore = dataDigest(ws.path);
    expect(
      digestBefore,
      "the unchanged-data check needs node:sqlite (Node 22.13+)",
    ).not.toBeNull();

    await rig.activate();
    expect(rig.gate.restricted).toBe(true);
    expect(rig.gate.unavailable).toBe(false);

    let digestBeforeCall = digestBefore;
    for (const call of readCalls(ws)) {
      const envelope = await rig.route(call.cmd, call.args);
      leavesNoCredential(envelope);
      if (rig.open) {
        expect(readOutcome(call, envelope), call.name).toEqual(
          baseline.get(call.name),
        );
        // 各 command の呼出しの前後で保存データの digest が変わらない。
        const digestAfterCall = dataDigest(ws.path);
        expect(digestAfterCall, `${call.name}: stored data unchanged`).toBe(
          digestBeforeCall,
        );
        digestBeforeCall = digestAfterCall;
      } else {
        expect(failureOf(envelope), call.name).toContain(MARKER);
      }
    }

    for (const call of refusedCalls(ws)) {
      const envelope = await rig.route(call.cmd, call.args);
      leavesNoCredential(envelope);
      expect(failureOf(envelope), call.name).toContain(MARKER);
    }
    // Native's DML arm is the authority for ledger writes, independent of Main's
    // early classification (K3/2 Negative (18)). Called straight into Native
    // with the Main-issued identity. A form that also reads columns reaches the
    // DML arm only once the read-open class is open; before that the read arm
    // rejects it first.
    const identity = JSON.stringify(rig.gate.issueCallerIdentity(7));
    for (const [sql, readsColumns] of [
      ["INSERT INTO chat_sessions(id, project_id) VALUES ('x', 'y')", false],
      ["UPDATE chat_sessions SET project_id = 'z'", false],
      ["UPDATE chat_sessions SET node_id = NULL", false],
      ["DELETE FROM chat_sessions", false],
      ["UPDATE chat_messages SET is_starred = 1", false],
      [
        "UPDATE chat_messages SET content = content || '!' WHERE id = 'own-m1'",
        true,
      ],
      [
        "UPDATE chat_sessions SET node_id = node_id WHERE id = 'own-session'",
        true,
      ],
    ] as const) {
      const message = await rig.nativeDbExecute(sql, [], "run", identity).then(
        () => "",
        (error: unknown) =>
          error instanceof Error ? error.message : String(error),
      );
      expect(message, sql).toContain(MARKER);
      if (rig.open || !readsColumns) {
        expect(message, sql).toContain("protected DML target");
      }
    }

    // Nothing the restricted profile did changed the author's data.
    const digestAfter = dataDigest(ws.path);
    expect(digestAfter).toBe(digestBefore);
    const survivors = ok<{ rows: Array<Record<string, unknown>> }>(
      await rig.route("db_execute", {
        sql: "SELECT key FROM app_settings WHERE key IN ('leak', 'k')",
        params: [],
        method: "all",
      }),
    );
    expect(survivors.rows).toEqual([]);
  });

  it("ordinary non-ledger work keeps running while restricted (unchanged)", async () => {
    const appData = newAppData();
    const rig = await startMain(appData);
    await seedWorkspace(rig);
    await rig.activate();
    ok(
      await rig.route("db_execute", {
        sql: "INSERT INTO app_settings(key, value) VALUES (?, ?)",
        params: ["own-data-read-probe", "v"],
        method: "run",
      }),
    );
    const read = await rig.route("db_execute", {
      sql: "SELECT value FROM app_settings WHERE key = ?",
      params: ["own-data-read-probe"],
      method: "all",
    });
    expect(
      JSON.stringify(ok(read)),
      "app_settings is not a ledger table",
    ).toContain('"v"');
  });

  it("a process restarted on a restricted profile behaves the same", async () => {
    const appData = newAppData();
    const first = await startMain(appData);
    const ws = await seedWorkspace(first);
    const baseline = new Map<string, unknown>();
    for (const call of readCalls(ws)) {
      baseline.set(
        call.name,
        readOutcome(call, await first.route(call.cmd, call.args)),
      );
    }
    await first.activate();
    first.exit();

    const restarted = await startMain(appData);
    expect(restarted.gate.restricted).toBe(true);
    ok(await restarted.route("open_workspace", { path: ws.path }));
    for (const call of readCalls(ws)) {
      const envelope = await restarted.route(call.cmd, call.args);
      leavesNoCredential(envelope);
      if (restarted.open) {
        expect(readOutcome(call, envelope), call.name).toEqual(
          baseline.get(call.name),
        );
      } else {
        expect(failureOf(envelope), call.name).toContain(MARKER);
      }
    }
    for (const call of refusedCalls(ws)) {
      expect(
        failureOf(await restarted.route(call.cmd, call.args)),
        call.name,
      ).toContain(MARKER);
    }
  });

  it("refuses at invoke while an activation is in flight (Negative (3))", async () => {
    const appData = newAppData();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rig = await startMain(appData, { holdActivation: held });
    const ws = await seedWorkspace(rig);
    const activation = rig.activate();
    await vi.waitFor(() => expect(rig.gate.activating).toBe(true));
    expect(rig.gate.restricted).toBe(true);
    for (const call of readCalls(ws)) {
      expect(
        failureOf(await rig.route(call.cmd, call.args)),
        call.name,
      ).toContain(MARKER);
    }
    release();
    await activation;
  });

  it("refuses everything own-data-read when the Native gate is unavailable", async () => {
    const appData = newAppData();
    const rig = await startMain(appData, { unavailable: true });
    expect(rig.gate.unavailable).toBe(true);
    for (const call of readCalls({
      path: "/none",
      projectId: "p",
      runId: "r",
      snapshotId: "s",
    })) {
      expect(
        failureOf(await rig.route(call.cmd, call.args)),
        call.name,
      ).toContain(MARKER);
    }
  });

  it("Native alone rejects a classified write, whatever Main sends (authority)", async () => {
    const appData = newAppData();
    const rig = await startMain(appData);
    await seedWorkspace(rig);
    await rig.activate();
    const identity = rig.gate.issueCallerIdentity(7);
    // Skipping Main's classification path: a statement Main classified
    // own-data-read is read-only-checked inside Native.
    await expect(
      rig.nativeDbExecute(
        "INSERT INTO app_settings(key, value) VALUES ('direct', 'v')",
        [],
        "run",
        JSON.stringify(identity),
        true,
      ),
    ).rejects.toThrow(/not read-only/);
  });

  it("saves a manuscript body bundle with foreshadow anchors the same way restricted and unrestricted (Positive (2))", async () => {
    const BODY = "灯台の灯が消えた夜、伏線の種と回収の一文を書く。";
    const saveOn = async (restrict: boolean) => {
      const rig = await startMain(newAppData());
      const ws = await seedWorkspace(rig);
      const scene = queryRows(
        ws.path,
        "SELECT id FROM tree_nodes WHERE node_type = 'scene' ORDER BY id LIMIT 1",
      )[0] as { id: string };
      // Every foreshadow the scene already touches needs its base version.
      const foreshadows = queryRows(
        ws.path,
        "SELECT id, version FROM foreshadows ORDER BY id",
      ) as Array<{ id: string; version: string }>;
      const [setupOf, payoffOf] = foreshadows;
      expect(
        setupOf && payoffOf,
        "the sample has two foreshadows",
      ).toBeTruthy();
      if (restrict) {
        await rig.activate();
        expect(rig.gate.restricted).toBe(true);
      }
      const sceneVersion = (
        queryRows(
          ws.path,
          `SELECT version FROM tree_nodes WHERE id = '${scene.id}'`,
        )[0] as { version: string }
      ).version;
      const payload = {
        sceneId: scene.id,
        projectId: ws.projectId,
        requestId: `req-${restrict ? "r" : "u"}`,
        sessionId: "renderer-scene-body",
        eventUid: `evt-${restrict ? "r" : "u"}`,
        origin: "human",
        includeSidecars: true,
        baseVersion: Number(sceneVersion),
        updatedAt: "2026-10-18T00:00:00.000Z",
        contentJson: JSON.stringify({
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: BODY }] },
          ],
        }),
        charCount: BODY.length,
        docContentSize: BODY.length + 2,
        placedBeatPreview: null,
        unplacedBeatsDoc: "[]",
        unplacedBeatPreview: null,
        authorshipSpans: [
          {
            fromPos: 0,
            toPos: 5,
            source: "human",
            model: null,
            timestamp: null,
            chatMsgId: null,
            traceId: null,
          },
        ],
        foreshadowBaseVersions: Object.fromEntries(
          foreshadows.map((row) => [row.id, Number(row.version)]),
        ),
        foreshadowSetups: [
          {
            id: "da1-setup-anchor",
            foreshadowId: setupOf.id,
            baseVersion: Number(setupOf.version),
            fromPos: 1,
            toPos: 6,
          },
        ],
        foreshadowPayoffs: [
          {
            foreshadowId: payoffOf.id,
            baseVersion: Number(payoffOf.version),
            fromPos: 8,
            toPos: 14,
          },
        ],
        annotationAnchors: [],
        beatMentions: [],
        beatPovOverrides: [],
      };
      const result = ok<{ contentVersion: number }>(
        await rig.route("save_scene_body_bundle", { payload }),
      );
      expect(result.contentVersion).toBeGreaterThan(Number(sceneVersion));
      expect(
        rig.gate.restricted,
        "the save does not lift the restriction",
      ).toBe(restrict);
      const anchors = JSON.parse(
        await rig.nativeForeshadowAnchors(scene.id),
      ) as {
        setups: Array<Record<string, unknown>>;
        payoffs: Array<Record<string, unknown>>;
      };
      const stored = {
        body: queryRows(
          ws.path,
          `SELECT content FROM tree_nodes WHERE id = '${scene.id}'`,
        ),
        setup: queryRows(
          ws.path,
          "SELECT foreshadow_id, scene_id, from_pos, to_pos FROM foreshadow_setups WHERE id = 'da1-setup-anchor'",
        ),
        payoff: queryRows(
          ws.path,
          `SELECT payoff_scene_id, payoff_from_pos, payoff_to_pos FROM foreshadows WHERE id = '${payoffOf.id}'`,
        ),
      };
      return {
        stored,
        anchors,
        sceneId: scene.id,
        setupId: setupOf.id,
        payoffId: payoffOf.id,
      };
    };

    const unrestricted = await saveOn(false);
    const restricted = await saveOn(true);

    // The body and both anchors are persisted under the restriction ...
    expect(JSON.stringify(restricted.stored.body)).toContain(BODY);
    expect(restricted.stored.setup).toEqual([
      {
        foreshadow_id: restricted.setupId,
        scene_id: restricted.sceneId,
        from_pos: 1,
        to_pos: 6,
      },
    ]);
    expect(restricted.stored.payoff).toEqual([
      {
        payoff_scene_id: restricted.sceneId,
        payoff_from_pos: 8,
        payoff_to_pos: 14,
      },
    ]);
    expect(JSON.stringify(restricted.anchors)).toContain("da1-setup-anchor");
    // ... and are the same rows an unrestricted profile persists.
    expect(restricted.stored).toEqual(unrestricted.stored);
    expect(restricted.anchors).toEqual(unrestricted.anchors);
  });
});

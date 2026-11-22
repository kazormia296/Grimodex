// MP-4b (K-6, DR-MP4-4/6): Electron main's read adapter and typed reads,
// against the real Native addon. A fake backend cannot say what Native really
// returns (object rows, the marker, a repeated column name, how it takes the
// identity), so this spec drives the adapter over a seeded sample workspace.
//
// What it fixes:
//   - a SELECT passes, and Drizzle gets its columns by position;
//   - a repeated column name and a column named like an integer;
//   - anything but a SELECT never reaches Native (the spy sees no call);
//   - the identity is the fourth argument and Native parses it; no fifth;
//   - the marker check, on what Native really answers to a mutation;
//   - the semantic reads: a workspace that is not the active one is refused,
//     and the refusal is the workspace's (not a missing index).
//
// Not covered here (open, recorded in the PR): a restricted profile (identity
// absent, stale, a closed table), and the 20-tool equivalence with the
// renderer's path (PR-9).
//
// The real addon is needed, so only `vitest.electron-native.config.ts` runs it.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { Envelope, NapiBackendLike } from "../shared/ipcContract.js";
import { createMainReadDb, parseNativeReadResult } from "./mastraRead/db.js";
import { MainReadError } from "./mastraRead/errors.js";
import { createMainTypedReads } from "./mastraRead/typed.js";
import type { MainIssuedCallerIdentity } from "./profileEgress.js";

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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NativeBackendInstance = NapiBackendLike & Record<string, any>;
const { Backend: NativeBackend } = require(ADDON) as {
  Backend: new (appData: string) => NativeBackendInstance;
};
const backends: NativeBackendInstance[] = [];
const roots: string[] = [];

afterAll(async () => {
  for (const backend of backends) {
    const wire = await backend.shutdownWorkspaceLifecycle!();
    expect(JSON.parse(wire).status).toBe("closed");
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function ok<T>(envelope: Envelope): T {
  if (!envelope.ok) throw new Error(`expected ok, got: ${envelope.error}`);
  return envelope.value as T;
}

/** The sample workspace, opened, with the gate that issues caller identities. */
async function startWorkspace(): Promise<{
  backend: NativeBackendInstance;
  /** A spy in front of `dbExecute`; the real Backend behind it. */
  dbExecute: ReturnType<typeof vi.fn>;
  readBackend: Pick<NapiBackendLike, "dbExecute">;
  workspacePath: string;
  projectId: string;
  identity: MainIssuedCallerIdentity;
  otherDirectory: string;
}> {
  const root = mkdtempSync(path.join(os.tmpdir(), "grimodex-mp4b-read-"));
  roots.push(root);
  const appData = path.join(realpathSync(root), "app-data");
  mkdirSync(appData, { recursive: true });
  const otherDirectory = path.join(realpathSync(root), "other-workspace");
  mkdirSync(otherDirectory, { recursive: true });
  mocks.handlers.clear();
  const backend = new NativeBackend(appData);
  backends.push(backend);
  const { createProfileEgressGate } = await import("./profileEgress.js");
  const { registerIpcRouter } = await import("./ipc.js");
  const { IPC } = await import("../shared/ipcContract.js");
  const gate = await createProfileEgressGate(backend as NapiBackendLike);
  registerIpcRouter(
    backend as NapiBackendLike,
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
  const route = (cmd: string, args: Record<string, unknown> = {}) =>
    handler(event, cmd, args);
  const seeded = ok<{ path: string; projectId: string }>(
    await route("seed_sample_workspace", {
      language: "ja",
      aiPolicy: '{"preset":"full"}',
    }),
  );
  ok(await route("open_workspace", { path: seeded.path }));
  const dbExecute = vi.fn((...args: Parameters<NapiBackendLike["dbExecute"]>) =>
    backend.dbExecute(...args),
  );
  return {
    backend,
    dbExecute,
    readBackend: { dbExecute },
    workspacePath: seeded.path,
    projectId: seeded.projectId,
    identity: gate.issueCallerIdentity(7),
    otherDirectory,
  };
}

const treeNodes = sqliteTable("tree_nodes", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  title: text("title").notNull(),
  version: integer("version").notNull(),
});

describe("main's DB read adapter against the real Native addon", () => {
  it("passes a SELECT, and Drizzle reads every column by its position", async () => {
    const ws = await startWorkspace();
    const client = createMainReadDb({
      backend: ws.readBackend,
      identity: ws.identity,
    });
    const db = drizzle(client);
    // The columns are deliberately NOT in alphabetical (or table) order: a row
    // mapped by `Object.values` would put them in the wrong place if Native's
    // key order were sorted, and a test whose columns happen to be sorted would
    // not see it.
    const rows = await db
      .select({
        version: treeNodes.version,
        title: treeNodes.title,
        id: treeNodes.id,
      })
      .from(treeNodes)
      .where(eq(treeNodes.projectId, ws.projectId))
      .orderBy(treeNodes.id)
      .limit(3);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(typeof row.id).toBe("string");
      expect(typeof row.title).toBe("string");
      expect(row.title).not.toBe(row.id);
      expect(typeof row.version).toBe("number");
    }
    // The same rows by the raw wire, in the same column order.
    const raw = JSON.parse(
      await ws.backend.dbExecute(
        'select "version","title","id" from "tree_nodes" where "project_id" = ? order by "id" limit 3',
        [ws.projectId],
        "all",
      ),
    ) as {
      rows: Array<{ version: number; title: string; id: string }>;
    };
    expect(Object.keys(raw.rows[0]!)).toEqual(["version", "title", "id"]);
    expect(rows.map((r) => r.version)).toEqual(raw.rows.map((r) => r.version));
    expect(rows.map((r) => r.title)).toEqual(raw.rows.map((r) => r.title));
    expect(rows.map((r) => r.id)).toEqual(raw.rows.map((r) => r.id));
  });

  it("keeps every column of a repeated name, in position", async () => {
    const ws = await startWorkspace();
    const client = createMainReadDb({
      backend: ws.readBackend,
      identity: ws.identity,
    });
    const repeated = await client(
      'select "id", "id", "id" from "tree_nodes" limit 1',
      [],
      "all",
    );
    expect(repeated.rows).toHaveLength(1);
    expect(repeated.rows[0]).toHaveLength(3);
    expect(new Set(repeated.rows[0]).size).toBe(1);

    // Two different columns with the same name keep their own values in order.
    const joined = await client(
      'select "n"."id", "p"."id" from "tree_nodes" as "n" join "tree_nodes" as "p" on "p"."id" <> "n"."id" limit 1',
      [],
      "all",
    );
    expect(joined.rows[0]).toHaveLength(2);
    // Two different nodes: two different values under one column name.
    expect(joined.rows[0]![1]).not.toBe(joined.rows[0]![0]);
  });

  it("refuses a column named like an integer, whose position Object.values would change", async () => {
    const ws = await startWorkspace();
    const client = createMainReadDb({
      backend: ws.readBackend,
      identity: ws.identity,
    });
    await expect(
      client('select 2 as "b", 1 as "1", 3 as "0"', [], "all"),
    ).rejects.toMatchObject({ code: "result-shape" });
    // It was sent: it is the answer that is not used.
    expect(ws.dbExecute).toHaveBeenCalledTimes(1);
  });

  it("never sends anything but an allowed SELECT: the spy sees no call", async () => {
    const ws = await startWorkspace();
    const client = createMainReadDb({
      backend: ws.readBackend,
      identity: ws.identity,
    });
    const before = async () =>
      (
        JSON.parse(
          await ws.backend.dbExecute(
            'select count(*) as "n" from "tree_nodes"',
            [],
            "all",
          ),
        ) as { rows: Array<{ n: number }> }
      ).rows[0]!.n;
    const count = await before();
    ws.dbExecute.mockClear();
    const refused: Array<[string, unknown, string]> = [
      ["delete from tree_nodes", [], "all"],
      ["update tree_nodes set title = 'x'", [], "all"],
      ["with t as (select 1) delete from tree_nodes where 0", [], "all"],
      ["select 1; delete from tree_nodes", [], "all"],
      ["select * from narrative_runs", [], "all"],
      ["select * from ai_audit_events", [], "values"],
      ["select * from sqlite_master", [], "all"],
      ['select 1 from "tree_nodes" limit 1', [], "get"],
      ['select 1 from "tree_nodes" limit 1', [], "run"],
      ['select 1 from "tree_nodes" limit 1', "not-an-array", "all"],
      ["pragma user_version", [], "all"],
      // Forms SQLite reads as a table without `from <name>`.
      ["select * from (tree_nodes)", [], "all"],
      ["select 1 from tree_nodes where id in chat_messages", [], "all"],
    ];
    for (const [sql, params, method] of refused) {
      await expect(
        client(sql, params as unknown[], method),
        `${method} ${sql}`,
      ).rejects.toBeInstanceOf(MainReadError);
    }
    expect(ws.dbExecute).not.toHaveBeenCalled();
    expect(await before()).toBe(count);
  });

  it("SQLite itself reads a parenthesised table name and `in <table>` (why the checker refuses them)", async () => {
    const ws = await startWorkspace();
    // Straight into Native, past the adapter. A parenthesised name is read.
    const wire = await ws.backend.dbExecute(
      'select count(*) as "n" from (labels)',
      [],
      "all",
    );
    expect(JSON.parse(wire).__grimodexDbResultKind).toBe("read");
    // `in <table>` is looked up as a table too: the table has several columns,
    // and SQLite says so, which it could not if it had not found the table.
    await expect(
      ws.backend.dbExecute(
        'select 1 as "x" from "tree_nodes" where "id" in labels',
        [],
        "all",
      ),
    ).rejects.toThrow(/sub-select returns \d+ columns/);
  });

  it("sends the identity as the fourth argument and no fifth, and Native parses it", async () => {
    const ws = await startWorkspace();
    const client = createMainReadDb({
      backend: ws.readBackend,
      identity: ws.identity,
    });
    await client('select "id" from "tree_nodes" limit 1', [], "values");
    const args = ws.dbExecute.mock.calls[0]!;
    expect(args).toHaveLength(4);
    expect(args[3]).toBe(JSON.stringify(ws.identity));

    // An identity Native cannot read is refused by Native, so the identity
    // really is parsed (it is not dropped on the way).
    const { callerId: _callerId, ...incomplete } = ws.identity;
    const broken = createMainReadDb({
      backend: ws.readBackend,
      identity: incomplete as unknown as MainIssuedCallerIdentity,
    });
    await expect(
      broken('select "id" from "tree_nodes" limit 1', [], "all"),
    ).rejects.toThrow(/D2A_EGRESS_DENIED/);
  });

  it("does not accept what Native answers to a mutation: the marker is not `read`", async () => {
    const ws = await startWorkspace();
    // A direct call, past the adapter (the adapter would never send this): the
    // raw wire of a committed mutation, the answer the marker check exists for.
    const wire = await ws.backend.dbExecute(
      'update "labels" set "id" = "id" where 0',
      [],
      "run",
    );
    expect(JSON.parse(wire).__grimodexDbResultKind).toBe("committed-mutation");
    expect(() => parseNativeReadResult(wire)).toThrow(
      expect.objectContaining({ code: "result-marker" }),
    );
    // And a read through the same Native is accepted.
    const read = await ws.backend.dbExecute(
      'select "id" from "tree_nodes" limit 1',
      [],
      "all",
    );
    expect(JSON.parse(read).__grimodexDbResultKind).toBe("read");
    expect(parseNativeReadResult(read)).toHaveLength(1);
  });
});

describe("main's typed reads against the real Native addon", () => {
  it("a gate-issued identity names the active workspace, so the semantic reads can use it as it is", async () => {
    const ws = await startWorkspace();
    expect(typeof ws.identity.workspaceId).toBe("string");
    expect(realpathSync(ws.identity.workspaceId as string)).toBe(
      realpathSync(ws.workspacePath),
    );
  });

  it("the semantic reads refuse a workspace that is not the active one, with the workspace's own error", async () => {
    const ws = await startWorkspace();
    const wrong = createMainTypedReads({
      backend: ws.backend,
      identity: { ...ws.identity, workspaceId: ws.otherDirectory },
    });
    await expect(
      wrong.codexSemantic({ projectId: ws.projectId, query: "灯台", limit: 3 }),
    ).rejects.toThrow(/SEMANTIC_INDEX_WORKSPACE_CHANGED/);
    await expect(
      wrong.eventsSemantic({
        projectId: ws.projectId,
        query: "灯台",
        limit: 3,
      }),
    ).rejects.toThrow(/SEMANTIC_INDEX_WORKSPACE_CHANGED/);

    // The active workspace is not refused for that reason. What it answers
    // otherwise depends on the machine: with no embedding model installed (the
    // case when this was written) it is "embedding model ... is not installed";
    // with one, a result. Either shows the workspace check passed.
    const right = createMainTypedReads({
      backend: ws.backend,
      identity: { ...ws.identity, workspaceId: ws.workspacePath },
    });
    for (const call of [
      () =>
        right.codexSemantic({
          projectId: ws.projectId,
          query: "灯台",
          limit: 3,
        }),
      () =>
        right.eventsSemantic({
          projectId: ws.projectId,
          query: "灯台",
          limit: 3,
        }),
    ]) {
      const outcome = await call().then(
        () => "answered",
        (error: unknown) => String(error),
      );
      expect(outcome).not.toMatch(/WORKSPACE_CHANGED/);
    }
  });

  it("fts and the foreshadow list answer through their own Native methods", async () => {
    const ws = await startWorkspace();
    const reads = createMainTypedReads({
      backend: ws.backend,
      identity: ws.identity,
    });
    for (const scope of ["codex", "scenes", "snippets"] as const) {
      const result = await reads.fts({
        projectId: ws.projectId,
        query: "灯台",
        scope,
        limit: 5,
      });
      expect(result).not.toBeUndefined();
    }
    const open = await reads.foreshadowOpen({ projectId: ws.projectId });
    expect(open).not.toBeUndefined();
  });
});

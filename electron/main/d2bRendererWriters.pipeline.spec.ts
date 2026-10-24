// NIR-1 DA-2b ST5-B (ST4-A note 8; DR-DA2B-R2, R4; K3/2 "chat の書込みの入口",
// the M and T rules): the renderer's own rewritten API functions (`mapApi`,
// `labelApi`, `prompt-library/api`, `chatApi`) run through the real router,
// the real profile gate and the real Native addon while restricted. The
// renderer bridge (`window.grimodex.invoke`) is a shim onto Main's
// `grim:invoke` handler, so `src/lib/tauri.ts` and the Drizzle sqlite-proxy
// client run unchanged and every statement they send is classified by Main and
// authorized by Native as in the product.
//
// `restrictedGenericSqlT.test.ts` runs the same functions against a model of
// the restricted shape (`d2aRestrictedGenericSql.testSupport.ts`); this spec
// replaces the model with the real gate.
//
// The real addon is needed, so only `vitest.electron-native.config.ts` runs it.
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
// Renderer side effects outside the writers under test.
vi.mock("@/features/timelapse/recorder", () => ({
  getRecorderSessionId: vi.fn(() => "t-session"),
  recordChangeEvent: vi.fn(),
}));
vi.mock("@/features/timelapse/captureChat", () => ({
  recordChatMessageAdd: vi.fn(),
  recordChatMessageDelete: vi.fn(),
  recordChatMessagesDeleteFrom: vi.fn(),
}));
vi.mock("@/features/semantic-search/scheduler", () => ({
  scheduleChatIndex: vi.fn(),
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
  delete (globalThis as Record<string, unknown>).window;
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
  activate: () => Promise<void>;
  /** Every `db_execute` statement the renderer sent, with Main's answer. */
  statements: Array<{ sql: string; ok: boolean; error?: string }>;
}

async function startMain(appData: string): Promise<Rig> {
  mocks.handlers.clear();
  const backend = new NativeBackend(appData);
  backends.push(backend);
  const { createProfileEgressGate } = await import("./profileEgress.js");
  const { activateThroughMain } =
    await import("./profileActivation.test.support.js");
  const { registerEventBus } = await import("./events.js");
  const { registerIpcRouter } = await import("./ipc.js");
  const { IPC } = await import("../shared/ipcContract.js");

  const gate = await createProfileEgressGate(backend as NapiBackendLike);
  registerEventBus(backend as NapiBackendLike, undefined, gate);
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
  return {
    gate,
    statements: [],
    activate: async () => {
      expect(
        await activateThroughMain(backend as NapiBackendLike, gate),
      ).toEqual({ status: "activated" });
    },
    route: (cmd, args) => handler(event, cmd, args ?? {}),
  };
}

function ok<T>(envelope: Envelope): T {
  if (!envelope.ok) throw new Error(`expected ok, got: ${envelope.error}`);
  return envelope.value as T;
}

/**
 * A renderer module, loaded through the `@` alias of
 * `vitest.electron-native.config.ts`. The specifier is not a literal so that
 * `tsc -p electron/tsconfig.json` (Node types, no DOM, no alias) does not
 * type-check the renderer tree; the renderer's own `tsc` does.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RendererModule = Record<string, any>;
function renderer(specifier: string): Promise<RendererModule> {
  return import(/* @vite-ignore */ specifier) as Promise<RendererModule>;
}

/** The renderer bridge, as the preload exposes it, onto Main's handler. */
function installRendererBridge(rig: Rig): void {
  const invoke = async (cmd: string, args?: Record<string, unknown>) => {
    const envelope = await rig.route(cmd, args);
    if (cmd === "db_execute") {
      rig.statements.push({
        sql: String(args?.sql),
        ok: envelope.ok,
        error: envelope.ok ? undefined : envelope.error,
      });
    }
    return envelope;
  };
  (globalThis as Record<string, unknown>).window = {
    grimodex: { invoke },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };
}

describe("DA-2b renderer writers through the real router, gate and Native", () => {
  it("restricted: Map, Label, Prompt template, the pin's children and the CW deletion", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grimodex-d2b-renderer-"));
    roots.push(root);
    const appData = path.join(realpathSync(root), "app-data");
    mkdirSync(appData, { recursive: true });
    const rig = await startMain(appData);

    // Seed while unrestricted (the generic SQL is open then).
    const seeded = ok<{ path: string; projectId: string }>(
      await rig.route("seed_sample_workspace", {
        language: "ja",
        aiPolicy: '{"preset":"full"}',
      }),
    );
    ok(await rig.route("open_workspace", { path: seeded.path }));
    const projectId = seeded.projectId;
    const run = async (sql: string, params: unknown[] = []) =>
      ok(await rig.route("db_execute", { sql, params, method: "run" }));
    const rows = async <T = Record<string, unknown>>(
      sql: string,
      params: unknown[] = [],
    ): Promise<T[]> =>
      ok<{ rows: T[] }>(
        await rig.route("db_execute", { sql, params, method: "all" }),
      ).rows;
    const [{ id: codexId }] = await rows<{ id: string }>(
      "SELECT id FROM codex_entries WHERE project_id = ? ORDER BY id LIMIT 1",
      [projectId],
    );
    await run(
      "INSERT INTO chat_sessions(id, project_id, title) VALUES ('rw-a', ?, 'a'), ('rw-b', ?, 'b')",
      [projectId, projectId],
    );
    await run(
      "INSERT INTO chat_messages(id, session_id, role, content, created_at) VALUES ('rw-m1', 'rw-b', 'user', 'x', '2026-10-25T00:00:00.000Z')",
    );
    await run(
      "INSERT INTO chat_session_pinned_codex(id, session_id, codex_entry_id) VALUES ('rw-pin', 'rw-a', ?)",
      [codexId],
    );

    await rig.activate();
    expect(rig.gate.restricted).toBe(true);
    // The model the renderer tests use matches the real gate on these shapes.
    expect(
      (
        await rig.route("db_execute", {
          sql: "UPDATE map_boards SET title = 'x' WHERE id = 'none' RETURNING id",
          params: [],
          method: "all",
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await rig.route("db_execute", {
          sql: "DELETE FROM chat_sessions WHERE id = 'rw-b'",
          params: [],
          method: "run",
        })
      ).ok,
    ).toBe(false);

    installRendererBridge(rig);
    const { setCurrentWorkspaceIdentity } = await renderer(
      "@/runtime/workspaceIdentity",
    );
    setCurrentWorkspaceIdentity({ path: seeded.path, openRevision: 1 });
    const mapApi = await renderer("@/features/map/mapApi");
    const { createLabel, updateLabel } = await renderer(
      "@/features/labels/labelApi",
    );
    const { createPromptTemplate, updatePromptTemplate } = await renderer(
      "@/features/prompt-library/api",
    );
    const chatApi = await renderer("@/features/chat/chatApi");

    const board = await mapApi.createBoard(projectId, "B");
    const renamed = await mapApi.renameBoard(board.id, "C");
    expect(renamed?.title).toBe("C");
    const { sticky, position } = await mapApi.createSticky({
      boardId: board.id,
      x: 1,
      y: 2,
      title: "S",
    });
    const edited = await mapApi.updateSticky(sticky.id, { title: "T" });
    expect(edited?.title).toBe("T");
    const moved = await mapApi.upsertNodePosition({
      boardId: board.id,
      nodeRefType: "sticky",
      stickyId: sticky.id,
      x: 5,
      y: 6,
    });
    expect([moved.id, moved.x, moved.y]).toEqual([position.id, 5, 6]);
    expect(
      await rows("SELECT title FROM map_stickies WHERE id = ?", [sticky.id]),
    ).toEqual([{ title: "T" }]);

    const label = await createLabel({
      id: "rw-label",
      projectId,
      name: "L",
      color: "#123456",
    });
    expect(label.name).toBe("L");
    expect((await updateLabel("rw-label", { name: "M" }))?.name).toBe("M");

    const template = await createPromptTemplate({
      id: "rw-template",
      projectId,
      title: "P",
      content: "c",
    });
    expect(template.title).toBe("P");
    expect(
      (await updatePromptTemplate(projectId, "rw-template", { title: "Q" }))
        ?.title,
    ).toBe("Q");

    await chatApi.togglePinChildren("rw-a", codexId, true);
    expect(
      await rows(
        "SELECT with_children FROM chat_session_pinned_codex WHERE id = 'rw-pin'",
      ),
    ).toEqual([{ with_children: 1 }]);

    // CW 5 through the typed writer: the session and (FK) its message go.
    await chatApi.deleteSession("rw-b");
    expect(
      await rows(
        "SELECT id FROM chat_sessions WHERE id LIKE 'rw-%' ORDER BY id",
      ),
    ).toEqual([{ id: "rw-a" }]);
    expect(
      await rows("SELECT id FROM chat_messages WHERE id = 'rw-m1'"),
    ).toEqual([]);

    // Every statement the renderer sent passed the real gate, none used
    // RETURNING, and none was a refused one.
    expect(rig.statements.length).toBeGreaterThan(0);
    expect(rig.statements.filter((s) => !s.ok)).toEqual([]);
    expect(rig.statements.filter((s) => /\breturning\b/i.test(s.sql))).toEqual(
      [],
    );
    expect(rig.statements.some((s) => s.error?.includes(MARKER))).toBe(false);
  });
});

// DR-UND-1 (docs/plans/tree-undo-restore-decisions.md): the Undo of a delete puts
// the database row back, through the renderer's own API functions, the real
// router (argument validation, authority binding), and the real Native addon.
//
//   (1) a scene and a note: create, edit, delete (a real Undo Journal), then the
//       Undo's `tree_node_create` with `restoreState` -> the row equals the row
//       before the delete (version, updated_at and char_count are not restored)
//   (2) the response carries the new OCC token and the resolved references
//   (3) Main refuses `restoreState` for any origin but undo and an unknown key;
//       a Codex entry that vanished becomes NULL
//   (4) a folder with a child: the folder comes back, the child's create is
//       still refused by the Undo Journal binding (an existing defect, pinned)
//   (5) the reading-order input the AI reads (`readReadInputs`) is what it was
//       before the delete (the store/DB divergence of DR-MP4-8 is closed)
//
// The real addon is needed (`pnpm napi:build`), so only
// `vitest.electron-native.config.ts` runs it:
//   pnpm exec vitest --config vitest.electron-native.config.ts --run electron/main/treeUndoRestore.pipeline.spec.ts
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Envelope, NapiBackendLike } from "../shared/ipcContract.js";
import { createCoreReadDb } from "../shared/readDomain/core/readDb.js";
import { readReadInputs } from "../shared/readDomain/core/readInputsReader.js";
import { createMainReadDb } from "./mastraRead/db.js";

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
// Renderer side effects outside the writers under test (a workspace without a
// writing timelapse).
vi.mock("@/features/timelapse/recorder", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getRecorderSessionId: vi.fn(() => "t-session"),
  isRecorderEnabled: vi.fn(() => false),
  recordChangeEvent: vi.fn(),
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

interface Rig {
  route: (cmd: string, args?: Record<string, unknown>) => Promise<Envelope>;
  backend: NativeBackendInstance;
  identity: unknown;
}

async function startMain(appData: string): Promise<Rig> {
  mocks.handlers.clear();
  const backend = new NativeBackend(appData);
  backends.push(backend);
  const { createProfileEgressGate } = await import("./profileEgress.js");
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
    backend,
    identity: gate.issueCallerIdentity(7),
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

interface Workspace {
  rig: Rig;
  projectId: string;
  codexId: string;
  rows: <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<T[]>;
}

let shared: Promise<Workspace> | undefined;
function workspace(): Promise<Workspace> {
  shared ??= (async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grimodex-tree-undo-"));
    roots.push(root);
    const appData = path.join(realpathSync(root), "app-data");
    mkdirSync(appData, { recursive: true });
    const rig = await startMain(appData);
    const seeded = ok<{ path: string; projectId: string }>(
      await rig.route("seed_sample_workspace", {
        language: "ja",
        aiPolicy: '{"preset":"full"}',
      }),
    );
    ok(await rig.route("open_workspace", { path: seeded.path }));
    const rows = async <T = Record<string, unknown>>(
      sql: string,
      params: unknown[] = [],
    ): Promise<T[]> =>
      ok<{ rows: T[] }>(
        await rig.route("db_execute", { sql, params, method: "all" }),
      ).rows;
    const [{ id: codexId }] = await rows<{ id: string }>(
      "SELECT id FROM codex_entries WHERE project_id = ? ORDER BY id LIMIT 1",
      [seeded.projectId],
    );
    // The renderer bridge, as the preload exposes it, onto Main's handler.
    (globalThis as Record<string, unknown>).window = {
      grimodex: {
        invoke: (cmd: string, args?: Record<string, unknown>) =>
          rig.route(cmd, args),
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    };
    const { setCurrentWorkspaceIdentity } = await renderer(
      "@/runtime/workspaceIdentity",
    );
    setCurrentWorkspaceIdentity({ path: seeded.path, openRevision: 1 });
    const { publishCurrentProjectId } = await renderer(
      "@/application/project/currentProjectAuthority",
    );
    publishCurrentProjectId(seeded.projectId);
    return { rig, projectId: seeded.projectId, codexId, rows };
  })();
  return shared;
}

const COLUMNS = `parent_id, node_type, title, sort_order, synopsis, status, content,
  intent, story_time_order, story_time_label, pov_character_id, location_id,
  context_mode, aliases, excluded_aliases, unplaced_beats_doc,
  unplaced_beat_preview, placed_beat_preview, source_uri, source_mtime,
  created_at, chronicle_start_time, chronicle_start_minute,
  chronicle_start_granularity, chronicle_end_time, chronicle_end_minute,
  chronicle_end_granularity, chronicle_precision`;

async function row(w: Workspace, id: string): Promise<Record<string, unknown>> {
  const found = await w.rows(
    `SELECT ${COLUMNS}, version, updated_at FROM tree_nodes WHERE id = ?`,
    [id],
  );
  return found[0] ?? {};
}

const withoutToken = (r: Record<string, unknown>): Record<string, unknown> => {
  const copy = { ...r };
  delete copy.version;
  delete copy.updated_at;
  return copy;
};

interface Deleted {
  before: Record<string, unknown>;
  snapshot: Record<string, unknown>;
  receipt: unknown;
}

/** What `treeStore.deleteNode` does before and during a delete. */
async function deleteLikeTheStore(w: Workspace, id: string): Promise<Deleted> {
  const api = await renderer("@/features/tree/api");
  const before = await row(w, id);
  const snapshot = await api.loadTreeNodeRestoreSnapshot(id);
  const receipt = await api.deleteNode(id, w.projectId);
  expect(await w.rows("SELECT id FROM tree_nodes WHERE id = ?", [id])).toEqual(
    [],
  );
  return { before, snapshot, receipt };
}

/** What `treeStore.restorePersisted` does for one node. */
async function undoLikeTheStore(
  w: Workspace,
  id: string,
  deleted: Deleted,
  overrides: { restoreState?: Record<string, unknown> } = {},
): Promise<Record<string, unknown>> {
  const api = await renderer("@/features/tree/api");
  const b = deleted.before;
  const snapshot = deleted.snapshot as {
    content: string;
    sourceUri: string | null;
    sourceMtime: string | null;
    restoreState: Record<string, unknown>;
  };
  return api.createNode(
    {
      id,
      projectId: w.projectId,
      parentId: (b.parent_id as string | null) ?? undefined,
      nodeType: b.node_type,
      title: b.title,
      synopsis: (b.synopsis as string | null) ?? undefined,
      sortOrder: b.sort_order,
      status: (b.status as string | null) ?? undefined,
      content: snapshot.content,
      ...(snapshot.sourceUri ? { sourceUri: snapshot.sourceUri } : {}),
      ...(snapshot.sourceMtime ? { sourceMtime: snapshot.sourceMtime } : {}),
    },
    {
      writeContext: api.historyWriteContext("undo", deleted.receipt),
      restoreState: overrides.restoreState ?? snapshot.restoreState,
    },
  );
}

async function makeScene(
  w: Workspace,
  id: string,
  parentId?: string,
): Promise<void> {
  const api = await renderer("@/features/tree/api");
  await api.createNode({
    id,
    projectId: w.projectId,
    parentId,
    nodeType: "scene",
    title: `Scene ${id}`,
    sortOrder: `n${id.length}${id}`,
    synopsis: "syn",
    sourceUri: `external-root://undo/${id}.md`,
    sourceMtime: "2026-01-01T00:00:00Z",
  });
  await api.updateNode(id, { intent: "goal", locationId: w.codexId });
  await api.updateNode(id, { povCharacterId: w.codexId });
  const current = await api.getNode(id);
  await api.updateTemporalScene(id, {
    storyTimeOrder: "b3",
    storyTimeLabel: "night",
    chronicleStartTime: 100,
    chronicleStartMinute: 540,
    chronicleStartGranularity: "time",
    chronicleEndTime: 101,
    chronicleEndMinute: null,
    chronicleEndGranularity: "day",
    chroniclePrecision: "approx",
    baseVersion: current.version,
  });
  await api.updateNode(id, { content: '{"type":"doc","content":[]}' });
}

describe("DR-UND-1: the Undo of a delete restores the row (real router, real Native)", () => {
  beforeAll(async () => {
    await workspace();
  });

  it("(1)(2) a scene comes back as it was, and the response carries the new token", async () => {
    const w = await workspace();
    await makeScene(w, "undo-scene-1");
    const deleted = await deleteLikeTheStore(w, "undo-scene-1");
    expect(deleted.before.story_time_order).toBe("b3");
    expect(deleted.before.chronicle_start_time).toBe(100);

    const created = await undoLikeTheStore(w, "undo-scene-1", deleted);
    const after = await row(w, "undo-scene-1");
    expect(withoutToken(after)).toEqual(withoutToken(deleted.before));
    expect(created).toMatchObject({
      id: "undo-scene-1",
      version: 0,
      povCharacterId: w.codexId,
      locationId: w.codexId,
    });
    expect(typeof created.updatedAt).toBe("string");
    // version and updated_at are not rolled back.
    expect(after.version).toBe(0);
    expect(after.updated_at).toBe(created.updatedAt);
  });

  it("(1) a note comes back with its AI context settings and its edited body", async () => {
    const w = await workspace();
    const api = await renderer("@/features/tree/api");
    await api.createNode({
      id: "undo-note-1",
      projectId: w.projectId,
      nodeType: "note",
      title: "Note",
      sortOrder: "n1",
    });
    await api.updateNode("undo-note-1", {
      contextMode: "hidden",
      aliases: '["a"]',
      excludedAliases: '["b"]',
      content: '{"type":"doc","edited":true}',
    });
    const deleted = await deleteLikeTheStore(w, "undo-note-1");
    expect(deleted.before.context_mode).toBe("hidden");
    await undoLikeTheStore(w, "undo-note-1", deleted);
    expect(withoutToken(await row(w, "undo-note-1"))).toEqual(
      withoutToken(deleted.before),
    );
  });

  it("(3) a Codex entry that vanished while the node was gone becomes NULL", async () => {
    const w = await workspace();
    await makeScene(w, "undo-scene-3");
    const deleted = await deleteLikeTheStore(w, "undo-scene-3");
    const created = await undoLikeTheStore(w, "undo-scene-3", deleted, {
      restoreState: {
        ...(deleted.snapshot.restoreState as Record<string, unknown>),
        povCharacterId: "codex-that-never-existed",
      },
    });
    expect(created.povCharacterId).toBeNull();
    expect((await row(w, "undo-scene-3")).pov_character_id).toBeNull();
  });

  it("(3) Main refuses restoreState for a human create and an unknown key", async () => {
    const w = await workspace();
    const api = await renderer("@/features/tree/api");
    await expect(
      api.createNode(
        {
          id: "undo-forged",
          projectId: w.projectId,
          nodeType: "scene",
          title: "Forged",
          sortOrder: "n9",
        },
        { restoreState: { intent: "x" } },
      ),
    ).rejects.toThrow();
    expect(
      await w.rows("SELECT id FROM tree_nodes WHERE id = 'undo-forged'"),
    ).toEqual([]);

    await makeScene(w, "undo-scene-4");
    const deleted = await deleteLikeTheStore(w, "undo-scene-4");
    await expect(
      undoLikeTheStore(w, "undo-scene-4", deleted, {
        restoreState: { bogus: "x" },
      }),
    ).rejects.toThrow();
    expect(
      await w.rows("SELECT id FROM tree_nodes WHERE id = 'undo-scene-4'"),
    ).toEqual([]);
  });

  it("(4) a folder with a child: the folder comes back, the child's create is still refused (existing defect)", async () => {
    const w = await workspace();
    const api = await renderer("@/features/tree/api");
    await api.createNode({
      id: "undo-folder-1",
      projectId: w.projectId,
      nodeType: "folder",
      title: "Folder",
      sortOrder: "n2",
    });
    await makeScene(w, "undo-child-1", "undo-folder-1");
    const folderBefore = await row(w, "undo-folder-1");
    const childBefore = await row(w, "undo-child-1");
    const childSnapshot = await api.loadTreeNodeRestoreSnapshot("undo-child-1");
    const folderSnapshot =
      await api.loadTreeNodeRestoreSnapshot("undo-folder-1");
    const receipt = await api.deleteNode("undo-folder-1", w.projectId);

    await undoLikeTheStore(w, "undo-folder-1", {
      before: folderBefore,
      snapshot: folderSnapshot,
      receipt,
    });
    expect(withoutToken(await row(w, "undo-folder-1"))).toEqual(
      withoutToken(folderBefore),
    );
    await expect(
      undoLikeTheStore(w, "undo-child-1", {
        before: childBefore,
        snapshot: childSnapshot,
        receipt,
      }),
    ).rejects.toThrow(/replay target|Undo Journal/);
  });

  it("(5) the reading-order input the AI reads is what it was before the delete", async () => {
    const w = await workspace();
    await makeScene(w, "undo-scene-5");
    const read = async () => {
      const db = createCoreReadDb(
        createMainReadDb({
          backend: {
            dbExecute: (...args: Parameters<NapiBackendLike["dbExecute"]>) =>
              w.rig.backend.dbExecute(...args),
          },
          identity: w.rig.identity,
        } as never),
      );
      const inputs = await readReadInputs(db, {
        projectId: w.projectId,
        currentSceneId: null,
      });
      return {
        scheduledSceneCount: inputs.sceneTimeIndex.scheduledSceneCount,
        explicit: inputs.sceneTimeIndex.explicitStoryOrder.get("undo-scene-5"),
        reading: inputs.readingOrder.has("undo-scene-5"),
      };
    };
    const before = await read();
    expect(before.explicit).toBe("b3");
    const deleted = await deleteLikeTheStore(w, "undo-scene-5");
    const during = await read();
    expect(during.scheduledSceneCount).toBe(before.scheduledSceneCount - 1);
    await undoLikeTheStore(w, "undo-scene-5", deleted);
    expect(await read()).toEqual(before);
  });
});

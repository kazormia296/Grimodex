// NIR-1 PUB-G prerequisite 34 (inventory row 34; continuation plan
// "DA-2a／DA-2b の引き継ぎ" (6); DR-DA2B-R11 (a)): the typed writers that the
// real-Electron restricted run could not reach, called by the renderer's own
// functions, through the real router, the real profile gate and the real
// Native addon.
//
//   CW 4   `chatApi.deleteMessage` / `deleteMessages`  -> `chat_messages_delete`
//   T      `impactBaselineVisibility` (baseline CAS)  -> `impact_review_baseline_update_visibility`
//   M      `createProjectSnapshot` / `deleteProjectSnapshot`
//                                                       -> `project_snapshot_create` / `_delete`
//   D      `importChatSessionsBatch` (the chat part of an import; a generic
//          INSERT that is refused while restricted and must be counted, not
//          dropped silently)
//
// `d2bRendererWriters.pipeline.spec.ts` covers Map, Label, Prompt template, the
// pin's children and CW 5. This spec adds the rest of the list. Its bridge is the
// same: `window.grimodex.invoke` is a shim onto Main's `grim:invoke` handler, so
// `src/lib/tauri.ts` and the Drizzle sqlite-proxy client run unchanged, every
// request is re-validated by Main (`NAPI_COMMANDS`), classified by the gate and
// answered by the N-API addon over the shared Rust.
//
// The writers are exercised unrestricted first (the control), then restricted
// (the profile after activation), so a refusal is attributable to the gate and
// not to the renderer's call shape.
//
// The real addon is needed, so only `vitest.electron-native.config.ts` runs it.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
// The recorder is off, as in a workspace without a writing timelapse: an import
// does not re-anchor timelapse baselines (not under test).
vi.mock("@/features/timelapse/recorder", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getRecorderSessionId: vi.fn(() => "t-session"),
  isRecorderEnabled: vi.fn(() => false),
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
  /** Every request the renderer sent, with Main's answer (args are not kept). */
  sent: Array<{ cmd: string; sql?: string; ok: boolean; error?: string }>;
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
    sent: [],
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

function refusedBy(envelope: Envelope): string {
  if (envelope.ok) throw new Error("expected a refusal, got ok");
  return envelope.error;
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
function installRendererBridge(
  rig: Rig,
  /** Runs before a request is routed (a concurrent writer, in the CAS test). */
  beforeRoute?: (cmd: string, args?: Record<string, unknown>) => Promise<void>,
): void {
  const invoke = async (cmd: string, args?: Record<string, unknown>) => {
    await beforeRoute?.(cmd, args);
    const envelope = await rig.route(cmd, args);
    rig.sent.push({
      cmd,
      sql: cmd === "db_execute" ? String(args?.sql) : undefined,
      ok: envelope.ok,
      error: envelope.ok ? undefined : envelope.error,
    });
    return envelope;
  };
  (globalThis as Record<string, unknown>).window = {
    grimodex: { invoke },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };
}

/** The renderer's `stableHash` (32-bit FNV-1a over UTF-16 code units). */
function stableHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

interface Seeded {
  rig: Rig;
  workspacePath: string;
  projectId: string;
  codexId: string;
  run: (sql: string, params?: unknown[]) => Promise<unknown>;
  rows: <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<T[]>;
}

/** One workspace for the whole file: seeded unrestricted, bridged to the renderer. */
let sharedRig: Promise<Seeded> | undefined;
function workspace(): Promise<Seeded> {
  sharedRig ??= (async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grimodex-pubg-writers-"));
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
      [seeded.projectId],
    );
    installRendererBridge(rig);
    const { setCurrentWorkspaceIdentity } = await renderer(
      "@/runtime/workspaceIdentity",
    );
    setCurrentWorkspaceIdentity({ path: seeded.path, openRevision: 1 });
    const { publishCurrentProjectId } = await renderer(
      "@/application/project/currentProjectAuthority",
    );
    publishCurrentProjectId(seeded.projectId);
    return {
      rig,
      workspacePath: seeded.path,
      projectId: seeded.projectId,
      codexId,
      run,
      rows,
    };
  })();
  return sharedRig;
}

/** The profile after activation: the generic SQL is closed from here on. */
async function restrict(w: Seeded): Promise<void> {
  if (w.rig.gate.restricted) return;
  await w.rig.activate();
  expect(w.rig.gate.restricted).toBe(true);
}

const snapshotFixture = {
  visibilityProvenanceVersion: 1,
  allPhaseIds: ["p1", "p2"],
  restrictedPhaseIds: [] as string[],
  visibleDeletedPhaseIds: [] as string[],
  phases: [{ phaseId: "p1" }, { phaseId: "p2" }],
  name: "N",
};

async function seedChatSession(w: Seeded, sessionId: string): Promise<void> {
  await w.run(
    "INSERT INTO chat_sessions(id, project_id, title) VALUES (?, ?, ?)",
    [sessionId, w.projectId, sessionId],
  );
  const roles = ["user", "assistant", "user", "assistant"];
  for (const [i, role] of roles.entries()) {
    await w.run(
      "INSERT INTO chat_messages(id, session_id, role, content, created_at) VALUES (?, ?, ?, 'x', ?)",
      [
        `${sessionId}-m${i + 1}`,
        sessionId,
        role,
        `2026-11-08T00:00:0${i}.000Z`,
      ],
    );
  }
}

const messageIds = async (w: Seeded, sessionId: string) =>
  (
    await w.rows<{ id: string }>(
      "SELECT id FROM chat_messages WHERE session_id = ? ORDER BY created_at, id",
      [sessionId],
    )
  ).map((r) => r.id);

interface BaselineRow {
  project_id: string;
  snapshot_json: string;
  content_hash: string;
}
const baselineRow = async (w: Seeded): Promise<BaselineRow> =>
  (
    await w.rows<BaselineRow>(
      "SELECT project_id, snapshot_json, content_hash FROM impact_review_baselines WHERE entry_id = ?",
      [w.codexId],
    )
  )[0];

const importedChapters = (prefix: string) => [
  {
    id: `${prefix}-chapter`,
    title: "Imported chapter",
    scenes: [{ id: `${prefix}-scene`, title: "Imported scene", body: "text" }],
  },
];

const importedSessions = (prefix: string) =>
  ["a", "b", "c"].map((id) => ({
    id: `${prefix}-${id}`,
    title: `Chat ${id}`,
    titleFromFrontmatter: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    messages: [
      { role: "user", content: `hello ${id}` },
      { role: "assistant", content: `reply ${id}` },
    ],
  }));

describe("PUB-G 34: renderer typed writers through the real router, gate and Native", () => {
  // The restricted specs' fixtures (a conversation and the baseline row) are
  // seeded here, before any spec and before `restrict()` closes the generic SQL
  // for good, so that each spec also passes when it runs alone (`-t`, a retry).
  beforeAll(async () => {
    const w = await workspace();
    expect(w.rig.gate.restricted).toBe(false);
    const { saveBaseline } = await renderer(
      "@/features/impact-review/baseline",
    );
    await seedChatSession(w, "cw4-closed");
    await saveBaseline(w.projectId, w.codexId, snapshotFixture);
  });

  // The control runs unrestricted: the same renderer calls, so a restricted
  // failure below is the gate's and not the call shape's. `restrict()` is
  // one-way, so the control is the first spec of the file (declaration order);
  // the restricted specs do not depend on it.
  it("control (unrestricted): the same renderer calls succeed on the open generic SQL", async () => {
    const w = await workspace();
    expect(w.rig.gate.restricted).toBe(false);
    const chatApi = await renderer("@/features/chat/chatApi");
    const { saveBaseline, getBaseline } = await renderer(
      "@/features/impact-review/baseline",
    );
    const { markImpactBaselinePhasesRestricted } = await renderer(
      "@/features/codex/impactBaselineVisibility",
    );
    const { createProjectSnapshot, deleteProjectSnapshot } = await renderer(
      "@/features/revision/projectSnapshotApi",
    );
    const { importChatSessionsBatch, importChapters } = await renderer(
      "@/features/import/importApi",
    );

    // CW 4.
    await seedChatSession(w, "cw4-open");
    await chatApi.deleteMessage("cw4-open-m2");
    expect(await messageIds(w, "cw4-open")).toEqual([
      "cw4-open-m1",
      "cw4-open-m3",
      "cw4-open-m4",
    ]);

    // Baseline: the renderer's own `saveBaseline` writes the row (the
    // restricted tests' `beforeAll` seeds the same one) that the restricted
    // tests then update only through the typed writer.
    await saveBaseline(w.projectId, w.codexId, snapshotFixture);
    await markImpactBaselinePhasesRestricted(w.codexId);
    expect(await getBaseline(w.codexId)).toMatchObject({
      restrictedPhaseIds: ["p1", "p2"],
    });
    // Back to the fixture, so the restricted test starts from a known row.
    await saveBaseline(w.projectId, w.codexId, snapshotFixture);

    // Snapshot: create and delete.
    const created = await createProjectSnapshot({ name: "open" });
    expect(created.entryCount).toBeGreaterThan(0);
    await deleteProjectSnapshot(created.id);
    expect(
      await w.rows("SELECT id FROM project_snapshots WHERE id = ?", [
        created.id,
      ]),
    ).toEqual([]);

    // An import: the chapters (typed Native writers) and then the chat part.
    expect(await importChapters(importedChapters("imp-open"))).toMatchObject({
      imported: 2,
      errors: [],
    });
    await expect(
      importChatSessionsBatch(importedSessions("imp-open")),
    ).resolves.toEqual({ imported: 3, errors: [], notImported: 0 });
    expect(
      await w.rows<{ n: number }>(
        "SELECT count(*) AS n FROM chat_messages WHERE session_id LIKE 'imp-open-%'",
      ),
    ).toEqual([{ n: 6 }]);
  });

  it("CW 4 restricted: deleteMessage / deleteMessages reach chat_messages_delete", async () => {
    const w = await workspace();
    await restrict(w);
    const { deleteMessage, deleteMessages } = await renderer(
      "@/features/chat/chatApi",
    );
    const { setCurrentWorkspaceIdentity } = await renderer(
      "@/runtime/workspaceIdentity",
    );
    const sentBefore = w.rig.sent.length;

    // The generic statement is closed now, so the typed writer is the only way.
    expect(
      refusedBy(
        await w.rig.route("db_execute", {
          sql: "DELETE FROM chat_messages WHERE id = 'cw4-closed-m1'",
          params: [],
          method: "run",
        }),
      ),
    ).toContain(MARKER);

    await deleteMessage("cw4-closed-m2");
    expect(await messageIds(w, "cw4-closed")).toEqual([
      "cw4-closed-m1",
      "cw4-closed-m3",
      "cw4-closed-m4",
    ]);
    // A user row and the rows after it go in one call (edit and resend).
    await deleteMessages(["cw4-closed-m3", "cw4-closed-m4"]);
    expect(await messageIds(w, "cw4-closed")).toEqual(["cw4-closed-m1"]);
    // A row that is already gone writes nothing and is not an error.
    await deleteMessage("cw4-closed-gone");
    expect(await messageIds(w, "cw4-closed")).toEqual(["cw4-closed-m1"]);

    // Native re-checks the workspace binding the renderer sent: a stale
    // identity is refused with the typed prefix and nothing is deleted.
    setCurrentWorkspaceIdentity({
      path: `${w.workspacePath}-other`,
      openRevision: 2,
    });
    await expect(deleteMessage("cw4-closed-m1")).rejects.toThrow(
      /CHAT_WRITE_REFUSED/,
    );
    setCurrentWorkspaceIdentity({ path: w.workspacePath, openRevision: 1 });
    expect(await messageIds(w, "cw4-closed")).toEqual(["cw4-closed-m1"]);

    // Main re-validates the payload before Native sees it.
    const scope = {
      expectedWorkspacePath: w.workspacePath,
      projectId: w.projectId,
      sessionId: "cw4-closed",
    };
    for (const payload of [
      { ...scope, messageIds: ["cw4-closed-m1"], extra: 1 },
      { ...scope, messageIds: [] },
      { ...scope, messageIds: [""] },
    ]) {
      expect(
        refusedBy(await w.rig.route("chat_messages_delete", { payload })),
      ).toMatch(/invalid args/);
    }
    expect(await messageIds(w, "cw4-closed")).toEqual(["cw4-closed-m1"]);

    const sent = w.rig.sent.slice(sentBefore);
    // deleteMessage, deleteMessages, then the stale identity; the absent id
    // never reached Native.
    expect(
      sent.filter((s) => s.cmd === "chat_messages_delete").map((s) => s.ok),
    ).toEqual([true, true, false]);
    expect(sent.filter((s) => s.sql && /\bdelete\b/i.test(s.sql))).toEqual([]);
  });

  it("baseline CAS restricted: impact_review_baseline_update_visibility, including a lost CAS", async () => {
    const w = await workspace();
    await restrict(w);
    const { getBaseline } = await renderer("@/features/impact-review/baseline");
    const {
      markImpactBaselinePhasesRestricted,
      markImpactBaselinePhaseVisible,
      markImpactBaselinePhaseVisibleDeleted,
    } = await renderer("@/features/codex/impactBaselineVisibility");
    const entryId = w.codexId;
    const sentBefore = w.rig.sent.length;

    // `impact_review_baselines` is read-open: the generic UPDATE is refused.
    expect(
      refusedBy(
        await w.rig.route("db_execute", {
          sql: "UPDATE impact_review_baselines SET content_hash = 'x' WHERE entry_id = ?",
          params: [entryId],
          method: "run",
        }),
      ),
    ).toContain(MARKER);
    expect(await getBaseline(entryId)).toMatchObject({
      restrictedPhaseIds: [],
    });

    await markImpactBaselinePhasesRestricted(entryId);
    expect(await getBaseline(entryId)).toMatchObject({
      restrictedPhaseIds: ["p1", "p2"],
      visibleDeletedPhaseIds: [],
      name: "N",
    });
    await markImpactBaselinePhaseVisible(entryId, "p1");
    expect(await getBaseline(entryId)).toMatchObject({
      restrictedPhaseIds: ["p2"],
    });
    await markImpactBaselinePhaseVisibleDeleted(entryId, "p1", false);
    expect(await getBaseline(entryId)).toMatchObject({
      restrictedPhaseIds: ["p2"],
      visibleDeletedPhaseIds: ["p1"],
    });

    // A competing writer commits between the renderer's read and its write.
    // Native answers `updated: false` to the stale hash, the renderer re-reads
    // and retries, and neither update is lost.
    let competed = 0;
    installRendererBridge(w.rig, async (cmd) => {
      if (cmd !== "impact_review_baseline_update_visibility" || competed)
        return;
      competed++;
      const current = await baselineRow(w);
      const next = JSON.parse(current.snapshot_json) as typeof snapshotFixture;
      next.restrictedPhaseIds = [...next.restrictedPhaseIds, "p1"].sort();
      const nextJson = JSON.stringify(next);
      expect(
        ok(
          await w.rig.route("impact_review_baseline_update_visibility", {
            payload: {
              projectId: current.project_id,
              entryId,
              expectedContentHash: current.content_hash,
              snapshotJson: nextJson,
              contentHash: stableHash(nextJson),
            },
          }),
        ),
      ).toEqual({ updated: true });
    });
    await markImpactBaselinePhaseVisible(entryId, "p2");
    expect(competed).toBe(1);
    expect(await getBaseline(entryId)).toMatchObject({
      restrictedPhaseIds: ["p1"],
      visibleDeletedPhaseIds: ["p1"],
    });
    // The lost CAS is `updated: false` in an ok envelope; the retry then wins.
    // The bridge's `sent` log only has the renderer's own calls (the competitor
    // used `route` directly), so the renderer made two attempts.
    expect(
      w.rig.sent
        .slice(sentBefore)
        .filter((s) => s.cmd === "impact_review_baseline_update_visibility"),
    ).toHaveLength(2 + 1 + 1 + 1);

    // Native refuses a write that is not visibility-only, a hash that is not
    // the FNV-1a of the JSON, and Main refuses an extra key; the row stays.
    const stored = await baselineRow(w);
    const tampered = JSON.stringify({
      ...JSON.parse(stored.snapshot_json),
      name: "changed",
    });
    const cas = (payload: Record<string, unknown>) =>
      w.rig.route("impact_review_baseline_update_visibility", {
        payload: {
          projectId: stored.project_id,
          entryId,
          expectedContentHash: stored.content_hash,
          ...payload,
        },
      });
    expect(
      refusedBy(
        await cas({
          snapshotJson: tampered,
          contentHash: stableHash(tampered),
        }),
      ),
    ).toMatch(/IMPACT_BASELINE_WRITE_REFUSED:not-visibility-only/);
    expect(
      refusedBy(
        await cas({
          snapshotJson: stored.snapshot_json,
          contentHash: "00000000",
        }),
      ),
    ).toMatch(/IMPACT_BASELINE_WRITE_REFUSED:hash-mismatch/);
    expect(
      refusedBy(
        await cas({
          snapshotJson: stored.snapshot_json,
          contentHash: stored.content_hash,
          extra: true,
        }),
      ),
    ).toMatch(/invalid args/);
    expect(await baselineRow(w)).toEqual(stored);
    expect(
      w.rig.sent.filter((s) => s.sql && s.error?.includes(MARKER)),
    ).toEqual([]);
  });

  it("snapshot restricted: createProjectSnapshot and deleteProjectSnapshot reach the typed writers", async () => {
    const w = await workspace();
    await restrict(w);
    const {
      createProjectSnapshot,
      deleteProjectSnapshot,
      listProjectSnapshots,
    } = await renderer("@/features/revision/projectSnapshotApi");
    const { publishCurrentProjectId } = await renderer(
      "@/application/project/currentProjectAuthority",
    );
    const sentBefore = w.rig.sent.length;
    const count = async (table: string, column: string, id: string) =>
      Number(
        (
          await w.rows<{ n: number }>(
            `SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`,
            [id],
          )
        )[0].n,
      );
    const versions = async () =>
      Number(
        (
          await w.rows<{ n: number }>(
            "SELECT count(*) AS n FROM content_versions",
          )
        )[0].n,
      );

    // The snapshot tables are read-open: no generic DELETE.
    expect(
      refusedBy(
        await w.rig.route("db_execute", {
          sql: "DELETE FROM project_snapshots",
          params: [],
          method: "run",
        }),
      ),
    ).toContain(MARKER);

    const created = await createProjectSnapshot({
      name: "restricted",
      description: "d",
    });
    expect(created.entryCount).toBeGreaterThan(0);
    expect(await count("project_snapshots", "id", created.id)).toBe(1);
    expect(
      await count("project_snapshot_entries", "snapshot_id", created.id),
    ).toBeGreaterThan(0);
    expect(
      await count("project_snapshot_aux", "snapshot_id", created.id),
    ).toBeGreaterThan(0);
    const listed = await listProjectSnapshots();
    expect(
      listed.find((s: { id: string }) => s.id === created.id),
    ).toMatchObject({ name: "restricted", isStructural: true });

    // An id that is not the current project's deletes nothing.
    publishCurrentProjectId("another-project");
    await deleteProjectSnapshot(created.id);
    publishCurrentProjectId(w.projectId);
    expect(await count("project_snapshots", "id", created.id)).toBe(1);

    const versionsBefore = await versions();
    await deleteProjectSnapshot(created.id);
    expect(await count("project_snapshots", "id", created.id)).toBe(0);
    expect(
      await count("project_snapshot_entries", "snapshot_id", created.id),
    ).toBe(0);
    expect(await count("project_snapshot_aux", "snapshot_id", created.id)).toBe(
      0,
    );
    expect(
      await count("project_snapshot_tree_nodes", "snapshot_id", created.id),
    ).toBe(0);
    // The snapshot's bodies are content_versions rows; deleting it keeps them.
    expect(await versions()).toBe(versionsBefore);

    // Main re-validates the create payload (exact keys) before Native.
    expect(
      refusedBy(
        await w.rig.route("project_snapshot_create", {
          payload: { projectId: w.projectId, snapshotId: "s", extra: 1 },
        }),
      ),
    ).toMatch(/invalid args/);

    const sent = w.rig.sent.slice(sentBefore);
    const typed = sent.filter((s) =>
      ["project_snapshot_create", "project_snapshot_delete"].includes(s.cmd),
    );
    expect(typed.map((s) => s.cmd)).toEqual([
      "project_snapshot_create",
      "project_snapshot_delete",
      "project_snapshot_delete",
    ]);
    // The renderer sent no generic DML of its own: every write was typed.
    expect(
      sent.filter((s) => s.sql && /\b(insert|update|delete)\b/i.test(s.sql)),
    ).toEqual([]);
  });

  it("chat import restricted: the conversation part is counted, not taken in and not dropped silently", async () => {
    const w = await workspace();
    await restrict(w);
    const { importChatSessionsBatch, importChapters } = await renderer(
      "@/features/import/importApi",
    );
    const { chatImportNotice } = await renderer(
      "@/features/import/chatImportNotice",
    );
    const progress: Array<Record<string, unknown>> = [];

    // The flow's order: the other items first (they are not refused), then the
    // conversations.
    expect(await importChapters(importedChapters("imp-closed"))).toMatchObject({
      imported: 2,
      errors: [],
    });
    expect(
      await w.rows("SELECT id FROM tree_nodes WHERE id = 'imp-closed-scene'"),
    ).toHaveLength(1);
    const sentBeforeChat = w.rig.sent.length;
    const result = await importChatSessionsBatch(
      importedSessions("imp-closed"),
      (p: Record<string, unknown>) => progress.push(p),
    );
    expect(result).toEqual({ imported: 0, errors: [], notImported: 3 });
    expect(
      await w.rows("SELECT id FROM chat_sessions WHERE id LIKE 'imp-closed-%'"),
    ).toEqual([]);
    expect(
      await w.rows(
        "SELECT id FROM chat_messages WHERE session_id LIKE 'imp-closed-%'",
      ),
    ).toEqual([]);
    expect(progress.at(-1)).toEqual({ total: 3, done: 3, currentName: "" });
    // One refused INSERT with the real marker, then nothing more is tried.
    const inserts = w.rig.sent
      .slice(sentBeforeChat)
      .filter((s) => s.sql && /\binsert\b/i.test(s.sql));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].ok).toBe(false);
    expect(inserts[0].error).toContain(MARKER);
    // The notice that the flow shows is not empty.
    expect(await chatImportNotice(3)).toEqual(expect.any(String));
    expect((await chatImportNotice(3)).length).toBeGreaterThan(0);
  });
});

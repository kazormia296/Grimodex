// CB-2 / S4 (K2/4 `graph-target-scene-body-disclosure`, `scope-storage-authority`):
// 本文宣言（宣言と取消）を、実 router + 実 MainGrant controller + 実 gate + 実 Native
// を通して固定する。
//
// E1: 通常の起動と packaged の起動（seam 無効）では、宣言も取消も DB を読む前に typed に
//     拒否され、ダイアログは出ない（Mandatory defense 10）。
// E2: 評価用 CI seam が有効な起動では、実 router・gate・Native を通して宣言でき、再起動
//     の後も残り、v1 の列は byte 同一。unrestricted と restricted の両方。
// E3: 取消は grant なしで動き、宣言がないときは何も書かない。
// N-13（CB-3）: 読取専用の状態の入口は、閉じた gate では DB を読む前に拒否され、seam が
//     有効な起動では宣言 → 有効 → 本文の保存で失効（content）→ 取消 → none と追従する。
// E6: 新しい table・column・row の種類が増えていない（宣言と取消が書く table の集合が閉じている）。
//
// 実 Native の addon が要るので `vitest.electron-native.config.ts` だけが拾う。
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Envelope, NapiBackendLike } from "../shared/ipcContract.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  showMessageBox: vi.fn(),
  fromWebContents: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.0-test",
    getPath: () => os.tmpdir(),
    getGPUFeatureStatus: () => ({}),
  },
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
    showMessageBox: mocks.showMessageBox,
  },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
  BrowserWindow: {
    fromWebContents: mocks.fromWebContents,
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
// The addon's methods are called by name; its generated types are not imported.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NativeBackendInstance = NapiBackendLike & Record<string, any>;
const { Backend: NativeBackend } = require(ADDON) as {
  Backend: new (appData: string) => NativeBackendInstance;
};

const backends: NativeBackendInstance[] = [];
/** Backends standing for a process that has exited (see d2aOwnDataRead). */
const exited = new Set<NativeBackendInstance>();
const roots: string[] = [];
afterAll(async () => {
  for (const backend of backends) {
    if (exited.has(backend)) continue;
    const wire = await backend.shutdownWorkspaceLifecycle!();
    expect(JSON.parse(wire).status).toBe("closed");
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const PROJECT = "default-project";
const SCENE = "scene-1";
const TITLE = "Chapter One";
const BODY = "Mira opened the door.";
const GATE_CLOSED = "NEX_BODY_DECLARATION_REFUSED:gate-closed";
const DECLARE = "narrative_scene_body_declaration_declare";
const REVOKE = "narrative_scene_body_declaration_revoke";
const STATE = "narrative_scene_body_declaration_state";
const NONCE_A = "3f9a8f0e-5b6c-4d7e-8a9b-0c1d2e3f4a5b";
const VALUES = {
  story: "independent",
  auto: "independent",
  phase: "independent",
  reveal: "non-secret",
  pov: "independent",
};

let sequence = 0;
const unique = (label: string) => `${label}-${(sequence += 1)}`;

const tiptapDoc = (text: string) =>
  JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
const exact = (ref: string) => ({ kind: "exact", ref });
const ANY = { kind: "any" };
const CONTROLS = [
  "runtime-policy",
  "actor-context",
  "typed-writer",
  "occ",
  "change-event",
  "change-feed",
];

/** Rows of the workspace database, read in a separate process. */
function queryRows<T = Record<string, unknown>>(
  workspacePath: string,
  sql: string,
): T[] {
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
  ) as T[];
}

interface Fixture {
  root: string;
  appData: string;
  workspace: string;
  userData: string;
}

/** A profile + workspace whose Scene has an explicit A1 (seeded while unrestricted). */
async function newFixture(label: string): Promise<Fixture> {
  const root = mkdtempSync(path.join(os.tmpdir(), `grimodex-cb2-${label}-`));
  roots.push(root);
  const appData = path.join(root, "app-data");
  const workspace = path.join(root, "workspace");
  const userData = path.join(root, "user-data");
  mkdirSync(appData, { recursive: true });
  mkdirSync(userData, { recursive: true });
  const backend = new NativeBackend(appData);
  backends.push(backend);
  await backend.openWorkspace!(workspace);
  const requestId = unique("scene-create");
  await backend.treeNodeCreate!({
    requestId,
    sessionId: `${requestId}:session`,
    eventUid: `${requestId}:event`,
    origin: "human",
    authorityRoute: "human-direct",
    caller: "manual-wrapper",
    controls: CONTROLS,
    provenance: null,
    writesAuthorityProtectedField: false,
    originalTransactionId: null,
    undoJournalId: null,
    id: SCENE,
    projectId: PROJECT,
    parentId: null,
    nodeType: "scene",
    title: TITLE,
    sortOrder: "a0",
    content: tiptapDoc(BODY),
  });
  const read = async () =>
    JSON.parse(
      await backend.narrativeSceneScopeRead!({
        expectedWorkspacePath: workspace,
        projectId: PROJECT,
        sceneId: SCENE,
      }),
    );
  const first = await read();
  await backend.narrativeSceneScopeRegistryUpdate!({
    expectedWorkspacePath: workspace,
    payload: {
      projectId: PROJECT,
      requestId: unique("registry"),
      sessionId: "fixture-session",
      eventUid: unique("registry-event"),
      baseVersion: first.registryRevision,
      updatedAt: "2026-10-18T00:00:00.000Z",
      registry: {
        registryVersion: first.registry.registryVersion,
        timelineRefs: ["tl"],
        worldlineRefs: ["wl"],
        narrativeLayerRefs: ["ly"],
      },
    },
  });
  const second = await read();
  await backend.narrativeSceneScopeUpdate!({
    expectedWorkspacePath: workspace,
    payload: {
      projectId: PROJECT,
      sceneId: SCENE,
      requestId: unique("a1"),
      sessionId: "fixture-session",
      eventUid: unique("a1-event"),
      baseVersion: second.binding.version,
      updatedAt: "2026-10-18T00:00:01.000Z",
      scope: {
        schemaVersion: 1,
        compatibilityMarker: "explicit",
        queryIdentity: {
          timeline: exact("tl"),
          worldline: exact("wl"),
          narrativeLayer: exact("ly"),
        },
        materialConstraint: {
          timeline: ANY,
          worldline: ANY,
          narrativeLayer: ANY,
        },
        knowledgeHolder: { kind: "reader" },
        audience: { kind: "reader" },
      },
    },
  });
  // This first process ends; each launch below is a later process. It is not
  // shut down: a shut-down Backend keeps its exclusive maintenance fence on
  // the path, and the later Backend's own shutdown (which also fences the path
  // and waits for any worker on it) would wait on it forever.
  exited.add(backend);
  return { root, appData, workspace, userData };
}

interface SeamEnvOptions {
  readonly ci?: string;
  readonly token?: string;
  readonly nonce?: string;
}

interface Launch {
  readonly backend: NativeBackendInstance;
  readonly workspace: string;
  readonly userData: string;
  readonly gate: Awaited<
    ReturnType<(typeof import("./profileEgress.js"))["createProfileEgressGate"]>
  >;
  /** The result of `startBodyDeclarationCiSeam`; null when the seam is off. */
  readonly seamStarted: boolean;
  readonly receiptPath: string | null;
  /** The window the sender belongs to (`BrowserWindow.fromWebContents`). */
  readonly window: EventEmitter;
  invoke(cmd: string, args: Record<string, unknown>): Promise<Envelope>;
  /** This process exits; a later start on the same workspace replaces it. */
  exit(): void;
  /** Ends the last process of a test: Native's lifecycle shutdown is proven. */
  shutdown(): Promise<void>;
}

class FakeWebContents extends EventEmitter {
  constructor(readonly id: number) {
    super();
  }
  isDestroyed(): boolean {
    return false;
  }
}
class FakeWindow extends EventEmitter {
  constructor(readonly id: number) {
    super();
  }
  isDestroyed(): boolean {
    return false;
  }
}

/**
 * A Main process on `fixture`: a fresh module graph, a real Backend over the
 * fixture's workspace, the real gate, the real MainGrant controller and the
 * real router. `seam` is how the launch's environment looks to the CI seam.
 */
async function launch(
  fixture: Fixture,
  options: {
    restricted: boolean;
    isPackaged?: boolean;
    seam?: "none" | SeamEnvOptions;
    /**
     * "product" keeps the seam's gate but shows the product's own dialog
     * (`showMainGrantDialog`, with `dialog.showMessageBox` mocked), so a test
     * can hold the dialog open. Default: the seam's replacement confirmation.
     */
    dialog?: "seam" | "product";
  },
): Promise<Launch> {
  vi.resetModules();
  mocks.handlers.clear();
  mocks.showMessageBox.mockReset();
  // A dialog that would be shown is a cancel; the tests assert none is shown
  // where none may be.
  mocks.showMessageBox.mockResolvedValue({
    response: 0,
    checkboxChecked: false,
  });
  const backend = new NativeBackend(fixture.appData);
  backends.push(backend);

  const { createProfileEgressGate } = await import("./profileEgress.js");
  const { activateThroughMain } =
    await import("./profileActivation.test.support.js");
  const { registerEventBus } = await import("./events.js");
  const { registerIpcRouter } = await import("./ipc.js");
  const { createMainGrantController } = await import("./mainGrant.js");
  const {
    BODY_DECLARATION_CI_NONCE_ENV,
    BODY_DECLARATION_CI_OWNER_TOKEN,
    BODY_DECLARATION_CI_OWNER_TOKEN_ENV,
    parseBodyDeclarationCiSeam,
    startBodyDeclarationCiSeam,
  } = await import("./bodyDeclarationCiSeam.js");
  const { IPC } = await import("../shared/ipcContract.js");

  const gate = await createProfileEgressGate(backend as NapiBackendLike);
  registerEventBus(backend as NapiBackendLike, undefined, gate);

  const isPackaged = options.isPackaged ?? false;
  let env: NodeJS.ProcessEnv = {};
  if (options.seam !== undefined && options.seam !== "none") {
    env = {
      CI: options.seam.ci ?? "true",
      [BODY_DECLARATION_CI_OWNER_TOKEN_ENV]:
        options.seam.token ?? BODY_DECLARATION_CI_OWNER_TOKEN,
      [BODY_DECLARATION_CI_NONCE_ENV]: options.seam.nonce ?? NONCE_A,
    };
  }
  const started = await startBodyDeclarationCiSeam({
    seam: parseBodyDeclarationCiSeam(env, { isPackaged }),
    backend: backend as NapiBackendLike,
    isPackaged,
    userDataDir: fixture.userData,
  });
  const mainGrant = createMainGrantController({
    backend: backend as NapiBackendLike,
    confirm: options.dialog === "product" ? undefined : started?.confirm,
  });
  registerIpcRouter(
    backend as NapiBackendLike,
    {} as never,
    undefined,
    undefined,
    { active: false },
    gate,
    undefined,
    undefined,
    undefined,
    mainGrant,
  );
  const handler = mocks.handlers.get(IPC.invoke) as (
    event: unknown,
    cmd: unknown,
    args: unknown,
  ) => Promise<Envelope>;
  const sender = new FakeWebContents(7);
  const window = new FakeWindow(11);
  mocks.fromWebContents.mockReturnValue(window);
  const invoke = (cmd: string, args: Record<string, unknown>) =>
    handler({ sender }, cmd, args);
  // As in a real start: the workspace is opened through the router, so the
  // gate observes Native's Open result; then the first restricted publication
  // is activated (a restart finds the profile restricted already).
  okValue(await invoke("open_workspace", { path: fixture.workspace }));
  if (options.restricted && !gate.restricted) {
    // DA-2: through Main's grant path (the entry opened as the seam does).
    expect(await activateThroughMain(backend as NapiBackendLike, gate)).toEqual(
      { status: "activated" },
    );
  }
  expect(gate.restricted).toBe(options.restricted);
  return {
    backend,
    workspace: fixture.workspace,
    userData: fixture.userData,
    gate,
    seamStarted: started !== null,
    receiptPath: started?.receiptPath ?? null,
    window,
    invoke,
    exit: () => {
      exited.add(backend);
    },
    shutdown: async () => {
      const wire = await backend.shutdownWorkspaceLifecycle!();
      expect(JSON.parse(wire).status).toBe("closed");
      exited.add(backend);
    },
  };
}

interface ScopeRow {
  version: number;
  sourceToken: string;
  updatedAt: string;
  marker: string;
  json: string | null;
  token: string | null;
}

const SCOPE_ROW_SQL = `SELECT version, source_token AS sourceToken, updated_at AS updatedAt,
            compatibility_marker AS marker, body_declaration_json AS json,
            body_declaration_token AS token
       FROM narrative_scene_scope_bindings
      WHERE project_id = '${PROJECT}' AND scene_id = '${SCENE}'`;

function scopeRow(workspace: string): ScopeRow {
  const [row] = queryRows<ScopeRow>(workspace, SCOPE_ROW_SQL);
  return row;
}

function declareArgs(workspace: string, requestId = unique("declare")) {
  const row = scopeRow(workspace);
  return {
    expectedWorkspacePath: workspace,
    payload: {
      projectId: PROJECT,
      sceneId: SCENE,
      requestId,
      expected: {
        scopeVersion: row.version,
        scopeToken: row.sourceToken,
        declarationToken: row.token,
      },
      values: VALUES,
    },
  };
}

function revokeArgs(
  workspace: string,
  declarationToken: string,
  requestId = unique("revoke"),
) {
  return {
    expectedWorkspacePath: workspace,
    payload: {
      projectId: PROJECT,
      sceneId: SCENE,
      requestId,
      declarationToken,
    },
  };
}

function stateArgs(workspace: string) {
  return {
    expectedWorkspacePath: workspace,
    payload: { projectId: PROJECT, sceneId: SCENE },
  };
}

interface StateAnswer {
  occ: { scopeVersion: number; scopeToken: string } | null;
  declarationToken: string | null;
  state: {
    kind: string;
    effective?: boolean;
    expiredBy?: string[];
    blocker: string | null;
  };
}

function failureOf(envelope: Envelope): string {
  expect(envelope.ok).toBe(false);
  return envelope.ok ? "" : envelope.error;
}
function okValue<T>(envelope: Envelope): T {
  if (!envelope.ok) throw new Error(`expected ok, got: ${envelope.error}`);
  return envelope.value as T;
}

/**
 * The whole observable state a declaration or a refusal could touch. Read with
 * one child process and one read-only connection, so the number of launches
 * does not grow with the number of tables.
 */
function snapshot(workspace: string) {
  const script = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1], { readOnly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
const counts = {};
for (const table of tables) {
  counts[table] = db.prepare('SELECT count(*) AS n FROM "' + table.replaceAll('"', '""') + '"').get().n;
}
const schema = db.prepare("SELECT name, sql FROM sqlite_master ORDER BY type, name").all();
const scope = db.prepare(process.argv[2]).all();
process.stdout.write(JSON.stringify({ counts, schema, scope }, (_k, v) => (typeof v === "bigint" ? String(v) : v)));
db.close();
`;
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--no-warnings",
        "-e",
        script,
        path.join(workspace, "grimodex.db"),
        SCOPE_ROW_SQL,
      ],
      { encoding: "utf8", timeout: 30_000 },
    ),
  ) as {
    counts: Record<string, number>;
    schema: Array<{ name: string; sql: string | null }>;
    scope: ScopeRow[];
  };
  return {
    counts: result.counts,
    schema: result.schema,
    scope: result.scope[0],
  };
}

/**
 * A digest of every row of every table (not only counts), read with a separate
 * read-only process. Two equal digests mean nothing in the database changed.
 */
function dataDigest(workspace: string): string {
  const script = `
const { DatabaseSync } = require("node:sqlite");
const { createHash } = require("node:crypto");
const db = new DatabaseSync(process.argv[1], { readOnly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
const hash = createHash("sha256");
for (const table of tables) {
  const rows = db.prepare('SELECT * FROM "' + table.replaceAll('"', '""') + '"').all()
    .map((row) => JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? String(v) : v)))
    .sort();
  hash.update(table + "\\n" + rows.join("\\n") + "\\n");
}
process.stdout.write(hash.digest("hex"));
db.close();
`;
  return execFileSync(
    process.execPath,
    ["--no-warnings", "-e", script, path.join(workspace, "grimodex.db")],
    { encoding: "utf8", timeout: 30_000 },
  );
}

beforeEach(() => {
  mocks.showMessageBox.mockReset();
});

describe("E1 a normal or packaged launch refuses the declaration entries before reading anything", () => {
  const launches: Array<
    [
      string,
      {
        isPackaged?: boolean;
        seam: "none" | SeamEnvOptions;
      },
    ]
  > = [
    ["a normal launch (no seam environment)", { seam: "none" }],
    [
      "a packaged launch with the full seam environment",
      { isPackaged: true, seam: {} },
    ],
    ["CI is not true", { seam: { ci: "1" } }],
    ["the owner token is wrong", { seam: { token: "not-the-owner-token" } }],
    ["the nonce is not a UUIDv4", { seam: { nonce: "nonce-not-a-uuid" } }],
  ];

  for (const restricted of [false, true]) {
    for (const [name, launchOptions] of launches) {
      it(`${restricted ? "restricted" : "unrestricted"}: ${name}`, async () => {
        const fixture = await newFixture("e1");
        const main = await launch(fixture, { restricted, ...launchOptions });
        expect(main.seamStarted).toBe(false);
        expect(readdirSync(fixture.userData)).toEqual([]);
        const before = snapshot(fixture.workspace);
        expect(before.scope.json).toBeNull();
        expect(before.scope.token).toBeNull();

        // Declaration: no preview is made and no dialog is shown.
        expect(
          failureOf(await main.invoke(DECLARE, declareArgs(fixture.workspace))),
        ).toContain(GATE_CLOSED);
        // The state read is closed by the same gate, before the database.
        expect(
          failureOf(await main.invoke(STATE, stateArgs(fixture.workspace))),
        ).toContain(GATE_CLOSED);
        // Revoke needs no grant but the gate still stands.
        expect(
          failureOf(
            await main.invoke(REVOKE, revokeArgs(fixture.workspace, "token")),
          ),
        ).toContain(GATE_CLOSED);
        expect(mocks.showMessageBox).not.toHaveBeenCalled();

        // A renderer that supplies its own grant-shaped fields changes nothing.
        const forged = declareArgs(fixture.workspace);
        Object.assign(forged, {
          grant: { grantId: "g", senderId: 7, windowId: 11 },
          grantId: "g",
          previewId: "p",
        });
        expect(failureOf(await main.invoke(DECLARE, forged))).toContain(
          GATE_CLOSED,
        );
        expect(mocks.showMessageBox).not.toHaveBeenCalled();

        // Nothing was written, created or stored.
        expect(snapshot(fixture.workspace)).toEqual(before);
        await main.shutdown();
      });
    }
  }
});

describe("E2 / E3 the seam-enabled launch declares and revokes through the real router", () => {
  for (const restricted of [false, true]) {
    it(`${restricted ? "restricted" : "unrestricted"}: declare, survive a restart, revoke without a grant`, async () => {
      const fixture = await newFixture("e2");
      const first = await launch(fixture, { restricted, seam: {} });
      expect(first.seamStarted).toBe(true);
      const before = snapshot(fixture.workspace);
      expect(before.scope.marker).toBe("explicit");

      // E3 (nothing to revoke): no grant, no write.
      expect(
        okValue(await first.invoke(REVOKE, revokeArgs(fixture.workspace, "t"))),
      ).toEqual({ outcome: "no-declaration" });
      expect(snapshot(fixture.workspace)).toEqual(before);

      // E2: the declaration goes through preview, the seam's confirmation,
      // issue, consume and the writer. The product's dialog is never shown.
      const request = declareArgs(fixture.workspace);
      expect(okValue(await first.invoke(DECLARE, request))).toEqual({
        outcome: "declared",
      });
      expect(mocks.showMessageBox).not.toHaveBeenCalled();
      const declared = snapshot(fixture.workspace);
      expect(declared.scope.json).not.toBeNull();
      expect(declared.scope.token).not.toBeNull();
      expect(declared.scope.json).not.toContain(BODY);
      expect(declared.scope.json).not.toContain(TITLE);
      // The v1 columns are byte-identical.
      for (const key of [
        "version",
        "sourceToken",
        "updatedAt",
        "marker",
      ] as const) {
        expect(declared.scope[key], key).toBe(before.scope[key]);
      }
      // E6: the declaration changed no schema, and wrote only the tables the
      // draft names (the two cells, the feed, the idempotency record).
      expect(declared.schema).toEqual(before.schema);
      const changed = Object.keys(declared.counts).filter(
        (table) => declared.counts[table] !== before.counts[table],
      );
      const ALLOWED_TABLES = [
        "change_events",
        "idempotency_requests",
        "narrative_change_events",
        "narrative_change_object_heads",
        "narrative_change_transactions",
      ];
      expect(
        changed.filter((table) => !ALLOWED_TABLES.includes(table)),
        `unexpected tables written: ${changed.join(", ")}`,
      ).toEqual([]);
      expect(changed).toContain("idempotency_requests");
      expect(changed).toContain("narrative_change_events");
      const domains = queryRows<{ domain: string }>(
        fixture.workspace,
        "SELECT DISTINCT domain FROM idempotency_requests WHERE domain LIKE 'scene_body_declaration_%'",
      );
      expect(domains.length).toBeGreaterThan(0);

      // The receipt records the approval; the nonce is not in it.
      const receiptText = readFileSync(first.receiptPath!, "utf8");
      expect(receiptText).not.toContain(NONCE_A);
      const receipt = JSON.parse(receiptText) as {
        gateOpened: boolean;
        approvedGrantCount: number;
        approvedBindingDigests: string[];
      };
      expect(receipt.gateOpened).toBe(true);
      expect(receipt.approvedGrantCount).toBe(1);
      expect(receipt.approvedBindingDigests).toHaveLength(1);

      // The same request again is refused: the Scene already has a declaration.
      expect(failureOf(await first.invoke(DECLARE, request))).toContain(
        "NEX_BODY_DECLARATION_REFUSED:",
      );
      expect(snapshot(fixture.workspace).scope).toEqual(declared.scope);
      first.exit();

      // A restart without the seam: the declaration is still there and the
      // gate is closed again (nothing, not even a revoke, runs).
      const restarted = await launch(fixture, { restricted, seam: "none" });
      expect(restarted.gate.restricted).toBe(restricted);
      expect(snapshot(fixture.workspace).scope).toEqual(declared.scope);
      expect(
        failureOf(
          await restarted.invoke(
            REVOKE,
            revokeArgs(fixture.workspace, declared.scope.token!),
          ),
        ),
      ).toContain(GATE_CLOSED);
      expect(snapshot(fixture.workspace).scope).toEqual(declared.scope);
      restarted.exit();

      // A restart with a new seam launch: revoke works without any grant and
      // leaves the v1 columns alone. A wrong token changes nothing.
      const evaluated = await launch(fixture, { restricted, seam: {} });
      expect(
        okValue(
          await evaluated.invoke(
            REVOKE,
            revokeArgs(fixture.workspace, "not-the-token"),
          ),
        ),
      ).toEqual({ outcome: "declaration-changed" });
      expect(snapshot(fixture.workspace).scope).toEqual(declared.scope);
      expect(
        okValue(
          await evaluated.invoke(
            REVOKE,
            revokeArgs(fixture.workspace, declared.scope.token!),
          ),
        ),
      ).toEqual({ outcome: "revoked" });
      const revoked = snapshot(fixture.workspace);
      expect(revoked.scope.json).toBeNull();
      expect(revoked.scope.token).toBeNull();
      for (const key of [
        "version",
        "sourceToken",
        "updatedAt",
        "marker",
      ] as const) {
        expect(revoked.scope[key], key).toBe(before.scope[key]);
      }
      expect(revoked.schema).toEqual(before.schema);
      // Nothing left to revoke: nothing is written.
      const afterRevoke = snapshot(fixture.workspace);
      expect(
        okValue(
          await evaluated.invoke(
            REVOKE,
            revokeArgs(fixture.workspace, declared.scope.token!),
          ),
        ),
      ).toEqual({ outcome: "no-declaration" });
      expect(snapshot(fixture.workspace)).toEqual(afterRevoke);
      expect(mocks.showMessageBox).not.toHaveBeenCalled();
      await evaluated.shutdown();
    });
  }
});

describe("N-13 the state read follows a declaration through the real router", () => {
  for (const restricted of [false, true]) {
    it(`${restricted ? "restricted" : "unrestricted"}: none, effective, expired by the body, declared again, revoked`, async () => {
      const fixture = await newFixture("n13");
      const main = await launch(fixture, { restricted, seam: {} });
      // A state read writes nothing: every row of every table is the same
      // before and after it (the digest is taken by a separate process).
      const readState = async (): Promise<StateAnswer> => {
        const digest = dataDigest(fixture.workspace);
        const answer = okValue<StateAnswer>(
          await main.invoke(STATE, stateArgs(fixture.workspace)),
        );
        expect(dataDigest(fixture.workspace)).toBe(digest);
        return answer;
      };
      const none = await readState();
      expect(none.state).toEqual({ kind: "none", blocker: null });
      expect(none.declarationToken).toBeNull();
      const row = scopeRow(fixture.workspace);
      expect(none.occ).toEqual({
        scopeVersion: row.version,
        scopeToken: row.sourceToken,
      });

      expect(
        okValue(await main.invoke(DECLARE, declareArgs(fixture.workspace))),
      ).toEqual({ outcome: "declared" });
      const declared = await readState();
      expect(declared.state).toEqual({
        kind: "declared",
        effective: true,
        expiredBy: [],
        blocker: null,
      });
      expect(declared.declarationToken).toBe(scopeRow(fixture.workspace).token);
      const wire = JSON.stringify(declared);
      for (const secret of [BODY, TITLE, SCENE, PROJECT]) {
        expect(wire).not.toContain(secret);
      }

      // The body is saved: still declared, no longer in effect.
      const [{ version }] = queryRows<{ version: number }>(
        fixture.workspace,
        `SELECT version FROM tree_nodes WHERE id = '${SCENE}'`,
      );
      const patchId = unique("scene-patch");
      await main.backend.treeNodePatch!({
        requestId: patchId,
        sessionId: `${patchId}:session`,
        eventUid: `${patchId}:event`,
        origin: "human",
        authorityRoute: "human-direct",
        caller: "manual-wrapper",
        controls: CONTROLS,
        provenance: null,
        writesAuthorityProtectedField: false,
        originalTransactionId: null,
        undoJournalId: null,
        projectId: PROJECT,
        nodeId: SCENE,
        patch: { content: tiptapDoc("Another sentence.") },
        baseVersion: version,
        bumpVersion: true,
        updatedAt: new Date().toISOString(),
      });
      const expired = await readState();
      expect(expired.state).toEqual({
        kind: "declared",
        effective: false,
        expiredBy: ["content"],
        blocker: null,
      });
      expect(expired.declarationToken).not.toBeNull();

      // Declaring again over the expired declaration: the request names the
      // stored declaration's token (it is not null), the OCC values come from
      // the same state read, and the new declaration is effective.
      expect(
        okValue(
          await main.invoke(DECLARE, {
            expectedWorkspacePath: fixture.workspace,
            payload: {
              projectId: PROJECT,
              sceneId: SCENE,
              requestId: unique("redeclare"),
              expected: {
                scopeVersion: expired.occ!.scopeVersion,
                scopeToken: expired.occ!.scopeToken,
                declarationToken: expired.declarationToken,
              },
              values: VALUES,
            },
          }),
        ),
      ).toEqual({ outcome: "declared" });
      const again = await readState();
      expect(again.state).toEqual({
        kind: "declared",
        effective: true,
        expiredBy: [],
        blocker: null,
      });
      expect(again.declarationToken).not.toBe(expired.declarationToken);

      expect(
        okValue(
          await main.invoke(
            REVOKE,
            revokeArgs(fixture.workspace, again.declarationToken!),
          ),
        ),
      ).toEqual({ outcome: "revoked" });
      const after = await readState();
      expect(after.state).toEqual({ kind: "none", blocker: null });
      expect(after.declarationToken).toBeNull();
      await main.shutdown();
    });
  }
});

// PUB-G 前提 #41（DR-CB3-20）: 確認ダイアログが開いている間（最大 60 秒）の待ち。
// 製品のダイアログ（`showMainGrantDialog`。`dialog.showMessageBox` だけ保留に差し替え）、
// 実 router、実 MainGrant、実 Native の上で、renderer の本物の `src/lib/tauri.ts`
// （ipcQueue）と宣言の API を、`window.grimodex.invoke` 経由で動かす。
//
// DR-CB3-20 は「ほかの mutation が待つ」と書くが、現行コードでは待たない（renderer の
// queue は同時 4 本、Main と Native はダイアログの間に lock を持たない）。ここで固定するのは
// 実際の挙動:
//   W1 ダイアログ中も、本文の保存（mutation）と状態の読取は待たされず通る。
//   W2 ダイアログ中の 2 つ目の確認は grant-busy で閉じる（待たない）。
//   W3 承認すれば宣言できる。ダイアログ中に本文を保存していたら、承認しても宣言は
//      書かれず閉じた code で終わる（承認した時点の本文が、確認した本文ではないため）。
//   W4 キャンセル、60 秒の期限、window の close のどれでも、宣言は何も書かず閉じた code
//      で終わり、確認の枠が残らない（次の宣言がまた通る）。
//   W5 ダイアログの文言は Native の display、ボタンは製品の固定文字列で、既定はキャンセル。
//   W6 実際に待つのは renderer の strict quiescence（workspace の切替・window の close）だけで、
//      開いているダイアログが終わるまで（長くても 60 秒の期限まで）待つ。
describe("DL the declaration's confirmation dialog while it is open (PUB-G #41)", () => {
  interface Held {
    options: {
      title?: string;
      message?: string;
      buttons?: string[];
      defaultId?: number;
      cancelId?: number;
      signal?: AbortSignal;
    };
    /** The author presses a button (an index into `buttons`). */
    press(response: number): void;
  }

  /** Each `dialog.showMessageBox` stays open until a button is pressed or its signal aborts. */
  function holdDialogs(): { shown: Held[] } {
    const shown: Held[] = [];
    mocks.showMessageBox.mockImplementation(
      (_win: unknown, options: Held["options"]) =>
        new Promise((resolve) => {
          shown.push({
            options,
            press: (response) => resolve({ response, checkboxChecked: false }),
          });
          options.signal?.addEventListener("abort", () =>
            resolve({
              response: options.cancelId ?? 0,
              checkboxChecked: false,
            }),
          );
        }),
    );
    return { shown };
  }

  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  // The dialog opens only after Native's preview (real SQLite I/O on a thread
  // pool) has finished, so the wait is bounded by wall-clock time. A count of
  // `setImmediate` turns is not: an idle loop spends them in milliseconds, and
  // a slow runner needs far longer than that. The clock is `performance.now()`,
  // which the `setTimeout`-only fake timers below leave real, and `tick` stays
  // a `setImmediate` for the same reason (no real timer is needed here).
  const WAIT_LIMIT_MS = 30_000;
  async function until(condition: () => boolean, what: string): Promise<void> {
    const deadline = performance.now() + WAIT_LIMIT_MS;
    while (!condition()) {
      if (performance.now() > deadline) {
        throw new Error(`timed out waiting for ${what}`);
      }
      await tick();
    }
  }
  const PENDING = Symbol("pending");
  /** What the promise settled to, or PENDING when it is still waiting after a while. */
  async function peek<T>(promise: Promise<T>): Promise<T | typeof PENDING> {
    for (let i = 0; i < 100; i += 1) await tick();
    return Promise.race([promise, Promise.resolve(PENDING)]);
  }

  // The renderer's own modules, through the `@` alias of the config.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Renderer = Record<string, any>;
  const rendererModule = (specifier: string) =>
    import(/* @vite-ignore */ specifier) as Promise<Renderer>;

  interface Snapshot {
    occ: { scopeVersion: number; scopeToken: string };
    declarationToken: string | null;
    state: { kind: string; effective?: boolean; expiredBy?: string[] };
  }
  interface Outcome {
    ok: boolean;
    code?: string;
  }

  /** `src/lib/tauri.ts` and the declaration API, bridged onto this launch's router. */
  async function rendererOn(main: Launch, workspace: string) {
    (globalThis as Record<string, unknown>).window = {
      grimodex: {
        invoke: (cmd: string, args?: Record<string, unknown>) =>
          main.invoke(cmd, args ?? {}),
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    };
    const { setCurrentWorkspaceIdentity } = await rendererModule(
      "@/runtime/workspaceIdentity",
    );
    setCurrentWorkspaceIdentity({ path: workspace, openRevision: 1 });
    const api = await rendererModule(
      "@/features/editor/sceneMeta/bodyDeclaration/bodyDeclarationApi",
    );
    const tree = await rendererModule("@/features/tree/api");
    const scene = {
      workspacePath: workspace,
      projectId: PROJECT,
      sceneId: SCENE,
    };
    const read = async (): Promise<Snapshot> => {
      const result = await api.readBodyDeclarationState(scene);
      expect(result.ok).toBe(true);
      return result.snapshot as Snapshot;
    };
    const declare = async (): Promise<Outcome> => {
      const snapshot = await read();
      return api.declareBody({
        scene,
        occ: snapshot.occ,
        declarationToken: snapshot.declarationToken,
        confirmed: {
          story: true,
          auto: true,
          phase: true,
          reveal: true,
          pov: true,
        },
      });
    };
    const saveBody = (text: string) =>
      tree.saveSceneContent(SCENE, tiptapDoc(text));
    const ipcQueue = await rendererModule("@/lib/ipcQueue");
    return {
      read,
      declare,
      saveBody,
      quiesce: ipcQueue.awaitPendingIpcActualTasks as () => Promise<void>,
    };
  }

  const bodyOf = (workspace: string) =>
    queryRows<{ content: string }>(
      workspace,
      `SELECT content FROM tree_nodes WHERE id = '${SCENE}'`,
    )[0]!.content;

  afterAll(() => {
    delete (globalThis as Record<string, unknown>).window;
  });

  for (const restricted of [false, true]) {
    const label = restricted ? "restricted" : "unrestricted";

    async function start(name: string) {
      const fixture = await newFixture(name);
      const main = await launch(fixture, {
        restricted,
        seam: {},
        dialog: "product",
      });
      const dialogs = holdDialogs();
      const renderer = await rendererOn(main, fixture.workspace);
      return { fixture, main, dialogs, renderer };
    }

    it(`${label}: W1 W2 W3 W5 a state read, a body save and a second confirmation do not wait; approving after a save declares nothing`, async () => {
      const { fixture, main, dialogs, renderer } = await start("dl-a");
      expect((await renderer.read()).state.kind).toBe("none");

      const declaring = renderer.declare();
      await until(() => dialogs.shown.length === 1, "the dialog");
      const dialog = dialogs.shown[0]!;
      // W5: Native's text, the product's fixed buttons, Cancel is the default.
      expect(dialog.options.title).toBe("本文の開示の宣言");
      expect(dialog.options.buttons).toEqual(["キャンセル", "宣言する"]);
      expect([dialog.options.defaultId, dialog.options.cancelId]).toEqual([
        0, 0,
      ]);
      expect(dialog.options.message).toEqual(expect.any(String));
      expect(dialog.options.message).not.toContain(BODY);
      expect(dialog.options.signal).toBeInstanceOf(AbortSignal);
      expect(await peek(declaring)).toBe(PENDING);

      // W1: neither the read nor a body save waits for the dialog.
      expect((await renderer.read()).state.kind).toBe("none");
      const text = "Saved while the dialog is open.";
      await renderer.saveBody(text);
      expect(bodyOf(fixture.workspace)).toContain(text);
      expect(await peek(declaring)).toBe(PENDING);

      // W2: a second confirmation is refused at once; no second dialog.
      expect(await renderer.declare()).toEqual({
        ok: false,
        code: "grant-busy",
      });
      expect(dialogs.shown).toHaveLength(1);

      // W3: the author approves the text they were shown. The body is no longer
      // the one they confirmed, so Native refuses and nothing is declared.
      dialog.press(1);
      expect(await declaring).toEqual({ ok: false, code: "grant-failed" });
      expect(scopeRow(fixture.workspace).json).toBeNull();
      expect((await renderer.read()).state.kind).toBe("none");
      expect(bodyOf(fixture.workspace)).toContain(text);
      await main.shutdown();
    });

    it(`${label}: W3 approving with nothing changed in the meantime declares, and the read follows`, async () => {
      const { fixture, main, dialogs, renderer } = await start("dl-b");
      const declaring = renderer.declare();
      await until(() => dialogs.shown.length === 1, "the dialog");
      // The read during the dialog does not wait and sees no declaration yet.
      expect((await renderer.read()).state.kind).toBe("none");
      expect(await peek(declaring)).toBe(PENDING);
      dialogs.shown[0]!.press(1);
      expect(await declaring).toEqual({ ok: true });
      expect((await renderer.read()).state).toEqual({
        kind: "declared",
        effective: true,
        expiredBy: [],
        blocker: null,
      });
      expect(scopeRow(fixture.workspace).json).not.toBeNull();
      await main.shutdown();
    });

    it(`${label}: W6 the renderer's strict quiescence (workspace switch, window close) waits for the open dialog and no longer than its limit`, async () => {
      const { main, dialogs, renderer } = await start("dl-d");
      // Nothing in flight: it settles at once.
      expect(await peek(renderer.quiesce())).toBeUndefined();

      const cancelled = renderer.declare();
      await until(() => dialogs.shown.length === 1, "the first dialog");
      const drained = renderer.quiesce();
      expect(await peek(drained)).toBe(PENDING);
      dialogs.shown[0]!.press(0);
      expect(await cancelled).toEqual({ ok: false, code: "grant-cancelled" });
      // The drain reports the cancelled declare as a failed mutation (the close
      // is refused, nothing is lost). Current behaviour; PUB-G #41 notes it.
      await expect(drained).rejects.toMatchObject({
        message: expect.stringContaining("MAIN_GRANT_CANCELLED"),
      });

      // Left alone, the limit ends it: the wait is bounded by Native's 60 s.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const expiring = renderer.declare();
        await until(() => dialogs.shown.length === 2, "the second dialog");
        const drainedAgain = renderer.quiesce();
        await vi.advanceTimersByTimeAsync(59_999);
        expect(await peek(drainedAgain)).toBe(PENDING);
        await vi.advanceTimersByTimeAsync(1);
        expect(await expiring).toEqual({ ok: false, code: "grant-revoked" });
        await expect(drainedAgain).rejects.toMatchObject({
          message: expect.stringContaining("MAIN_GRANT_REVOKED"),
        });
      } finally {
        vi.useRealTimers();
      }
      // Approved: the drain completes with the declaration.
      const approved = renderer.declare();
      await until(() => dialogs.shown.length === 3, "the third dialog");
      const drainedApproved = renderer.quiesce();
      expect(await peek(drainedApproved)).toBe(PENDING);
      dialogs.shown[2]!.press(1);
      expect(await approved).toEqual({ ok: true });
      await drainedApproved;
      await main.shutdown();
    });

    it(`${label}: W4 Cancel, the 60 s limit and closing the window each end the wait with nothing written and free the next declaration`, async () => {
      const { fixture, main, dialogs, renderer } = await start("dl-c");
      const digest = dataDigest(fixture.workspace);
      // Cancel.
      const cancelled = renderer.declare();
      await until(() => dialogs.shown.length === 1, "the first dialog");
      dialogs.shown[0]!.press(0);
      expect(await cancelled).toEqual({ ok: false, code: "grant-cancelled" });
      expect(dataDigest(fixture.workspace)).toBe(digest);

      // The 60 s limit (Native's `expiresInMs`; Main's timer aborts the dialog).
      // Only timers are faked; Native and the queue's promises are real.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const expiring = renderer.declare();
        await until(() => dialogs.shown.length === 2, "the second dialog");
        await vi.advanceTimersByTimeAsync(59_999);
        expect(await peek(expiring)).toBe(PENDING);
        expect(dialogs.shown[1]!.options.signal!.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(dialogs.shown[1]!.options.signal!.aborted).toBe(true);
        expect(await expiring).toEqual({ ok: false, code: "grant-revoked" });
      } finally {
        vi.useRealTimers();
      }
      expect(dataDigest(fixture.workspace)).toBe(digest);

      // The window is closed while the dialog is open.
      const closing = renderer.declare();
      await until(() => dialogs.shown.length === 3, "the third dialog");
      main.window.emit("closed");
      expect(await closing).toEqual({ ok: false, code: "grant-revoked" });
      expect(dialogs.shown[2]!.options.signal!.aborted).toBe(true);
      expect(dataDigest(fixture.workspace)).toBe(digest);

      // Nothing is left held: the next declaration opens a dialog and is approved.
      const next = renderer.declare();
      await until(() => dialogs.shown.length === 4, "the fourth dialog");
      dialogs.shown[3]!.press(1);
      expect(await next).toEqual({ ok: true });
      await main.shutdown();
    });
  }
});

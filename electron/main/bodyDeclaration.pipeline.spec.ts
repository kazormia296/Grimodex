// CB-2 / S4 (K2/4 `graph-target-scene-body-disclosure`, `scope-storage-authority`):
// 本文宣言（宣言と取消）を、実 router + 実 MainGrant controller + 実 gate + 実 Native
// を通して固定する。
//
// E1: 通常の起動と packaged の起動（seam 無効）では、宣言も取消も DB を読む前に typed に
//     拒否され、ダイアログは出ない（Mandatory defense 10）。
// E2: 評価用 CI seam が有効な起動では、実 router・gate・Native を通して宣言でき、再起動
//     の後も残り、v1 の列は byte 同一。unrestricted と restricted の両方。
// E3: 取消は grant なしで動き、宣言がないときは何も書かない。
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
    confirm: started?.confirm,
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
  mocks.fromWebContents.mockReturnValue(new FakeWindow(11));
  const invoke = (cmd: string, args: Record<string, unknown>) =>
    handler({ sender }, cmd, args);
  // As in a real start: the workspace is opened through the router, so the
  // gate observes Native's Open result; then the first restricted publication
  // is activated (a restart finds the profile restricted already).
  okValue(await invoke("open_workspace", { path: fixture.workspace }));
  if (options.restricted && !gate.restricted) {
    await gate.activateFirstRestrictedPublication!();
  }
  expect(gate.restricted).toBe(options.restricted);
  return {
    backend,
    workspace: fixture.workspace,
    userData: fixture.userData,
    gate,
    seamStarted: started !== null,
    receiptPath: started?.receiptPath ?? null,
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

function scopeRow(workspace: string): ScopeRow {
  const [row] = queryRows<ScopeRow>(
    workspace,
    `SELECT version, source_token AS sourceToken, updated_at AS updatedAt,
            compatibility_marker AS marker, body_declaration_json AS json,
            body_declaration_token AS token
       FROM narrative_scene_scope_bindings
      WHERE project_id = '${PROJECT}' AND scene_id = '${SCENE}'`,
  );
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

function failureOf(envelope: Envelope): string {
  expect(envelope.ok).toBe(false);
  return envelope.ok ? "" : envelope.error;
}
function okValue<T>(envelope: Envelope): T {
  if (!envelope.ok) throw new Error(`expected ok, got: ${envelope.error}`);
  return envelope.value as T;
}

/** The whole observable state a declaration or a refusal could touch. */
function snapshot(workspace: string) {
  const tables = queryRows<{ name: string }>(
    workspace,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).map((row) => row.name);
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const [{ n }] = queryRows<{ n: number }>(
      workspace,
      `SELECT count(*) AS n FROM "${table}"`,
    );
    counts[table] = n;
  }
  const schema = queryRows<{ name: string; sql: string | null }>(
    workspace,
    "SELECT name, sql FROM sqlite_master ORDER BY type, name",
  );
  return { counts, schema, scope: scopeRow(workspace) };
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

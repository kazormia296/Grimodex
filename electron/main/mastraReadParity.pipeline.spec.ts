// MP-4b PR-9: the read core on Main's adapter, against the REAL Native addon,
// compared with the renderer's results (the PR-0 golden).
//
// WHAT THIS IS FOR. The PR-0 golden is made from the unchanged renderer path on
// sql.js (browser-mock), and `readCore.mainAdapter.test.ts` (PR-4) runs the
// core over a fake backend that wraps the same sql.js. Neither can say what
// Native really returns: the order of the rows of a statement with no total
// ORDER BY, how integers, booleans, timestamps and JSON columns come back, and
// what a real FTS5 index finds. This spec seeds the SAME data (PR-0's
// `legacyReadSeed.ts`, which imports nothing) into a real workspace, drives the
// seven read tools of the core through `createCoreReadDb(createMainReadDb(..))`
// and requires every golden case to come out the same: name, summary,
// tokensUsed, content, and the bytes of `JSON.stringify(content)`.
//
// A difference is a finding, not something to tune away: this file never
// loosens a comparison to make a case pass.
//
// THE TYPED READS (fts, codexSemantic, eventsSemantic, foreshadowOpen) have no
// golden that Native can match (the golden's fts is browser-mock's LIKE arm,
// its semantic reads are `[]`, its foreshadow read is a Drizzle branch). Their
// block below fixes the SHAPE of what the real addon answers on this seed, as
// the frame PR-5, PR-7 and PR-8 add their cases to.
//
// Where the data comes from: `legacyReadSeed.ts` and the golden files live
// under `src/features/chat/agent/__fixtures__/`. The seed file is data only (no
// import) so this spec imports it by a relative path (the electron vitest
// config has no `@` alias; the native one does, but `electron/tsconfig.json`
// does not resolve it). The golden is read as text. Neither is copied, so the
// golden's bytes cannot drift from the renderer's.
//
// The real addon is needed, so only `vitest.electron-native.config.ts` runs it.
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import {
  LEGACY_READ_PROJECTS,
  LEGACY_READ_SEED,
} from "../../src/features/chat/agent/__fixtures__/legacyReadSeed.js";
import type { Envelope, NapiBackendLike } from "../shared/ipcContract.js";
import {
  CoreProjectRequiredError,
  type CoreReadContext,
} from "../shared/mastraRead/ports.js";
import { createCoreReadDb } from "../shared/readDomain/core/readDb.js";
import {
  CORE_READ_TOOL_NAMES,
  createReadExecutors,
} from "../shared/readDomain/core/readExecutors.js";
import { createDbSceneBodyReader } from "../shared/readDomain/core/sceneBody.js";
import { createMainReadDb } from "./mastraRead/db.js";
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
const GOLDEN_DIR = path.join(
  ROOT,
  "src",
  "features",
  "chat",
  "agent",
  "__fixtures__",
  "legacyReadGolden",
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

interface Workspace {
  readonly backend: NativeBackendInstance;
  /** A spy in front of `dbExecute`; the real Backend behind it. */
  readonly dbExecute: ReturnType<typeof vi.fn>;
  readonly readBackend: Pick<NapiBackendLike, "dbExecute">;
  readonly workspacePath: string;
  readonly identity: MainIssuedCallerIdentity;
  readonly otherDirectory: string;
}

/**
 * A real workspace (opened, with the gate that issues caller identities) holding
 * PR-0's seed. The sample workspace's own project is left in place beside the
 * seed's four projects: every read is by project id, so it is only more rows
 * that a missing project condition would show.
 */
async function startSeededWorkspace(): Promise<Workspace> {
  const root = mkdtempSync(path.join(os.tmpdir(), "grimodex-mp4b-parity-"));
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
  // Before the workspace is opened: the generic SQL may not create a project
  // row (`PROTECTED_WRITER_SQL`, writer `project.lifecycle`), so the seed is
  // written from a separate process, as `d2aChatWriters.pipeline.spec.ts` does.
  insertSeedFromAnotherProcess(seeded.path, root);
  ok(await route("open_workspace", { path: seeded.path }));
  const dbExecute = vi.fn((...args: Parameters<NapiBackendLike["dbExecute"]>) =>
    backend.dbExecute(...args),
  );
  return {
    backend,
    dbExecute,
    readBackend: { dbExecute },
    workspacePath: seeded.path,
    identity: gate.issueCallerIdentity(7),
    otherDirectory,
  };
}

/**
 * PR-0's seed, as the renderer's harness inserts it into sql.js: one INSERT per
 * row, the tables in the seed's (foreign-key) order, in one transaction, from a
 * separate process (`node:sqlite`) on the workspace's database file. The rows
 * are passed as a JSON file (the seed is larger than an argument may be).
 */
function insertSeedFromAnotherProcess(
  workspacePath: string,
  scratchDirectory: string,
): void {
  const seedFile = path.join(scratchDirectory, "legacy-read-seed.json");
  writeFileSync(seedFile, JSON.stringify(LEGACY_READ_SEED));
  const script = `
const { DatabaseSync } = require("node:sqlite");
const { readFileSync } = require("node:fs");
const db = new DatabaseSync(process.argv[1]);
db.exec("PRAGMA busy_timeout = 10000");
db.exec("BEGIN");
for (const { table, rows } of JSON.parse(readFileSync(process.argv[2], "utf8"))) {
  for (const row of rows) {
    const columns = Object.keys(row);
    db.prepare(
      "INSERT INTO " + table + " (" + columns.join(", ") + ") VALUES (" +
        columns.map(() => "?").join(", ") + ")",
    ).run(...columns.map((c) => row[c]));
  }
}
db.exec("COMMIT");
db.close();
`;
  execFileSync(
    process.execPath,
    [
      "--no-warnings",
      "-e",
      script,
      path.join(workspacePath, "grimodex.db"),
      seedFile,
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
}

interface GoldenCase {
  readonly case: string;
  readonly world: { projectId: string; activeSceneId?: string };
  readonly params: Record<string, unknown>;
  readonly result: {
    readonly name: string;
    readonly summary: string;
    readonly tokensUsed: number;
    readonly content: unknown;
  };
  readonly contentJson: string;
}

function goldenOf(tool: string): GoldenCase[] {
  const raw = readFileSync(path.join(GOLDEN_DIR, `${tool}.golden.txt`), "utf8");
  return (JSON.parse(raw) as { cases: GoldenCase[] }).cases;
}

describe("the read core on Main's adapter over the real Native addon gives the renderer's results (PR-0 golden)", () => {
  it("covers exactly the seven tools of groups B1 and B2, each with a golden", () => {
    expect([...CORE_READ_TOOL_NAMES].sort()).toEqual(
      [
        "get_chapter_summaries",
        "get_scene",
        "get_scene_timeline_neighbors",
        "get_thread_scenes",
        "list_chapters",
        "list_codex_tags",
        "list_plot_threads",
      ].sort(),
    );
    for (const tool of CORE_READ_TOOL_NAMES) {
      expect(goldenOf(tool).length, tool).toBeGreaterThan(0);
    }
  });

  it("every golden case of the seven tools is the same on the real addon, to the byte", async () => {
    const ws = await startSeededWorkspace();
    const mainDb = createCoreReadDb(
      createMainReadDb({ backend: ws.readBackend, identity: ws.identity }),
    );
    // The tree state of a turn is what Main fixes at its start (DR-MP4-8): here
    // only the project and the active scene, which is all the seven tools read
    // of it (the tree itself they read from the DB).
    let world: GoldenCase["world"] = { projectId: "" };
    const ctx: CoreReadContext = {
      getDb: () => mainDb,
      getTreeState: () => ({
        projectId: world.projectId,
        nodes: [],
        activeSceneId: world.activeSceneId ?? null,
      }),
      body: createDbSceneBodyReader(() => mainDb),
      // The golden counts one UTF-16 unit as one token (PR-0's fixed counter).
      countTokens: (text) => (text ? text.length : 0),
    };
    const executors = createReadExecutors(ctx);

    const compared: Record<string, number> = {};
    for (const tool of CORE_READ_TOOL_NAMES) {
      const cases = goldenOf(tool);
      let done = 0;
      let noProject = 0;
      for (const golden of cases) {
        world = golden.world;
        ws.dbExecute.mockClear();
        const label = `${tool} / ${golden.case}`;
        let actual: Awaited<ReturnType<(typeof executors)[typeof tool]>>;
        try {
          actual = await executors[tool](golden.params);
        } catch (error) {
          // An empty project: the core stops before it reads anything (the
          // renderer's thin layer makes the `No active project` result, which
          // the golden test fixes).
          expect(error, label).toBeInstanceOf(CoreProjectRequiredError);
          expect(golden.world.projectId, label).toBe("");
          expect(golden.result.summary, label).toBe("No active project");
          expect(ws.dbExecute, label).not.toHaveBeenCalled();
          noProject += 1;
          continue;
        }
        expect(
          {
            name: actual.name,
            summary: actual.summary,
            tokensUsed: actual.tokensUsed,
            content: actual.content,
          },
          label,
        ).toEqual({
          name: golden.result.name,
          summary: golden.result.summary,
          tokensUsed: golden.result.tokensUsed,
          content: golden.result.content,
        });
        expect(JSON.stringify(actual.content), label).toBe(golden.contentJson);
        // What went to Native is a SELECT by `all` or `values`, with the
        // identity of the turn as the fourth argument and no fifth.
        for (const call of ws.dbExecute.mock.calls) {
          expect(String(call[0]), label).toMatch(/^\s*select\b/iu);
          expect(["all", "values"], label).toContain(call[2]);
          expect(call, label).toHaveLength(4);
          expect(call[3], label).toBe(JSON.stringify(ws.identity));
        }
        done += 1;
      }
      expect(done + noProject, tool).toBe(cases.length);
      expect(done, tool).toBeGreaterThan(0);
      compared[tool] = done;
    }
    expect(Object.keys(compared).sort()).toEqual(
      [...CORE_READ_TOOL_NAMES].sort(),
    );
  });
});

describe("what the real Native returns for a column's type, through Main's adapter", () => {
  it("integers are numbers, text (the ISO timestamps too) is strings, NULL is null, and the position is the select's", async () => {
    const ws = await startSeededWorkspace();
    const client = createMainReadDb({
      backend: ws.readBackend,
      identity: ws.identity,
    });
    const { rows } = await client(
      'select "title", "char_count", "version", "created_at", "archived_at", "story_time_label", "id" from "tree_nodes" where "id" = ?',
      ["n-s1"],
      "all",
    );
    expect(rows).toEqual([
      ["出会い", 30, 0, "2026-01-01T00:00:00.000Z", null, "春の朝", "n-s1"],
    ]);
    // An aggregate comes back as a number as well (the core's tag counts).
    const counted = await client(
      'select count(*) as "n" from "tree_nodes" where "project_id" = ?',
      ["p-main"],
      "values",
    );
    expect(typeof counted.rows[0]![0]).toBe("number");
  });
});

describe("main's typed reads against the real Native addon: the shape the later PRs add their cases to", () => {
  // These are characterisations of what Native answers on PR-0's seed, not
  // golden comparisons: the renderer's path on sql.js cannot give the same
  // (its fts is a LIKE arm, its semantic reads are `[]`, its foreshadow read is
  // a Drizzle branch). PR-5 (search_scenes, search_snippets, the foreshadow
  // tools), PR-7 (events) and PR-8 (Codex hidden) add their cases here.
  const MAIN = LEGACY_READ_PROJECTS.main;
  const OTHER = LEGACY_READ_PROJECTS.other;

  async function typedReads() {
    const ws = await startSeededWorkspace();
    const reads = createMainTypedReads({
      backend: ws.backend,
      identity: ws.identity,
    });
    return { ws, reads };
  }

  it("fts finds seeded rows through the real FTS5 index, in each scope", async () => {
    const { reads } = await typedReads();
    const hits = async (
      query: string,
      scope: "codex" | "scenes" | "snippets",
    ) =>
      (await reads.fts({ projectId: MAIN, query, scope, limit: 5 })) as Array<
        Record<string, unknown>
      >;
    // The wire: an array of rows `{sourceType, id, title, excerpt}`, with the
    // singular source type (`scene`, not `scenes`).
    const scenes = await hits("裏切り", "scenes");
    expect(scenes).toEqual([
      {
        sourceType: "scene",
        id: "n-s3",
        title: "裏切り",
        excerpt: "黒幕の正体が明かされる。",
      },
    ]);
    expect(await hits("アリア", "codex")).toEqual([
      {
        sourceType: "codex",
        id: "c-aria",
        title: "アリア",
        excerpt: "老魔術師を訪ねる旅の少女",
      },
    ]);
    const snippets = await hits("魔法", "snippets");
    expect(snippets.map((r) => [r.sourceType, r.id])).toEqual([
      ["snippet", "sn-1"],
    ]);
    // A word that is not in the seed finds nothing (an empty array, not an error).
    expect(await hits("灯台", "scenes")).toEqual([]);
    expect(await hits("灯台", "codex")).toEqual([]);
  });

  it("fts keeps projects apart, and does not itself drop archived scenes or hidden codex entries", async () => {
    const { reads } = await typedReads();
    const ids = async (
      projectId: string,
      scope: "codex" | "scenes",
      query: string,
    ) =>
      (
        (await reads.fts({ projectId, query, scope, limit: 10 })) as Array<{
          id: string;
        }>
      ).map((r) => r.id);
    const mainScenes = await ids(MAIN, "scenes", "魔法");
    expect(mainScenes).toContain("n-s3");
    // Neither of the other project's scenes is in the main project's answer,
    // and the other project's own search gives its own scene.
    expect(mainScenes.some((id) => id.startsWith("x-"))).toBe(false);
    expect(await ids(OTHER, "scenes", "魔法")).toEqual(["x-s1"]);
    // Native's fts answers an archived scene (`n-arch`) and a hidden entry
    // (`c-secret`): the filtering the renderer's search tools do is the TOOL
    // layer's, so a tool that moves into the core (PR-5, PR-8) must do it
    // itself. This pins today's Native; a change here is a finding.
    expect(mainScenes).toContain("n-arch");
    expect(await ids(MAIN, "codex", "魔法")).toContain("c-secret");
  });

  it("foreshadowOpen answers Native's own wire: the project's open foreshadows and their setups", async () => {
    const { reads } = await typedReads();
    type Wire = {
      foreshadows: Array<Record<string, unknown>>;
      setups: Array<Record<string, unknown>>;
    };
    const main = (await reads.foreshadowOpen({ projectId: MAIN })) as Wire;
    // snake_case keys, integer 0/1 for booleans, epoch milliseconds for the time.
    expect(Object.keys(main).sort()).toEqual(["foreshadows", "setups"]);
    expect(main.foreshadows.map((f) => f.id)).toEqual(["fs-1", "fs-5"]);
    expect(Object.keys(main.foreshadows[0]!).sort()).toEqual(
      [
        "abandoned",
        "id",
        "intent",
        "load_bearing",
        "payoff_confirmed",
        "title",
        "updated_at",
        "version",
      ].sort(),
    );
    expect(main.foreshadows[0]).toMatchObject({
      id: "fs-1",
      payoff_confirmed: 0,
      abandoned: 0,
      updated_at: 1_767_225_600_000,
    });
    expect(Object.keys(main.setups[0]!).sort()).toEqual(
      [
        "ai_reasoning",
        "ai_strength",
        "foreshadow_id",
        "is_orphan",
        "strength",
      ].sort(),
    );
    expect(main.setups.every((s) => s.foreshadow_id === "fs-1")).toBe(true);
    // The other project's foreshadow is not in the main project's answer.
    expect(main.foreshadows.some((f) => String(f.id).startsWith("x-"))).toBe(
      false,
    );
    const other = (await reads.foreshadowOpen({ projectId: OTHER })) as Wire;
    expect(other.foreshadows.map((f) => f.id)).toEqual(["x-fs-1"]);
    // An empty project is an empty answer, not an error.
    expect(
      await reads.foreshadowOpen({ projectId: LEGACY_READ_PROJECTS.empty }),
    ).toEqual({ foreshadows: [], setups: [] });
  });

  it("the semantic reads refuse a workspace that is not the active one; for the active one they stop after the workspace check", async () => {
    const { ws } = await typedReads();
    const call = (
      identity: MainIssuedCallerIdentity,
      method: "codexSemantic" | "eventsSemantic",
    ) =>
      createMainTypedReads({ backend: ws.backend, identity })[method]({
        projectId: MAIN,
        query: "魔法",
        limit: 3,
      });
    for (const method of ["codexSemantic", "eventsSemantic"] as const) {
      await expect(
        call({ ...ws.identity, workspaceId: ws.otherDirectory }, method),
      ).rejects.toThrow(/SEMANTIC_INDEX_WORKSPACE_CHANGED/);
      // The active workspace is past that check. What it answers then depends
      // on the machine: with no embedding model installed (the case when this
      // was written) it is `embedding model 'ruri-v3-30m' is not installed`;
      // with one, a result. A semantic tool's test belongs to a machine that
      // has the model; here only the stop after the workspace check is fixed.
      const outcome = await call(
        { ...ws.identity, workspaceId: ws.workspacePath },
        method,
      ).then(
        (value) => ({ answered: true as const, value }),
        (error: unknown) => ({
          answered: false as const,
          error: String(error),
        }),
      );
      if (outcome.answered) {
        expect(Array.isArray(outcome.value), method).toBe(true);
      } else {
        expect(outcome.error, method).not.toMatch(/WORKSPACE_CHANGED/);
        expect(outcome.error, method).toMatch(
          /embedding model .* is not installed|semantic/i,
        );
      }
    }
  });
});

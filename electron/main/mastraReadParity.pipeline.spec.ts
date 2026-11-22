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
// read tools of the core through `createCoreReadDb(createMainReadDb(..))` (and,
// for the search tools of PR-5a, Main's typed `fts` over the real FTS5 index, and
// for the foreshadow tools of PR-5b, Main's typed `foreshadowOpen`)
// and requires every golden case to come out the same: name, summary,
// tokensUsed, content, and the bytes of `JSON.stringify(content)`.
//
// A difference is a finding, not something to tune away: this file never
// loosens a comparison to make a case pass.
//
// THE TYPED READS (fts, codexSemantic, eventsSemantic, foreshadowOpen) have no
// golden that Native can match as a wire (the golden's fts is browser-mock's
// LIKE arm, its semantic reads are `[]`, its foreshadow read is a Drizzle
// branch). Their block below fixes the SHAPE of what the real addon answers on
// this seed, as the frame PR-7 and PR-8 add their cases to. What the tools BUILD
// from a wire is compared with the golden above: since PR-5a the two search
// tools (fts, with its order handled as that comparison says) and since PR-5b
// `list_open_foreshadows`, whose result is built from Native's real
// `foreshadowOpen` wire and must equal the golden to the byte.
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
  LEGACY_READ_CANNED_EVENT_HITS,
  LEGACY_READ_PROJECTS,
  LEGACY_READ_SEED,
} from "../../src/features/chat/agent/__fixtures__/legacyReadSeed.js";
import {
  CHRONICLE_CHARACTERIZATION_STATEMENTS,
  CHRONICLE_HIDDEN_NAME_EVENT,
  CHRONICLE_SCENE_OWN_ANCHOR_SCENE,
} from "../../src/features/chat/agent/__fixtures__/chronicleCharacterizationSeed.js";
import type { Envelope, NapiBackendLike } from "../shared/ipcContract.js";
import {
  CoreProjectRequiredError,
  type CoreNativeReads,
  type CoreReadContext,
} from "../shared/mastraRead/ports.js";
import {
  createMainChronicleReadContext,
  createMainChronicleSearchContext,
} from "../shared/readDomain/core/chronicleMainContext.js";
import {
  CHRONICLE_READ_TOOL_NAMES,
  CHRONICLE_SEARCH_TOOL_NAMES,
  createChronicleReadExecutors,
  createChronicleSearchExecutors,
} from "../shared/readDomain/core/chronicleReadExecutors.js";
import { readEventsFailClosed } from "../shared/readDomain/core/chronicleReaders.js";
import { buildReadInputs } from "../shared/readDomain/core/readInputs.js";
import { readChronicleReadInputs } from "../shared/readDomain/core/readInputsReader.js";
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
/** The seed's archived scenes: Native's `fts` returns them, the tool drops them. */
const ARCHIVED_SCENE_IDS: ReadonlySet<string> = new Set(
  LEGACY_READ_SEED.filter((t) => t.table === "tree_nodes").flatMap((t) =>
    t.rows
      .filter(
        (row) =>
          (row as Record<string, unknown>)["node_type"] === "scene" &&
          (row as Record<string, unknown>)["archived_at"] != null,
      )
      .map((row) => String((row as Record<string, unknown>)["id"])),
  ),
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
async function startSeededWorkspace(
  extraStatements: ReadonlyArray<{
    sql: string;
    params: ReadonlyArray<string | number | null>;
  }> = [],
): Promise<Workspace> {
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
  insertSeedFromAnotherProcess(seeded.path, root, extraStatements);
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
  extraStatements: ReadonlyArray<{
    sql: string;
    params: ReadonlyArray<string | number | null>;
  }>,
): void {
  const seedFile = path.join(scratchDirectory, "legacy-read-seed.json");
  writeFileSync(seedFile, JSON.stringify(LEGACY_READ_SEED));
  const extraFile = path.join(scratchDirectory, "extra-statements.json");
  writeFileSync(extraFile, JSON.stringify(extraStatements));
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
for (const { sql, params } of JSON.parse(readFileSync(process.argv[3], "utf8"))) {
  db.prepare(sql).run(...params);
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
      extraFile,
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
  it("covers exactly the eleven tools of groups B1, B2, B3 and B4, each with a golden", () => {
    expect([...CORE_READ_TOOL_NAMES].sort()).toEqual(
      [
        "get_chapter_summaries",
        "get_foreshadow_detail",
        "get_scene",
        "get_scene_timeline_neighbors",
        "get_thread_scenes",
        "list_chapters",
        "list_codex_tags",
        "list_open_foreshadows",
        "list_plot_threads",
        "search_scenes",
        "search_snippets",
      ].sort(),
    );
    for (const tool of CORE_READ_TOOL_NAMES) {
      expect(goldenOf(tool).length, tool).toBeGreaterThan(0);
    }
  });

  it("every golden case of the eleven tools is the same on the real addon, to the byte", async () => {
    const ws = await startSeededWorkspace();
    const mainDb = createCoreReadDb(
      createMainReadDb({ backend: ws.readBackend, identity: ws.identity }),
    );
    // The tree state of a turn is what Main fixes at its start (DR-MP4-8): here
    // only the project and the active scene, which is all the eleven tools read
    // of it (the tree itself they read from the DB).
    let world: GoldenCase["world"] = { projectId: "" };
    const realReads = createMainTypedReads({
      backend: ws.backend,
      identity: ws.identity,
    });
    const ftsCalls: Array<Parameters<CoreNativeReads["fts"]>[0]> = [];
    const foreshadowCalls: Array<
      Parameters<CoreNativeReads["foreshadowOpen"]>[0]
    > = [];
    const ctx: CoreReadContext = {
      getDb: () => mainDb,
      getTreeState: () => ({
        projectId: world.projectId,
        nodes: [],
        activeSceneId: world.activeSceneId ?? null,
      }),
      body: createDbSceneBodyReader(() => mainDb),
      // The real Native's full-text read, through Main's typed read (PR-5a),
      // behind a spy: a case that reaches `fts` is the FTS arm (see below).
      native: {
        fts: async (args) => {
          ftsCalls.push(args);
          return realReads.fts(args);
        },
        // The real Native's open-foreshadow read, through Main's typed read
        // (PR-5b), behind a spy: its answer is a wire and the core builds the
        // tool's result from it (the golden is compared to the byte).
        foreshadowOpen: async (args) => {
          foreshadowCalls.push(args);
          return realReads.foreshadowOpen(args);
        },
      },
      // The golden counts one UTF-16 unit as one token (PR-0's fixed counter).
      countTokens: (text) => (text ? text.length : 0),
    };
    const executors = createReadExecutors(ctx);

    const compared: Record<string, number> = {};
    const ftsCases: Record<string, number> = {};
    for (const tool of CORE_READ_TOOL_NAMES) {
      const cases = goldenOf(tool);
      let done = 0;
      let noProject = 0;
      for (const golden of cases) {
        world = golden.world;
        ws.dbExecute.mockClear();
        ftsCalls.length = 0;
        foreshadowCalls.length = 0;
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
          expect(foreshadowCalls, label).toEqual([]);
          noProject += 1;
          continue;
        }
        if (ftsCalls.length === 0) {
          // Not the FTS arm (a short word's LIKE-OR, an empty query): nothing
          // reached `fts`, and the golden is compared to the byte. A word of
          // three characters or more that matches nothing still reaches `fts`
          // and is compared in the branch below.
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
          expect(JSON.stringify(actual.content), label).toBe(
            golden.contentJson,
          );
        } else {
          // The FTS arm. The golden's order is browser-mock's LIKE scan order,
          // which is not an order real FTS5 gives, and the renderer's own
          // product path takes the order of Native's `fts` too. So the ORDER is
          // required to be the order the real `fts` returned (with the archived
          // scenes dropped, and cut to the tool's 10), computed here from a
          // direct call of the real `fts` with the same arguments (not written
          // down); everything else is still the golden's, to the byte: the
          // summary, tokensUsed, and each row (the rows sorted by id, as JSON).
          expect(ftsCalls, label).toHaveLength(1);
          const call = ftsCalls[0]!;
          // The arguments are fixed here too, not taken on trust from the core:
          // the project of the case, the trimmed query, the tool's scope, and
          // the limit (scenes take Rust's 50 to drop archived rows before the
          // cut to 10; snippets take 10).
          const params = golden.params as { query?: unknown };
          expect(call, `${label}: fts arguments`).toEqual({
            projectId: golden.world.projectId,
            query: String(params.query ?? "").trim(),
            scope: tool === "search_scenes" ? "scenes" : "snippets",
            limit: tool === "search_scenes" ? 50 : 10,
          });
          const sourceType = call.scope === "scenes" ? "scene" : "snippet";
          const direct = (await realReads.fts(call)) as Array<{
            sourceType: string;
            id: string;
          }>;
          const expectedIds = direct
            .filter(
              (hit) =>
                hit.sourceType === sourceType &&
                !(sourceType === "scene" && ARCHIVED_SCENE_IDS.has(hit.id)),
            )
            .map((hit) => hit.id)
            .slice(0, 10);
          const rows = actual.content as Array<{ id: string }>;
          const goldenRows = golden.result.content as Array<{ id: string }>;
          expect(
            rows.map((row) => row.id),
            `${label}: order of the real fts`,
          ).toEqual(expectedIds);
          const byId = (a: { id: string }, b: { id: string }) =>
            a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
          expect(actual.name, label).toBe(golden.result.name);
          expect(actual.summary, label).toBe(golden.result.summary);
          expect(actual.tokensUsed, label).toBe(golden.result.tokensUsed);
          expect(JSON.stringify([...rows].sort(byId)), label).toBe(
            JSON.stringify([...goldenRows].sort(byId)),
          );
          ftsCases[tool] = (ftsCases[tool] ?? 0) + 1;
        }
        ftsCalls.length = 0;
        // list_open_foreshadows reads through the typed read, once, for the
        // project only, and sends no statement of its own; no other tool does.
        if (tool === "list_open_foreshadows") {
          expect(foreshadowCalls, label).toEqual([
            { projectId: golden.world.projectId },
          ]);
          expect(ws.dbExecute, label).not.toHaveBeenCalled();
        } else {
          expect(foreshadowCalls, label).toEqual([]);
        }
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
    // The FTS-arm comparison above is not vacuous, per tool: the golden cases
    // that reach `fts` (search_scenes: アリア, 外部ファイル, 親フォルダ, 旅立ち,
    // 存在しない語, 他作品; search_snippets: 老魔術師, 存在しない語, 他作品).
    expect(ftsCases).toEqual({ search_scenes: 6, search_snippets: 3 });
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
  // tools), PR-7 (events) and PR-8 (Codex hidden) add their cases here. The
  // foreshadow tools (PR-5b) also have a golden comparison in the describe above;
  // the secret case below is the one that must not be empty.
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

  it("search_scenes drops the archived scene that the real fts returns (the condition is the tool's), search_snippets follows the real fts order", async () => {
    const ws = await startSeededWorkspace();
    const reads = createMainTypedReads({
      backend: ws.backend,
      identity: ws.identity,
    });
    const mainDb = createCoreReadDb(
      createMainReadDb({ backend: ws.readBackend, identity: ws.identity }),
    );
    const executors = createReadExecutors({
      getDb: () => mainDb,
      getTreeState: () => ({
        projectId: MAIN,
        nodes: [],
        activeSceneId: null,
      }),
      body: createDbSceneBodyReader(() => mainDb),
      native: reads,
      countTokens: (text) => (text ? text.length : 0),
    });
    // The word is only in the archived scene `n-arch`: Native's fts finds it ...
    const raw = (await reads.fts({
      projectId: MAIN,
      query: "外部ファイル",
      scope: "scenes",
      limit: 50,
    })) as Array<{ id: string }>;
    expect(raw.map((r) => r.id)).toContain("n-arch");
    // ... and the tool, which owns the archived condition, does not show it.
    const scenes = await executors.search_scenes({ query: "外部ファイル" });
    expect(scenes.content).toEqual([]);
    expect(scenes.summary).toBe("0 scenes found");
    // A snippet found by the real index comes back with its tags and preview.
    const snippets = await executors.search_snippets({ query: "老魔術師" });
    expect(
      (snippets.content as Array<{ id: string }>).map((r) => r.id),
    ).toEqual(["sn-2"]);
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

  it("a secret foreshadow is not in list_open_foreshadows built from the real Native wire, and get_foreshadow_detail still returns it (DR-MP4-24)", async () => {
    // The condition `secret = 0` lives in Native's SQL only: the wire has no
    // secret column, so the core cannot filter again. If Native's SQL changed,
    // a secret foreshadow's intent would reach the model; this case is what
    // would show it. It must not be vacuous: the seed's `fs-2` is secret, not
    // paid off and not abandoned (what would otherwise be listed).
    const seedRows = LEGACY_READ_SEED.find((t) => t.table === "foreshadows")!
      .rows as Array<Record<string, unknown>>;
    const fs2 = seedRows.find((r) => r.id === "fs-2")!;
    expect(fs2).toMatchObject({
      project_id: MAIN,
      secret: 1,
      payoff_confirmed: 0,
      abandoned: 0,
    });

    const ws = await startSeededWorkspace();
    const reads = createMainTypedReads({
      backend: ws.backend,
      identity: ws.identity,
    });
    const mainDb = createCoreReadDb(
      createMainReadDb({ backend: ws.readBackend, identity: ws.identity }),
    );
    const executors = createReadExecutors({
      getDb: () => mainDb,
      getTreeState: () => ({
        projectId: MAIN,
        nodes: [],
        activeSceneId: null,
      }),
      body: createDbSceneBodyReader(() => mainDb),
      native: reads,
      countTokens: (text) => (text ? text.length : 0),
    });

    // The raw wire has neither fs-2 nor a setup of it (fsu-4).
    const wire = (await reads.foreshadowOpen({ projectId: MAIN })) as {
      foreshadows: Array<{ id: string }>;
      setups: Array<{ foreshadow_id: string }>;
    };
    expect(wire.foreshadows.map((f) => f.id)).not.toContain("fs-2");
    expect(wire.setups.map((x) => x.foreshadow_id)).not.toContain("fs-2");

    // The tool's answer is the golden's first case, to the byte, without fs-2.
    const golden = goldenOf("list_open_foreshadows")[0]!;
    expect(golden.world.projectId).toBe(MAIN);
    ws.dbExecute.mockClear();
    const listed = await executors.list_open_foreshadows({});
    expect((listed.content as Array<{ id: string }>).map((r) => r.id)).toEqual([
      "fs-1",
      "fs-5",
    ]);
    expect(JSON.stringify(listed.content)).toBe(golden.contentJson);
    expect(listed.summary).toBe(golden.result.summary);
    expect(listed.tokensUsed).toBe(golden.result.tokensUsed);
    expect(ws.dbExecute).not.toHaveBeenCalled();

    // get_foreshadow_detail answers the same foreshadow by id (moved as it is).
    const detailGolden = goldenOf("get_foreshadow_detail").find(
      (c) => (c.params as { id?: unknown }).id === "fs-2",
    )!;
    expect(detailGolden).toBeDefined();
    const detail = await executors.get_foreshadow_detail({ id: "fs-2" });
    expect(detail.summary).toBe(detailGolden.result.summary);
    expect(JSON.stringify(detail.content)).toBe(detailGolden.contentJson);
    expect((detail.content as { id: string; intent: string }).intent).toBe(
      "黒幕は最初から出ている",
    );
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

describe("the chronicle tools of the read core (PR-7a) on Main's adapter over the real Native addon", () => {
  /**
   * The turn of the chronicle tools: the tree from one select and the current
   * scene of the wire (`readChronicleReadInputs`), then a context built from it.
   * An empty project cannot read a tree, so it gets empty inputs and the core
   * stops before it reads anything.
   */
  async function chronicleExecutors(
    ws: Workspace,
    world: GoldenCase["world"] & { language?: "ja" | "en" },
  ) {
    const db = createCoreReadDb(
      createMainReadDb({ backend: ws.readBackend, identity: ws.identity }),
    );
    const turn =
      world.projectId === ""
        ? {
            inputs: buildReadInputs({
              projectId: "",
              treeRows: [],
              project: null,
              currentSceneId: null,
            }),
            nodes: [],
          }
        : await readChronicleReadInputs(db, {
            projectId: world.projectId,
            currentSceneId: world.activeSceneId ?? null,
          });
    ws.dbExecute.mockClear();
    const main = createMainChronicleReadContext({
      db,
      turn,
      countTokens: (text) => (text ? text.length : 0),
      getUiLanguage: () => world.language ?? "ja",
    });
    return { executors: createChronicleReadExecutors(main.ctx), main };
  }

  it("covers exactly the four tools of group B6 (search_events is the next describe), each with a golden, and none of them is in CORE_READ_TOOL_NAMES", () => {
    expect([...CHRONICLE_READ_TOOL_NAMES].sort()).toEqual([
      "get_character_timeline",
      "get_chronicle_state",
      "get_event_detail",
      "list_events",
    ]);
    for (const tool of CHRONICLE_READ_TOOL_NAMES) {
      expect(goldenOf(tool).length, tool).toBeGreaterThan(0);
      expect((CORE_READ_TOOL_NAMES as readonly string[]).includes(tool)).toBe(
        false,
      );
    }
  });

  it("every golden case of the four tools is the same on the real addon, to the byte", async () => {
    const ws = await startSeededWorkspace();
    const compared: Record<string, number> = {};
    for (const tool of CHRONICLE_READ_TOOL_NAMES) {
      const cases = goldenOf(tool);
      let done = 0;
      let noProject = 0;
      for (const golden of cases) {
        const label = `${tool} / ${golden.case}`;
        const world = golden.world as GoldenCase["world"] & {
          language?: "ja" | "en";
        };
        const { executors } = await chronicleExecutors(ws, world);
        let actual: Awaited<ReturnType<(typeof executors)[typeof tool]>>;
        try {
          actual = await executors[tool](golden.params);
        } catch (error) {
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
      [...CHRONICLE_READ_TOOL_NAMES].sort(),
    );
  });

  it("the golden's world has no scene-own date and no event that names a hidden Codex entry; with them (the characterization seed) the real addon answers as the renderer's legacy did", async () => {
    const ws = await startSeededWorkspace(
      CHRONICLE_CHARACTERIZATION_STATEMENTS,
    );
    const world = { projectId: "p-main", activeSceneId: "n-s3" };
    const { executors } = await chronicleExecutors(ws, world);
    // A scene's own chronicle date reaches the anchor: the integer columns come
    // back as numbers and the text columns as text (n-s2 has no event of its own).
    const own = await executors.get_chronicle_state({
      sceneId: CHRONICLE_SCENE_OWN_ANCHOR_SCENE,
    });
    expect(own.summary).toBe("Chronicle state at scene (scene)");
    expect(JSON.stringify(own.content)).toBe(
      '{"time":{"source":"scene","startTime":7000,"season":null,"precision":"approx","formattedDate":"1019年第161日"},"characters":[{"codexId":"c-secret","name":"黒幕","status":"unknown","age":null,"location":"黒幕"},{"codexId":"c-aria","name":"アリア","status":"alive","age":19,"location":"古い塔"},{"codexId":"c-mage","name":"老魔術師","status":"unknown","age":null,"location":"古い塔"}],"recentEvents":[{"eventId":"ev-hidden-name","title":"黒幕の登場","note":null,"relTime":"約3年前"},{"eventId":"ev-meet","title":"老魔術師との出会い","note":null,"relTime":"約4年前"}],"unresolvedCausal":[],"offpage":[]}',
    );
    // The names of a hidden Codex entry are returned as they are (DR-MP4-37).
    const detail = await executors.get_event_detail({
      eventId: CHRONICLE_HIDDEN_NAME_EVENT,
    });
    expect(detail.content).toMatchObject({
      primaryCharacter: "黒幕",
      location: "黒幕",
      participants: [{ codexId: "c-secret", name: "黒幕", role: "黒幕役" }],
    });
    const timeline = await executors.get_character_timeline({
      codexId: "c-secret",
    });
    expect(timeline.content).toMatchObject({ character: "黒幕" });
  });
});

describe("search_events of the read core (PR-7b) on Main's adapter over the real Native addon", () => {
  const MAIN_PROJECT = LEGACY_READ_PROJECTS.main;

  /**
   * The turn of `search_events`: the tree from one select and the current scene of
   * the wire, a context that reads the events and the scene-event bridges again for
   * every call (DR-MP4-38), and a `native` the caller chooses: a fake that answers
   * the golden's canned hits (the model-independent comparison), or Main's typed
   * read over the real backend (what the real index answers depends on the machine).
   */
  async function searchExecutors(
    ws: Workspace,
    world: GoldenCase["world"],
    native: Pick<CoreNativeReads, "eventsSemantic">,
  ) {
    const db = createCoreReadDb(
      createMainReadDb({ backend: ws.readBackend, identity: ws.identity }),
    );
    const turn =
      world.projectId === ""
        ? {
            inputs: buildReadInputs({
              projectId: "",
              treeRows: [],
              project: null,
              currentSceneId: null,
            }),
            nodes: [],
          }
        : await readChronicleReadInputs(db, {
            projectId: world.projectId,
            currentSceneId: world.activeSceneId ?? null,
          });
    ws.dbExecute.mockClear();
    return createChronicleSearchExecutors(
      createMainChronicleSearchContext({
        db,
        turn,
        countTokens: (text) => (text ? text.length : 0),
        native,
      }),
    );
  }

  const cannedNative = (
    sent: unknown[] = [],
  ): Pick<CoreNativeReads, "eventsSemantic"> => ({
    eventsSemantic: async (args) => {
      sent.push(args);
      return LEGACY_READ_CANNED_EVENT_HITS;
    },
  });

  /** The golden cases whose dense answer is the canned hits (the others have no model-independent answer here). */
  const CANNED_CASE = /^(?:canned: (?!dense が reject)|XPROJ: )/u;

  it("is the one tool of its own table, with a golden", () => {
    expect([...CHRONICLE_SEARCH_TOOL_NAMES]).toEqual(["search_events"]);
    expect(goldenOf("search_events").length).toBeGreaterThan(0);
    const all = [
      ...CORE_READ_TOOL_NAMES,
      ...CHRONICLE_READ_TOOL_NAMES,
      ...CHRONICLE_SEARCH_TOOL_NAMES,
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  it("the golden cases that answer from the canned hits are the same on the real addon, to the byte (real events and scene_events reads, a fake dense)", async () => {
    const ws = await startSeededWorkspace();
    const cases = goldenOf("search_events");
    let compared = 0;
    for (const golden of cases.filter((c) => CANNED_CASE.test(c.case))) {
      const label = `search_events / ${golden.case}`;
      const sent: Array<{ projectId: string; query: string; limit: number }> =
        [];
      const executors = await searchExecutors(
        ws,
        golden.world,
        cannedNative(sent),
      );
      const actual = await executors.search_events(golden.params);
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
      expect(sent, label).toEqual([
        {
          projectId: golden.world.projectId,
          query: golden.params.query,
          limit: golden.params.limit === 2 ? 6 : 30,
        },
      ]);
      for (const call of ws.dbExecute.mock.calls) {
        expect(String(call[0]), label).toMatch(/^\s*select\b/iu);
        expect(["all", "values"], label).toContain(call[2]);
        expect(call[3], label).toBe(JSON.stringify(ws.identity));
      }
      compared += 1;
    }
    // S1, S3, no scene, limit=2, limit "abc", XPROJ
    expect(compared).toBe(6);
  });

  it("the cases that stop before the dense read (no project; an empty query before the project) are the same, and read nothing", async () => {
    const ws = await startSeededWorkspace();
    for (const golden of goldenOf("search_events").filter(
      (c) => c.case.startsWith("no-project") || c.case.startsWith("order"),
    )) {
      const label = golden.case;
      const sent: unknown[] = [];
      const executors = await searchExecutors(
        ws,
        golden.world,
        cannedNative(sent),
      );
      if (golden.world.projectId === "" && golden.params.query !== "") {
        await expect(
          executors.search_events(golden.params),
          label,
        ).rejects.toBeInstanceOf(CoreProjectRequiredError);
      } else {
        const actual = await executors.search_events(golden.params);
        expect(actual.summary, label).toBe(golden.result.summary);
        expect(actual.content, label).toEqual(golden.result.content);
        expect(JSON.stringify(actual.content), label).toBe(golden.contentJson);
      }
      expect(sent, label).toEqual([]);
      expect(ws.dbExecute, label).not.toHaveBeenCalled();
    }
  });

  it("a dense failure is the tool's error, never `[]` (the golden's `reject` case is a legacy-port result, not compared)", async () => {
    const ws = await startSeededWorkspace();
    const golden = goldenOf("search_events").find((c) =>
      c.case.includes("dense が reject"),
    )!;
    expect(golden.result.summary).toBe("0 events found");
    const executors = await searchExecutors(ws, golden.world, {
      eventsSemantic: async () => {
        throw new Error("dense unavailable");
      },
    });
    await expect(executors.search_events(golden.params)).rejects.toThrow(
      /dense unavailable/,
    );
  });

  it("reads `events` and `scene_events` from the real addon again for every call (twice for two calls)", async () => {
    const ws = await startSeededWorkspace();
    const executors = await searchExecutors(
      ws,
      { projectId: MAIN_PROJECT, activeSceneId: "n-s1" },
      cannedNative(),
    );
    const countFrom = (table: string) =>
      ws.dbExecute.mock.calls.filter((call) =>
        new RegExp(`from "${table}"`, "iu").test(String(call[0])),
      ).length;
    await executors.search_events({ query: "魔術" });
    await executors.search_events({ query: "魔術" });
    expect(countFrom("events")).toBe(2);
    expect(countFrom("scene_events")).toBe(2);
  });

  it("the real dense read (what it answers depends on the machine): when it answers, every hit is an event of the asked project; when it does not, the tool fails and is never `[]`", async () => {
    const ws = await startSeededWorkspace();
    const native = createMainTypedReads({
      backend: ws.backend,
      identity: ws.identity,
    });
    const executors = await searchExecutors(
      ws,
      { projectId: MAIN_PROJECT, activeSceneId: "n-s3" },
      native,
    );
    const db = createCoreReadDb(
      createMainReadDb({ backend: ws.readBackend, identity: ws.identity }),
    );
    const own = new Set(
      (await readEventsFailClosed(db, MAIN_PROJECT)).map((e) => e.id),
    );
    expect(own.size).toBeGreaterThan(0);
    const outcome = await executors.search_events({ query: "魔術" }).then(
      (value) => ({ answered: true as const, value }),
      (error: unknown) => ({ answered: false as const, error: String(error) }),
    );
    if (outcome.answered) {
      const content = outcome.value.content as Array<{ eventId: string }>;
      expect(Array.isArray(content)).toBe(true);
      // Native's index is read by project: no hit of another project's event. (Vacuous
      // where the seed has no event index: the answer is [] and the loop does not run.
      // The project scoping itself is pinned in Rust, `events_search_scopes_to_project`.)
      for (const hit of content)
        expect(own.has(hit.eventId), hit.eventId).toBe(true);
    } else {
      expect(outcome.error).not.toMatch(/WORKSPACE_CHANGED/);
      expect(outcome.error).toMatch(
        /embedding model .* is not installed|semantic/i,
      );
    }
  });

  it("a workspace that is not the active one is refused and reaches the tool as its failure", async () => {
    const ws = await startSeededWorkspace();
    const native = createMainTypedReads({
      backend: ws.backend,
      identity: { ...ws.identity, workspaceId: ws.otherDirectory },
    });
    const executors = await searchExecutors(
      ws,
      { projectId: MAIN_PROJECT, activeSceneId: "n-s3" },
      native,
    );
    await expect(executors.search_events({ query: "魔術" })).rejects.toThrow(
      /SEMANTIC_INDEX_WORKSPACE_CHANGED/,
    );
  });

  it("a limit that rounds to 0 passes the real `requireUnsignedInteger` and Native answers none (or the model-less machine refuses; never a workspace error)", async () => {
    const ws = await startSeededWorkspace();
    const native = createMainTypedReads({
      backend: ws.backend,
      identity: ws.identity,
    });
    const executors = await searchExecutors(
      ws,
      { projectId: MAIN_PROJECT, activeSceneId: "n-s3" },
      native,
    );
    const outcome = await executors
      .search_events({ query: "魔術", limit: 0.5 })
      .then(
        (value) => ({ answered: true as const, value }),
        (error: unknown) => ({
          answered: false as const,
          error: String(error),
        }),
      );
    if (outcome.answered) {
      expect(outcome.value.summary).toBe("0 events found");
    } else {
      expect(outcome.error).not.toMatch(/WORKSPACE_CHANGED|unsigned|integer/i);
      expect(outcome.error).toMatch(
        /embedding model .* is not installed|semantic/i,
      );
    }
  });
});

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

import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";

import {
  LEGACY_READ_CANNED_CODEX_HITS,
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
  createMainCodexReadContext,
  createMainCodexVisibilityPorts,
} from "../shared/readDomain/core/codexMainContext.js";
import {
  CODEX_READ_TOOL_NAMES,
  createCodexReadExecutors,
} from "../shared/readDomain/core/codexReadExecutors.js";
import { readCodexPhases } from "../shared/readDomain/core/codexReaders.js";
import {
  dropHiddenCodexRows,
  listHiddenCodexIds,
  resolveCodexAiVisibility,
} from "../shared/readDomain/core/codexVisibility.js";
import {
  CHRONICLE_READ_TOOL_NAMES,
  CHRONICLE_SEARCH_TOOL_NAMES,
  createChronicleReadExecutors,
  createChronicleSearchExecutors,
} from "../shared/readDomain/core/chronicleReadExecutors.js";
import { readEventsFailClosed } from "../shared/readDomain/core/chronicleReaders.js";
import { buildReadInputs } from "../shared/readDomain/core/readInputs.js";
import {
  readChronicleReadInputs,
  readReadInputs,
} from "../shared/readDomain/core/readInputsReader.js";
import { createCoreReadDb } from "../shared/readDomain/core/readDb.js";
import { fuseCodexHybrid } from "../shared/readDomain/features/chat/agent/codexHybridSearch.js";
import {
  CORE_READ_TOOL_NAMES,
  createReadExecutors,
} from "../shared/readDomain/core/readExecutors.js";
import { createDbSceneBodyReader } from "../shared/readDomain/core/sceneBody.js";
import { codexEntries } from "../shared/readDomain/db/schema.js";
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
/**
 * The calls the renderer's four Codex tools send for each golden case (PR-8b; made from the unchanged
 * renderer by `toolExecutors.codexCalls.test.ts`). `db_execute` entries are (sql, params, method).
 */
const CODEX_CALLS_FIXTURE = path.join(
  ROOT,
  "src",
  "features",
  "chat",
  "agent",
  "__fixtures__",
  "codexReadCalls",
  "codex-read-calls.golden.txt",
);
/**
 * The seed's archived scenes: Native's `fts` returns them in the `scenes` scope
 * and leaves them out in `scenes_live` (the scope `search_scenes` asks for).
 */
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
          // down; Native's own `scenes_live` already leaves archived scenes
          // out, so nothing is dropped from it here); everything else is still the golden's, to the byte: the
          // summary, tokensUsed, and each row (the rows sorted by id, as JSON).
          expect(ftsCalls, label).toHaveLength(1);
          const call = ftsCalls[0]!;
          // The arguments are fixed here too, not taken on trust from the core:
          // the project of the case, the trimmed query, the tool's scope, and
          // the limit (both tools take 10; scenes ask for the `scenes_live`
          // scope, which leaves archived scenes out before its limit).
          const params = golden.params as { query?: unknown };
          expect(call, `${label}: fts arguments`).toEqual({
            projectId: golden.world.projectId,
            query: String(params.query ?? "").trim(),
            scope: tool === "search_scenes" ? "scenes_live" : "snippets",
            limit: 10,
          });
          const sourceType = call.scope === "snippets" ? "snippet" : "scene";
          const direct = (await realReads.fts(call)) as Array<{
            sourceType: string;
            id: string;
          }>;
          // Native's own answer is the order, as it is: no archived scene is in
          // it (the `scenes_live` scope), and no cut is needed (limit 10).
          expect(
            direct.filter((hit) => ARCHIVED_SCENE_IDS.has(hit.id)),
            `${label}: Native's scenes_live leaves archived scenes out`,
          ).toEqual([]);
          const expectedIds = direct
            .filter((hit) => hit.sourceType === sourceType)
            .map((hit) => hit.id);
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
    // Native's fts answers an archived scene (`n-arch`) in the `scenes` scope
    // and a hidden entry (`c-secret`) in the `codex` scope: the `scenes` scope
    // is not changed by the `scenes_live` scope (DR-ARC-1; the command center,
    // the chat recall and the related scenes still read it), and the hidden
    // entry's condition is the tool layer's (DR-MP4-40). This pins today's
    // Native; a change here is a finding.
    expect(mainScenes).toContain("n-arch");
    expect(await ids(MAIN, "codex", "魔法")).toContain("c-secret");
  });

  it("fts scenes_live is scenes without the archived scenes: it finds the live ones (not an empty answer) and keeps projects apart", async () => {
    const { reads } = await typedReads();
    const ids = async (
      projectId: string,
      scope: "scenes" | "scenes_live",
      query: string,
    ) =>
      (
        (await reads.fts({ projectId, query, scope, limit: 10 })) as Array<{
          id: string;
        }>
      ).map((r) => r.id);
    // The positive control: an addon that does not know `scenes_live` answers
    // an empty list (an unknown scope is not an error), and fails these.
    expect(await ids(MAIN, "scenes_live", "裏切り")).toEqual(["n-s3"]);
    const live = await ids(MAIN, "scenes_live", "魔法");
    expect(live).toContain("n-s3");
    expect(live).not.toContain("n-arch");
    expect(live.some((id) => id.startsWith("x-"))).toBe(false);
    expect(await ids(OTHER, "scenes_live", "魔法")).toEqual(["x-s1"]);
    // The word is only in the archived scene: `scenes` finds it, `scenes_live`
    // does not.
    expect(await ids(MAIN, "scenes", "外部ファイル")).toEqual(["n-arch"]);
    expect(await ids(MAIN, "scenes_live", "外部ファイル")).toEqual([]);
    // A subset of `scenes`, in `scenes`' order.
    const scenes = await ids(MAIN, "scenes", "魔法");
    expect(live).toEqual(scenes.filter((id) => id !== "n-arch"));
  });

  it("search_scenes does not show the archived scene (Native's scenes_live leaves it out, and the tool keeps its own condition), search_snippets follows the real fts order", async () => {
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
    // The word is only in the archived scene `n-arch`: Native's `scenes` scope
    // finds it, its `scenes_live` scope (the one the tool asks for) does not ...
    const raw = (await reads.fts({
      projectId: MAIN,
      query: "外部ファイル",
      scope: "scenes",
      limit: 10,
    })) as Array<{ id: string }>;
    expect(raw.map((r) => r.id)).toContain("n-arch");
    const live = (await reads.fts({
      projectId: MAIN,
      query: "外部ファイル",
      scope: "scenes_live",
      limit: 10,
    })) as Array<{ id: string }>;
    expect(live).toEqual([]);
    // ... and the tool does not show it.
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
        expect(outcome.error, method).not.toMatch(
          /(?:codex|events)_semantic_search: /,
        );
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
      // The core's own narrowing errors ("events_semantic_search: the result is not an array", ...) also
      // contain "semantic": a wire that does not fit the narrowing must not pass as "no model here".
      expect(outcome.error).not.toMatch(/events_semantic_search: /);
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
      expect(outcome.error).not.toMatch(/events_semantic_search: /);
      expect(outcome.error).toMatch(
        /embedding model .* is not installed|semantic/i,
      );
    }
  });
});

describe("the Codex visibility decision of the read core (PR-8a) on Main's adapter over the real Native addon", () => {
  async function visibilityPorts(
    ws: Workspace,
    projectId: string,
    currentSceneId: string | null,
  ) {
    const db = createCoreReadDb(
      createMainReadDb({ backend: ws.readBackend, identity: ws.identity }),
    );
    const inputs = await readReadInputs(db, { projectId, currentSceneId });
    ws.dbExecute.mockClear();
    return {
      db,
      inputs,
      ports: createMainCodexVisibilityPorts({ db, inputs }),
    };
  }

  const expectOnlySelectsWithIdentity = (ws: Workspace): void => {
    expect(ws.dbExecute).toHaveBeenCalled();
    for (const call of ws.dbExecute.mock.calls) {
      expect(String(call[0])).toMatch(/^\s*select\b/iu);
      expect(["all", "values"]).toContain(call[2]);
      expect(call).toHaveLength(4);
      expect(call[3]).toBe(JSON.stringify(ws.identity));
    }
  };

  it("`codex_entry_phases` is readable through the adapter: every column, the types Native returns (integers are numbers, text is strings, NULL is null), the seed's `ph-released`", async () => {
    const ws = await startSeededWorkspace();
    const { db } = await visibilityPorts(ws, "p-main", null);
    const phases = await readCodexPhases(db, ["c-released", "c-aria"]);
    expect(phases).toEqual([
      {
        id: "ph-released",
        entryId: "c-released",
        anchorNodeId: "n-s3",
        label: "正体判明",
        summaryOverride: "n-s3 で正体が明らかになる騎士。",
        contentOverride: expect.stringContaining("Phase 解決後の本文。"),
        contextModeOverride: "mentioned",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        version: 0,
      },
    ]);
    expect(typeof phases[0]!.version).toBe("number");
    expectOnlySelectsWithIdentity(ws);
  });

  it("hides the seed's hidden entry, releases `c-released` from n-s3 with the phase's text, keeps another project's entry out, and sends only selects with the caller identity", async () => {
    const ws = await startSeededWorkspace();
    const ids = ["c-aria", "c-secret", "c-released", "x-c-aria", "gone"];
    const decide = async (sceneId: string | null) => {
      const { ports } = await visibilityPorts(ws, "p-main", sceneId);
      ws.dbExecute.mockClear();
      const result = await resolveCodexAiVisibility(ports, {
        projectId: "p-main",
        entryIds: ids,
        sceneId,
        withContent: true,
      });
      expectOnlySelectsWithIdentity(ws);
      // The entries select and the phases select, in this order.
      expect(ws.dbExecute.mock.calls.map((c) => String(c[0]))).toEqual([
        expect.stringMatching(/from "codex_entries"/u),
        expect.stringMatching(/from "codex_entry_phases"/u),
      ]);
      return result;
    };

    for (const sceneId of ["n-s1", "n-s2", null]) {
      const r = await decide(sceneId);
      expect([...r.hidden].sort(), String(sceneId)).toEqual([
        "c-released",
        "c-secret",
        "gone",
        "x-c-aria",
      ]);
      expect([...r.texts.keys()], String(sceneId)).toEqual(["c-aria"]);
    }
    const atS3 = await decide("n-s3");
    expect([...atS3.hidden].sort()).toEqual(["c-secret", "gone", "x-c-aria"]);
    expect(atS3.texts.get("c-released")).toEqual({
      summary: "n-s3 で正体が明らかになる騎士。",
      content: expect.stringContaining("Phase 解決後の本文。"),
      released: true,
      mode: "mentioned",
    });
    expect(atS3.texts.get("c-aria")).toMatchObject({
      released: false,
      summary: "老魔術師を訪ねる旅の少女",
    });
  });

  it("listHiddenCodexIds and dropHiddenCodexRows give the same answer, and the turn's input is the project's own (another project's input is refused)", async () => {
    const ws = await startSeededWorkspace();
    const { ports } = await visibilityPorts(ws, "p-main", "n-s3");
    const hidden = await listHiddenCodexIds(ports, {
      projectId: "p-main",
      entryIds: ["c-aria", "c-secret", "c-released", "gone"],
      sceneId: "n-s3",
    });
    expect([...hidden].sort()).toEqual(["c-secret", "gone"]);
    const kept = await dropHiddenCodexRows(
      ports,
      [
        { id: "c-secret", summary: "s" },
        { id: "c-released", summary: "base" },
      ],
      { projectId: "p-main", sceneId: "n-s3" },
    );
    expect(kept).toEqual([
      { id: "c-released", summary: "n-s3 で正体が明らかになる騎士。" },
    ]);
    await expect(
      listHiddenCodexIds(ports, {
        projectId: "p-other",
        entryIds: ["x-c-aria"],
        sceneId: null,
      }),
    ).rejects.toThrow(/different project/u);
    await expect(
      resolveCodexAiVisibility(ports, {
        projectId: "",
        entryIds: ["c-aria"],
        sceneId: null,
      }),
    ).rejects.toBeInstanceOf(CoreProjectRequiredError);
  });

  it("two phases of one entry at one scene with the same created_at are ordered by id (K-4: the real database gives them in the order the resolver then fixes)", async () => {
    // `c-mage` is public. `ph-tie-b` hides it and `ph-tie-a` shows it, both at n-s1
    // with the same time: the resolver orders them by id, so the later id (b) wins.
    const phase = (id: string, mode: string) => ({
      sql: "INSERT INTO codex_entry_phases (id, entry_id, anchor_node_id, label, context_mode_override, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      params: [
        id,
        "c-mage",
        "n-s1",
        id,
        mode,
        "2026-01-02T00:00:00.000Z",
        "2026-01-02T00:00:00.000Z",
      ],
    });
    const ws = await startSeededWorkspace([
      phase("ph-tie-b", "hidden"),
      phase("ph-tie-a", "mentioned"),
    ]);
    const { ports } = await visibilityPorts(ws, "p-main", "n-s1");
    const atS1 = await resolveCodexAiVisibility(ports, {
      projectId: "p-main",
      entryIds: ["c-mage"],
      sceneId: "n-s1",
    });
    expect([...atS1.hidden]).toEqual(["c-mage"]);
  });
});

/**
 * The comparison normalization of "the statements sent" (PR-8b): in a recorded or a sent `db_execute` call, the run of
 * params that fills an `in (?, ?, ...)` list is sorted (compared as a set). Everything else is compared as it is:
 * `cmd`, `sql`, `method`, the number and the order of the statements, and every param outside those runs (the project,
 * the LIKE patterns, the limit) in order.
 *
 * Why: the recorded calls come from sql.js, and a select with no ORDER BY (the LIKE arm of `search_codex`,
 * `list_codex_by_type`, ...) returns its rows in an order that real SQLite does not have to share. The ids of those
 * rows go into the next statement's `in (...)` list in that order, and the order of an `in` list means nothing to SQL.
 * It is the same for the core and the renderer (both receive the real SQLite order), so it is not a difference between
 * them. The result (content, summary, tokensUsed, the JSON bytes) is still compared to the golden as it is.
 */
function normalizeInListParams(call: Record<string, unknown>) {
  const sql = String(call.sql);
  if (!Array.isArray(call.params)) return call;
  const params = [...call.params];
  for (const match of sql.matchAll(/\bin \(([?, ]*)\)/giu)) {
    const start = (sql.slice(0, match.index).match(/\?/gu) ?? []).length;
    const length = (match[1]!.match(/\?/gu) ?? []).length;
    const sorted = params
      .slice(start, start + length)
      .sort((a, b) =>
        String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0,
      );
    params.splice(start, length, ...sorted);
  }
  return { ...call, params };
}

describe("the four Codex tools of the read core (PR-8b) on Main's adapter over the real Native addon", () => {
  const MAIN_PROJECT = LEGACY_READ_PROJECTS.main;

  /**
   * The golden's `search_codex` cases by what answers the dense read: the golden's own canned hits, a
   * rejection (the legacy port's catch is the renderer's, so the case is not compared: the core's answer is
   * the tool's failure), or nothing (browser-mock's `[]`). The real dense read depends on the machine and has
   * its own test below.
   */
  type Dense = "canned" | "rejects" | "empty";
  const denseOf = (caseName: string): Dense =>
    caseName.startsWith("canned dense: dense が reject")
      ? "rejects"
      : caseName.startsWith("canned dense:")
        ? "canned"
        : "empty";

  interface Turn {
    readonly executors: ReturnType<typeof createCodexReadExecutors>;
    readonly ftsCalls: Array<Parameters<CoreNativeReads["fts"]>[0]>;
    readonly denseCalls: Array<Parameters<CoreNativeReads["codexSemantic"]>[0]>;
    readonly realReads: CoreNativeReads;
  }

  /**
   * One turn: the inputs are read from the real workspace when the turn starts (`readReadInputs`: the reading
   * order, the mode, the current scene), `fts` is the real Native's behind a spy, and the dense read is the
   * caller's.
   */
  async function codexTurn(
    ws: Workspace,
    world: GoldenCase["world"],
    dense: CoreNativeReads["codexSemantic"],
  ): Promise<Turn> {
    const db = createCoreReadDb(
      createMainReadDb({ backend: ws.readBackend, identity: ws.identity }),
    );
    const inputs =
      world.projectId === ""
        ? buildReadInputs({
            projectId: "",
            treeRows: [],
            project: null,
            currentSceneId: null,
          })
        : await readReadInputs(db, {
            projectId: world.projectId,
            currentSceneId: world.activeSceneId ?? null,
          });
    const realReads = createMainTypedReads({
      backend: ws.backend,
      identity: ws.identity,
    });
    const ftsCalls: Turn["ftsCalls"] = [];
    const denseCalls: Turn["denseCalls"] = [];
    ws.dbExecute.mockClear();
    return {
      executors: createCodexReadExecutors(
        createMainCodexReadContext({
          db,
          inputs,
          countTokens: (text) => (text ? text.length : 0),
          native: {
            fts: async (args) => {
              ftsCalls.push(args);
              return realReads.fts(args);
            },
            codexSemantic: async (args) => {
              denseCalls.push(args);
              return dense(args);
            },
          },
        }),
      ),
      ftsCalls,
      denseCalls,
      realReads,
    };
  }

  const answers =
    (kind: Dense): CoreNativeReads["codexSemantic"] =>
    async () => {
      if (kind === "canned") return LEGACY_READ_CANNED_CODEX_HITS;
      if (kind === "rejects") throw new Error("dense unavailable");
      return [];
    };

  const byId = (a: { id: string }, b: { id: string }) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

  it("is the fourth table of names, disjoint from the other three (twenty tools), and each of the four has a golden and a recorded call sequence", () => {
    expect([...CODEX_READ_TOOL_NAMES].sort()).toEqual(
      [
        "find_related_entries",
        "list_codex_by_type",
        "search_codex",
        "search_codex_by_tags",
      ].sort(),
    );
    const all = [
      ...CORE_READ_TOOL_NAMES,
      ...CHRONICLE_READ_TOOL_NAMES,
      ...CHRONICLE_SEARCH_TOOL_NAMES,
      ...CODEX_READ_TOOL_NAMES,
    ];
    expect(all).toHaveLength(20);
    expect(new Set(all).size).toBe(20);
    const calls = JSON.parse(
      readFileSync(CODEX_CALLS_FIXTURE, "utf8"),
    ) as Record<string, Record<string, unknown[]>>;
    let cases = 0;
    for (const tool of CODEX_READ_TOOL_NAMES) {
      expect(Object.keys(calls[tool] ?? {}), tool).toEqual(
        goldenOf(tool).map((c) => c.case),
      );
      cases += goldenOf(tool).length;
    }
    expect(cases).toBe(46);
  });

  it("every golden case of the four tools is the same on the real addon: to the byte where no `fts` is read, and for the full-text arm in the order of the real `fts` (the other fields and the rows by id are the golden's)", async () => {
    const ws = await startSeededWorkspace();
    const recorded = JSON.parse(
      readFileSync(CODEX_CALLS_FIXTURE, "utf8"),
    ) as Record<string, Record<string, Array<Record<string, unknown>>>>;
    const compared: Record<string, number> = {};
    const ftsCases: Record<string, number> = {};
    for (const tool of CODEX_READ_TOOL_NAMES) {
      const cases = goldenOf(tool);
      let done = 0;
      for (const golden of cases) {
        const label = `${tool} / ${golden.case}`;
        const dense = tool === "search_codex" ? denseOf(golden.case) : "empty";
        const turn = await codexTurn(ws, golden.world, answers(dense));
        if (dense === "rejects") {
          // The golden's result is the renderer's port catching the failure and answering from the sparse
          // arm. The core and Main do not catch it: the tool fails, and is never a success.
          await expect(
            turn.executors[tool](golden.params),
            label,
          ).rejects.toThrow(/dense unavailable/u);
          expect(turn.denseCalls, label).toHaveLength(1);
          continue;
        }
        let actual: Awaited<ReturnType<(typeof turn.executors)[typeof tool]>>;
        try {
          actual = await turn.executors[tool](golden.params);
        } catch (error) {
          // An empty project: the core stops before it reads anything.
          expect(error, label).toBeInstanceOf(CoreProjectRequiredError);
          expect(golden.world.projectId, label).toBe("");
          expect(golden.result.summary, label).toBe("No active project");
          expect(ws.dbExecute, label).not.toHaveBeenCalled();
          expect(turn.ftsCalls, label).toEqual([]);
          expect(turn.denseCalls, label).toEqual([]);
          done += 1;
          continue;
        }
        if (turn.ftsCalls.length === 0) {
          // Not the full-text arm (a short word's LIKE-OR, an empty query, the other three tools): the golden
          // is compared to the byte, and the statements sent are the renderer's, in the same order.
          if (dense === "canned") {
            // The dense hits are fused with the sparse rows by rank, so the golden's ORDER (sql.js's LIKE scan
            // order for the sparse arm) is not the real database's. The order is required to be what the fusion
            // gives for the sparse rows the real database returned (read from the first statement's answer, not
            // written down), with the golden's visible ids kept; everything else is still the golden's to the
            // byte: name, summary, tokensUsed, and each row (the rows sorted by id, as JSON).
            const sparseWire = JSON.parse(
              (await ws.dbExecute.mock.results[0]!.value) as string,
            ) as { rows: Array<Record<string, unknown>> };
            const fused = fuseCodexHybrid(
              LEGACY_READ_CANNED_CODEX_HITS.map((hit) => ({ ...hit })),
              sparseWire.rows.map((row) => ({
                id: String(row["id"]),
                name: String(row["name"]),
                type: String(row["type"]),
                summary: String(row["summary"] ?? ""),
              })),
              20,
            );
            const goldenRows = golden.result.content as Array<{ id: string }>;
            const visible = new Set(goldenRows.map((row) => row.id));
            const rows = actual.content as Array<{ id: string }>;
            expect(
              rows.map((row) => row.id),
              `${label}: order of the fusion over the real sparse rows`,
            ).toEqual(
              fused.map((row) => row.id).filter((id) => visible.has(id)),
            );
            expect(actual.name, label).toBe(golden.result.name);
            expect(actual.summary, label).toBe(golden.result.summary);
            expect(actual.tokensUsed, label).toBe(golden.result.tokensUsed);
            expect(JSON.stringify([...rows].sort(byId)), label).toBe(
              JSON.stringify([...goldenRows].sort(byId)),
            );
          } else {
            // A select with no ORDER BY (the LIKE arm of `search_codex`, `list_codex_by_type`,
            // `search_codex_by_tags`, `find_related_entries`) returns its rows in an order that real SQLite does
            // not share with sql.js (the golden's). The ORDER is required to be the order the real database
            // returned for the tool's own select (read from that statement's answer, not written down), with
            // the golden's visible ids kept; everything else is still the golden's to the byte: name, summary,
            // tokensUsed, and each row (the rows sorted by id, as JSON).
            const toolSelect = ws.dbExecute.mock.calls.findIndex((call) =>
              tool === "find_related_entries"
                ? /\blike\b/iu.test(String(call[0]))
                : /from "codex_entries"/iu.test(String(call[0])),
            );
            const goldenRows = golden.result.content as Array<{ id: string }>;
            const visible = new Set(goldenRows.map((row) => row.id));
            const realOrder =
              toolSelect < 0
                ? []
                : (
                    JSON.parse(
                      (await ws.dbExecute.mock.results[toolSelect]!
                        .value) as string,
                    ) as { rows: Array<Record<string, unknown>> }
                  ).rows
                    .map((row) => String(row["id"]))
                    .filter((id) => visible.has(id));
            const rows = actual.content as Array<{ id: string }>;
            expect(
              rows.map((row) => row.id),
              `${label}: order of the real database's rows`,
            ).toEqual(realOrder);
            expect(actual.name, label).toBe(golden.result.name);
            expect(actual.summary, label).toBe(golden.result.summary);
            expect(actual.tokensUsed, label).toBe(golden.result.tokensUsed);
            expect(JSON.stringify([...rows].sort(byId)), label).toBe(
              JSON.stringify([...goldenRows].sort(byId)),
            );
          }
          const sentDb = ws.dbExecute.mock.calls.map((call) => ({
            cmd: "db_execute",
            sql: call[0],
            params: call[1],
            method: call[2],
          }));
          // The same normalization on both sides (see `normalizeInListParams`).
          expect(
            sentDb.map(normalizeInListParams),
            `${label}: the statements sent`,
          ).toEqual(
            (recorded[tool]![golden.case] ?? [])
              .filter((call) => call["cmd"] === "db_execute")
              .map(normalizeInListParams),
          );
        } else {
          // The full-text arm. The golden's order is browser-mock's LIKE scan, which is not an order real
          // FTS5 gives, and the renderer's own product path takes the order of Native's `fts` too. So the
          // ORDER is required to be the order the real `fts` returned (hidden entries are dropped after the
          // cut, so it is the real order with the golden's visible ids kept), computed from a direct call of
          // the real `fts` with the same arguments (not written down); everything else is still the
          // golden's, to the byte: the summary, tokensUsed, and each row (the rows sorted by id).
          expect(tool, label).toBe("search_codex");
          expect(turn.ftsCalls, label).toHaveLength(1);
          const call = turn.ftsCalls[0]!;
          const params = golden.params as { query?: unknown };
          expect(call, `${label}: fts arguments`).toEqual({
            projectId: golden.world.projectId,
            query: String(params.query ?? "").trim(),
            scope: "codex",
            limit: 20,
          });
          const direct = (await turn.realReads.fts(call)) as Array<{
            sourceType: string;
            id: string;
          }>;
          const goldenRows = golden.result.content as Array<{ id: string }>;
          const visible = new Set(goldenRows.map((row) => row.id));
          const expectedIds = direct
            .filter((hit) => hit.sourceType === "codex")
            .map((hit) => hit.id)
            .filter((id) => visible.has(id));
          const rows = actual.content as Array<{ id: string }>;
          expect(
            rows.map((row) => row.id),
            `${label}: order of the real fts`,
          ).toEqual(expectedIds);
          expect(actual.name, label).toBe(golden.result.name);
          expect(actual.summary, label).toBe(golden.result.summary);
          expect(actual.tokensUsed, label).toBe(golden.result.tokensUsed);
          expect(JSON.stringify([...rows].sort(byId)), label).toBe(
            JSON.stringify([...goldenRows].sort(byId)),
          );
          ftsCases[tool] = (ftsCases[tool] ?? 0) + 1;
        }
        // What went to Native is a SELECT by `all` or `values`, with the identity of the turn as the fourth
        // argument and no fifth.
        for (const call of ws.dbExecute.mock.calls) {
          expect(String(call[0]), label).toMatch(/^\s*select\b/iu);
          expect(["all", "values"], label).toContain(call[2]);
          expect(call, label).toHaveLength(4);
          expect(call[3], label).toBe(JSON.stringify(ws.identity));
        }
        done += 1;
      }
      compared[tool] = done;
      expect(done, tool).toBeGreaterThan(0);
    }
    expect(Object.keys(compared).sort()).toEqual(
      [...CODEX_READ_TOOL_NAMES].sort(),
    );
    // The full-text comparison is not vacuous: the golden's `search_codex` cases that reach `fts` (老魔術師,
    // アリア trimmed, 存在しない語, 他作品 in the main project, アリア in the other project).
    expect(ftsCases).toEqual({ search_codex: 5 });
  });

  it("a dense hit that is another project's entry or a hidden one is dropped by the decision, whatever the index answered", async () => {
    const ws = await startSeededWorkspace();
    const turn = await codexTurn(
      ws,
      { projectId: MAIN_PROJECT, activeSceneId: "n-s1" },
      async () => [
        {
          entryId: "x-c-aria",
          entryName: "他作品のアリア",
          entryType: "character",
          summary: "他作品の少女",
          score: 0.99,
        },
        {
          entryId: "c-secret",
          entryName: "黒幕",
          entryType: "character",
          summary: "正体は秘密",
          score: 0.98,
        },
        {
          entryId: "c-aria",
          entryName: "アリア",
          entryType: "character",
          summary: "老魔術師を訪ねる旅の少女",
          score: 0.5,
        },
      ],
    );
    const result = await turn.executors.search_codex({ query: "魔法" });
    const ids = (result.content as Array<{ id: string }>).map((row) => row.id);
    expect(ids).not.toContain("x-c-aria");
    expect(ids).not.toContain("c-secret");
    expect(ids).toContain("c-aria");
  });

  it("the real dense read (what it answers depends on the machine): when it answers, every hit is an entry of the asked project; when it does not, the tool fails and is never a sparse-only success", async () => {
    const ws = await startSeededWorkspace();
    const real = createMainTypedReads({
      backend: ws.backend,
      identity: ws.identity,
    });
    const turn = await codexTurn(
      ws,
      { projectId: MAIN_PROJECT, activeSceneId: "n-s3" },
      (args) => real.codexSemantic(args),
    );
    const db = createCoreReadDb(
      createMainReadDb({ backend: ws.readBackend, identity: ws.identity }),
    );
    const own = new Set(
      (
        await db
          .select({ id: codexEntries.id })
          .from(codexEntries)
          .where(eq(codexEntries.projectId, MAIN_PROJECT))
      ).map((row) => row.id),
    );
    expect(own.size).toBeGreaterThan(0);
    const outcome = await turn.executors.search_codex({ query: "魔法" }).then(
      (value) => ({ answered: true as const, value }),
      (error: unknown) => ({ answered: false as const, error: String(error) }),
    );
    if (outcome.answered) {
      for (const row of outcome.value.content as Array<{ id: string }>) {
        expect(own.has(row.id), row.id).toBe(true);
      }
    } else {
      expect(outcome.error).not.toMatch(/WORKSPACE_CHANGED/);
      // The core's own narrowing errors ("codex_semantic_search: the result is not an array", ...) also
      // contain "semantic": a wire that does not fit the narrowing must not pass as "no model here".
      expect(outcome.error).not.toMatch(/codex_semantic_search: /);
      expect(outcome.error).toMatch(
        /embedding model .* is not installed|semantic/i,
      );
    }
  });

  it("a workspace that is not the active one is refused and reaches the tool as its failure", async () => {
    const ws = await startSeededWorkspace();
    const wrong = createMainTypedReads({
      backend: ws.backend,
      identity: { ...ws.identity, workspaceId: ws.otherDirectory },
    });
    const turn = await codexTurn(
      ws,
      { projectId: MAIN_PROJECT, activeSceneId: "n-s3" },
      (args) => wrong.codexSemantic(args),
    );
    await expect(
      turn.executors.search_codex({ query: "魔法" }),
    ).rejects.toThrow(/SEMANTIC_INDEX_WORKSPACE_CHANGED/);
  });

  it("the phase decision is the real database's: list_codex_by_type releases c-released only from n-s3 (not at n-s1 or with no scene), and the hidden c-secret never appears", async () => {
    const ws = await startSeededWorkspace();
    const idsAt = async (scene: string | null) => {
      const turn = await codexTurn(
        ws,
        {
          projectId: MAIN_PROJECT,
          ...(scene === null ? {} : { activeSceneId: scene }),
        },
        answers("empty"),
      );
      const result = await turn.executors.list_codex_by_type({
        type: "character",
      });
      return (result.content as Array<{ id: string }>).map((row) => row.id);
    };
    const atS1 = await idsAt("n-s1");
    const atS3 = await idsAt("n-s3");
    const none = await idsAt(null);
    expect(atS1).not.toContain("c-released");
    expect(atS3).toContain("c-released");
    expect(none).not.toContain("c-released");
    for (const ids of [atS1, atS3, none]) expect(ids).not.toContain("c-secret");
  });
});

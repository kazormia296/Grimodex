// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

/**
 * MP-4b PR-4（B1・B2 の 7 本）と PR-5a（B3 の search_scenes・search_snippets）：共有 core を、main の DB adapter（`createMainReadDb`：送信前の検査・表の
 * allowlist・行の位置対応）の上で動かし、PR-0 の golden（未変更の legacy から生成）と
 * 同じ結果になることを確かめる。PR-9 の同値 spec の最初の版（B1・B2 の 7 本）。
 *
 * 何を比べるか：同じ seed の実 sql.js（browser-mock）に、core を **main 用の ports**
 * （barrier なしの本文 reader、`createCoreReadDb(createMainReadDb(...))`）で当て、
 * golden の各 case（world・params）の結果（name・summary・tokensUsed・content・JSON の
 * bytes）が一致すること。`createMainReadDb` に渡す backend は sql.js の `db_execute` を
 * 包んだ fake で、answer の wire（`{rows, __grimodexDbResultKind: "read"}`、行は object）を
 * Native と同じ形にする。
 *
 * PR-5a の fts：main の typed read（`createMainTypedReads`。引数の検査・`parseWire`・caller timeout
 * を通る）に、golden を作ったのと同じ browser-mock の `fts_search` handler を JSON 文字列で
 * 返す fake の `ftsSearch` を繋ぐ（id の順は golden と同じ。browser-mock は scope を無視して
 * archived の場面も返すので、archived の絞りが core の tool 層で働くことも見える）。
 *
 * 覆えない範囲：実 Native（実 addon）の行の返り順・型の返り方は見ない（sql.js の結果）。
 * 本文 2 本は main では barrier なし（renderer の未着の書込みを待たない。DR-MP4-9）ので、
 * ここは「待つべき書込みが無い」ときの同値だけを示す。project が空の case は core が
 * `CoreProjectRequiredError` で止まることを見る（`No active project` の結果は renderer の
 * 薄い層の仕事で、golden 試験が固定する）。
 */
vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  const { legacyReadInvokeBridge } =
    await import("./legacyReadInvokeBridge.testSupport");
  legacyReadInvokeBridge.bindActual(actual.invoke as never);
  return { ...actual, invoke: legacyReadInvokeBridge.invoke };
});

import { invoke } from "@/lib/tauri";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { createMainReadDb } from "@/../electron/main/mastraRead/db";
import {
  createMainTypedReads,
  type MainTypedReadsBackend,
} from "@/../electron/main/mastraRead/typed";
import type { MainIssuedCallerIdentity } from "@/../electron/main/profileEgress";
import type { NapiBackendLike } from "@/../electron/shared/ipcContract";
import {
  CoreProjectRequiredError,
  type CoreReadContext,
} from "@/../electron/shared/mastraRead/ports";
import { createCoreReadDb } from "@/../electron/shared/readDomain/core/readDb";
import {
  CORE_READ_TOOL_NAMES,
  createReadExecutors,
} from "@/../electron/shared/readDomain/core/readExecutors";
import { createDbSceneBodyReader } from "@/../electron/shared/readDomain/core/sceneBody";
import { legacyReadInvokeBridge } from "./legacyReadInvokeBridge.testSupport";
import {
  bindLegacyReadHarnessPorts,
  seedLegacyReadFixture,
  setLegacyReadWorkspaceIdentity,
  setLegacyReadWorld,
  type LegacyReadGoldenCase,
} from "./legacyReadHarness.testSupport";

bindLegacyReadHarnessPorts({
  executeRun: (sql, params) =>
    invoke("db_execute", { sql, params, method: "run" }),
  setTreeState: (state) => useTreeStore.setState(state),
  setPhaseState: (state) => usePhaseStore.setState(state),
});

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const IDENTITY: MainIssuedCallerIdentity = {
  profileId: "profile-1",
  callerId: "caller-1",
  callerEpoch: 1,
  senderId: 1,
  workspaceId: "/workspace/legacy-read.grimodex",
  sessionId: "session-1",
};

/** sql.js の `db_execute` を、Native と同じ wire（object の行＋marker）で返す backend。 */
const sent: Array<{ sql: string; method: string }> = [];
const backend: Pick<NapiBackendLike, "dbExecute"> = {
  dbExecute: async (sql, params, method) => {
    sent.push({ sql, method });
    const result = (await invoke("db_execute", { sql, params, method })) as {
      rows: Record<string, unknown>[];
    };
    return JSON.stringify({
      rows: result.rows,
      __grimodexDbResultKind: "read",
    });
  },
};

/**
 * typed read の backend：`ftsSearch` だけを持つ fake（残りの 3 本は無い＝呼べば fail closed）。
 * golden を作った browser-mock の `fts_search` handler の結果を JSON 文字列で返す
 * （Native の wire と同じ。実 FTS5 の順は PR-9 の実 addon spec が見る）。
 */
const ftsSent: Array<{ projectId: string; scope: string; limit: number }> = [];
const typedBackend = {
  ftsSearch: async (
    projectId: string,
    query: string,
    scope: string,
    limit: number,
  ) => {
    ftsSent.push({ projectId, scope, limit });
    return JSON.stringify(
      await invoke("fts_search", { projectId, query, scope, limit }),
    );
  },
} as unknown as MainTypedReadsBackend;

/** main の ports：DB は検査つきの adapter、本文は barrier なし、tree の state は project だけ。 */
const mainDb = createCoreReadDb(
  createMainReadDb({ backend, identity: IDENTITY }),
);
const MAIN_PORTS: CoreReadContext = {
  getDb: () => mainDb,
  getTreeState: () => useTreeStore.getState(),
  body: createDbSceneBodyReader(() => mainDb),
  native: createMainTypedReads({ backend: typedBackend, identity: IDENTITY }),
  countTokens: (text) => (text ? text.length : 0),
};
const executors = createReadExecutors(MAIN_PORTS);

/** golden は vite の `?raw` で読む（happy-dom の `import.meta.url` は file の path にならない）。 */
const GOLDEN_FILES = import.meta.glob<string>(
  "./__fixtures__/legacyReadGolden/*.golden.txt",
  { query: "?raw", import: "default", eager: true },
);

const goldenOf = (tool: string): LegacyReadGoldenCase[] => {
  const raw =
    GOLDEN_FILES[`./__fixtures__/legacyReadGolden/${tool}.golden.txt`];
  if (raw === undefined) throw new Error(`no golden for ${tool}`);
  return (JSON.parse(raw) as { cases: LegacyReadGoldenCase[] }).cases;
};

describe("共有 core（main の DB adapter の上）が、PR-0 の golden と同じ結果を返す", () => {
  it("B1・B2 の 7 本と B3 の 2 本（いずれも golden を持つ）を対象にしている", () => {
    expect([...CORE_READ_TOOL_NAMES].sort()).toEqual(
      [
        "get_chapter_summaries",
        "get_scene",
        "get_scene_timeline_neighbors",
        "get_thread_scenes",
        "list_chapters",
        "list_codex_tags",
        "list_plot_threads",
        "search_scenes",
        "search_snippets",
      ].sort(),
    );
  });

  for (const tool of CORE_READ_TOOL_NAMES) {
    it(`${tool}：golden の全 case（world・params）で結果が一致する`, async () => {
      setLegacyReadWorkspaceIdentity();
      await seedLegacyReadFixture();
      const cases = goldenOf(tool);
      expect(cases.length).toBeGreaterThan(0);
      let compared = 0;
      let noProject = 0;
      for (const golden of cases) {
        await setLegacyReadWorld(golden.world);
        legacyReadInvokeBridge.reset();
        sent.length = 0;
        ftsSent.length = 0;
        const label = `${tool} / ${golden.case}`;
        let actual: Awaited<ReturnType<(typeof executors)[typeof tool]>>;
        try {
          actual = await executors[tool](golden.params);
        } catch (e) {
          // project が空で、引数の検査より後の case：core は何も読まずに止まる
          // （結果にするのは renderer の薄い層。golden 試験が固定する）。
          expect(e, label).toBeInstanceOf(CoreProjectRequiredError);
          expect(golden.world.projectId, label).toBe("");
          expect(golden.result.summary, label).toBe("No active project");
          expect(sent, label).toEqual([]);
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
        // 送った文は全部 SELECT（method は all か values）。送らなかった case は
        // 引数の検査や「見つからない」で DB の前に終わったもの。
        for (const statement of sent) {
          expect(statement.sql, label).toMatch(/^\s*select\b/iu);
          expect(["all", "values"], label).toContain(statement.method);
        }
        compared += 1;
      }
      expect(compared + noProject).toBe(cases.length);
      expect(compared).toBeGreaterThan(0);
    });
  }
});

describe("共有 core の search 2 本が main の typed read（fts）へ送るもの", () => {
  it("3 字以上の語は fts を scope・limit つきで 1 回だけ呼び、短い語は呼ばない", async () => {
    setLegacyReadWorkspaceIdentity();
    await seedLegacyReadFixture();
    await setLegacyReadWorld({
      projectId: "p-main",
      activeSceneId: "n-s1",
    });
    legacyReadInvokeBridge.reset();

    ftsSent.length = 0;
    await executors.search_scenes({ query: "アリア" });
    await executors.search_snippets({ query: "老魔術師" });
    expect(ftsSent).toEqual([
      { projectId: "p-main", scope: "scenes", limit: 50 },
      { projectId: "p-main", scope: "snippets", limit: 10 },
    ]);

    ftsSent.length = 0;
    await executors.search_scenes({ query: "魔法" });
    await executors.search_snippets({ query: "魔法" });
    expect(ftsSent).toEqual([]);
  });

  it("archived の場面（fts は返す）は core の絞りで落ち、fts の失敗は握らずそのまま伝わる", async () => {
    setLegacyReadWorkspaceIdentity();
    await seedLegacyReadFixture();
    await setLegacyReadWorld({
      projectId: "p-main",
      activeSceneId: "n-s1",
    });
    legacyReadInvokeBridge.reset();
    // fts は archived の n-arch を先頭にして返す（Native も返す）。live の場面だけが残る。
    legacyReadInvokeBridge.override("fts_search", () => [
      { sourceType: "scene", id: "n-arch", title: "t", excerpt: "e" },
      { sourceType: "snippet", id: "sn-1", title: "t", excerpt: "e" },
      { sourceType: "scene", id: "n-s1", title: "t", excerpt: "e" },
    ]);
    const found = await executors.search_scenes({ query: "外部ファイル" });
    expect((found.content as Array<{ id: string }>).map((r) => r.id)).toEqual([
      "n-s1",
    ]);

    legacyReadInvokeBridge.override("fts_search", () => {
      throw new Error("fts is down");
    });
    await expect(executors.search_scenes({ query: "アリア" })).rejects.toThrow(
      /fts is down/,
    );
  });
});

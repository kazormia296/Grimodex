// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

/**
 * MP-4b PR-4（B1・B2 の 7 本）、PR-5a（B3 の search_scenes・search_snippets）、PR-5b（B4 の
 * list_open_foreshadows・get_foreshadow_detail）：共有 core を、main の DB adapter（`createMainReadDb`：送信前の検査・表の
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
 * PR-5b の foreshadowOpen：同じく main の typed read（`createMainTypedReads`）に、fake の
 * `foreshadowListOpenForContext` を繋ぐ。browser-mock に handler が無いので、Native の SQL
 * （`foreshadow.rs` の `list_open_for_context`：`secret = 0`・未回収・未放棄、setups は別の IN の 1 文）と
 * 同じ SELECT を sql.js に打ち、Native の wire（snake_case・真偽は 0/1・epoch ms・setups に scene_id なし）の
 * JSON 文字列にして返す。get_foreshadow_detail は Drizzle なので main の DB adapter（`foreshadows`・
 * `foreshadow_setups` が allowlist にある）を通る。
 *
 * PR-7a の年表 4 本（list_events・get_event_detail・get_character_timeline・get_chronicle_state）：
 * 別の ctx（`createMainChronicleReadContext`）と別の factory（`createChronicleReadExecutors`）で動かす。
 * main の入力は store でなく、**turn の開始時に 1 本の tree select から作る**（`readChronicleReadInputs`：
 * 読む順・場面の題・場面自身の暦日付・現在の場面）。同値を示すのは「turn の途中で何も変わらない」ときだけで、
 * cache の寿命が turn であることによる差（turn の途中の secret・reveal の変更が次の呼出しに届かない。Q5）と、
 * 現在の場面が読む順に無いときの `No sceneId and no active scene`（main は null にする）は対象外
 * （`chronicleMainContext.test.ts` が差として固定する）。
 *
 * PR-7b の search_events：もう 1 つの ctx（`createMainChronicleSearchContext`）と factory
 * （`createChronicleSearchExecutors`）。dense は main の typed read（`eventsSemantic`）に、fake の
 * `eventsSemanticSearch`（canned の hit を JSON 文字列で返す）を繋ぐ。**この ctx は呼出しごとに events・
 * scene_events を取り直す**（turn の cache を通さない。DR-MP4-38）ので、PR-7a の ctx と違って
 * 「同一 turn の list_events と search_events で events の読みが 1 回」にはならない（逆を固定する）。
 * golden の dense が reject する case は main では tool error（throw）になる（握りは renderer の port にだけ置く。
 * DR-MP4-38c）ので byte 比較から外し、case 名→native の表で結ぶ。
 *
 * PR-8a の Codex の hidden 判定（tool はまだ動かさない）：`resolveCodexAiVisibility`・`listHiddenCodexIds`・
 * `dropHiddenCodexRows` を main の ports（`createMainCodexVisibilityPorts`＝turn の入力＋`codex_entry_phases` の
 * Drizzle select）の上で動かし、legacy の `resolveCodexForAi`（store・`listPhasesByEntryIds`）と、同じ seed の同じ
 * 入力で hidden・texts が一致することを見る（`c-secret`・Phase `ph-released` で n-s3 に解除される `c-released`）。
 *
 * PR-8b の Codex の 4 本（search_codex・list_codex_by_type・search_codex_by_tags・find_related_entries）：4 つ目の
 * 表（`CODEX_READ_TOOL_NAMES`）と専用の ctx（`createMainCodexReadContext`＝turn の入力 1 つから project・現在の場面・
 * phase state を束ねる）。golden の 46 case を byte 一致で流し、**送った呼出しの列（db_execute の sql・params・method、
 * fts・dense の引数、その順）が legacy の fixture（`toolExecutors.codexCalls.test.ts`）と一致する**ことを見る。dense は
 * main の typed read（`codexSemantic`）に fake の `codexSemanticSearch` を繋ぎ、reject する case は throw を確かめて
 * byte 比較から外す（握りは renderer の port にだけ置く。DR-MP4-40）。
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
import {
  createMainChronicleReadContext,
  createMainChronicleSearchContext,
} from "@/../electron/shared/readDomain/core/chronicleMainContext";
import {
  CHRONICLE_READ_TOOL_NAMES,
  CHRONICLE_SEARCH_TOOL_NAMES,
  createChronicleReadExecutors,
  createChronicleSearchExecutors,
} from "@/../electron/shared/readDomain/core/chronicleReadExecutors";
import { buildReadInputs } from "@/../electron/shared/readDomain/core/readInputs";
import {
  readChronicleReadInputs,
  readReadInputs,
} from "@/../electron/shared/readDomain/core/readInputsReader";
import {
  createMainCodexEntryContext,
  createMainCodexReadContext,
  createMainCodexVisibilityPorts,
} from "@/../electron/shared/readDomain/core/codexMainContext";
import {
  CODEX_ENTRY_TOOL_NAMES,
  createCodexEntryExecutors,
} from "@/../electron/shared/readDomain/core/codexEntryExecutors";
import {
  CODEX_READ_TOOL_NAMES,
  createCodexReadExecutors,
} from "@/../electron/shared/readDomain/core/codexReadExecutors";
import {
  dropHiddenCodexRows,
  listHiddenCodexIds,
  resolveCodexAiVisibility,
} from "@/../electron/shared/readDomain/core/codexVisibility";
import { resolveCodexForAi } from "@/features/codex/context/codexHiddenFromAi";
import { executeTool } from "./toolExecutors";
import { LEGACY_CHRONICLE_READ_CONTEXT } from "./chronicleReadContext";
import { extractPlainText } from "@/features/codex/prosemirrorTextExtractor";
import { CODEX_ENTRY_SEED } from "./__fixtures__/codexEntrySeed";
import { readCodexNames } from "@/../electron/shared/readDomain/core/chronicleReaders";
import { listCodexMatchTargets } from "@/features/codex/api";
import {
  LEGACY_READ_CANNED_CODEX_HITS,
  LEGACY_READ_CANNED_EVENT_HITS,
} from "./__fixtures__/legacyReadSeed";
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
/**
 * PR-8b：db・fts・Codex の dense に送ったものを、送った順に 1 本の列にする（Codex の 4 本が送る呼出しの列を
 * `toolExecutors.codexCalls.test.ts` の fixture と比べるため。db_execute は（sql・params・method）、
 * fts・dense は Native へ渡る引数）。
 */
const callLog: Array<Record<string, unknown>> = [];
const backend: Pick<NapiBackendLike, "dbExecute"> = {
  dbExecute: async (sql, params, method) => {
    sent.push({ sql, method });
    callLog.push({ cmd: "db_execute", sql, params, method });
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
 * typed read の backend：`ftsSearch`・`foreshadowListOpenForContext`・`eventsSemanticSearch`（PR-7b）を持つ fake
 * （PR-8b：`codexSemanticSearch` は Codex の dense。答えは `codexDenseAnswer`）。
 * golden を作った browser-mock の `fts_search` handler の結果を JSON 文字列で返す
 * （Native の wire と同じ。実 FTS5 の順は PR-9 の実 addon spec が見る）。
 */
const ftsSent: Array<{ projectId: string; scope: string; limit: number }> = [];
const foreshadowSent: string[] = [];
/** dense（events）：Native の引数の並び（workspace・projectId・query・limit）のまま記録し、答えは試験が差し替える。 */
const denseSent: Array<{
  workspace: string;
  projectId: string;
  query: string;
  limit: number;
}> = [];
let denseAnswer: (projectId: string) => unknown = () => [];
/** Codex の dense（PR-8b）。 */
const codexDenseSent: Array<{
  workspace: string;
  projectId: string;
  query: string;
  limit: number;
}> = [];
let codexDenseAnswer: (projectId: string) => unknown = () => [];
const typedBackend = {
  eventsSemanticSearch: async (
    workspace: string,
    projectId: string,
    query: string,
    limit: number,
  ) => {
    denseSent.push({ workspace, projectId, query, limit });
    return JSON.stringify(denseAnswer(projectId));
  },
  // Codex の dense（PR-8b）。引数の並びは Native のまま（workspace・projectId・query・limit）。答えは試験が差し替える。
  codexSemanticSearch: async (
    workspace: string,
    projectId: string,
    query: string,
    limit: number,
  ) => {
    codexDenseSent.push({ workspace, projectId, query, limit });
    callLog.push({
      cmd: "codex_semantic_search",
      args: { expectedWorkspacePath: workspace, projectId, query, limit },
    });
    return JSON.stringify(codexDenseAnswer(projectId));
  },
  ftsSearch: async (
    projectId: string,
    query: string,
    scope: string,
    limit: number,
  ) => {
    ftsSent.push({ projectId, scope, limit });
    callLog.push({
      cmd: "fts_search",
      args: { projectId, query, scope, limit },
    });
    return JSON.stringify(
      await invoke("fts_search", { projectId, query, scope, limit }),
    );
  },
  // Native の `foreshadow_list_open_for_context` の写し（SQL は `foreshadow.rs` の同名の関数と同じ）。
  foreshadowListOpenForContext: async (projectId: string) => {
    foreshadowSent.push(projectId);
    const read = async (sql: string, params: string[]) =>
      (
        (await invoke("db_execute", { sql, params, method: "all" })) as {
          rows: Record<string, unknown>[];
        }
      ).rows;
    const foreshadows = await read(
      "SELECT id, title, intent, load_bearing, version, payoff_confirmed, abandoned, updated_at " +
        "FROM foreshadows " +
        "WHERE project_id = ? AND payoff_confirmed = 0 AND abandoned = 0 AND secret = 0",
      [projectId],
    );
    const ids = foreshadows.map((row) => String(row.id));
    const setups =
      ids.length === 0
        ? []
        : await read(
            "SELECT foreshadow_id, is_orphan, strength, ai_strength, ai_reasoning " +
              `FROM foreshadow_setups WHERE foreshadow_id IN (${ids.map(() => "?").join(", ")})`,
            ids,
          );
    return JSON.stringify({ foreshadows, setups });
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

interface CodexEntryGoldenCase {
  readonly case: string;
  readonly world: {
    readonly projectId: string;
    readonly activeSceneId: string;
  };
  readonly params: Record<string, unknown>;
  readonly result: {
    readonly name: string;
    readonly summary: string;
    readonly tokensUsed: number;
    readonly content: unknown;
  };
  readonly contentJson: string;
}

const CODEX_ENTRY_GOLDEN = JSON.parse(
  readFileSync(
    resolve(
      "src/features/chat/agent/__fixtures__/codexEntryGolden/get_codex_entry.golden.txt",
    ),
    "utf8",
  ),
) as { cases: CodexEntryGoldenCase[] };
const CODEX_ENTRY_READS_GOLDEN = JSON.parse(
  readFileSync(
    resolve(
      "src/features/chat/agent/__fixtures__/codexEntryGolden/get_codex_entry.reads.golden.txt",
    ),
    "utf8",
  ),
) as Record<string, Array<{ sql: string; params: unknown[] }>>;

let codexEntryFixtureSeeded: Promise<void> | null = null;

function seedCodexEntryFixture(): Promise<void> {
  codexEntryFixtureSeeded ??= insertCodexEntryFixture();
  return codexEntryFixtureSeeded;
}

async function insertCodexEntryFixture(): Promise<void> {
  for (const { table, rows } of CODEX_ENTRY_SEED) {
    for (const row of rows) {
      const columns = Object.keys(row);
      await invoke("db_execute", {
        sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        params: columns.map((column) => row[column]),
        method: "run",
      });
    }
  }
}

async function makeCodexEntryExecutors(world: {
  readonly projectId: string;
  readonly activeSceneId: string | null;
}) {
  const inputs = await readReadInputs(mainDb, {
    projectId: world.projectId,
    currentSceneId: world.activeSceneId,
  });
  return createCodexEntryExecutors(
    createMainCodexEntryContext({
      db: mainDb,
      inputs,
      countTokens: (text) => (text ? text.length : 0),
      extractPlainText: (json) => extractPlainText(json),
    }),
  );
}

describe("共有 core（main の DB adapter の上）が、PR-0 の golden と同じ結果を返す", () => {
  it("B1・B2 の 7 本、B3 の 2 本、B4 の 2 本（いずれも golden を持つ）を対象にしている", () => {
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
        foreshadowSent.length = 0;
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
      { projectId: "p-main", scope: "scenes_live", limit: 10 },
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

describe("共有 core の伏線 2 本が main の経路で読むもの（PR-5b）", () => {
  it("list_open_foreshadows は typed read の foreshadowOpen を { projectId } で 1 回だけ呼び、DB の文は送らず、Native の wire（snake_case・0/1・epoch ms・setups に scene_id なし）から組んだ結果が golden と同じ。secret の伏線は出ない", async () => {
    setLegacyReadWorkspaceIdentity();
    await seedLegacyReadFixture();
    await setLegacyReadWorld({
      projectId: "p-main",
      activeSceneId: "n-s1",
    });
    legacyReadInvokeBridge.reset();
    sent.length = 0;
    foreshadowSent.length = 0;

    // main の typed read が core へ渡す wire（Native と同じ形）。
    const wire = (await MAIN_PORTS.native.foreshadowOpen({
      projectId: "p-main",
    })) as {
      foreshadows: Array<Record<string, unknown>>;
      setups: Array<Record<string, unknown>>;
    };
    expect(wire.foreshadows.map((f) => f.id)).toEqual(["fs-1", "fs-5"]);
    expect(Object.keys(wire.foreshadows[0]!).sort()).toEqual(
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
    expect(wire.foreshadows[0]).toMatchObject({
      payoff_confirmed: 0,
      abandoned: 0,
      updated_at: 1_767_225_600_000,
    });
    expect(wire.setups.length).toBeGreaterThan(0);
    expect(wire.setups.every((s) => !("scene_id" in s))).toBe(true);

    foreshadowSent.length = 0;
    const result = await executors.list_open_foreshadows({});
    expect(foreshadowSent).toEqual(["p-main"]);
    expect(sent).toEqual([]);
    const ids = (result.content as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toEqual(["fs-1", "fs-5"]);
    // fs-2 は secret=1・未回収・未放棄（seed）：list には出ないが、detail は返す（DR-MP4-24）。
    expect(ids).not.toContain("fs-2");
    const detail = await executors.get_foreshadow_detail({ id: "fs-2" });
    expect(detail.summary).toBe("黒幕の伏線: 1 setup(s), payoff unset");
    expect((detail.content as { id: string }).id).toBe("fs-2");
    for (const statement of sent) {
      expect(statement.sql).toMatch(/^\s*select\b/iu);
    }
  });

  it("project が空なら foreshadowOpen を呼ばずに止まる", async () => {
    setLegacyReadWorkspaceIdentity();
    await seedLegacyReadFixture();
    await setLegacyReadWorld({ projectId: "" });
    foreshadowSent.length = 0;
    await expect(executors.list_open_foreshadows({})).rejects.toBeInstanceOf(
      CoreProjectRequiredError,
    );
    expect(foreshadowSent).toEqual([]);
  });
});

/**
 * PR-7a：年表 4 本。golden の world から main の turn の入力を作る（tree は DB の 1 本の select、
 * 現在の場面は wire の値、UI 言語は world の値）。project が空の world は turn を作れない（tree を読まない）ので、
 * 空の入力で ctx を作り、core が何も読まずに止まることを見る。
 */
describe("共有 core の年表 4 本（main の DB adapter と turn の入力の上）が、PR-0 の golden と同じ結果を返す", () => {
  it("対象は golden を持つ 4 本で、CORE_READ_TOOL_NAMES とは別の表", () => {
    expect([...CHRONICLE_READ_TOOL_NAMES].sort()).toEqual([
      "get_character_timeline",
      "get_chronicle_state",
      "get_event_detail",
      "list_events",
    ]);
    for (const name of CHRONICLE_READ_TOOL_NAMES) {
      expect((CORE_READ_TOOL_NAMES as readonly string[]).includes(name)).toBe(
        false,
      );
    }
  });

  for (const tool of CHRONICLE_READ_TOOL_NAMES) {
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
        const label = `${tool} / ${golden.case}`;
        const turn =
          golden.world.projectId === ""
            ? {
                inputs: buildReadInputs({
                  projectId: "",
                  treeRows: [],
                  project: null,
                  currentSceneId: null,
                }),
                nodes: [],
              }
            : await readChronicleReadInputs(mainDb, {
                projectId: golden.world.projectId,
                currentSceneId: golden.world.activeSceneId ?? null,
              });
        sent.length = 0;
        const { ctx } = createMainChronicleReadContext({
          db: mainDb,
          turn,
          countTokens: (text) => (text ? text.length : 0),
          getUiLanguage: () => golden.world.language ?? "ja",
        });
        const chronicle = createChronicleReadExecutors(ctx);
        let actual: Awaited<ReturnType<(typeof chronicle)[typeof tool]>>;
        try {
          actual = await chronicle[tool](golden.params);
        } catch (e) {
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

  it("Codex 名の Map：main の 2 列の select が、renderer の listCodexMatchTargets 由来の Map（chronicleToolCache の codexNamesLoader と同じ作り方）と、同じ key・値・順になる（hidden の entry も含む）", async () => {
    setLegacyReadWorkspaceIdentity();
    await seedLegacyReadFixture();
    const projectIds = new Set(
      CHRONICLE_READ_TOOL_NAMES.flatMap((tool) =>
        goldenOf(tool).map((c) => c.world.projectId),
      ),
    );
    projectIds.delete("");
    expect(projectIds.size).toBeGreaterThan(0);
    let named = 0;
    for (const projectId of projectIds) {
      const legacy = new Map(
        (await listCodexMatchTargets(projectId)).map(
          (e) => [e.id, e.name] as const,
        ),
      );
      const main = await readCodexNames(mainDb, projectId);
      expect([...main.entries()], projectId).toEqual([...legacy.entries()]);
      named += main.size;
    }
    expect(named).toBeGreaterThan(0);
  });
});

/**
 * PR-7b：search_events。golden の 10 case を、**case 名→native の明示の表**で結ぶ（golden の bytes は
 * 変えない。native は golden test の SCENARIOS にしか無く、case 名の prefix で結ぶと XPROJ の case も canned を
 * 使うので誤る）。表に無い case が来たら試験が落ちる（無言で通さない）。
 *   canned：dense が canned の hit を返す／empty：dense が [] を返す（browser-mock の既定）／
 *   rejects：dense が reject する（main では throw。legacy の port だけが空に握る）／
 *   none：core が dense に届く前に止まる（no-project・空の query）。
 */
type DenseKind = "canned" | "empty" | "rejects" | "none";
const SEARCH_EVENTS_DENSE: Record<string, DenseKind> = {
  "canned: S1 では secret の戦争（n-s3 で公開）と恒久秘匿の死が落ちる。DB に無い他 project の id は素通し":
    "canned",
  "canned: S3 では戦争が出る（恒久秘匿の死は出ない）": "canned",
  "canned: 場面なしでは secret を全部隠す（fail-closed）": "canned",
  "canned: limit=2 で slice": "canned",
  "canned: limit が数でなければ 10": "canned",
  "canned: dense が reject したら空配列に退避する": "rejects",
  "empty: browser-mock の dense は常に []": "empty",
  "XPROJ: 他 project で canned の hit が main の event id を含んでも、他 project の年表に無い id は hidden 判定の対象外（素通し）":
    "canned",
  "no-project: 引数が有効でも No active project": "none",
  "order: 空の query は no-project より先（0 events found）": "none",
};
const XPROJ_CASE =
  "XPROJ: 他 project で canned の hit が main の event id を含んでも、他 project の年表に無い id は hidden 判定の対象外（素通し）";

/** golden の world から turn の入力を作る（年表 4 本の describe と同じ）。 */
async function searchTurn(world: LegacyReadGoldenCase["world"]) {
  return world.projectId === ""
    ? {
        inputs: buildReadInputs({
          projectId: "",
          treeRows: [],
          project: null,
          currentSceneId: null,
        }),
        nodes: [],
      }
    : await readChronicleReadInputs(mainDb, {
        projectId: world.projectId,
        currentSceneId: world.activeSceneId ?? null,
      });
}

function makeSearchExecutors(turn: Awaited<ReturnType<typeof searchTurn>>) {
  const ctx = createMainChronicleSearchContext({
    db: mainDb,
    turn,
    countTokens: (text) => (text ? text.length : 0),
    native: createMainTypedReads({ backend: typedBackend, identity: IDENTITY }),
  });
  return createChronicleSearchExecutors(ctx);
}

describe("共有 core の search_events（main の DB adapter・turn の入力・typed read の上）が、PR-0 の golden と同じ結果を返す", () => {
  it("対象は golden を持つ 1 本で、CORE_READ_TOOL_NAMES・CHRONICLE_READ_TOOL_NAMES とは別の表（3 つの表は互いに素で合計 16）", () => {
    expect([...CHRONICLE_SEARCH_TOOL_NAMES]).toEqual(["search_events"]);
    const all = [
      ...CORE_READ_TOOL_NAMES,
      ...CHRONICLE_READ_TOOL_NAMES,
      ...CHRONICLE_SEARCH_TOOL_NAMES,
    ];
    expect(all).toHaveLength(16);
    expect(new Set(all).size).toBe(16);
    expect(goldenOf("search_events").length).toBeGreaterThan(0);
  });

  it("case 名→native の表は golden の 10 case と過不足なく一致する", () => {
    expect(goldenOf("search_events").map((c) => c.case)).toEqual(
      Object.keys(SEARCH_EVENTS_DENSE),
    );
  });

  it("golden の全 case（world・params）で結果が一致する（dense が reject する case だけは throw を確かめ、byte 比較から外す）", async () => {
    setLegacyReadWorkspaceIdentity();
    await seedLegacyReadFixture();
    const cases = goldenOf("search_events");
    const done: Record<DenseKind, number> = {
      canned: 0,
      empty: 0,
      rejects: 0,
      none: 0,
    };
    for (const golden of cases) {
      const kind = SEARCH_EVENTS_DENSE[golden.case];
      if (kind === undefined) throw new Error(`no dense kind: ${golden.case}`);
      await setLegacyReadWorld(golden.world);
      legacyReadInvokeBridge.reset();
      const label = `search_events / ${golden.case}`;
      const turn = await searchTurn(golden.world);
      const executors = makeSearchExecutors(turn);
      denseAnswer = () => {
        if (kind === "canned") return LEGACY_READ_CANNED_EVENT_HITS;
        if (kind === "empty") return [];
        throw new Error("dense unavailable");
      };
      sent.length = 0;
      denseSent.length = 0;

      if (kind === "rejects") {
        // main は握らない：tool error（throw）で、`[]` の成功にならない。golden の
        // `0 events found` は legacy の port の握りの結果（renderer の結果は変わらない）。
        expect(golden.result.summary, label).toBe("0 events found");
        await expect(
          executors.search_events(golden.params),
          label,
        ).rejects.toThrow();
        expect(denseSent, label).toHaveLength(1);
        done.rejects += 1;
        continue;
      }

      let actual: Awaited<ReturnType<typeof executors.search_events>>;
      try {
        actual = await executors.search_events(golden.params);
      } catch (e) {
        expect(e, label).toBeInstanceOf(CoreProjectRequiredError);
        expect(kind, label).toBe("none");
        expect(golden.world.projectId, label).toBe("");
        expect(golden.result.summary, label).toBe("No active project");
        expect(sent, label).toEqual([]);
        expect(denseSent, label).toEqual([]);
        done.none += 1;
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
      // dense に送った引数：workspace は turn の identity、project・query は world・params、
      // limit は fetchLimit（golden の limit=2 は 6、他は 30）。
      if (kind === "none") {
        expect(denseSent, label).toEqual([]);
      } else {
        expect(denseSent, label).toEqual([
          {
            workspace: IDENTITY.workspaceId,
            projectId: golden.world.projectId,
            query: golden.params.query,
            limit: golden.params.limit === 2 ? 6 : 30,
          },
        ]);
      }
      // 送った文は全部 SELECT（method は all か values）。
      for (const statement of sent) {
        expect(statement.sql, label).toMatch(/^\s*select\b/iu);
        expect(["all", "values"], label).toContain(statement.method);
      }
      done[kind] += 1;
    }
    expect(done).toEqual({ canned: 6, empty: 1, rejects: 1, none: 2 });
  });

  it("XPROJ の case の期待（他 project の年表に無い id は、main の secret な event の id でも出る）は、Native が索引を project で絞ることに依存する。fake が他 project に main の id を返すので出る（実 Native では出ない。実 addon の spec が確かめる）", async () => {
    setLegacyReadWorkspaceIdentity();
    await seedLegacyReadFixture();
    const golden = goldenOf("search_events").find(
      (c) => c.case === XPROJ_CASE,
    )!;
    expect(golden.world.projectId).toBe("p-other");
    await setLegacyReadWorld(golden.world);
    legacyReadInvokeBridge.reset();
    denseAnswer = () => LEGACY_READ_CANNED_EVENT_HITS;
    const executors = makeSearchExecutors(await searchTurn(golden.world));
    const result = await executors.search_events(golden.params);
    const ids = (result.content as Array<{ eventId: string }>).map(
      (e) => e.eventId,
    );
    // p-other の年表には ev-death（恒久秘匿）も ev-war（secret）も無いので、hidden 判定の対象にならず素通しする。
    expect(ids).toEqual([
      "ev-war",
      "ev-meet",
      "ev-death",
      "ev-birth",
      "x-ev-1",
    ]);
  });

  it("limit が hit の件数より小さいとき：秘匿の出来事も落とさず、dense の並びの先頭から slice する（CSR/1）。dense には fetchLimit（limit×3）を送る（golden の canned dense は limit を無視するので、golden ではこの 2 点は見えない）", async () => {
    setLegacyReadWorkspaceIdentity();
    await seedLegacyReadFixture();
    await setLegacyReadWorld({ projectId: "p-main", activeSceneId: "n-s1" });
    legacyReadInvokeBridge.reset();
    // CSR/1：ev-war（n-s3 で公開）と ev-death（恒久秘匿）も、秘匿を理由には落とさない。
    denseAnswer = () => [
      LEGACY_READ_CANNED_EVENT_HITS[0],
      LEGACY_READ_CANNED_EVENT_HITS[2],
      LEGACY_READ_CANNED_EVENT_HITS[1],
      LEGACY_READ_CANNED_EVENT_HITS[3],
    ];
    const executors = makeSearchExecutors(
      await searchTurn({ projectId: "p-main", activeSceneId: "n-s1" }),
    );
    denseSent.length = 0;
    const result = await executors.search_events({ query: "魔術", limit: 1 });
    expect(
      (result.content as Array<{ eventId: string }>).map((e) => e.eventId),
    ).toEqual(["ev-war"]);
    expect(denseSent.map((d) => d.limit)).toEqual([3]);
  });

  it("dense の失敗（workspace の不一致・backend の欠落）は tool error で、`[]` の成功にならない", async () => {
    setLegacyReadWorkspaceIdentity();
    await seedLegacyReadFixture();
    await setLegacyReadWorld({ projectId: "p-main", activeSceneId: "n-s1" });
    const turn = await searchTurn({
      projectId: "p-main",
      activeSceneId: "n-s1",
    });
    // backend に eventsSemanticSearch が無い（fail closed）。
    const bare = createChronicleSearchExecutors(
      createMainChronicleSearchContext({
        db: mainDb,
        turn,
        countTokens: (text) => text.length,
        native: createMainTypedReads({
          backend: {} as unknown as MainTypedReadsBackend,
          identity: IDENTITY,
        }),
      }),
    );
    await expect(bare.search_events({ query: "魔術" })).rejects.toThrow(
      /backend has no such method/u,
    );
    // identity に workspace が無い。
    const noWorkspace = createChronicleSearchExecutors(
      createMainChronicleSearchContext({
        db: mainDb,
        turn,
        countTokens: (text) => text.length,
        native: createMainTypedReads({
          backend: typedBackend,
          identity: { ...IDENTITY, workspaceId: "" },
        }),
      }),
    );
    denseSent.length = 0;
    await expect(noWorkspace.search_events({ query: "魔術" })).rejects.toThrow(
      /no workspace/u,
    );
    expect(denseSent).toEqual([]);
  });

  it("search_events は events・scene_events を読まない（CSR/1）：list_events（cache つきの ctx）が events を読んだ後でも、search_events は 2 回呼んで 0 回。turn の途中で secret にした event の hit も、落ちない", async () => {
    setLegacyReadWorkspaceIdentity();
    await seedLegacyReadFixture();
    await setLegacyReadWorld({ projectId: "p-main", activeSceneId: "n-s1" });
    legacyReadInvokeBridge.reset();
    const turn = await searchTurn({
      projectId: "p-main",
      activeSceneId: "n-s1",
    });
    const cached = createChronicleReadExecutors(
      createMainChronicleReadContext({
        db: mainDb,
        turn,
        countTokens: (text) => text.length,
        getUiLanguage: () => "ja",
      }).ctx,
    );
    const executors = makeSearchExecutors(turn);
    denseAnswer = () => LEGACY_READ_CANNED_EVENT_HITS;
    const countFrom = (table: string) =>
      sent.filter((x) => new RegExp(`from "${table}"`, "iu").test(x.sql))
        .length;
    const idsOf = (r: { content: unknown }) =>
      (r.content as Array<{ eventId: string }>).map((e) => e.eventId);

    sent.length = 0;
    await cached.list_events({});
    await cached.list_events({});
    expect(countFrom("events")).toBe(1); // the cached context: once
    sent.length = 0;
    const first = await executors.search_events({ query: "魔術" });
    expect(idsOf(first)).toContain("ev-meet");
    await executors.search_events({ query: "魔術" });
    expect(countFrom("events")).toBe(0); // search_events は DB を読まない（秘匿の判定が無いため）
    expect(countFrom("scene_events")).toBe(0);

    const update = (secret: number, reveal: string | null) =>
      invoke("db_execute", {
        sql: "UPDATE events SET secret = ?, reveal_scene_id = ? WHERE id = 'ev-meet'",
        params: [secret, reveal],
        method: "run",
      });
    try {
      await update(1, "n-s3"); // 公開の ev-meet が、turn の途中で n-s3 公開の secret になる（今は n-s1）
      const after = await executors.search_events({ query: "魔術" });
      expect(idsOf(after)).toContain("ev-meet"); // secret は、検索の判定に使われない
    } finally {
      await update(0, null);
    }
  });
});

/**
 * PR-8a：Codex の hidden 判定。legacy は live の store（`setLegacyReadWorld` が seed の木から作る）と
 * `listPhasesByEntryIds`、main は turn の開始時に DB から作る入力（`readReadInputs`：1 つの木の select と
 * `projects.phase_resolution_mode`）と `codex_entry_phases` の select。同じ seed の同じ入力で同じ結果になる。
 */
describe("Codex の hidden 判定（main の DB adapter と turn の入力の上）が、legacy の resolveCodexForAi と同じ結果を返す", () => {
  const setMode = (mode: "reading" | "story" | "auto") =>
    invoke("db_execute", {
      sql: "UPDATE projects SET phase_resolution_mode = ? WHERE id = ?",
      params: [mode, "p-main"],
      method: "run",
    });

  const codexIds = async (projectId: string): Promise<string[]> =>
    (
      (await invoke("db_execute", {
        sql: "SELECT id FROM codex_entries WHERE project_id = ? ORDER BY id",
        params: [projectId],
        method: "all",
      })) as { rows: Array<{ id: string }> }
    ).rows.map((row) => row.id);

  const mainPorts = async (sceneId: string | null) =>
    createMainCodexVisibilityPorts({
      db: mainDb,
      inputs: await readReadInputs(mainDb, {
        projectId: "p-main",
        currentSceneId: sceneId,
      }),
    });

  it("p-main の全 entry・他 project の entry・存在しない id を、場面 n-s1・n-s2・n-s3・場面なし・読む順に無い id、reading・story・auto で比べて、hidden・texts（挿入順まで）が一致する。hidden の c-secret は出ず、c-released は n-s3 から出る", async () => {
    setLegacyReadWorkspaceIdentity();
    await seedLegacyReadFixture();
    const own = await codexIds("p-main");
    expect(own).toEqual(expect.arrayContaining(["c-secret", "c-released"]));
    const ids = [...own, "x-c-aria", "gone", own[0]!];
    let compared = 0;
    try {
      for (const mode of ["reading", "story", "auto"] as const) {
        await setMode(mode);
        for (const sceneId of [
          "n-s1",
          "n-s2",
          "n-s3",
          "n-s4",
          "",
          "no-such-scene",
          "n-arch",
        ]) {
          await setLegacyReadWorld({
            projectId: "p-main",
            activeSceneId: sceneId,
            resolutionMode: mode,
          });
          const label = `${mode} / ${sceneId || "(none)"}`;
          for (const withContent of [false, true]) {
            legacyReadInvokeBridge.reset();
            const legacy = await resolveCodexForAi({
              entryIds: ids,
              projectId: "p-main",
              sceneId,
              withContent,
            });
            // main の入力は turn の開始時に DB から作る。wire の現在の場面は信用しない（読む順に無ければ null）。
            const ports = await mainPorts(sceneId);
            sent.length = 0;
            const core = await resolveCodexAiVisibility(ports, {
              entryIds: ids,
              projectId: "p-main",
              sceneId: ports
                .getPhaseState()
                .sceneTimeIndex.readingOrder.has(sceneId)
                ? sceneId
                : null,
              withContent,
            });
            expect([...core.hidden], label).toEqual([...legacy.hidden]);
            expect([...core.texts.entries()], label).toEqual([
              ...legacy.texts.entries(),
            ]);
            for (const statement of sent) {
              expect(statement.sql, label).toMatch(/^\s*select\b/iu);
              expect(["all", "values"], label).toContain(statement.method);
            }
            expect(
              sent.filter((s) => /codex_entry_phases/iu.test(s.sql)).length,
              label,
            ).toBe(1);
            compared += 1;
          }
        }
      }
    } finally {
      await setMode("reading");
    }
    expect(compared).toBe(3 * 7 * 2);

    // seed の 2 件は、実際に判定が分かれる（自明な比較になっていない）。
    await setLegacyReadWorld({ projectId: "p-main", activeSceneId: "n-s1" });
    const atS1 = await resolveCodexAiVisibility(await mainPorts("n-s1"), {
      entryIds: ["c-secret", "c-released", "c-aria"],
      projectId: "p-main",
      sceneId: "n-s1",
    });
    expect([...atS1.hidden].sort()).toEqual(["c-released", "c-secret"]);
    const atS3 = await resolveCodexAiVisibility(await mainPorts("n-s3"), {
      entryIds: ["c-secret", "c-released", "c-aria"],
      projectId: "p-main",
      sceneId: "n-s3",
    });
    expect([...atS3.hidden]).toEqual(["c-secret"]);
    expect(atS3.texts.get("c-released")).toMatchObject({
      released: true,
      summary: "n-s3 で正体が明らかになる騎士。",
    });
  });

  it("listHiddenCodexIds・dropHiddenCodexRows も legacy と同じ（hidden の行は落ち、解除された行の summary は Phase 解決後）", async () => {
    setLegacyReadWorkspaceIdentity();
    await seedLegacyReadFixture();
    await setLegacyReadWorld({ projectId: "p-main", activeSceneId: "n-s3" });
    const ports = await mainPorts("n-s3");
    const rows = [
      { id: "c-secret", summary: "s" },
      { id: "c-released", summary: "base の summary（hidden）" },
      { id: "c-aria", summary: "老魔術師を訪ねる旅の少女" },
    ];
    const kept = await dropHiddenCodexRows(ports, rows, {
      projectId: "p-main",
      sceneId: "n-s3",
    });
    expect(kept).toEqual([
      { id: "c-released", summary: "n-s3 で正体が明らかになる騎士。" },
      { id: "c-aria", summary: "老魔術師を訪ねる旅の少女" },
    ]);
    const hidden = await listHiddenCodexIds(ports, {
      projectId: "p-main",
      entryIds: rows.map((r) => r.id).concat("gone"),
      sceneId: "n-s3",
    });
    expect([...hidden].sort()).toEqual(["c-secret", "gone"]);
  });

  it("年表の read ctx は live scene の hidden id を legacy と同じく返し、main は呼ぶたび DB を読む", async () => {
    setLegacyReadWorkspaceIdentity();
    await seedLegacyReadFixture();
    await setLegacyReadWorld({ projectId: "p-main", activeSceneId: "n-s3" });
    const phaseId = "ph-csr1-hidden";
    await invoke("db_execute", {
      sql: "INSERT INTO codex_entry_phases (id, entry_id, anchor_node_id, label, context_mode_override, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      params: [
        phaseId,
        "c-aria",
        "n-s3",
        "CSR/1 hidden",
        "hidden",
        "2026-11-24T00:00:00.000Z",
        "2026-11-24T00:00:00.000Z",
      ],
      method: "run",
    });
    try {
      const ids = [
        "c-secret",
        "c-released",
        "c-aria",
        "c-mage",
        "gone",
        "x-c-aria",
      ];
      const turn = await readChronicleReadInputs(mainDb, {
        projectId: "p-main",
        currentSceneId: "n-s3",
      });
      const read = createMainChronicleReadContext({
        db: mainDb,
        turn,
        countTokens: (text) => text.length,
        getUiLanguage: () => "ja",
      }).ctx;

      const legacy =
        await LEGACY_CHRONICLE_READ_CONTEXT.chronicle.listHiddenCodexIds(
          "p-main",
          ids,
        );
      const main = await read.chronicle.listHiddenCodexIds("p-main", ids);
      expect([...main].sort()).toEqual([...legacy].sort());
      expect([...main].sort()).toEqual([
        "c-aria",
        "c-secret",
        "gone",
        "x-c-aria",
      ]);
      expect(main.has("c-released")).toBe(false);
      expect(main.has("c-mage")).toBe(false);

      sent.length = 0;
      await read.chronicle.listHiddenCodexIds("p-main", ids);
      await read.chronicle.listHiddenCodexIds("p-main", ids);
      expect(
        sent.filter((statement) =>
          /from\s+"codex_entries"/iu.test(statement.sql),
        ),
      ).toHaveLength(2);
      expect(
        sent.filter((statement) =>
          /from\s+"codex_entry_phases"/iu.test(statement.sql),
        ),
      ).toHaveLength(2);
    } finally {
      await invoke("db_execute", {
        sql: "DELETE FROM codex_entry_phases WHERE id = ?",
        params: [phaseId],
        method: "run",
      });
      sent.length = 0;
    }
  });

  it("unresolved な read inputs では候補 id 全てを hidden として返す", async () => {
    const turn = {
      inputs: buildReadInputs({
        projectId: "p-missing",
        treeRows: [],
        project: null,
        currentSceneId: null,
      }),
      nodes: [],
    };
    const { ctx } = createMainChronicleReadContext({
      db: mainDb,
      turn,
      countTokens: (text) => text.length,
      getUiLanguage: () => "ja",
    });
    expect([
      ...(await ctx.chronicle.listHiddenCodexIds("p-missing", [
        "candidate-a",
        "candidate-b",
      ])),
    ]).toEqual(["candidate-a", "candidate-b"]);
  });

  it("別 project の入力で判定を求めると拒否する。別 project の entry の id は、project 条件のために DB に無い id と同じに hidden", async () => {
    setLegacyReadWorkspaceIdentity();
    await seedLegacyReadFixture();
    const other = createMainCodexVisibilityPorts({
      db: mainDb,
      inputs: await readReadInputs(mainDb, {
        projectId: "p-other",
        currentSceneId: null,
      }),
    });
    await expect(
      resolveCodexAiVisibility(other, {
        entryIds: ["c-aria"],
        projectId: "p-main",
        sceneId: "n-s1",
      }),
    ).rejects.toThrow(/different project/u);
    // p-other の入力で p-other の判定は通り、p-main の entry の id は hidden。
    const own = await resolveCodexAiVisibility(other, {
      entryIds: ["x-c-aria", "c-aria"],
      projectId: "p-other",
      sceneId: null,
    });
    expect([...own.hidden]).toEqual(["c-aria"]);
    expect([...own.texts.keys()]).toEqual(["x-c-aria"]);
    // project の条件は SQL に入っている。
    sent.length = 0;
    await resolveCodexAiVisibility(await mainPorts(null), {
      entryIds: ["x-c-aria"],
      projectId: "p-main",
      sceneId: null,
    });
    expect(sent[0]!.sql).toMatch(/"project_id" = \?/u);
  });

  it("project 行が無い入力（unresolved）は、見つかった entry を全部 hidden にする。project が空なら何も読まずに止まる", async () => {
    setLegacyReadWorkspaceIdentity();
    await seedLegacyReadFixture();
    // project 行が無い id に、entry を 1 つ持たせることはできない（FK）。DB の読みは entries 0 件で、unresolved の
    // 分岐は入力の単体（core の試験）が覆う。ここでは「project 行が無い turn は全部 hidden」を結果で確かめる。
    const ports = createMainCodexVisibilityPorts({
      db: mainDb,
      inputs: await readReadInputs(mainDb, {
        projectId: "p-no-such-project",
        currentSceneId: null,
      }),
    });
    expect(ports.getPhaseState().resolutionMode).toMatchObject({
      kind: "unresolved",
      reason: "project-missing",
    });
    const r = await resolveCodexAiVisibility(ports, {
      entryIds: ["c-aria", "c-secret"],
      projectId: "p-no-such-project",
      sceneId: null,
    });
    expect([...r.hidden]).toEqual(["c-aria", "c-secret"]);
    expect(r.texts.size).toBe(0);

    sent.length = 0;
    await expect(
      resolveCodexAiVisibility(ports, {
        entryIds: ["c-aria"],
        projectId: "",
        sceneId: null,
      }),
    ).rejects.toBeInstanceOf(CoreProjectRequiredError);
    expect(sent).toEqual([]);
  });
});

/**
 * PR-8b：Codex の 4 本。golden の case を、**search_codex の dense の種類**（case 名→kind の明示の表。表に無い case が
 * 来たら試験が落ちる）で結ぶ。canned：dense が canned の hit／empty：[]（browser-mock の既定）／rejects：reject
 * （main では throw）／none：dense に届く前に止まる（no-project・空の query）。他の 3 本は dense を呼ばない。
 */
const SEARCH_CODEX_DENSE: Record<string, DenseKind> = {
  "rows: 短い語 2 字（LIKE-OR の arm）。hidden の黒幕と幻の騎士は落ちる":
    "empty",
  "rows: 3 字以上（fts_search の arm → id で Drizzle）": "empty",
  "rows: 前後の空白は trim される": "empty",
  "hidden: base が hidden の c-secret は結果に出ない": "empty",
  "hidden: Phase 解除前（n-s1）は幻の騎士が出ない": "empty",
  "hidden: Phase 解除後（n-s3）は幻の騎士が Phase 解決後の summary で出る":
    "empty",
  "canned dense: sparse と RRF 融合し、融合の後に hidden を落とす（S1）":
    "canned",
  "canned dense: Phase 解除後（S3）は幻の騎士が Phase 解決後の summary で残る":
    "canned",
  "canned dense: dense が reject しても sparse だけに退避する": "rejects",
  "empty: 一致なし": "empty",
  "empty: 空の project": "empty",
  "XPROJ: 他 project では他 project の行だけ": "empty",
  "XPROJ: main から他 project にしかない語は出ない": "empty",
  "no-project: 引数が有効でも No active project": "none",
  "order: 空の query は no-project より先（0 entries found）": "none",
  "order: 空白だけの query も先に弾く": "none",
  "order: query 欠落（undefined）も先に弾く": "none",
};

const CALLS_RAW = import.meta.glob<string>(
  "./__fixtures__/codexReadCalls/*.golden.txt",
  {
    query: "?raw",
    import: "default",
    eager: true,
  },
)["./__fixtures__/codexReadCalls/codex-read-calls.golden.txt"];
const CODEX_CALLS = JSON.parse(CALLS_RAW ?? "{}") as Record<
  string,
  Record<string, Array<Record<string, unknown>>>
>;

/** golden の world から、main の turn の入力（読む順・mode・現在の場面）を作る。project が空なら project 行なし。 */
async function codexInputs(world: LegacyReadGoldenCase["world"]) {
  return world.projectId === ""
    ? buildReadInputs({
        projectId: "",
        treeRows: [],
        project: null,
        currentSceneId: null,
      })
    : await readReadInputs(mainDb, {
        projectId: world.projectId,
        currentSceneId: world.activeSceneId ?? null,
      });
}

async function makeCodexExecutors(world: LegacyReadGoldenCase["world"]) {
  return createCodexReadExecutors(
    createMainCodexReadContext({
      db: mainDb,
      inputs: await codexInputs(world),
      countTokens: (text) => (text ? text.length : 0),
      native: createMainTypedReads({
        backend: typedBackend,
        identity: IDENTITY,
      }),
    }),
  );
}

describe("共有 core の Codex の 4 本（main の DB adapter・turn の入力・typed read の上）が、PR-0 の golden と同じ結果を返す（PR-8b）", () => {
  it("対象は golden を持つ 4 本で、CORE_READ_TOOL_NAMES・CHRONICLE_READ_TOOL_NAMES・CHRONICLE_SEARCH_TOOL_NAMES とは別の表（4 つの表は互いに素で合計 20）", () => {
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
    let goldenCases = 0;
    for (const tool of CODEX_READ_TOOL_NAMES) {
      expect(goldenOf(tool).length, tool).toBeGreaterThan(0);
      expect(Object.keys(CODEX_CALLS[tool] ?? {}), tool).toEqual(
        goldenOf(tool).map((c) => c.case),
      );
      goldenCases += goldenOf(tool).length;
    }
    expect(goldenCases).toBe(46);
  });

  it("case 名→dense の表は search_codex の golden の 17 case と過不足なく一致する", () => {
    expect(goldenOf("search_codex").map((c) => c.case)).toEqual(
      Object.keys(SEARCH_CODEX_DENSE),
    );
  });

  for (const tool of CODEX_READ_TOOL_NAMES) {
    it(`${tool}：golden の全 case で結果が byte 一致し、送った呼出しの列（db_execute の sql・params・method、fts・dense の引数、その順）が legacy の fixture と一致する`, async () => {
      setLegacyReadWorkspaceIdentity();
      await seedLegacyReadFixture();
      const cases = goldenOf(tool);
      const done: Record<DenseKind, number> = {
        canned: 0,
        empty: 0,
        rejects: 0,
        none: 0,
      };
      for (const golden of cases) {
        const kind: DenseKind =
          tool === "search_codex"
            ? (SEARCH_CODEX_DENSE[golden.case] ?? "none")
            : "none";
        if (tool === "search_codex" && !(golden.case in SEARCH_CODEX_DENSE)) {
          throw new Error(`no dense kind: ${golden.case}`);
        }
        await setLegacyReadWorld(golden.world);
        legacyReadInvokeBridge.reset();
        const label = `${tool} / ${golden.case}`;
        const executors = await makeCodexExecutors(golden.world);
        codexDenseAnswer = () => {
          if (kind === "canned") return LEGACY_READ_CANNED_CODEX_HITS;
          if (kind === "rejects") throw new Error("dense unavailable");
          return [];
        };
        callLog.length = 0;
        codexDenseSent.length = 0;
        const expectedCalls = CODEX_CALLS[tool]?.[golden.case] ?? [];

        if (kind === "rejects") {
          // main は握らない：tool error（throw）で、sparse だけの成功にならない。golden の結果は
          // legacy の port の握りの結果（renderer の結果は変わらない）。
          await expect(executors[tool](golden.params), label).rejects.toThrow();
          expect(codexDenseSent, label).toHaveLength(1);
          // throw までに送ったものは、legacy が dense まで送ったものと同じ（判定の読みは dense の後なので含まない）。
          expect(callLog, label).toEqual(
            expectedCalls.slice(0, callLog.length),
          );
          done.rejects += 1;
          continue;
        }

        let actual: Awaited<ReturnType<(typeof executors)[typeof tool]>>;
        try {
          actual = await executors[tool](golden.params);
        } catch (e) {
          expect(e, label).toBeInstanceOf(CoreProjectRequiredError);
          expect(golden.world.projectId, label).toBe("");
          expect(golden.result.summary, label).toBe("No active project");
          expect(callLog, label).toEqual([]);
          expect(expectedCalls, label).toEqual([]);
          done.none += 1;
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
        // 送った呼出しの列：legacy の fixture と同じ（sql・params・method・順）。dense の workspace は turn の identity。
        expect(callLog, label).toEqual(
          expectedCalls.map((call) =>
            call["cmd"] === "codex_semantic_search"
              ? {
                  ...call,
                  args: {
                    ...(call["args"] as object),
                    expectedWorkspacePath: IDENTITY.workspaceId,
                  },
                }
              : call,
          ),
        );
        // 送った文は全部 SELECT（method は all か values）。
        for (const statement of sent) {
          expect(statement.sql, label).toMatch(/^\s*select\b/iu);
          expect(["all", "values"], label).toContain(statement.method);
        }
        done[kind] += 1;
      }
      if (tool === "search_codex") {
        expect(done).toEqual({ canned: 2, empty: 10, rejects: 1, none: 4 });
      } else {
        expect(done.canned + done.empty + done.rejects).toBe(0);
        expect(done.none).toBe(cases.length);
      }
    });
  }

  it("renderer の 4 本（executeTool）と main の core が、golden に無い world でも同じ結果を返す：場面 n-s1・n-s2・n-s3・場面なし・読む順に無い id、reading・story・auto（content と summary。tokensUsed は renderer が実 tokenizer なので除く）", async () => {
    setLegacyReadWorkspaceIdentity();
    await seedLegacyReadFixture();
    const setMode = (mode: "reading" | "story" | "auto") =>
      invoke("db_execute", {
        sql: "UPDATE projects SET phase_resolution_mode = ? WHERE id = ?",
        params: [mode, "p-main"],
        method: "run",
      });
    const calls: Array<
      [(typeof CODEX_READ_TOOL_NAMES)[number], Record<string, unknown>]
    > = [
      ["search_codex", { query: "魔法" }],
      ["search_codex", { query: "老魔術師" }],
      ["list_codex_by_type", { type: "character" }],
      ["search_codex_by_tags", { tags: ["魔法", "主人公"] }],
      ["find_related_entries", { id: "c-mage" }],
      ["find_related_entries", { id: "c-released" }],
    ];
    let compared = 0;
    let released = 0;
    try {
      for (const mode of ["reading", "story", "auto"] as const) {
        await setMode(mode);
        for (const sceneId of ["n-s1", "n-s2", "n-s3", "", "no-such-scene"]) {
          const world = {
            projectId: "p-main",
            activeSceneId: sceneId,
            resolutionMode: mode,
          };
          const executors = await makeCodexExecutors(world);
          for (const [tool, params] of calls) {
            await setLegacyReadWorld(world);
            legacyReadInvokeBridge.reset();
            codexDenseAnswer = () => LEGACY_READ_CANNED_CODEX_HITS;
            legacyReadInvokeBridge.override(
              "codex_semantic_search",
              () => LEGACY_READ_CANNED_CODEX_HITS,
            );
            const label = `${tool} ${JSON.stringify(params)} / ${mode} / ${sceneId || "(none)"}`;
            const legacy = await executeTool(tool, "c", params);
            const main = await executors[tool](params);
            expect(main.summary, label).toBe(legacy.summary);
            expect(main.content, label).toEqual(legacy.content);
            if (
              (main.content as Array<{ id: string }>).some(
                (row) => row.id === "c-released",
              )
            ) {
              released += 1;
            }
            compared += 1;
          }
        }
      }
    } finally {
      await setMode("reading");
      codexDenseAnswer = () => [];
    }
    expect(compared).toBe(3 * 5 * 6);
    // 自明な比較になっていない：Phase で解除された c-released が出る組がある（reading の n-s3 など）。
    expect(released).toBeGreaterThan(0);
  });

  it("dense の失敗（workspace の不一致・backend の欠落・wire の不正）は tool error で、sparse だけの成功にならない。score が null の hit は通る", async () => {
    setLegacyReadWorkspaceIdentity();
    await seedLegacyReadFixture();
    const world = { projectId: "p-main", activeSceneId: "n-s1" };
    await setLegacyReadWorld(world);
    const inputs = await codexInputs(world);
    const make = (
      backendLike: unknown,
      identity: MainIssuedCallerIdentity = IDENTITY,
    ) =>
      createCodexReadExecutors(
        createMainCodexReadContext({
          db: mainDb,
          inputs,
          countTokens: (text) => text.length,
          native: createMainTypedReads({
            backend: backendLike as MainTypedReadsBackend,
            identity,
          }),
        }),
      );
    await expect(
      make({ ftsSearch: typedBackend.ftsSearch }).search_codex({
        query: "魔法",
      }),
    ).rejects.toThrow(/backend has no such method/u);
    codexDenseSent.length = 0;
    await expect(
      make(typedBackend, { ...IDENTITY, workspaceId: "" }).search_codex({
        query: "魔法",
      }),
    ).rejects.toThrow(/no workspace/u);
    expect(codexDenseSent).toEqual([]);
    codexDenseAnswer = () => [{ entryId: "c-mage", score: "high" }];
    await expect(
      make(typedBackend).search_codex({ query: "魔法" }),
    ).rejects.toThrow(/codex_semantic_search/u);
    codexDenseAnswer = () => [
      {
        entryId: "c-mage",
        entryName: "老魔術師",
        entryType: "character",
        summary: "塔に住む魔術師",
        score: null,
      },
    ];
    const ok = await make(typedBackend).search_codex({ query: "魔法" });
    expect(
      (ok.content as Array<{ id: string }>).map((row) => row.id),
    ).toContain("c-mage");
    codexDenseAnswer = () => [];
  });

  it("dense が他 project の entry や hidden の entry の id を返しても、project 条件つきの判定で落ちる（XPROJ・hidden。実 Native が索引を project で絞ることとは独立の防御）", async () => {
    setLegacyReadWorkspaceIdentity();
    await seedLegacyReadFixture();
    const world = { projectId: "p-main", activeSceneId: "n-s1" };
    await setLegacyReadWorld(world);
    const executors = await makeCodexExecutors(world);
    codexDenseAnswer = () => [
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
    ];
    try {
      const result = await executors.search_codex({ query: "魔法" });
      const ids = (result.content as Array<{ id: string }>).map((r) => r.id);
      expect(ids).not.toContain("x-c-aria");
      expect(ids).not.toContain("c-secret");
      expect(ids).toContain("c-aria");
    } finally {
      codexDenseAnswer = () => [];
    }
  });
});

describe("共有 core の get_codex_entry（10b）", () => {
  it("5つの名前表は互いに素で合計21本。既存4表の合計20本はそのまま", () => {
    const groups: readonly (readonly string[])[] = [
      CORE_READ_TOOL_NAMES,
      CHRONICLE_READ_TOOL_NAMES,
      CHRONICLE_SEARCH_TOOL_NAMES,
      CODEX_READ_TOOL_NAMES,
      CODEX_ENTRY_TOOL_NAMES,
    ];
    const all = groups.flatMap((group) => [...group]);
    expect(CODEX_ENTRY_TOOL_NAMES).toEqual(["get_codex_entry"]);
    expect(all).toHaveLength(21);
    expect(new Set(all).size).toBe(21);
    for (let i = 0; i < groups.length; i += 1) {
      for (let j = i + 1; j < groups.length; j += 1) {
        expect(groups[i]!.some((name) => groups[j]!.includes(name))).toBe(
          false,
        );
      }
    }
  });

  it("commit ① の4 caseを main adapter 上で golden と byte 一致させる", async () => {
    setLegacyReadWorkspaceIdentity();
    await seedLegacyReadFixture();
    await seedCodexEntryFixture();

    for (const golden of CODEX_ENTRY_GOLDEN.cases) {
      const executors = await makeCodexEntryExecutors(golden.world);
      callLog.length = 0;
      sent.length = 0;
      const actual = await executors.get_codex_entry(golden.params);
      const label = `get_codex_entry / ${golden.case}`;
      expect(
        {
          name: actual.name,
          summary: actual.summary,
          tokensUsed: actual.tokensUsed,
          content: actual.content,
        },
        label,
      ).toEqual(golden.result);
      expect(JSON.stringify(actual.content), label).toBe(golden.contentJson);
    }
  });

  it("通常・released・hidden・missing の select 列と順序を legacy fixture と一致させる", async () => {
    setLegacyReadWorkspaceIdentity();
    await seedLegacyReadFixture();
    await seedCodexEntryFixture();
    const cases = [
      {
        key: "normal",
        world: { projectId: "p-main", activeSceneId: "n-s1" },
        params: { id: "ge-normal" },
      },
      {
        key: "released",
        world: { projectId: "p-main", activeSceneId: "n-s2" },
        params: { id: "ge-released-old" },
      },
      {
        key: "hidden",
        world: { projectId: "p-main", activeSceneId: "n-s2" },
        params: { id: "ge-hidden" },
      },
      {
        key: "missing",
        world: { projectId: "p-main", activeSceneId: "n-s2" },
        params: { id: "missing-entry" },
      },
    ] as const;

    for (const scenario of cases) {
      const executors = await makeCodexEntryExecutors(scenario.world);
      callLog.length = 0;
      sent.length = 0;
      await executors.get_codex_entry(scenario.params);
      expect(
        callLog.map((call) => ({
          sql: call["sql"],
          params: call["params"],
        })),
        scenario.key,
      ).toEqual(CODEX_ENTRY_READS_GOLDEN[scenario.key]);
    }
  });

  it("commit ① と同じ入力行列で SECRET marker の公開境界を保つ", async () => {
    setLegacyReadWorkspaceIdentity();
    await seedLegacyReadFixture();
    await seedCodexEntryFixture();
    const modes = ["reading", "story", "auto"] as const;
    const treeRows = ["n-s1", "n-s2", "n-s3"].map((id, index) => ({
      id,
      parentId: null,
      nodeType: "scene",
      sortOrder: `a${index}`,
      storyTimeOrder: null,
      archivedAt: null,
    }));
    const matrix: Array<{
      label: string;
      id: string;
      sceneId: string;
      visible: boolean;
      marker?: string;
    }> = [
      {
        label: "base hidden・Phase なし",
        id: "ge-no-phase",
        sceneId: "n-s2",
        visible: false,
      },
      { label: "場面なし", id: "ge-released-old", sceneId: "", visible: false },
      {
        label: "空白の場面",
        id: "ge-released-old",
        sceneId: "   ",
        visible: false,
      },
      {
        label: "読む順に無い場面",
        id: "ge-released-old",
        sceneId: "n-not-indexed",
        visible: false,
      },
      {
        label: "release 前",
        id: "ge-released-old",
        sceneId: "n-s1",
        visible: false,
      },
      {
        label: "released",
        id: "ge-released-old",
        sceneId: "n-s2",
        visible: true,
        marker: "SECRET-PHASE-OLD",
      },
      {
        label: "released の現在 Phase",
        id: "ge-released-current",
        sceneId: "n-s2",
        visible: true,
        marker: "SECRET-PHASE",
      },
      {
        label: "解除後に再 hidden",
        id: "ge-released-old",
        sceneId: "n-s3",
        visible: false,
      },
      {
        label: "NULL 起点の orphan hidden Phase",
        id: "ge-orphan-null-release",
        sceneId: "n-s3",
        visible: false,
      },
      {
        label: "読む順に無い orphan hidden Phase",
        id: "ge-orphan-index-release",
        sceneId: "n-s3",
        visible: false,
      },
      {
        label: "orphan の公開 Phase だけ",
        id: "ge-orphan-public",
        sceneId: "n-s3",
        visible: false,
      },
      {
        label: "別 project の id",
        id: "x-c-aria",
        sceneId: "n-s2",
        visible: false,
      },
      {
        label: "base 公開・Phase に本文上書き",
        id: "ge-base-public-override",
        sceneId: "n-s2",
        visible: true,
        marker: "PUBLIC-BASE",
      },
    ];

    for (const mode of modes) {
      for (const scenario of matrix) {
        const inputs = buildReadInputs({
          projectId: "p-main",
          treeRows,
          project: { phaseResolutionMode: mode },
          currentSceneId: scenario.sceneId,
        });
        const executors = createCodexEntryExecutors(
          createMainCodexEntryContext({
            db: mainDb,
            inputs,
            countTokens: (text) => (text ? text.length : 0),
            extractPlainText: (json) => extractPlainText(json),
          }),
        );
        const result = await executors.get_codex_entry({ id: scenario.id });
        const json = JSON.stringify(result);
        expect(result.content !== null, `${mode}: ${scenario.label}`).toBe(
          scenario.visible,
        );
        expect(
          json.includes('"SECRET-BASE'),
          `${mode}: ${scenario.label}`,
        ).toBe(false);
        expect(
          json.includes('"SECRET-PHASE-OLD"'),
          `${mode}: ${scenario.label}`,
        ).toBe(scenario.marker === "SECRET-PHASE-OLD");
        expect(
          json.includes('"SECRET-PHASE"'),
          `${mode}: ${scenario.label}`,
        ).toBe(scenario.marker === "SECRET-PHASE");
        expect(json, `${mode}: ${scenario.label}`).not.toContain(
          "SECRET-PHASE-PUBLIC",
        );
        expect(json, `${mode}: ${scenario.label}`).not.toContain(
          "SECRET-PHASE-ORPHAN",
        );
        if (scenario.marker)
          expect(json, `${mode}: ${scenario.label}`).toContain(scenario.marker);
      }
    }
  });

  it("reading・story・auto の Phase 場面順の解釈を保つ", async () => {
    setLegacyReadWorkspaceIdentity();
    await seedLegacyReadFixture();
    await seedCodexEntryFixture();
    const baseInputs = await readReadInputs(mainDb, {
      projectId: "p-main",
      currentSceneId: "n-s2",
    });
    const cases = [
      { mode: "reading", summary: "Entry not found" },
      { mode: "story", summary: "mode 判定 (character)" },
      { mode: "auto", summary: "Entry not found" },
    ] as const;
    for (const { mode, summary } of cases) {
      const inputs = {
        ...baseInputs,
        resolutionMode: { kind: "resolved" as const, mode },
      };
      const executors = createCodexEntryExecutors(
        createMainCodexEntryContext({
          db: mainDb,
          inputs,
          countTokens: (text) => (text ? text.length : 0),
          extractPlainText: (json) => extractPlainText(json),
        }),
      );
      const result = await executors.get_codex_entry({ id: "ge-mode" });
      expect(result.summary, mode).toBe(summary);
      if (mode === "story") {
        const json = JSON.stringify(result);
        expect(json).toContain("MODE-PHASE");
        expect(json).not.toContain("SECRET-BASE-MODE");
      }
    }
  });
});

// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MP-4b PR-0：legacy の read tool が Native 側へ出す呼び出し（command 名・引数・scope）の固定。
 *
 * browser-mock（実 sql.js）では、fts は LIKE の arm、semantic 2 本は常に `[]`、foreshadow は
 * Drizzle 側の分岐になり、Native 経路（`fts_search`／`codex_semantic_search`／
 * `events_semantic_search`／`foreshadow_list_open_for_context` の typed read 4 本）を覆えない。
 * そこで `@/lib/tauri` の `invoke` に挟んだ spy で、legacy が呼ぶ command 名・引数・scope・回数と、
 * 戻りを受け渡す位置（sourceType の filter、事後の workspace 照合、fail の退避）を固定する。
 * 後続の PR が read を共有 core の port（typed read）へ移したとき、legacy の port の配線
 * （invoke の引数、scope の literal、fts の結果の受け渡し）を黙って変えないための試験。
 *
 * **Native 経路の結果の同値は、後続の実 addon の spec（PR-9。同じ fixture DB を renderer 経路と
 * main の adapter で比べる）の担当**。ここは呼び方の固定で、結果の同値は示さない。
 */
vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  const { legacyReadInvokeBridge } =
    await import("./legacyReadInvokeBridge.testSupport");
  legacyReadInvokeBridge.bindActual(actual.invoke as never);
  return { ...actual, invoke: legacyReadInvokeBridge.invoke };
});
vi.mock("../contextBuilder", () => ({
  countTokens: (s: string) => (s ? s.length : 0),
}));

import { executeTool, executeReadOnlyTool } from "./toolExecutors";
import {
  setCurrentWorkspaceIdentity,
  getCurrentWorkspaceIdentity,
} from "@/runtime/workspaceIdentity";
import {
  LEGACY_READ_CANNED_CODEX_HITS,
  LEGACY_READ_CANNED_EVENT_HITS,
} from "./__fixtures__/legacyReadSeed";
import { legacyReadInvokeBridge } from "./legacyReadInvokeBridge.testSupport";
import {
  bindLegacyReadHarnessPorts,
  LEGACY_READ_WORKSPACE_PATH,
  seedLegacyReadFixture,
  setLegacyReadWorkspaceIdentity,
  setLegacyReadWorld,
  type LegacyReadWorld,
} from "./legacyReadHarness.testSupport";
import { invoke } from "@/lib/tauri";
import { useTreeStore } from "@/features/tree/treeStore";
import { usePhaseStore } from "@/features/codex/phaseStore";

bindLegacyReadHarnessPorts({
  executeRun: (sql, params) =>
    invoke("db_execute", { sql, params, method: "run" }),
  setTreeState: (state) => useTreeStore.setState(state),
  setPhaseState: (state) => usePhaseStore.setState(state),
});

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const MAIN_S1: LegacyReadWorld = { projectId: "p-main", activeSceneId: "n-s1" };
const MAIN_S3: LegacyReadWorld = { projectId: "p-main", activeSceneId: "n-s3" };
const OTHER: LegacyReadWorld = { projectId: "p-other", activeSceneId: "x-s1" };

/** db_execute 以外（＝Native の typed read など）の呼出しだけを返す。 */
function nativeCalls() {
  return legacyReadInvokeBridge
    .calls()
    .filter((c) => c.cmd !== "db_execute" && c.cmd !== "db_execute_batch");
}

async function run(tool: string, params: Record<string, unknown>) {
  legacyReadInvokeBridge.reset();
  const result = await executeTool(tool, "call-1", params);
  return result;
}

describe("legacy が呼ぶ Native 経路の command・引数・scope（Native 経路の結果の同値は後続の実 addon spec の担当）", () => {
  beforeAll(async () => {
    await seedLegacyReadFixture();
  });

  beforeEach(() => {
    setLegacyReadWorkspaceIdentity();
    legacyReadInvokeBridge.reset();
  });

  describe("fts_search（scope の literal と limit）", () => {
    it("search_codex（3 字以上）：scope='codex'、limit=20、projectId・query は trim 後", async () => {
      await setLegacyReadWorld(MAIN_S1);
      await run("search_codex", { query: "  老魔術師  " });
      expect(legacyReadInvokeBridge.calls("fts_search")).toEqual([
        {
          cmd: "fts_search",
          args: {
            projectId: "p-main",
            query: "老魔術師",
            scope: "codex",
            limit: 20,
          },
        },
      ]);
    });

    it("search_scenes（3 字以上）：scope='scenes'、limit=50（Rust の上限。archived を Drizzle で落とした後に 10 件へ切るため、以前の 10 から変更）", async () => {
      await setLegacyReadWorld(MAIN_S1);
      await run("search_scenes", { query: "アリア" });
      expect(legacyReadInvokeBridge.calls("fts_search")).toEqual([
        {
          cmd: "fts_search",
          args: {
            projectId: "p-main",
            query: "アリア",
            scope: "scenes",
            limit: 50,
          },
        },
      ]);
    });

    it("search_snippets（3 字以上）：scope='snippets'、limit=10", async () => {
      await setLegacyReadWorld(MAIN_S1);
      await run("search_snippets", { query: "老魔術師" });
      expect(legacyReadInvokeBridge.calls("fts_search")).toEqual([
        {
          cmd: "fts_search",
          args: {
            projectId: "p-main",
            query: "老魔術師",
            scope: "snippets",
            limit: 10,
          },
        },
      ]);
    });

    it("短い語（3 字未満が 1 つでも混じる）は fts_search を呼ばず LIKE-OR に倒す（3 本とも）", async () => {
      await setLegacyReadWorld(MAIN_S1);
      for (const tool of ["search_codex", "search_scenes", "search_snippets"]) {
        await run(tool, { query: "魔法" });
        expect(legacyReadInvokeBridge.calls("fts_search"), tool).toEqual([]);
      }
      await run("search_scenes", { query: "アリア 魔法" });
      expect(legacyReadInvokeBridge.calls("fts_search")).toEqual([]);
    });

    it("fts の結果の受け渡し：sourceType が scope と違う行は捨て、残りの id を fts の順で Drizzle の行に並べる", async () => {
      await setLegacyReadWorld(MAIN_S1);
      legacyReadInvokeBridge.reset();
      legacyReadInvokeBridge.override("fts_search", () => [
        { sourceType: "scene", id: "n-s1" },
        { sourceType: "codex", id: "c-tower" },
        { sourceType: "snippet", id: "sn-1" },
        { sourceType: "codex", id: "c-mage" },
        { sourceType: "codex", id: "c-secret" },
      ]);
      const result = await executeTool("search_codex", "call-1", {
        query: "老魔術師",
      });
      expect(
        (result.content as Array<{ id: string }>).map((r) => r.id),
      ).toEqual(["c-tower", "c-mage"]);
    });

    it("fts が 0 件なら Drizzle の SELECT を打たずに空（search_scenes の sparse arm）", async () => {
      await setLegacyReadWorld(MAIN_S1);
      legacyReadInvokeBridge.reset();
      legacyReadInvokeBridge.override("fts_search", () => []);
      const result = await executeTool("search_scenes", "call-1", {
        query: "アリア",
      });
      expect(result.content).toEqual([]);
      expect(
        legacyReadInvokeBridge
          .calls("db_execute")
          .some((c) => /from "tree_nodes"/iu.test(String(c.args?.sql))),
      ).toBe(false);
    });
  });

  describe("codex_semantic_search／events_semantic_search（workspace 権威の引数と事後照合）", () => {
    it("search_codex：expectedWorkspacePath（renderer の workspace identity）・projectId・query・limit=30", async () => {
      await setLegacyReadWorld(MAIN_S1);
      await run("search_codex", { query: "  魔法  " });
      expect(legacyReadInvokeBridge.calls("codex_semantic_search")).toEqual([
        {
          cmd: "codex_semantic_search",
          args: {
            expectedWorkspacePath: LEGACY_READ_WORKSPACE_PATH,
            projectId: "p-main",
            query: "魔法",
            limit: 30,
          },
        },
      ]);
    });

    it("search_codex：sparse が 0 件でも dense は呼ぶ（1 回）", async () => {
      await setLegacyReadWorld(MAIN_S1);
      await run("search_codex", { query: "存在しない語" });
      expect(
        legacyReadInvokeBridge.calls("codex_semantic_search"),
      ).toHaveLength(1);
    });

    it("search_events：limit は min(limit×3, 30)（既定 10 → 30、2 → 6、100 → 30、0.5 → 0）", async () => {
      await setLegacyReadWorld(MAIN_S3);
      const limits: Array<[unknown, number]> = [
        [undefined, 30],
        [2, 6],
        [100, 30],
        [0.5, 0],
        ["abc", 30],
      ];
      for (const [limit, expected] of limits) {
        await run("search_events", {
          query: "魔術",
          ...(limit === undefined ? {} : { limit }),
        });
        expect(
          legacyReadInvokeBridge.calls("events_semantic_search"),
          String(limit),
        ).toEqual([
          {
            cmd: "events_semantic_search",
            args: {
              expectedWorkspacePath: LEGACY_READ_WORKSPACE_PATH,
              projectId: "p-main",
              query: "魔術",
              limit: expected,
            },
          },
        ]);
      }
    });

    it("空の query・project なしでは semantic も fts も呼ばない（引数検査が先）", async () => {
      await setLegacyReadWorld({ projectId: "" });
      for (const [tool, params] of [
        ["search_codex", { query: "" }],
        ["search_codex", { query: "魔法" }],
        ["search_events", { query: "" }],
        ["search_events", { query: "魔術" }],
        ["search_scenes", { query: "アリア" }],
        ["search_snippets", { query: "老魔術師" }],
      ] as const) {
        await run(tool, params);
        expect(nativeCalls(), `${tool} ${JSON.stringify(params)}`).toEqual([]);
      }
    });

    it("workspace identity が無いと semantic は invoke の前に throw し、legacy は sparse（codex）／空（events）に退避する（Native は呼ばれない）", async () => {
      await setLegacyReadWorld(MAIN_S1);
      setCurrentWorkspaceIdentity(null);
      const codex = await run("search_codex", { query: "魔法" });
      expect(legacyReadInvokeBridge.calls("codex_semantic_search")).toEqual([]);
      expect((codex.content as Array<{ id: string }>).map((r) => r.id)).toEqual(
        ["c-aria", "c-mage", "c-item"],
      );
      const events = await run("search_events", { query: "魔術" });
      expect(legacyReadInvokeBridge.calls("events_semantic_search")).toEqual(
        [],
      );
      expect(events.content).toEqual([]);
    });

    it("事後の identity 照合：推論の最中に workspace が変わると結果を捨てる（codex は sparse だけ、events は空）", async () => {
      await setLegacyReadWorld(MAIN_S1);
      const original = getCurrentWorkspaceIdentity();
      expect(original).not.toBeNull();
      legacyReadInvokeBridge.reset();
      legacyReadInvokeBridge.override("codex_semantic_search", () => {
        setCurrentWorkspaceIdentity({
          path: LEGACY_READ_WORKSPACE_PATH,
          openRevision: 2,
        });
        return LEGACY_READ_CANNED_CODEX_HITS;
      });
      const codex = await executeTool("search_codex", "call-1", {
        query: "魔法",
      });
      // dense の hit（c-mage が先頭）は捨てられ、sparse の並びのまま。
      expect((codex.content as Array<{ id: string }>).map((r) => r.id)).toEqual(
        ["c-aria", "c-mage", "c-item"],
      );

      setLegacyReadWorkspaceIdentity();
      legacyReadInvokeBridge.reset();
      legacyReadInvokeBridge.override("events_semantic_search", () => {
        setCurrentWorkspaceIdentity({
          path: LEGACY_READ_WORKSPACE_PATH,
          openRevision: 2,
        });
        return LEGACY_READ_CANNED_EVENT_HITS;
      });
      const events = await executeTool("search_events", "call-1", {
        query: "魔術",
      });
      expect(events.content).toEqual([]);
    });
  });

  describe("foreshadow_list_open_for_context（Native の分岐）", () => {
    const nativePayload = {
      foreshadows: [
        {
          id: "fs-1",
          title: "老魔術師の杖",
          intent: "杖が後で鍵になる",
          loadBearing: "critical",
          version: 0,
          payoffConfirmed: false,
          abandoned: false,
          updatedAt: 1_767_225_600_000,
        },
        {
          id: "fs-5",
          title: "軽い伏線",
          intent: null,
          loadBearing: null,
          version: 0,
          payoffConfirmed: false,
          abandoned: false,
          updatedAt: 1_767_225_600_000,
        },
      ],
      setups: [
        {
          foreshadowId: "fs-1",
          sceneId: "n-s1",
          isOrphan: false,
          strength: null,
          aiStrength: "subtle",
        },
        {
          foreshadowId: "fs-1",
          sceneId: "n-s2",
          isOrphan: false,
          strength: "overt",
          aiStrength: null,
        },
      ],
    };

    it("Native の分岐（window.grimodex あり）では command='foreshadow_list_open_for_context'、引数は { projectId } だけ、DB は読まない。結果の整形は Drizzle の分岐と同じ", async () => {
      await setLegacyReadWorld(MAIN_S1);
      // Drizzle の分岐（browser-mock）の結果を先に取る。
      const drizzle = await run("list_open_foreshadows", {});
      expect(
        legacyReadInvokeBridge.calls("foreshadow_list_open_for_context"),
      ).toEqual([]);

      const holder = window as unknown as { grimodex?: unknown };
      holder.grimodex = {};
      try {
        legacyReadInvokeBridge.reset();
        legacyReadInvokeBridge.override(
          "foreshadow_list_open_for_context",
          () => nativePayload,
        );
        const native = await executeTool("list_open_foreshadows", "call-1", {});
        expect(
          legacyReadInvokeBridge.calls("foreshadow_list_open_for_context"),
        ).toEqual([
          {
            cmd: "foreshadow_list_open_for_context",
            args: { projectId: "p-main" },
          },
        ]);
        expect(legacyReadInvokeBridge.calls("db_execute")).toEqual([]);
        expect(JSON.stringify(native.content)).toBe(
          JSON.stringify(drizzle.content),
        );
        expect(native.summary).toBe(drizzle.summary);
      } finally {
        delete holder.grimodex;
      }
    });

    it("get_foreshadow_detail は Native の foreshadow command を呼ばない（Drizzle だけ）", async () => {
      await setLegacyReadWorld(MAIN_S1);
      await run("get_foreshadow_detail", { id: "fs-1" });
      expect(nativeCalls()).toEqual([]);
    });
  });

  describe("tool ごとの Native command の一覧（typed read は 4 本だけ）", () => {
    it("browser-mock では search_codex／search_events／search_scenes／search_snippets の 4 本だけが Native の command を呼び（foreshadow は Native の分岐でだけ。上で固定）、呼ぶ command と順序が下表どおり。残りの 16 本は db_execute だけ", async () => {
      await setLegacyReadWorld(MAIN_S3);
      const cases: Array<[string, Record<string, unknown>, string[]]> = [
        [
          "search_codex",
          { query: "老魔術師" },
          ["fts_search", "codex_semantic_search"],
        ],
        ["search_events", { query: "魔術" }, ["events_semantic_search"]],
        ["search_scenes", { query: "アリア" }, ["fts_search"]],
        ["search_snippets", { query: "老魔術師" }, ["fts_search"]],
        // browser-mock では Drizzle の分岐。Native の分岐は別の試験で固定した。
        ["list_open_foreshadows", {}, []],
        ["list_codex_by_type", { type: "character" }, []],
        ["list_codex_tags", {}, []],
        ["search_codex_by_tags", { tags: ["魔法"] }, []],
        ["find_related_entries", { id: "c-mage" }, []],
        ["list_chapters", {}, []],
        ["get_scene", { id: "n-s1" }, []],
        ["list_plot_threads", {}, []],
        ["get_thread_scenes", { threadId: "th-main" }, []],
        ["get_chapter_summaries", {}, []],
        ["get_foreshadow_detail", { id: "fs-1" }, []],
        ["get_scene_timeline_neighbors", { sceneId: "n-s3" }, []],
        ["list_events", {}, []],
        ["get_event_detail", { eventId: "ev-meet" }, []],
        ["get_character_timeline", { codexId: "c-aria" }, []],
        ["get_chronicle_state", {}, []],
      ];
      expect(cases).toHaveLength(20);
      for (const [tool, params, expected] of cases) {
        await run(tool, params);
        expect(
          nativeCalls().map((c) => c.cmd),
          tool,
        ).toEqual(expected);
      }
    });
  });

  describe("research sub-agent の経路（executeReadOnlyTool）は executeTool と同じ結果を返す", () => {
    it("M4 の 20 本について、同じ入力の JSON が byte 一致する（READ_ONLY_EXECUTORS と EXECUTORS の差は search_events の IR 版だけで、IR 閉の間は同じ）", async () => {
      const cases: Array<[string, Record<string, unknown>, LegacyReadWorld]> = [
        ["search_codex", { query: "魔法" }, MAIN_S1],
        ["search_events", { query: "魔術" }, MAIN_S3],
        ["list_codex_by_type", { type: "character" }, MAIN_S3],
        ["list_codex_tags", {}, MAIN_S1],
        ["search_codex_by_tags", { tags: ["魔法"] }, MAIN_S1],
        ["find_related_entries", { id: "c-mage" }, MAIN_S1],
        ["list_chapters", {}, MAIN_S1],
        ["get_scene", { id: "n-s1" }, MAIN_S1],
        ["search_scenes", { query: "魔法" }, MAIN_S1],
        ["search_snippets", { query: "魔法" }, MAIN_S1],
        ["get_chapter_summaries", {}, MAIN_S1],
        ["list_open_foreshadows", {}, MAIN_S1],
        ["get_foreshadow_detail", { id: "fs-1" }, MAIN_S1],
        ["get_scene_timeline_neighbors", { sceneId: "n-s3" }, MAIN_S1],
        ["list_plot_threads", {}, MAIN_S1],
        ["get_thread_scenes", { threadId: "th-main" }, MAIN_S1],
        ["list_events", {}, MAIN_S3],
        ["get_event_detail", { eventId: "ev-meet" }, MAIN_S3],
        ["get_character_timeline", { codexId: "c-aria" }, MAIN_S3],
        ["get_chronicle_state", {}, MAIN_S3],
        ["list_chapters", {}, OTHER],
      ];
      for (const [tool, params, world] of cases) {
        await setLegacyReadWorld(world);
        legacyReadInvokeBridge.reset();
        const main = await executeTool(tool, "call-1", params);
        await setLegacyReadWorld(world);
        legacyReadInvokeBridge.reset();
        const sub = await executeReadOnlyTool(tool, "call-1", params);
        expect(JSON.stringify(sub), tool).toBe(JSON.stringify(main));
      }
    });
  });
});

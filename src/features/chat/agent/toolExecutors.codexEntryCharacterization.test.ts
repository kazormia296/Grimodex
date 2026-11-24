// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** MP-4b 10b commit ①：共有 core 化の前の get_codex_entry の結果と読み取り順を固定する。 */
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

import { invoke } from "@/lib/tauri";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { executeTool } from "./toolExecutors";
import { CODEX_ENTRY_SEED } from "./__fixtures__/codexEntrySeed";
import { legacyReadInvokeBridge } from "./legacyReadInvokeBridge.testSupport";
import {
  bindLegacyReadHarnessPorts,
  seedLegacyReadFixture,
  setLegacyReadWorkspaceIdentity,
  setLegacyReadWorld,
  type LegacyReadWorld,
} from "./legacyReadHarness.testSupport";

bindLegacyReadHarnessPorts({
  executeRun: (sql, params) =>
    invoke("db_execute", { sql, params, method: "run" }),
  setTreeState: (state) => useTreeStore.setState(state),
  setPhaseState: (state) => usePhaseStore.setState(state),
});

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const MAIN_S1: LegacyReadWorld = { projectId: "p-main", activeSceneId: "n-s1" };
const MAIN_S2: LegacyReadWorld = { projectId: "p-main", activeSceneId: "n-s2" };
const GOLDEN = resolve(
  "src/features/chat/agent/__fixtures__/codexEntryGolden/get_codex_entry.golden.txt",
);
const READ_CALLS_GOLDEN = resolve(
  "src/features/chat/agent/__fixtures__/codexEntryGolden/get_codex_entry.reads.golden.txt",
);

type ToolResult = Awaited<ReturnType<typeof executeTool>>;
type Context = Parameters<typeof executeTool>[4];

async function seedCodexEntryFixture(): Promise<void> {
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

async function setWorld(world: LegacyReadWorld): Promise<void> {
  await setLegacyReadWorld(world);
  legacyReadInvokeBridge.reset();
}

const run = (id: unknown, context?: Context): Promise<ToolResult> =>
  executeTool("get_codex_entry", "call-1", { id }, undefined, context);

function selectCalls(): Array<{ sql: unknown; params: unknown }> {
  return legacyReadInvokeBridge
    .calls("db_execute")
    .map((call) => ({
      sql: call.args?.["sql"],
      params: call.args?.["params"],
    }))
    .filter((call) => /^select/iu.test(String(call.sql).trimStart()));
}

function resultJson(result: ToolResult): string {
  return JSON.stringify(result);
}

beforeAll(async () => {
  setLegacyReadWorkspaceIdentity();
  await seedLegacyReadFixture();
  await seedCodexEntryFixture();
});

beforeEach(() => {
  setLegacyReadWorkspaceIdentity();
  legacyReadInvokeBridge.reset();
});

describe("get_codex_entry の legacy 特性", () => {
  it("通常・released・aliases の結果 bytes を専用 golden に固定する", async () => {
    const cases: Array<{
      case: string;
      world: LegacyReadWorld;
      params: Record<string, unknown>;
      result: {
        name: string;
        summary: string;
        tokensUsed: number;
        content: unknown;
        error?: string;
      };
      contentJson: string;
    }> = [];

    for (const scenario of [
      { name: "通常", world: MAIN_S1, id: "ge-normal" },
      { name: "released", world: MAIN_S2, id: "ge-released-old" },
      {
        name: "released の現在 Phase",
        world: MAIN_S2,
        id: "ge-released-current",
      },
      { name: "非配列 aliases", world: MAIN_S1, id: "ge-alias-object" },
    ]) {
      await setWorld(scenario.world);
      const result = await run(scenario.id);
      cases.push({
        case: scenario.name,
        world: scenario.world,
        params: { id: scenario.id },
        result: {
          name: result.name,
          summary: result.summary,
          tokensUsed: result.tokensUsed,
          content: result.content,
          ...(result.error ? { error: result.error } : {}),
        },
        contentJson: JSON.stringify(result.content),
      });
    }

    const actual = `${JSON.stringify({ tool: "get_codex_entry", cases }, null, 2)}\n`;
    expect(actual).toBe(readFileSync(GOLDEN, "utf8"));
  });

  it("Q-C6-1 を直し、自 project の詳細だけを通常・released の details に含める", async () => {
    await setWorld(MAIN_S1);
    const result = await run("ge-normal");
    const content = result.content as {
      details: Array<{ field: string; value: string | null }>;
    };
    expect(content.details).toContainEqual({ field: "年齢", value: "18" });
    expect(content.details).not.toContainEqual({
      field: "別 project の項目名",
      value: null,
    });
    expect(content.details).not.toContainEqual({
      field: "AI に含めない詳細",
      value: "PRIVATE-VALUE",
    });
    expect(content.details.map((detail) => detail.field)).toEqual([
      "年齢",
      "秘密の詳細",
    ]);
    expect(content.details.map((detail) => detail.field)).not.toContain(
      "別 project の項目名",
    );
  });

  it("released は Phase 解決後の本文・要約・詳細を使い、null と非公開詳細を出さない", async () => {
    await setWorld(MAIN_S2);
    const result = await run("ge-released-old");
    const content = result.content as {
      summary: string;
      body: string;
      details: Array<{ field: string; value: string | null }>;
    };
    expect(content.summary).toBe("解除後の要約");
    expect(content.body).toBe("SECRET-PHASE-OLD");
    expect(content.details).toEqual([
      { field: "年齢", value: "Phase 解決後の年齢" },
      { field: "秘密の詳細", value: null },
    ]);
    expect(resultJson(result)).not.toContain("SECRET-BASE");
    expect(resultJson(result)).not.toContain("SECRET-PHASE-OLD-DETAIL");
    expect(resultJson(result)).not.toContain("PRIVATE-BASE-DETAIL");
  });

  it("hidden・存在しない entry・別 project の id は同じ not-found で、詳細の select に進まない", async () => {
    await setWorld(MAIN_S2);
    for (const id of ["ge-hidden", "missing-entry", "x-c-aria"]) {
      legacyReadInvokeBridge.reset();
      const result = await run(id);
      expect(result).toMatchObject({
        content: null,
        summary: "Entry not found",
        tokensUsed: 0,
      });
      const calls = selectCalls();
      expect(
        calls.some(({ sql }) =>
          String(sql).includes('"codex_detail_definitions"'),
        ),
      ).toBe(false);
      expect(
        calls.some(({ sql }) => String(sql).includes('"codex_detail_values"')),
      ).toBe(false);
      expect(
        calls.some(({ sql }) =>
          String(sql).includes('where "codex_entries"."parent_id"'),
        ),
      ).toBe(false);
      expect(calls).toHaveLength(id === "ge-hidden" ? 3 : 1);
      expect(
        calls.some(({ sql }) => String(sql).includes('"codex_entry_phases"')),
      ).toBe(id === "ge-hidden");
    }
  });

  it("空 id は project 未選択より先に返し、scope の projectId は store を補わない", async () => {
    await setWorld({ projectId: "" });
    const empty = await run("  ", {
      scope: { projectId: "p-main", currentSceneId: "n-s2" },
    } as Context);
    expect(empty).toMatchObject({
      content: null,
      summary: "No id provided",
      tokensUsed: 0,
    });
    expect(selectCalls()).toEqual([]);

    const noProject = await run("ge-normal", {
      scope: { projectId: "p-main", currentSceneId: "n-s2" },
    } as Context);
    expect(noProject).toMatchObject({
      content: null,
      summary: "No active project",
      tokensUsed: 0,
    });
    expect(selectCalls()).toEqual([]);
  });

  it("壊れた aliases の JSON は tool error にする", async () => {
    await setWorld(MAIN_S1);
    const result = await run("ge-malformed");
    expect(result.content).toBeNull();
    expect(result.summary).toMatch(/^Error: /u);
    expect(result.error).toMatch(/JSON/u);
    expect(result.tokensUsed).toBe(0);
  });

  it("各 resolution mode で hidden の本文を閉じ、released と孤児 Phase の境界を固定する", async () => {
    const modes = ["reading", "story", "auto"] as const;
    const matrix = [
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
        await setWorld({
          projectId: "p-main",
          activeSceneId: scenario.sceneId,
          resolutionMode: mode,
        });
        const result = await run(scenario.id);
        const json = resultJson(result);
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
        expect(json).not.toContain("SECRET-PHASE-PUBLIC");
        expect(json).not.toContain("SECRET-PHASE-ORPHAN");
        if (scenario.marker) expect(json).toContain(scenario.marker);
        if (scenario.label === "released")
          expect(json).not.toContain("SECRET-BASE");
        if (scenario.label === "base 公開・Phase に本文上書き") {
          expect(json).not.toContain("SECRET-PHASE-PUBLIC");
        }
      }
    }
  });

  it("reading・story・auto の mode によって Phase の場面順の解釈を保つ", async () => {
    const expected = new Map([
      ["reading", "Entry not found"],
      ["story", "mode 判定 (character)"],
      ["auto", "Entry not found"],
    ]);
    for (const [resolutionMode, summary] of expected) {
      await setWorld({
        ...MAIN_S2,
        resolutionMode: resolutionMode as "reading" | "story" | "auto",
      });
      const result = await run("ge-mode");
      expect(result.summary, resolutionMode).toBe(summary);
      if (resolutionMode === "story") {
        expect(resultJson(result)).toContain("MODE-PHASE");
        expect(resultJson(result)).not.toContain("SECRET-BASE-MODE");
      }
    }
  });

  it("scope の場面を使い、projectId は scope ではなく store から読む", async () => {
    await setWorld(MAIN_S1);
    const spy = vi.spyOn(useTreeStore, "getState");
    try {
      const result = await run("ge-released-old", {
        scope: { projectId: "p-other", currentSceneId: "n-s2" },
      } as Context);
      expect((result.content as { id: string }).id).toBe("ge-released-old");
      expect(result.summary).toBe("解除される項目 (character)");
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("scope がないと場面を 2 回読む。details の読みの間の切替は children の判定にだけ反映する", async () => {
    await setWorld(MAIN_S1);
    const control = await run("ge-scene-parent");
    expect(
      (control.content as { children: Array<{ id: string }> }).children.map(
        (c) => c.id,
      ),
    ).toEqual(["ge-scene-child"]);

    await setWorld(MAIN_S1);
    let switched = false;
    legacyReadInvokeBridge.setOnCall(({ cmd, args }) => {
      if (
        !switched &&
        cmd === "db_execute" &&
        String(args?.["sql"]).includes('from "codex_detail_definitions"')
      ) {
        switched = true;
        useTreeStore.setState({ activeSceneId: "n-s2" });
      }
    });
    const spy = vi.spyOn(useTreeStore, "getState");
    try {
      const result = await run("ge-scene-parent");
      expect(switched).toBe(true);
      expect(spy).toHaveBeenCalledTimes(3);
      expect(
        (result.content as { children: Array<{ id: string }> }).children,
      ).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("判定中の entries／phases の読みで epoch が変わると not-found、details の読みなら検査しない", async () => {
    for (const table of ["codex_entries", "codex_entry_phases"]) {
      await setWorld(MAIN_S2);
      let seenEntries = 0;
      legacyReadInvokeBridge.setOnCall(({ cmd, args }) => {
        if (cmd !== "db_execute") return;
        const sql = String(args?.["sql"]);
        if (table === "codex_entries" && sql.includes('from "codex_entries"')) {
          seenEntries += 1;
          if (seenEntries === 2) usePhaseStore.getState().resetForProject();
        }
        if (
          table === "codex_entry_phases" &&
          sql.includes('from "codex_entry_phases"')
        ) {
          usePhaseStore.getState().resetForProject();
        }
      });
      const result = await run("ge-released-old");
      expect(result.summary, table).toBe("Entry not found");
      expect(result.content, table).toBeNull();
    }

    await setWorld(MAIN_S2);
    legacyReadInvokeBridge.setOnCall(({ cmd, args }) => {
      if (
        cmd === "db_execute" &&
        String(args?.["sql"]).includes('from "codex_detail_definitions"')
      ) {
        usePhaseStore.getState().resetForProject();
      }
    });
    const afterDecision = await run("ge-released-old");
    expect((afterDecision.content as { body: string }).body).toBe(
      "SECRET-PHASE-OLD",
    );
    expect(afterDecision.summary).toBe("解除される項目 (character)");
  });

  it("通常・released・hidden・不在の SQL 文と列順を専用 fixture に固定する", async () => {
    const captures: Record<string, ReturnType<typeof selectCalls>> = {};
    for (const scenario of [
      { name: "normal", world: MAIN_S1, id: "ge-normal" },
      { name: "released", world: MAIN_S2, id: "ge-released-old" },
      { name: "hidden", world: MAIN_S2, id: "ge-hidden" },
      { name: "missing", world: MAIN_S2, id: "missing-entry" },
    ]) {
      await setWorld(scenario.world);
      await run(scenario.id);
      captures[scenario.name] = selectCalls();
    }
    const expected = JSON.parse(
      readFileSync(READ_CALLS_GOLDEN, "utf8"),
    ) as typeof captures;
    expect(captures).toEqual(expected);
    for (const name of ["normal", "released"]) {
      const unorderedQueries = captures[name]?.filter(({ sql }) =>
        /from "codex_detail_definitions"|from "codex_detail_values"|where "codex_entries"\."parent_id"/iu.test(
          String(sql),
        ),
      );
      expect(
        unorderedQueries?.every(
          ({ sql }) => !/\border by\b/iu.test(String(sql)),
        ),
      ).toBe(true);
    }
  });

  it("resolveCodexForAi の全 id 不在時は phases を読まない", async () => {
    const raceRow = CODEX_ENTRY_SEED.find(
      (table) => table.table === "codex_entries",
    )!.rows.find((row) => row["id"] === "ge-race")!;
    await setWorld(MAIN_S1);
    let entrySelects = 0;
    legacyReadInvokeBridge.setOnCall(async ({ cmd, args }) => {
      if (
        cmd !== "db_execute" ||
        !String(args?.["sql"]).includes('from "codex_entries"')
      ) {
        return;
      }
      entrySelects += 1;
      if (entrySelects === 2) {
        await invoke("db_execute", {
          sql: "DELETE FROM codex_entries WHERE id = ?",
          params: ["ge-race"],
          method: "run",
        });
      }
    });
    const result = await run("ge-race");
    expect(result.summary).toBe("Entry not found");
    expect(selectCalls()).toHaveLength(2);
    expect(
      selectCalls().some(({ sql }) =>
        String(sql).includes('"codex_entry_phases"'),
      ),
    ).toBe(false);

    const columns = Object.keys(raceRow);
    await invoke("db_execute", {
      sql: `INSERT INTO codex_entries (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      params: columns.map((column) => raceRow[column]),
      method: "run",
    });
    legacyReadInvokeBridge.reset();
  });
});

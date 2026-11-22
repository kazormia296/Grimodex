// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * search_scenes の FTS の arm：archived の行が上位の枠を使わないこと。
 *
 * 外部 Markdown の重複で archived になった行は、生きている行と同じ本文を持つので FTS の上位に並ぶ。
 * fts_search を Rust の上限（50）まで多めに取り、archived を Drizzle で落として元の FTS の順に並べ、
 * その後に 10 件へ切る。`fts_search` は canned の hit（archived が上位）を返し、
 * Native に渡す limit が 50 であることも固定する。
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

import { invoke } from "@/lib/tauri";
import { useTreeStore } from "@/features/tree/treeStore";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { executeTool } from "./toolExecutors";
import { legacyReadInvokeBridge } from "./legacyReadInvokeBridge.testSupport";
import {
  bindLegacyReadHarnessPorts,
  seedLegacyReadFixture,
  setLegacyReadWorkspaceIdentity,
  setLegacyReadWorld,
} from "./legacyReadHarness.testSupport";
import { pmDoc } from "./__fixtures__/legacyReadSeed";

bindLegacyReadHarnessPorts({
  executeRun: (sql, params) =>
    invoke("db_execute", { sql, params, method: "run" }),
  setTreeState: (state) => useTreeStore.setState(state),
  setPhaseState: (state) => usePhaseStore.setState(state),
});

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const T0 = "2026-01-01T00:00:00.000Z";
const QUERY = "重複本文";

async function insertScene(id: string, archived: boolean, order: number) {
  await invoke("db_execute", {
    sql: "INSERT INTO tree_nodes (id, project_id, parent_id, node_type, title, sort_order, content, archived_at, created_at, updated_at) VALUES (?, 'p-main', NULL, 'scene', ?, ?, ?, ?, ?, ?)",
    params: [
      id,
      `重複 ${id}`,
      `z${String(order).padStart(3, "0")}`,
      pmDoc(`${QUERY}（${id}）`),
      archived ? "2026-02-01T00:00:00.000Z" : null,
      T0,
      T0,
    ],
    method: "run",
  });
}

const hit = (id: string) => ({ sourceType: "scene", id });

async function search() {
  await setLegacyReadWorld({ projectId: "p-main", activeSceneId: "n-s1" });
  legacyReadInvokeBridge.reset();
  legacyReadInvokeBridge.override("fts_search", () => ftsHits);
  const result = await executeTool("search_scenes", "call-1", {
    query: QUERY,
  });
  const ftsCalls = legacyReadInvokeBridge.calls("fts_search");
  legacyReadInvokeBridge.reset();
  return { result, ftsCalls };
}

let ftsHits: Array<{ sourceType: string; id: string }> = [];

describe("search_scenes：FTS の arm は archived を落とした後に 10 件へ切る", () => {
  beforeAll(async () => {
    await seedLegacyReadFixture();
    // 12 件の archived（FTS の上位）と、その後ろの 3 件の live。
    for (let i = 1; i <= 12; i++) await insertScene(`dup-a${i}`, true, i);
    for (let i = 1; i <= 3; i++) await insertScene(`dup-l${i}`, false, 100 + i);
    // live が 12 件ある側（10 件への切り詰めと元の FTS の順の確認）。
    for (let i = 1; i <= 12; i++)
      await insertScene(`many-l${i}`, false, 200 + i);
    for (let i = 1; i <= 2; i++) await insertScene(`many-a${i}`, true, 300 + i);
  });

  beforeEach(() => {
    setLegacyReadWorkspaceIdentity();
    legacyReadInvokeBridge.reset();
  });

  it("archived が上位 10 件を占めても、live の 3 件が FTS の順で出る（Native に渡す limit は 50）", async () => {
    ftsHits = [
      ...Array.from({ length: 12 }, (_, i) => hit(`dup-a${i + 1}`)),
      ...Array.from({ length: 3 }, (_, i) => hit(`dup-l${i + 1}`)),
    ];
    const { result, ftsCalls } = await search();
    expect((result.content as Array<{ id: string }>).map((r) => r.id)).toEqual([
      "dup-l1",
      "dup-l2",
      "dup-l3",
    ]);
    expect(result.summary).toBe("3 scenes found");
    expect(ftsCalls).toEqual([
      {
        cmd: "fts_search",
        args: {
          projectId: "p-main",
          query: QUERY,
          scope: "scenes",
          limit: 50,
        },
      },
    ]);
  });

  it("live が 10 件を超えるときは、archived を除いた元の FTS の順で 10 件に切る", async () => {
    ftsHits = [
      hit("many-a1"),
      ...Array.from({ length: 6 }, (_, i) => hit(`many-l${i + 1}`)),
      hit("many-a2"),
      ...Array.from({ length: 6 }, (_, i) => hit(`many-l${i + 7}`)),
    ];
    const { result } = await search();
    expect((result.content as Array<{ id: string }>).map((r) => r.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `many-l${i + 1}`),
    );
    expect(result.summary).toBe("10 scenes found");
  });
});

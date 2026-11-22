// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * MP-4b PR-6：main が DB の行から作り直す hidden・年表 secret の入力（DR-MP4-8）と、
 * renderer の store の値の parity。
 *
 * 同じ seed（PR-0 の `legacyReadSeed.ts`）を実 sql.js（browser-mock）に入れ、
 * - renderer 側：`setLegacyReadWorld` が tree store の `nodes`（`listNodes`＝archived 除外）と phase store の
 *   `sceneTimeIndex`（`buildSceneTimeIndex(nodes)`）を作る。それを読む。
 * - main 側：`readReadInputs`（Drizzle の select 2 本）に、`db_execute` を包んだ client を渡す。client は
 *   `createMainReadDb` と同じく、送る前に `checkReadSql`（表の allowlist 付き）と method を検査する。
 * を比べる。buildReadingOrder／buildSceneTimeIndex は両側で同じ関数なので、**比べる価値があるのは行の段**
 * （project 条件・archived 除外・6 列の写し）。そのため map だけでなく、reader が返す行の集合も
 * renderer の `listNodes` の集合と照合する。
 *
 * 覆わない範囲：Chromium と Electron main の `localeCompare` の一致（K-4。ここは Node の既定 locale だけ）、
 * 実 addon（Native）での同値（PR-9）、DB が古いときの store とのずれ（Q5）。
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

import { invoke } from "@/lib/tauri";
import { useTreeStore } from "@/features/tree/treeStore";
import { usePhaseStore } from "@/features/codex/phaseStore";
import {
  buildReadingOrder,
  buildSceneTimeIndex,
} from "@/features/codex/context/sceneTimeIndex";
import { createCoreReadDb } from "@/../electron/shared/readDomain/core/readDb";
import {
  readProjectModeRow,
  readReadInputs,
  readTreeRows,
} from "@/../electron/shared/readDomain/core/readInputsReader";
import type { CoreReadDbClient } from "@/../electron/shared/mastraRead/ports";
import { checkReadSql } from "@/../electron/shared/mastraRead/sql";
import { MAIN_READ_TABLE_SET } from "@/../electron/shared/mastraRead/tables";
import {
  bindLegacyReadHarnessPorts,
  seedLegacyReadFixture,
  setLegacyReadWorld,
} from "./legacyReadHarness.testSupport";

bindLegacyReadHarnessPorts({
  executeRun: (sql, params) =>
    invoke("db_execute", { sql, params, method: "run" }),
  setTreeState: (state) => useTreeStore.setState(state),
  setPhaseState: (state) => usePhaseStore.setState(state),
});

const sent: { sql: string; method: string }[] = [];

/** `createMainReadDb` と同じ送信前の検査を通す client（Native の代わりに sql.js）。 */
const mainClient: CoreReadDbClient = async (sql, params, method) => {
  const checked = checkReadSql(sql, MAIN_READ_TABLE_SET);
  if (!checked.ok) throw new Error(`refused before send: ${checked.code}`);
  if (method !== "all" && method !== "values") {
    throw new Error(`refused before send: method ${method}`);
  }
  sent.push({ sql, method });
  const result = (await invoke("db_execute", { sql, params, method })) as {
    rows: Record<string, unknown>[];
  };
  return { rows: result.rows.map((r) => Object.values(r)) };
};

const run = (sql: string, params: unknown[]) =>
  invoke("db_execute", { sql, params, method: "run" });

const T0 = "2026-01-01T00:00:00.000Z";

/**
 * seed の兄弟は sortOrder がすべて別なので、同順位の兄弟（id で決まる）・入れ子の folder・
 * story の鍵を持つ場面を持つ project を足す。id は小文字の hex とハイフンだけ
 * （大文字や `_` は locale で並びが変わりうる。K-4）。
 */
async function seedTieProject(): Promise<void> {
  await run(
    "INSERT INTO projects (id, title, language, phase_resolution_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ["p-tie", "同順位project", "ja", "story", T0, T0],
  );
  const node = (
    id: string,
    parentId: string | null,
    nodeType: string,
    sortOrder: string,
    storyTimeOrder: string | null = null,
  ) =>
    run(
      "INSERT INTO tree_nodes (id, project_id, parent_id, node_type, title, sort_order, story_time_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, "p-tie", parentId, nodeType, id, sortOrder, storyTimeOrder, T0, T0],
    );
  await node("t-part", null, "folder", "a0");
  await node("t-ch-b", "t-part", "folder", "a0");
  await node("t-ch-a", "t-part", "folder", "a0");
  await node("t-0b7e-3", "t-ch-b", "scene", "a0", "a5");
  await node("t-0a11-9", "t-ch-b", "scene", "a0", "a1");
  await node("t-0a11-10", "t-ch-b", "scene", "a0");
  await node("t-f003-1", "t-ch-a", "scene", "a0", "a3");
  await node("t-root-b", null, "scene", "a1");
  await node("t-root-a", null, "scene", "a1", "a2");
}

const PROJECTS = ["p-main", "p-other", "p-empty", "p-big", "p-tie"] as const;

const sixColumns = (n: {
  id: string;
  parentId: string | null;
  nodeType: string;
  sortOrder: string;
  storyTimeOrder?: string | null;
  archivedAt?: string | null;
}) => ({
  id: n.id,
  parentId: n.parentId ?? null,
  nodeType: n.nodeType,
  sortOrder: n.sortOrder,
  storyTimeOrder: n.storyTimeOrder ?? null,
  archivedAt: n.archivedAt ?? null,
});

const entries = <K, V>(m: ReadonlyMap<K, V>) => [...m.entries()];

beforeAll(async () => {
  await seedLegacyReadFixture();
  await seedTieProject();
});

describe("main's rebuilt inputs equal the renderer store's, project by project", () => {
  it.each(PROJECTS)("%s", async (projectId) => {
    await setLegacyReadWorld({ projectId });
    const storeNodes = useTreeStore.getState().nodes;
    const storeIndex = usePhaseStore.getState().sceneTimeIndex;

    // 行の段：reader が選ぶ行は listNodes（renderer の nodes）と同じ集合・同じ 6 列。
    const rows = await readTreeRows(createCoreReadDb(mainClient), projectId);
    expect(rows.map((r) => r.id).sort()).toEqual(
      storeNodes.map((n) => n.id).sort(),
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const node of storeNodes) {
      expect(byId.get(node.id)).toEqual(sixColumns(node));
    }
    expect(rows.every((r) => r.archivedAt === null)).toBe(true);

    // 値の段：map の中身と挿入順（DFS の順）、数、revision。
    const inputs = await readReadInputs(createCoreReadDb(mainClient), {
      projectId,
      currentSceneId: null,
    });
    expect(entries(inputs.readingOrder)).toEqual(
      entries(buildReadingOrder(storeNodes)),
    );
    expect(entries(inputs.sceneTimeIndex.readingOrder)).toEqual(
      entries(storeIndex.readingOrder),
    );
    expect(entries(inputs.sceneTimeIndex.explicitStoryOrder)).toEqual(
      entries(storeIndex.explicitStoryOrder),
    );
    expect(entries(inputs.sceneTimeIndex.inheritedStoryOrder)).toEqual(
      entries(storeIndex.inheritedStoryOrder),
    );
    expect(inputs.sceneTimeIndex.liveSceneCount).toBe(
      storeIndex.liveSceneCount,
    );
    expect(inputs.sceneTimeIndex.scheduledSceneCount).toBe(
      storeIndex.scheduledSceneCount,
    );
    expect(inputs.sceneTimeIndex.revision).toBe(storeIndex.revision);
    expect(inputs.resolutionMode).toEqual({
      kind: "resolved",
      mode: expect.stringMatching(/^(reading|story|auto)$/u),
    });
  });

  it("the seed has the shapes this parity is meant to cover", async () => {
    await setLegacyReadWorld({ projectId: "p-main" });
    const nodes = useTreeStore.getState().nodes;
    // 入れ子の folder（部＞章＞場面）、note、行単位で live だが祖先が archived の場面。
    expect(nodes.some((n) => n.parentId === "n-ch1")).toBe(true);
    expect(nodes.some((n) => n.nodeType === "note")).toBe(true);
    expect(nodes.some((n) => n.id === "n-s5")).toBe(true);
    // archived の行は renderer の nodes にも reader の行にも無い。
    expect(nodes.some((n) => n.id === "n-arch")).toBe(false);
    const rows = await readTreeRows(createCoreReadDb(mainClient), "p-main");
    expect(rows.some((r) => r.id === "n-arch" || r.id === "n-part2")).toBe(
      false,
    );
    // 同順位の兄弟（p-tie）。DFS の中で id の localeCompare が効く。
    await setLegacyReadWorld({ projectId: "p-tie" });
    const tie = [...useTreeStore.getState().nodes]
      .filter((n) => n.parentId === "t-ch-b")
      .map((n) => n.sortOrder);
    expect(new Set(tie).size).toBe(1);
    const inputs = await readReadInputs(createCoreReadDb(mainClient), {
      projectId: "p-tie",
      currentSceneId: null,
    });
    // 同順位の章は id で決まり（t-ch-a が t-ch-b の前）、章の中の場面も id で決まる。
    expect([...inputs.readingOrder.keys()]).toEqual([
      "t-f003-1",
      "t-0a11-10",
      "t-0a11-9",
      "t-0b7e-3",
      "t-root-a",
      "t-root-b",
    ]);
  });

  it("every statement sent passed the pre-send check, as `all`, and named only the two tables", () => {
    expect(sent.length).toBeGreaterThan(0);
    for (const call of sent) {
      expect(call.method).toBe("all");
      const checked = checkReadSql(call.sql, MAIN_READ_TABLE_SET);
      expect(checked.ok).toBe(true);
      if (checked.ok) {
        expect(["tree_nodes", "projects"]).toContain(checked.tables[0]);
        expect(checked.tables).toHaveLength(1);
      }
    }
  });
});

describe("the current scene is null unless it is a live scene of the project's reading order", () => {
  it.each([
    // 他 project の場面（main と同じ題名の場面を持つ project）
    ["p-main", "x-s1", null],
    ["p-main", "x-s2", null],
    ["p-other", "n-s1", null],
    // 存在しない、空
    ["p-main", "no-such-scene", null],
    ["p-main", "", null],
    // archived の場面、archived の folder
    ["p-main", "n-arch", null],
    ["p-main", "n-part2", null],
    // live の行だが祖先が archived の場面（読む順に入らない）
    ["p-main", "n-s5", null],
    // folder、note
    ["p-main", "n-ch1", null],
    ["p-main", "n-note1", null],
    // 正しい場面
    ["p-main", "n-s1", "n-s1"],
    ["p-main", "n-s4", "n-s4"],
    ["p-other", "x-s2", "x-s2"],
    // project が無い
    ["p-nonexistent", "n-s1", null],
  ])("%s / %j -> %j", async (projectId, sceneId, expected) => {
    const inputs = await readReadInputs(createCoreReadDb(mainClient), {
      projectId,
      currentSceneId: sceneId,
    });
    expect(inputs.currentSceneId).toBe(expected);
    if (expected !== null) {
      // renderer の chronicle も読む順にあるかで同じ判定をする（`isEventHiddenFromAi`）。
      await setLegacyReadWorld({ projectId, activeSceneId: sceneId });
      expect(
        usePhaseStore.getState().sceneTimeIndex.readingOrder.has(sceneId),
      ).toBe(true);
    }
  });

  it("agrees with the renderer's reading order on whether each id is in it", async () => {
    await setLegacyReadWorld({ projectId: "p-main" });
    const storeOrder = buildSceneTimeIndex(
      useTreeStore.getState().nodes,
    ).readingOrder;
    for (const id of [
      "n-s1",
      "n-s5",
      "n-arch",
      "n-ch1",
      "n-note1",
      "x-s1",
      "",
    ]) {
      const inputs = await readReadInputs(createCoreReadDb(mainClient), {
        projectId: "p-main",
        currentSceneId: id,
      });
      expect(inputs.currentSceneId !== null).toBe(storeOrder.has(id));
    }
  });
});

describe("the resolution mode", () => {
  it("is the value the project row holds, and follows an update", async () => {
    for (const mode of ["story", "auto", "reading"] as const) {
      await run("UPDATE projects SET phase_resolution_mode = ? WHERE id = ?", [
        mode,
        "p-main",
      ]);
      expect(
        await readProjectModeRow(createCoreReadDb(mainClient), "p-main"),
      ).toEqual({
        phaseResolutionMode: mode,
      });
      const inputs = await readReadInputs(createCoreReadDb(mainClient), {
        projectId: "p-main",
        currentSceneId: null,
      });
      expect(inputs.resolutionMode).toEqual({ kind: "resolved", mode });
    }
  });

  it("is unresolved (not `reading`, not `auto`) for a project with no row", async () => {
    const inputs = await readReadInputs(createCoreReadDb(mainClient), {
      projectId: "p-nonexistent",
      currentSceneId: null,
    });
    expect(inputs.resolutionMode).toEqual({
      kind: "unresolved",
      reason: "project-missing",
    });
    expect(inputs.readingOrder.size).toBe(0);
  });

  it("cannot hold a null or an unknown value in the database (NOT NULL, CHECK)", async () => {
    // `unresolved` for these is for a schema drift or an outside writer; the
    // column refuses them, so the legacy carry-over (`projectRuntimeComposition`
    // skips a falsy mode and keeps the previous project's) has no DB-level source.
    await expect(
      run("UPDATE projects SET phase_resolution_mode = NULL WHERE id = ?", [
        "p-main",
      ]),
    ).rejects.toThrow();
    await expect(
      run("UPDATE projects SET phase_resolution_mode = 'weird' WHERE id = ?", [
        "p-main",
      ]),
    ).rejects.toThrow();
  });
});

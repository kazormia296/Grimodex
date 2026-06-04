// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AiTreePlan, CreateOp } from "./types";
import type { NodePlacement } from "./placement";
import { createBrowserMock } from "@/lib/browser-mock";

const h = vi.hoisted(() => ({
  nodes: [] as unknown[],
  reloadImpl: vi.fn().mockResolvedValue(undefined),
  closeTab: vi.fn(),
  closeSecondaryTab: vi.fn(),
  pushed: undefined as
    | { undo: () => Promise<void>; redo: () => Promise<void> }
    | undefined,
  isReplaying: false,
}));

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn().mockResolvedValue({}) }));
vi.mock("../treeStore", () => ({
  useTreeStore: {
    getState: () => ({ nodes: h.nodes, reloadTreeOrThrow: h.reloadImpl }),
  },
}));
vi.mock("@/features/editor/tabStore", () => ({
  useTabStore: {
    getState: () => ({
      closeTab: h.closeTab,
      closeSecondaryTab: h.closeSecondaryTab,
    }),
  },
}));
vi.mock("@/features/timelapse/recorder", () => ({
  recordChangeEvent: vi.fn(),
}));
vi.mock("@/store/globalHistoryStore", () => ({
  useGlobalHistoryStore: {
    getState: () => ({
      isReplaying: h.isReplaying,
      push: (cmd: { undo: () => Promise<void>; redo: () => Promise<void> }) => {
        h.pushed = cmd;
      },
    }),
  },
}));

import { buildForwardStatements, buildUndoStatements } from "./applyPlan";

const PROJECT_ID = "default-project";

let mock: Awaited<ReturnType<typeof createBrowserMock>>;

beforeEach(async () => {
  mock = await createBrowserMock();
});

async function seedKeepScene(): Promise<void> {
  const now = new Date().toISOString();
  await mock.invoke("db_execute_batch", {
    statements: [
      {
        sql: "INSERT INTO tree_nodes (id, project_id, parent_id, node_type, title, sort_order, created_at, updated_at) VALUES (?, ?, NULL, 'scene', 'Keep', 'a0', ?, ?)",
        params: ["sc-keep", PROJECT_ID, now, now],
        method: "run",
      },
    ],
  });
}

async function rows(
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  const result = await mock.invoke<{ rows: Record<string, unknown>[] }>(
    "db_execute",
    { sql, params, method: "all" },
  );
  return result.rows;
}

function groupFixture(): {
  plan: AiTreePlan;
  orderedCreates: CreateOp[];
  idMap: Map<string, string>;
  placements: Map<string, NodePlacement>;
  beforeStates: {
    id: string;
    parentId: string | null;
    sortOrder: string;
    title: string;
  }[];
  createdIdsTopo: string[];
} {
  const createOp: CreateOp = {
    op: "create",
    tempId: "tmp:g",
    parentRef: null,
    nodeType: "folder",
    title: "G",
  };
  const plan: AiTreePlan = {
    kind: "reorganize",
    ops: [createOp, { op: "move", nodeId: "sc-keep", newParentRef: "tmp:g" }],
  };
  return {
    plan,
    orderedCreates: [createOp],
    idMap: new Map([["tmp:g", "g-new"]]),
    placements: new Map([
      ["g-new", { parentId: null, sortOrder: "a1" }],
      ["sc-keep", { parentId: "g-new", sortOrder: "a0" }],
    ]),
    beforeStates: [
      { id: "sc-keep", parentId: null, sortOrder: "a0", title: "Keep" },
    ],
    createdIdsTopo: ["g-new"],
  };
}

describe("applyPlan drizzle SQL on real SQLite (browser-mock)", () => {
  it("cascade-safe undo preserves existing scene (drizzle forward + undo)", async () => {
    await seedKeepScene();
    const fx = groupFixture();

    const forward = buildForwardStatements(
      fx.plan,
      fx.orderedCreates,
      fx.idMap,
      fx.placements,
      PROJECT_ID,
    );
    await mock.invoke("db_execute_batch", { statements: forward });

    const mid = await rows("SELECT parent_id FROM tree_nodes WHERE id = ?", [
      "sc-keep",
    ]);
    expect(mid).toHaveLength(1);
    expect(mid[0].parent_id).toBe("g-new");

    const undo = buildUndoStatements(
      fx.beforeStates,
      fx.createdIdsTopo,
      PROJECT_ID,
    );
    await mock.invoke("db_execute_batch", { statements: undo });

    const keep = await rows("SELECT parent_id FROM tree_nodes WHERE id = ?", [
      "sc-keep",
    ]);
    expect(keep).toHaveLength(1);
    expect(keep[0].parent_id).toBeNull();

    const gone = await rows("SELECT id FROM tree_nodes WHERE id = ?", [
      "g-new",
    ]);
    expect(gone).toHaveLength(0);
  });

  it("negative control: naive delete-first undo cascade-deletes existing scene", async () => {
    await seedKeepScene();
    const fx = groupFixture();

    const forward = buildForwardStatements(
      fx.plan,
      fx.orderedCreates,
      fx.idMap,
      fx.placements,
      PROJECT_ID,
    );
    await mock.invoke("db_execute_batch", { statements: forward });

    const naive = [
      {
        sql: "DELETE FROM tree_nodes WHERE id = ?",
        params: ["g-new"],
        method: "run",
      },
      {
        sql: "UPDATE tree_nodes SET parent_id = NULL WHERE id = ?",
        params: ["sc-keep"],
        method: "run",
      },
    ];
    await mock.invoke("db_execute_batch", { statements: naive });

    const keep = await rows("SELECT id FROM tree_nodes WHERE id = ?", [
      "sc-keep",
    ]);
    expect(keep).toHaveLength(0);
  });

  it("drift guard: omitted NOT NULL columns fall back to DB defaults on create", async () => {
    const createOp: CreateOp = {
      op: "create",
      tempId: "tmp:g",
      parentRef: null,
      nodeType: "folder",
      title: "G",
    };
    const plan: AiTreePlan = {
      kind: "scaffold",
      ops: [createOp],
    };
    const forward = buildForwardStatements(
      plan,
      [createOp],
      new Map([["tmp:g", "g-new"]]),
      new Map([["g-new", { parentId: null, sortOrder: "a1" }]]),
      PROJECT_ID,
    );
    await mock.invoke("db_execute_batch", { statements: forward });

    const row = await rows(
      "SELECT content, unplaced_beats_doc, char_count, synopsis FROM tree_nodes WHERE id = ?",
      ["g-new"],
    );
    expect(row).toHaveLength(1);
    expect(row[0].content).toBe("{}");
    expect(row[0].unplaced_beats_doc).toBe("[]");
    expect(row[0].char_count).toBe(0);
    // synopsis 省略アーム: INSERT に列が出ず DB default(NULL)に倒れる。
    expect(row[0].synopsis).toBeNull();
  });

  it("drift guard: synopsis-present create writes the synopsis column", async () => {
    // c.synopsis != null アーム: INSERT の列集合が動的に増える経路を実 SQLite で gate。
    const createOp: CreateOp = {
      op: "create",
      tempId: "tmp:g",
      parentRef: null,
      nodeType: "folder",
      title: "G",
      synopsis: "起承転結の承",
    };
    const plan: AiTreePlan = {
      kind: "scaffold",
      ops: [createOp],
    };
    const forward = buildForwardStatements(
      plan,
      [createOp],
      new Map([["tmp:g", "g-new"]]),
      new Map([["g-new", { parentId: null, sortOrder: "a1" }]]),
      PROJECT_ID,
    );
    await mock.invoke("db_execute_batch", { statements: forward });

    const row = await rows("SELECT synopsis FROM tree_nodes WHERE id = ?", [
      "g-new",
    ]);
    expect(row).toHaveLength(1);
    expect(row[0].synopsis).toBe("起承転結の承");
  });
});

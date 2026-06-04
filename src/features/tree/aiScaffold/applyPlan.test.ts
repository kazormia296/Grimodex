import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import {
  buildForwardStatements,
  buildUndoStatements,
  applyAiTreePlan,
  AiTreePlanError,
} from "./applyPlan";
import type { NodePlacement } from "./placement";
import type { AiTreePlan, ApplyContext, CreateOp } from "./types";
import type { TreeNodeData, NodeType } from "../treeStore";

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

import { invoke } from "@/lib/tauri";
import { recordChangeEvent } from "@/features/timelapse/recorder";

function mkNode(p: {
  id: string;
  nodeType: NodeType;
  parentId: string | null;
  sortOrder: string;
}): TreeNodeData {
  return {
    projectId: "proj-1",
    title: p.id,
    synopsis: null,
    status: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    charCount: 0,
    sourceUri: null,
    sourceMtime: null,
    archivedAt: null,
    contextMode: null,
    aliases: null,
    excludedAliases: null,
    createdAt: "t",
    updatedAt: "t",
    ...p,
  };
}

const ctx = (scopeOverride?: Partial<ApplyContext["scope"]>): ApplyContext => ({
  projectId: "proj-1",
  source: "ai",
  model: "test-model",
  traceId: "trace-1",
  scope: {
    allowedOps: ["create", "move", "rename"],
    rootRef: null,
    editableIds: new Set(["x1", "x2"]),
    ...scopeOverride,
  },
});

const sqlKind = (s: string) => s.trim().slice(0, 6).toLowerCase();

beforeEach(() => {
  (invoke as Mock).mockClear().mockResolvedValue({});
  (recordChangeEvent as Mock).mockClear();
  h.nodes = [];
  h.reloadImpl = vi.fn().mockResolvedValue(undefined);
  h.closeTab.mockClear();
  h.closeSecondaryTab.mockClear();
  h.pushed = undefined;
  h.isReplaying = false;
});

describe("buildForwardStatements", () => {
  it("emits INSERT (topo) before move UPDATE for a group", () => {
    const plan: AiTreePlan = {
      kind: "reorganize",
      ops: [
        {
          op: "create",
          tempId: "tmp:g",
          parentRef: null,
          nodeType: "folder",
          title: "G",
        },
        { op: "move", nodeId: "x1", newParentRef: "tmp:g" },
      ],
    };
    const orderedCreates: CreateOp[] = [plan.ops[0] as CreateOp];
    const idMap = new Map([["tmp:g", "G"]]);
    const placements = new Map<string, NodePlacement>([
      ["G", { parentId: null, sortOrder: "a0" }],
      ["x1", { parentId: "G", sortOrder: "a0" }],
    ]);
    const stmts = buildForwardStatements(
      plan,
      orderedCreates,
      idMap,
      placements,
      "proj-1",
    );
    expect(sqlKind(stmts[0].sql)).toBe("insert");
    expect(stmts[0].params).toContain("G");
    expect(sqlKind(stmts[1].sql)).toBe("update");
  });

  it("passes parentId=null directly for move-to-root (not omitted)", () => {
    const plan: AiTreePlan = {
      kind: "reorganize",
      ops: [{ op: "move", nodeId: "x1", newParentRef: null }],
    };
    const placements = new Map<string, NodePlacement>([
      ["x1", { parentId: null, sortOrder: "a5" }],
    ]);
    const stmts = buildForwardStatements(
      plan,
      [],
      new Map(),
      placements,
      "proj-1",
    );
    expect(stmts).toHaveLength(1);
    expect(sqlKind(stmts[0].sql)).toBe("update");
    expect(stmts[0].params).toContain(null);
  });
});

describe("buildUndoStatements — cascade safety (★)", () => {
  it("restores existing nodes BEFORE deleting created nodes", () => {
    const stmts = buildUndoStatements(
      [{ id: "x1", parentId: null, sortOrder: "a0", title: "x1" }],
      ["G"],
    );
    // restore UPDATE first, DELETE last
    expect(sqlKind(stmts[0].sql)).toBe("update");
    expect(stmts[0].params).toContain("x1");
    expect(sqlKind(stmts[stmts.length - 1].sql)).toBe("delete");
    // the moved existing node must NOT appear in any DELETE
    const deletes = stmts.filter((s) => sqlKind(s.sql) === "delete");
    expect(deletes.some((s) => s.params.includes("x1"))).toBe(false);
    expect(deletes.some((s) => s.params.includes("G"))).toBe(true);
  });

  it("deletes created nodes leaf-first (reverse topo)", () => {
    const stmts = buildUndoStatements([], ["parent", "child"]);
    const deletes = stmts.filter((s) => sqlKind(s.sql) === "delete");
    expect(deletes[0].params).toContain("child");
    expect(deletes[1].params).toContain("parent");
  });
});

describe("applyAiTreePlan — orchestration", () => {
  const groupPlan: AiTreePlan = {
    kind: "reorganize",
    ops: [
      {
        op: "create",
        tempId: "tmp:g",
        parentRef: null,
        nodeType: "folder",
        title: "G",
      },
      { op: "move", nodeId: "x1", newParentRef: "tmp:g" },
      { op: "move", nodeId: "x2", newParentRef: "tmp:g" },
    ],
  };
  const setGroupNodes = () => {
    h.nodes = [
      mkNode({ id: "x1", nodeType: "scene", parentId: null, sortOrder: "a0" }),
      mkNode({ id: "x2", nodeType: "scene", parentId: null, sortOrder: "a1" }),
    ];
  };

  it("throws AiTreePlanError on validation failure and writes nothing", async () => {
    const bad: AiTreePlan = {
      kind: "scaffold",
      ops: [
        {
          op: "create",
          tempId: "bad",
          parentRef: null,
          nodeType: "scene",
          title: "",
        },
      ],
    };
    await expect(
      applyAiTreePlan(bad, ctx({ allowedOps: ["create"] })),
    ).rejects.toBeInstanceOf(AiTreePlanError);
    expect(invoke).not.toHaveBeenCalled();
    expect(recordChangeEvent).not.toHaveBeenCalled();
    expect(h.pushed).toBeUndefined();
  });

  it("applies forward, reloads, records, and pushes a single undo", async () => {
    setGroupNodes();
    const res = await applyAiTreePlan(groupPlan, ctx());
    expect(invoke).toHaveBeenCalledTimes(1);
    expect((invoke as Mock).mock.calls[0][0]).toBe("db_execute_batch");
    expect(h.reloadImpl).toHaveBeenCalledTimes(1);
    expect(recordChangeEvent).toHaveBeenCalledTimes(1);
    const ev = (recordChangeEvent as Mock).mock.calls[0][0];
    expect(ev.opType).toBe("tree.aiReorganize");
    expect(ev.payload.source).toBe("ai");
    expect(ev.payload.movedIds).toEqual(["x1", "x2"]);
    expect(res.createdIds).toHaveLength(1);
    expect(h.pushed).toBeDefined();
  });

  it("undo runs cascade-safe statements and closes created tabs", async () => {
    setGroupNodes();
    await applyAiTreePlan(groupPlan, ctx());
    (invoke as Mock).mockClear();
    h.isReplaying = true;
    await h.pushed!.undo();
    expect(invoke).toHaveBeenCalledTimes(1);
    const undoStmts = (invoke as Mock).mock.calls[0][1].statements as {
      sql: string;
    }[];
    // first ops are restores (update), last is delete of the created folder
    expect(sqlKind(undoStmts[0].sql)).toBe("update");
    expect(sqlKind(undoStmts[undoStmts.length - 1].sql)).toBe("delete");
    expect(h.closeTab).toHaveBeenCalled();
  });

  it("does NOT record or push when reload throws after commit (Medium-3)", async () => {
    setGroupNodes();
    h.reloadImpl = vi.fn().mockRejectedValue(new Error("reload failed"));
    await expect(applyAiTreePlan(groupPlan, ctx())).rejects.toThrow(
      "reload failed",
    );
    expect(invoke).toHaveBeenCalledTimes(1); // forward batch committed
    expect(recordChangeEvent).not.toHaveBeenCalled();
    expect(h.pushed).toBeUndefined();
  });

  it("skips history push when isReplaying", async () => {
    setGroupNodes();
    h.isReplaying = true;
    await applyAiTreePlan(groupPlan, ctx());
    expect(h.pushed).toBeUndefined();
    expect(recordChangeEvent).toHaveBeenCalledTimes(1);
  });
});

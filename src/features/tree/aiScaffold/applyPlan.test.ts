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
  getRecorderSessionId: vi.fn().mockReturnValue("test-session"),
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

    intent: null,
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
      "proj-1",
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
    const stmts = buildUndoStatements([], ["parent", "child"], "proj-1");
    const deletes = stmts.filter((s) => sqlKind(s.sql) === "delete");
    expect(deletes[0].params).toContain("child");
    expect(deletes[1].params).toContain("parent");
  });

  it("scopes every undo statement to projectId (N1 defense)", () => {
    const stmts = buildUndoStatements(
      [{ id: "x1", parentId: null, sortOrder: "a0", title: "x1" }],
      ["G"],
      "proj-1",
    );
    // both the restore UPDATE and the DELETE carry the project id param
    for (const s of stmts) expect(s.params).toContain("proj-1");
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
    expect(h.pushed).toBeUndefined();
  });

  it("applies forward, reloads, records, and pushes a single undo", async () => {
    setGroupNodes();
    const res = await applyAiTreePlan(groupPlan, ctx());
    expect(invoke).toHaveBeenCalledTimes(1);
    expect((invoke as Mock).mock.calls[0][0]).toBe("agent_write_bundle");
    expect(h.reloadImpl).toHaveBeenCalledTimes(1);
    const bundlePayload = (invoke as Mock).mock.calls[0][1].payload;
    expect(bundlePayload.changeEvent.opType).toBe("tree.aiReorganize");
    const payload = JSON.parse(bundlePayload.changeEvent.payload);
    expect(payload.source).toBe("ai");
    expect(payload.movedIds).toEqual(["x1", "x2"]);
    expect(res.createdIds).toHaveLength(1);
    expect(h.pushed).toBeDefined();
  });

  it("undo sends the typed restore snapshot and closes created tabs", async () => {
    setGroupNodes();
    await applyAiTreePlan(groupPlan, ctx());
    (invoke as Mock).mockClear();
    h.isReplaying = true;
    await h.pushed!.undo();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect((invoke as Mock).mock.calls[0][0]).toBe("tree_plan_undo");
    expect((invoke as Mock).mock.calls[0][1]).toMatchObject({
      payload: {
        projectId: "proj-1",
        beforeStates: expect.arrayContaining([
          expect.objectContaining({ id: "x1" }),
          expect.objectContaining({ id: "x2" }),
        ]),
        createdIds: [expect.any(String)],
        updatedAt: expect.any(String),
      },
    });
    expect(h.closeTab).toHaveBeenCalled();
  });

  it("still records + pushes undo when reload fails AFTER commit (M1: committed change must stay undoable)", async () => {
    setGroupNodes();
    h.reloadImpl = vi.fn().mockRejectedValue(new Error("reload failed"));
    // resync is best-effort: a post-commit reload failure must NOT reject the apply
    // nor orphan the committed change.
    const res = await applyAiTreePlan(groupPlan, ctx());
    expect(invoke).toHaveBeenCalledTimes(1); // forward bundle committed
    expect((invoke as Mock).mock.calls[0][0]).toBe("agent_write_bundle");
    expect(h.pushed).toBeDefined();
    expect(res.createdIds).toHaveLength(1);
  });

  it("does NOT record or push when the forward commit itself fails (rolled back)", async () => {
    setGroupNodes();
    (invoke as Mock).mockRejectedValueOnce(new Error("commit failed"));
    await expect(applyAiTreePlan(groupPlan, ctx())).rejects.toThrow(
      "commit failed",
    );
    expect(h.pushed).toBeUndefined();
  });

  it("skips history push when isReplaying", async () => {
    setGroupNodes();
    h.isReplaying = true;
    await applyAiTreePlan(groupPlan, ctx());
    expect(h.pushed).toBeUndefined();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect((invoke as Mock).mock.calls[0][0]).toBe("agent_write_bundle");
  });

  it("undo tolerates a reload failure after its commit (no throw → no history wipe) [M1]", async () => {
    setGroupNodes();
    await applyAiTreePlan(groupPlan, ctx());
    (invoke as Mock).mockClear();
    h.closeTab.mockClear();
    h.reloadImpl = vi.fn().mockRejectedValue(new Error("reload failed"));
    h.isReplaying = true;
    // resyncTree swallows the reload error, so undo resolves; if it threw, the global
    // history store would clear the whole undo/redo stack (finding #3/#4 worst case).
    await expect(h.pushed!.undo()).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledTimes(1); // undo batch committed
    expect(h.closeTab).toHaveBeenCalled(); // post-commit cleanup still ran
  });

  it("redo re-applies with the SAME created UUIDs (apply→undo→redo stable)", async () => {
    setGroupNodes();
    const res = await applyAiTreePlan(groupPlan, ctx());
    const createdId = res.createdIds[0];
    h.isReplaying = true;
    await h.pushed!.undo();
    (invoke as Mock).mockClear();
    await h.pushed!.redo();
    expect((invoke as Mock).mock.calls[0][0]).toBe("agent_write_bundle");
    const redoStmts = (invoke as Mock).mock.calls[0][1].payload.statements as {
      sql: string;
      params: unknown[];
    }[];
    // the re-INSERT of the created folder must reuse the original UUID, so a
    // subsequent undo (which deletes by that id) still matches.
    const insert = redoStmts.find((s) => sqlKind(s.sql) === "insert");
    expect(insert?.params).toContain(createdId);
  });

  it("every reported created/moved id is backed by an emitted statement (no phantom ids)", async () => {
    setGroupNodes();
    const res = await applyAiTreePlan(groupPlan, ctx());
    const stmts = (invoke as Mock).mock.calls[0][1].payload.statements as {
      params: unknown[];
    }[];
    const allParams = new Set(stmts.flatMap((s) => s.params));
    for (const id of [...res.createdIds, ...res.movedIds]) {
      expect(allParams.has(id)).toBe(true);
    }
  });

  it("handles a node that is BOTH moved and renamed in one plan", async () => {
    h.nodes = [
      mkNode({ id: "f", nodeType: "folder", parentId: null, sortOrder: "a0" }),
      mkNode({ id: "x1", nodeType: "scene", parentId: null, sortOrder: "a1" }),
    ];
    const plan: AiTreePlan = {
      kind: "reorganize",
      ops: [
        { op: "move", nodeId: "x1", newParentRef: "f" },
        { op: "rename", nodeId: "x1", title: "Renamed" },
      ],
    };
    const res = await applyAiTreePlan(
      plan,
      ctx({ editableIds: new Set(["x1", "f"]) }),
    );
    expect(res.movedIds).toEqual(["x1"]);
    expect(res.renamedIds).toEqual(["x1"]);
    // undo restores parentId/sortOrder/title for x1 in a single before-state
    h.isReplaying = true;
    (invoke as Mock).mockClear();
    await h.pushed!.undo();
    expect((invoke as Mock).mock.calls[0][0]).toBe("tree_plan_undo");
    expect((invoke as Mock).mock.calls[0][1].payload.beforeStates).toEqual([
      expect.objectContaining({
        id: "x1",
        parentId: null,
        title: "x1",
      }),
    ]);
  });

  it("rejects a mutual-afterRef plan (after_cycle) and writes nothing", async () => {
    h.nodes = [
      mkNode({ id: "f", nodeType: "folder", parentId: null, sortOrder: "a0" }),
    ];
    const plan: AiTreePlan = {
      kind: "scaffold",
      ops: [
        {
          op: "create",
          tempId: "tmp:a",
          parentRef: "f",
          nodeType: "scene",
          title: "a",
          pos: { afterRef: "tmp:b" },
        },
        {
          op: "create",
          tempId: "tmp:b",
          parentRef: "f",
          nodeType: "scene",
          title: "b",
          pos: { afterRef: "tmp:a" },
        },
      ],
    };
    await expect(
      applyAiTreePlan(plan, ctx({ allowedOps: ["create"], rootRef: "f" })),
    ).rejects.toBeInstanceOf(AiTreePlanError);
    expect(invoke).not.toHaveBeenCalled();
  });
});

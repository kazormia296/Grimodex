import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { applyAiTreePlan, AiTreePlanError } from "./applyPlan";
import type { AiTreePlan, ApplyContext } from "./types";
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

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn() }));
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

function ipcFailure(message: string, outcome: "failed" | "unknown"): Error {
  return Object.assign(new Error(message), { outcome });
}

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
    version: 1,
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

beforeEach(() => {
  const createdIds = new Set<string>();
  let receiptSequence = 0;
  (invoke as Mock)
    .mockClear()
    .mockImplementation(
      async (command: string, args: { payload: Record<string, unknown> }) => {
        receiptSequence += 1;
        const payload = args.payload;
        if (command === "ai_tree_plan_apply") {
          const creates = payload.creates as Array<{ id: string }>;
          const updates = payload.updates as Array<{
            id: string;
            baseVersion: number;
          }>;
          for (const create of creates) createdIds.add(create.id);
          return {
            versions: [
              ...creates.map((create) => ({ id: create.id, version: 1 })),
              ...updates.map((update) => ({
                id: update.id,
                version: update.baseVersion + 1,
              })),
            ],
            changeEventUid: String(payload.requestId),
            maintenanceTransactionId: `maintenance-${receiptSequence}`,
            undoJournalId: "tree-journal-1",
          };
        }
        if (command === "ai_tree_plan_undo") {
          const expected = payload.expectedVersions as Array<{
            id: string;
            version: number;
          }>;
          return {
            versions: expected
              .filter((entry) => !createdIds.has(entry.id))
              .map((entry) => ({ id: entry.id, version: entry.version + 1 })),
            changeEventUid: String(payload.requestId),
            maintenanceTransactionId: `maintenance-${receiptSequence}`,
            undoJournalId: "tree-journal-1",
          };
        }
        return {};
      },
    );
  h.nodes = [];
  h.reloadImpl = vi.fn().mockResolvedValue(undefined);
  h.closeTab.mockClear();
  h.closeSecondaryTab.mockClear();
  h.pushed = undefined;
  h.isReplaying = false;
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
    expect((invoke as Mock).mock.calls[0][0]).toBe("ai_tree_plan_apply");
    expect(h.reloadImpl).toHaveBeenCalledTimes(1);
    const payload = (invoke as Mock).mock.calls[0][1].payload;
    expect(payload).toMatchObject({
      projectId: "proj-1",
      surface: "in-app-agent",
      kind: "reorganize",
      redo: false,
      originalTransactionId: null,
      undoJournalId: null,
    });
    expect(payload.updates.map((update: { id: string }) => update.id)).toEqual([
      "x1",
      "x2",
    ]);
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
    expect((invoke as Mock).mock.calls[0][0]).toBe("ai_tree_plan_undo");
    expect((invoke as Mock).mock.calls[0][1]).toMatchObject({
      payload: {
        projectId: "proj-1",
        originalTransactionId: "maintenance-1",
        undoJournalId: "tree-journal-1",
        expectedVersions: expect.arrayContaining([
          expect.objectContaining({ id: "x1" }),
          expect.objectContaining({ id: "x2" }),
          expect.objectContaining({ id: expect.any(String), version: 1 }),
        ]),
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
    expect((invoke as Mock).mock.calls[0][0]).toBe("ai_tree_plan_apply");
    expect(h.pushed).toBeDefined();
    expect(res.createdIds).toHaveLength(1);
  });

  it("does NOT record or push when the forward commit itself fails (rolled back)", async () => {
    setGroupNodes();
    (invoke as Mock).mockRejectedValueOnce(
      ipcFailure("commit failed", "failed"),
    );
    await expect(applyAiTreePlan(groupPlan, ctx())).rejects.toThrow(
      "commit failed",
    );
    expect(h.pushed).toBeUndefined();
  });

  it("retries an unknown initial outcome with the exact request and created IDs", async () => {
    setGroupNodes();
    (invoke as Mock).mockRejectedValueOnce(
      ipcFailure("transport outcome is unknown", "unknown"),
    );
    await expect(applyAiTreePlan(groupPlan, ctx())).rejects.toThrow(
      "transport outcome is unknown",
    );
    const firstPayload = (invoke as Mock).mock.calls[0][1].payload;

    await applyAiTreePlan(groupPlan, ctx());
    const retryPayload = (invoke as Mock).mock.calls[1][1].payload;
    expect(retryPayload.requestId).toBe(firstPayload.requestId);
    expect(retryPayload.updatedAt).toBe(firstPayload.updatedAt);
    expect(retryPayload.creates).toEqual(firstPayload.creates);
  });

  it("retains the initial identity when Native returned but receipt publication failed", async () => {
    setGroupNodes();
    (invoke as Mock).mockResolvedValueOnce({
      versions: [],
      changeEventUid: "committed-with-bad-receipt",
    });
    await expect(applyAiTreePlan(groupPlan, ctx())).rejects.toThrow(
      "Native receipt is incomplete",
    );
    const firstPayload = (invoke as Mock).mock.calls[0][1].payload;

    await applyAiTreePlan(groupPlan, ctx());
    const retryPayload = (invoke as Mock).mock.calls[1][1].payload;
    expect(retryPayload.requestId).toBe(firstPayload.requestId);
    expect(retryPayload.creates).toEqual(firstPayload.creates);
  });

  it("rotates the initial identity after an explicit definite failure", async () => {
    setGroupNodes();
    (invoke as Mock).mockRejectedValueOnce(
      ipcFailure("Native did not execute", "failed"),
    );
    await expect(applyAiTreePlan(groupPlan, ctx())).rejects.toThrow(
      "Native did not execute",
    );
    const firstPayload = (invoke as Mock).mock.calls[0][1].payload;

    await applyAiTreePlan(groupPlan, ctx());
    const retryPayload = (invoke as Mock).mock.calls[1][1].payload;
    expect(retryPayload.requestId).not.toBe(firstPayload.requestId);
    expect(retryPayload.creates).not.toEqual(firstPayload.creates);
  });

  it("skips history push when isReplaying", async () => {
    setGroupNodes();
    h.isReplaying = true;
    await applyAiTreePlan(groupPlan, ctx());
    expect(h.pushed).toBeUndefined();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect((invoke as Mock).mock.calls[0][0]).toBe("ai_tree_plan_apply");
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
    expect((invoke as Mock).mock.calls[0][0]).toBe("ai_tree_plan_apply");
    const redoPayload = (invoke as Mock).mock.calls[0][1].payload;
    expect(redoPayload).toMatchObject({
      redo: true,
      originalTransactionId: "maintenance-1",
      undoJournalId: "tree-journal-1",
    });
    expect(redoPayload.creates).toContainEqual(
      expect.objectContaining({ id: createdId }),
    );
  });

  it("retains undo and redo identities across unknown outcomes", async () => {
    setGroupNodes();
    await applyAiTreePlan(groupPlan, ctx());

    (invoke as Mock).mockClear();
    (invoke as Mock).mockRejectedValueOnce(
      ipcFailure("undo outcome unknown", "unknown"),
    );
    await expect(h.pushed!.undo()).rejects.toThrow("undo outcome unknown");
    const firstUndo = (invoke as Mock).mock.calls[0][1].payload;
    await h.pushed!.undo();
    const retryUndo = (invoke as Mock).mock.calls[1][1].payload;
    expect(retryUndo).toEqual(firstUndo);

    (invoke as Mock).mockClear();
    (invoke as Mock).mockRejectedValueOnce(
      ipcFailure("redo outcome unknown", "unknown"),
    );
    await expect(h.pushed!.redo()).rejects.toThrow("redo outcome unknown");
    const firstRedo = (invoke as Mock).mock.calls[0][1].payload;
    await h.pushed!.redo();
    const retryRedo = (invoke as Mock).mock.calls[1][1].payload;
    expect(retryRedo).toEqual(firstRedo);
  });

  it("rotates a confirmed undo identity for the next undo cycle", async () => {
    setGroupNodes();
    await applyAiTreePlan(groupPlan, ctx());
    (invoke as Mock).mockClear();

    await h.pushed!.undo();
    const firstUndoRequest = (invoke as Mock).mock.calls[0][1].payload
      .requestId;
    await h.pushed!.redo();
    await h.pushed!.undo();
    const nextUndoRequest = (invoke as Mock).mock.calls[2][1].payload.requestId;
    expect(nextUndoRequest).not.toBe(firstUndoRequest);
  });

  it("every reported created/moved id is backed by an emitted statement (no phantom ids)", async () => {
    setGroupNodes();
    const res = await applyAiTreePlan(groupPlan, ctx());
    const payload = (invoke as Mock).mock.calls[0][1].payload;
    const allIds = new Set<string>([
      ...payload.creates.map((create: { id: string }) => create.id),
      ...payload.updates.map((update: { id: string }) => update.id),
    ]);
    for (const id of [...res.createdIds, ...res.movedIds]) {
      expect(allIds.has(id)).toBe(true);
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
    const forwardUpdate = (invoke as Mock).mock.calls[0][1].payload.updates[0];
    expect(forwardUpdate).toMatchObject({
      id: "x1",
      baseVersion: 1,
      placement: { parentId: "f" },
      title: "Renamed",
    });
    // undo restores parentId/sortOrder/title for x1 in a single before-state
    h.isReplaying = true;
    (invoke as Mock).mockClear();
    await h.pushed!.undo();
    expect((invoke as Mock).mock.calls[0][0]).toBe("ai_tree_plan_undo");
    expect((invoke as Mock).mock.calls[0][1].payload.expectedVersions).toEqual([
      { id: "x1", version: 2 },
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

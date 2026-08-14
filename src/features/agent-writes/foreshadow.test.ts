import { describe, expect, it, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  blockIfPolicyOff: vi.fn(() => false),
  invoke: vi.fn(),
  load: vi.fn().mockResolvedValue(undefined),
  items: [] as Array<Record<string, unknown>>,
  push: vi.fn(),
  isReplaying: false,
  applyUndoJournal: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: h.blockIfPolicyOff,
}));
vi.mock("@/lib/tauri", () => ({
  invoke: h.invoke,
}));
vi.mock("@/features/timelapse/recorder", () => ({
  getRecorderSessionId: () => "sess-1",
}));
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "p1",
}));
vi.mock("@/features/foreshadow/foreshadowStore", () => ({
  useForeshadowStore: {
    getState: () => ({ load: h.load, items: h.items }),
  },
}));
vi.mock("@/store/globalHistoryStore", () => ({
  useGlobalHistoryStore: {
    getState: () => ({ isReplaying: h.isReplaying, push: h.push }),
  },
}));
vi.mock("./undoJournal", () => ({
  applyUndoJournal: h.applyUndoJournal,
}));

import { agentCreateForeshadow, agentUpdateForeshadow } from "./foreshadow";

const writeResult = {
  entityId: "f1",
  version: 1,
  changeEventUid: "uid-1",
  undoJournalId: "j1",
};

const storedItem = {
  id: "f1",
  projectId: "p1",
  title: "刻印の謎",
  intent: null,
  notes: null,
  payoffConfirmed: false,
  abandoned: false,
  secret: true,
  loadBearing: null,
  version: 1,
};

describe("agentCreateForeshadow", () => {
  beforeEach(() => {
    h.blockIfPolicyOff.mockClear();
    h.blockIfPolicyOff.mockReturnValue(false);
    h.invoke.mockClear();
    h.invoke.mockResolvedValue(writeResult);
    h.load.mockClear();
    h.push.mockClear();
    h.items = [{ ...storedItem }];
    h.isReplaying = false;
  });

  it("is gated by knowledgeWrite and never invokes when off", async () => {
    h.blockIfPolicyOff.mockReturnValue(true);
    await expect(
      agentCreateForeshadow({
        requestId: "agent-tool:create-gated",
        title: "x",
      }),
    ).rejects.toThrow();
    expect(h.blockIfPolicyOff).toHaveBeenCalledWith("knowledgeWrite");
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("invokes the tracked command, reloads the store, and pushes undo history", async () => {
    const result = await agentCreateForeshadow({
      requestId: "agent-tool:foreshadow-request",
      foreshadowId: "f1",
      title: "刻印の謎",
    });

    expect(h.invoke).toHaveBeenCalledWith("agent_foreshadow_create", {
      payload: {
        requestId: "agent-tool:foreshadow-request",
        foreshadowId: "f1",
        projectId: "p1",
        sessionId: "sess-1",
        title: "刻印の謎",
        intent: null,
        notes: null,
        loadBearing: null,
        secret: true,
      },
    });
    expect(h.load).toHaveBeenCalledWith("p1");
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(h.push.mock.calls[0][0]).toMatchObject({
      kind: "foreshadow",
      operationId: "j1",
      entityId: "f1",
    });
    expect(result.id).toBe("f1");
  });

  it("defaults secret to true (MCP parity) but passes an explicit false through", async () => {
    await agentCreateForeshadow({
      requestId: "agent-tool:create-open",
      title: "open plant",
      secret: false,
    });
    expect(h.invoke.mock.calls[0][1].payload.secret).toBe(false);
  });

  it("rejects an unknown loadBearing before invoking", async () => {
    await expect(
      agentCreateForeshadow({
        requestId: "agent-tool:create-invalid",
        title: "x",
        loadBearing: "urgent" as never,
      }),
    ).rejects.toThrow();
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("rejects an empty request identity before invoking", async () => {
    await expect(
      agentCreateForeshadow({ requestId: " ", title: "x" }),
    ).rejects.toThrow("requestId");
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("undo/redo closures apply the journal and reload the store", async () => {
    await agentCreateForeshadow({
      requestId: "agent-tool:create-history",
      title: "刻印の謎",
    });
    const cmd = h.push.mock.calls[0][0];
    await cmd.undo();
    expect(h.applyUndoJournal).toHaveBeenCalledWith("j1", "undo");
    await cmd.redo();
    expect(h.applyUndoJournal).toHaveBeenCalledWith("j1", "redo");
  });

  it("does not push history while replaying", async () => {
    h.isReplaying = true;
    await agentCreateForeshadow({
      requestId: "agent-tool:create-replay",
      title: "刻印の謎",
    });
    expect(h.push).not.toHaveBeenCalled();
  });

  it("throws when the created row is missing after reload", async () => {
    h.items = [];
    await expect(
      agentCreateForeshadow({
        requestId: "agent-tool:create-ghost",
        title: "ghost",
      }),
    ).rejects.toThrow();
  });
});

describe("agentUpdateForeshadow", () => {
  beforeEach(() => {
    h.blockIfPolicyOff.mockClear();
    h.blockIfPolicyOff.mockReturnValue(false);
    h.invoke.mockClear();
    h.invoke.mockResolvedValue(writeResult);
    h.load.mockClear();
    h.push.mockClear();
    h.items = [{ ...storedItem, payoffConfirmed: true }];
    h.isReplaying = false;
  });

  it("is gated by knowledgeWrite", async () => {
    h.blockIfPolicyOff.mockReturnValue(true);
    await expect(
      agentUpdateForeshadow({
        requestId: "agent-tool:update-gated",
        foreshadowId: "f1",
        baseVersion: 1,
        title: "x",
      }),
    ).rejects.toThrow();
    expect(h.blockIfPolicyOff).toHaveBeenCalledWith("knowledgeWrite");
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("rejects an empty patch before invoking", async () => {
    await expect(
      agentUpdateForeshadow({
        requestId: "agent-tool:update-empty",
        foreshadowId: "f1",
        baseVersion: 1,
      }),
    ).rejects.toThrow();
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("rejects an empty request identity before invoking", async () => {
    await expect(
      agentUpdateForeshadow({
        requestId: " ",
        foreshadowId: "f1",
        baseVersion: 1,
        title: "x",
      }),
    ).rejects.toThrow("requestId");
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("invokes the tracked command with only the provided fields and pushes undo", async () => {
    const result = await agentUpdateForeshadow({
      requestId: "agent-tool:update-f1",
      foreshadowId: "f1",
      baseVersion: 1,
      payoffConfirmed: true,
    });

    expect(h.invoke).toHaveBeenCalledWith("agent_foreshadow_update", {
      payload: {
        requestId: "agent-tool:update-f1",
        projectId: "p1",
        sessionId: "sess-1",
        foreshadowId: "f1",
        baseVersion: 1,
        title: null,
        intent: null,
        notes: null,
        loadBearing: null,
        payoffConfirmed: true,
        abandoned: null,
        secret: null,
      },
    });
    expect(h.load).toHaveBeenCalledWith("p1");
    expect(h.push.mock.calls[0][0]).toMatchObject({
      kind: "foreshadow",
      entityId: "f1",
    });
    expect(result.payoffConfirmed).toBe(true);
  });
});

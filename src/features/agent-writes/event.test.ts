import { describe, expect, it, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  blockIfPolicyOff: vi.fn(() => false),
  invoke: vi.fn(),
  bumpRevision: vi.fn(),
  push: vi.fn(),
  isReplaying: false,
  applyUndoJournal: vi.fn().mockResolvedValue(undefined),
  scheduleEventIndex: vi.fn(),
}));

vi.mock("i18next", () => ({ default: { t: (k: string) => k } }));
vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: h.blockIfPolicyOff,
}));
vi.mock("@/lib/tauri", () => ({ invoke: h.invoke }));
vi.mock("@/features/timelapse/recorder", () => ({
  getRecorderSessionId: () => "sess-1",
}));
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "p1",
}));
vi.mock("@/features/chronicle/chronicleStore", () => ({
  useChronicleStore: {
    getState: () => ({ bumpRevision: h.bumpRevision }),
  },
}));
vi.mock("@/features/semantic-search/scheduler", () => ({
  scheduleEventIndex: h.scheduleEventIndex,
}));
vi.mock("@/store/globalHistoryStore", () => ({
  useGlobalHistoryStore: {
    getState: () => ({ isReplaying: h.isReplaying, push: h.push }),
  },
}));
vi.mock("./undoJournal", () => ({ applyUndoJournal: h.applyUndoJournal }));

import {
  uiLinkSceneEvent,
  uiUnlinkSceneEvent,
  agentLinkSceneEvent,
} from "./event";

const writeResult = {
  entityId: "e1",
  version: 1,
  changeEventUid: "uid-1",
  undoJournalId: "j1",
};

describe("uiLinkSceneEvent / uiUnlinkSceneEvent (手動リンクの tracked-write)", () => {
  beforeEach(() => {
    h.blockIfPolicyOff.mockClear();
    h.blockIfPolicyOff.mockReturnValue(false);
    h.invoke.mockClear();
    h.invoke.mockResolvedValue(writeResult);
    h.bumpRevision.mockClear();
    h.push.mockClear();
    h.isReplaying = false;
  });

  it("surface='manual' で policy gate を通さず tracked link を invoke する", async () => {
    await uiLinkSceneEvent("s1", "e1");
    // skipPolicyGate:true の短絡で knowledgeWrite ゲートは参照されない。
    expect(h.blockIfPolicyOff).not.toHaveBeenCalled();
    expect(h.invoke).toHaveBeenCalledWith("agent_scene_event_link", {
      payload: {
        projectId: "p1",
        sessionId: "sess-1",
        surface: "manual",
        sceneId: "s1",
        eventId: "e1",
      },
    });
    expect(h.bumpRevision).toHaveBeenCalled();
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(h.push.mock.calls[0][0]).toMatchObject({
      kind: "chronicle",
      entityId: "e1",
    });
  });

  it("unlink も surface='manual' で agent_scene_event_unlink を invoke する", async () => {
    await uiUnlinkSceneEvent("s1", "e1");
    expect(h.blockIfPolicyOff).not.toHaveBeenCalled();
    expect(h.invoke).toHaveBeenCalledWith("agent_scene_event_unlink", {
      payload: {
        projectId: "p1",
        sessionId: "sess-1",
        surface: "manual",
        sceneId: "s1",
        eventId: "e1",
      },
    });
  });

  it("replay 中は undo history を積まない", async () => {
    h.isReplaying = true;
    await uiLinkSceneEvent("s1", "e1");
    expect(h.push).not.toHaveBeenCalled();
  });

  it("undo/redo クロージャは journal を適用し revision を bump する", async () => {
    await uiLinkSceneEvent("s1", "e1");
    const cmd = h.push.mock.calls[0][0];
    await cmd.undo();
    expect(h.applyUndoJournal).toHaveBeenCalledWith("j1", "undo");
    await cmd.redo();
    expect(h.applyUndoJournal).toHaveBeenCalledWith("j1", "redo");
  });

  it("対照: AI 経路 agentLinkSceneEvent は knowledgeWrite gate を通り、off なら invoke しない", async () => {
    h.blockIfPolicyOff.mockReturnValueOnce(true);
    await expect(agentLinkSceneEvent("s1", "e1")).rejects.toThrow();
    expect(h.blockIfPolicyOff).toHaveBeenCalledWith("knowledgeWrite");
    expect(h.invoke).not.toHaveBeenCalled();
  });
});

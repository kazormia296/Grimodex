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
  agentCreateEvent,
  agentUpdateEvent,
  uiCreateEvent,
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

// #2: 出来事 detail（リッチテキスト）の AI 帰属焼込。codex/snippet と同様、
// AI/agent 経路の detail には authorship マークを焼き込み、手動 UI 編集
// (surface="manual") の detail には足さない（既に人間帰属マークを持つため）。
describe("event detail の AI 帰属焼込 (#2)", () => {
  const DETAIL_DOC = JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "AI が書いた詳細" }],
      },
    ],
  });

  type PmNode = {
    type?: string;
    marks?: { type: string }[];
    content?: PmNode[];
  };

  function lastDetailDoc(): PmNode {
    const call = [...h.invoke.mock.calls]
      .reverse()
      .find(
        (c) => c[0] === "agent_event_create" || c[0] === "agent_event_update",
      );
    const payload = (call?.[1] as { payload: { detail: string } }).payload;
    return JSON.parse(payload.detail) as PmNode;
  }

  function hasAuthorshipMark(doc: PmNode): boolean {
    const text = doc.content?.[0]?.content?.[0];
    return (text?.marks ?? []).some((m) => m.type === "authorship");
  }

  beforeEach(() => {
    h.blockIfPolicyOff.mockClear();
    h.blockIfPolicyOff.mockReturnValue(false);
    h.invoke.mockClear();
    h.invoke.mockResolvedValue(writeResult);
    h.bumpRevision.mockClear();
    h.push.mockClear();
    h.isReplaying = false;
  });

  it("AI 経路 agentCreateEvent は detail に authorship マークを焼き込む", async () => {
    await agentCreateEvent({ title: "t", detail: DETAIL_DOC });
    expect(hasAuthorshipMark(lastDetailDoc())).toBe(true);
  });

  it("AI 経路 agentUpdateEvent も detail 更新に authorship マークを焼き込む", async () => {
    await agentUpdateEvent({ eventId: "e1", detail: DETAIL_DOC });
    expect(hasAuthorshipMark(lastDetailDoc())).toBe(true);
  });

  it("手動 UI 経路 uiCreateEvent は detail に AI マークを足さない (surface=manual)", async () => {
    await uiCreateEvent({ title: "t", detail: DETAIL_DOC });
    expect(hasAuthorshipMark(lastDetailDoc())).toBe(false);
  });
});

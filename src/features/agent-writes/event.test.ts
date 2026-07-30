import { describe, expect, it, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  blockIfPolicyOff: vi.fn(() => false),
  invoke: vi.fn(),
  bumpRevision: vi.fn(),
  push: vi.fn(),
  isReplaying: false,
  applyUndoJournal: vi.fn().mockResolvedValue(undefined),
  scheduleEventIndex: vi.fn(),
  notifySameRendererDocumentWrite: vi.fn(),
  currentProjectId: "p1",
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
  getCurrentProjectId: () => h.currentProjectId,
}));
vi.mock("@/features/chronicle/chronicleStore", () => ({
  useChronicleStore: {
    getState: () => ({ bumpRevision: h.bumpRevision }),
  },
}));
vi.mock("@/features/semantic-search/scheduler", () => ({
  scheduleEventIndex: h.scheduleEventIndex,
}));
vi.mock("@/features/concurrency/documentWriteNotification", () => ({
  notifySameRendererDocumentWrite: h.notifySameRendererDocumentWrite,
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
  agentAddEventRelation,
  agentCreateEvent,
  agentUpdateEvent,
  agentDeleteEvent,
  uiCreateEvent,
  uiUpdateEvent,
  uiDeleteEvent,
  uiSetEventParticipants,
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
    h.invoke.mockImplementation(async (command: string) =>
      command === "event_get_version" ? 0 : writeResult,
    );
    h.bumpRevision.mockClear();
    h.push.mockClear();
    h.notifySameRendererDocumentWrite.mockClear();
    h.scheduleEventIndex.mockClear();
    h.isReplaying = false;
    h.currentProjectId = "p1";
  });

  it("surface='manual' で policy gate を通さず tracked link を invoke する", async () => {
    await uiLinkSceneEvent("s1", "e1");
    // skipPolicyGate:true の短絡で knowledgeWrite ゲートは参照されない。
    expect(h.blockIfPolicyOff).not.toHaveBeenCalled();
    expect(h.invoke).toHaveBeenCalledWith("agent_scene_event_link", {
      payload: {
        requestId: expect.any(String),
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
      operationId: "j1",
      entityId: "e1",
      documentKey: { kind: "chronicle-event", id: "e1" },
      retainOnVersionConflict: true,
    });
  });

  it("unlink も surface='manual' で agent_scene_event_unlink を invoke する", async () => {
    await uiUnlinkSceneEvent("s1", "e1");
    expect(h.blockIfPolicyOff).not.toHaveBeenCalled();
    expect(h.invoke).toHaveBeenCalledWith("agent_scene_event_unlink", {
      payload: {
        requestId: expect.any(String),
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

  it("association retry IDs are passed to link and relation commands", async () => {
    await agentLinkSceneEvent("s1", "e1", { requestId: "link-request-1" });
    await agentAddEventRelation("e1", "e2", {
      requestId: "relation-request-1",
    });
    expect(h.invoke).toHaveBeenNthCalledWith(1, "agent_scene_event_link", {
      payload: expect.objectContaining({ requestId: "link-request-1" }),
    });
    expect(h.invoke).toHaveBeenNthCalledWith(2, "agent_event_relation_add", {
      payload: expect.objectContaining({ requestId: "relation-request-1" }),
    });
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
    h.invoke.mockImplementation(async (command: string) =>
      command === "event_get_version" ? 0 : writeResult,
    );
    h.bumpRevision.mockClear();
    h.push.mockClear();
    h.notifySameRendererDocumentWrite.mockClear();
    h.scheduleEventIndex.mockClear();
    h.isReplaying = false;
    h.currentProjectId = "p1";
  });

  it("AI 経路 agentCreateEvent は detail に authorship マークを焼き込む", async () => {
    await agentCreateEvent({ title: "t", detail: DETAIL_DOC });
    expect(hasAuthorshipMark(lastDetailDoc())).toBe(true);
  });

  it("caller-reusable eventId is passed through the create payload", async () => {
    await agentCreateEvent({
      requestId: "agent-tool:event-request",
      eventId: "event-request-1",
      title: "t",
    });
    expect(h.invoke).toHaveBeenCalledWith("agent_event_create", {
      payload: expect.objectContaining({
        requestId: "agent-tool:event-request",
        eventId: "event-request-1",
        projectId: "p1",
        sessionId: "sess-1",
      }),
    });
  });

  it("granularity 省略を native 推論へ渡し、日付を none で上書きしない", async () => {
    await agentCreateEvent({
      title: "dated",
      startTime: 10,
      startMinute: 720,
      endTime: 11,
      endGranularity: "day",
    });

    const createCall = h.invoke.mock.calls.find(
      ([command]) => command === "agent_event_create",
    );
    const payload = (
      createCall?.[1] as { payload: Record<string, unknown> } | undefined
    )?.payload;
    expect(payload).not.toHaveProperty("startGranularity");
    expect(payload).toMatchObject({
      startTime: 10,
      startMinute: 720,
      endTime: 11,
      endGranularity: "day",
    });
  });

  it("削除済み create replay は renderer side effect を公開しない", async () => {
    h.invoke.mockImplementation(async (command: string) =>
      command === "event_get_version" ? null : writeResult,
    );

    await expect(
      agentCreateEvent({
        requestId: "agent-tool:deleted-event-request",
        title: "deleted",
      }),
    ).rejects.toThrow("not found after replay");

    expect(h.notifySameRendererDocumentWrite).not.toHaveBeenCalled();
    expect(h.bumpRevision).not.toHaveBeenCalled();
    expect(h.scheduleEventIndex).not.toHaveBeenCalled();
    expect(h.push).not.toHaveBeenCalled();
  });

  it("invoke 中に Project が変わった create completion を公開しない", async () => {
    let resolveCreate: ((value: typeof writeResult) => void) | undefined;
    h.invoke.mockImplementation((command: string) => {
      if (command === "agent_event_create") {
        return new Promise((resolve) => {
          resolveCreate = resolve;
        });
      }
      return Promise.resolve({ rows: [{ version: 1 }] });
    });

    const creation = agentCreateEvent({
      requestId: "agent-tool:stale-event-request",
      title: "old project",
    });
    await vi.waitFor(() =>
      expect(h.invoke).toHaveBeenCalledWith(
        "agent_event_create",
        expect.anything(),
      ),
    );
    h.currentProjectId = "p2";
    resolveCreate?.(writeResult);

    await expect(creation).rejects.toThrow("event write authority changed");
    expect(h.notifySameRendererDocumentWrite).not.toHaveBeenCalled();
    expect(h.bumpRevision).not.toHaveBeenCalled();
    expect(h.scheduleEventIndex).not.toHaveBeenCalled();
    expect(h.push).not.toHaveBeenCalled();
  });

  it("version 読み込み中に Project が変わった update を別 Project へ送らない", async () => {
    let resolveVersion: ((value: number) => void) | undefined;
    h.invoke.mockImplementation((command: string) => {
      if (command === "event_get_version") {
        return new Promise((resolve) => {
          resolveVersion = resolve;
        });
      }
      return Promise.resolve(writeResult);
    });

    const update = agentUpdateEvent({ eventId: "shared-id", title: "old" });
    await vi.waitFor(() =>
      expect(h.invoke).toHaveBeenCalledWith("event_get_version", {
        eventId: "shared-id",
        projectId: "p1",
      }),
    );
    h.currentProjectId = "p2";
    resolveVersion?.(7);

    await expect(update).rejects.toThrow("event write authority changed");
    expect(
      h.invoke.mock.calls.some(([command]) => command === "agent_event_update"),
    ).toBe(false);
    expect(h.notifySameRendererDocumentWrite).not.toHaveBeenCalled();
    expect(h.bumpRevision).not.toHaveBeenCalled();
    expect(h.push).not.toHaveBeenCalled();
  });

  it("AI 経路 agentUpdateEvent も detail 更新に authorship マークを焼き込む", async () => {
    await agentUpdateEvent({ eventId: "e1", detail: DETAIL_DOC });
    expect(hasAuthorshipMark(lastDetailDoc())).toBe(true);
  });

  it("読み込み時点の baseVersion を update payload に通す", async () => {
    await agentUpdateEvent({
      eventId: "e1",
      baseVersion: 7,
      title: "new",
    });
    expect(h.invoke).toHaveBeenCalledWith("agent_event_update", {
      payload: expect.objectContaining({
        eventId: "e1",
        baseVersion: 7,
        title: "new",
      }),
    });
    expect(h.notifySameRendererDocumentWrite).toHaveBeenCalledWith(
      { kind: "chronicle-event", id: "e1" },
      {
        domain: "event",
        opType: "event.update",
        entityId: "e1",
      },
    );
  });

  it("ChroniclePanel の手動 UI 更新も open Editor session へ通知する", async () => {
    await uiUpdateEvent({ eventId: "e1", baseVersion: 0, title: "manual" });
    expect(h.notifySameRendererDocumentWrite).toHaveBeenCalledTimes(1);
  });

  it("起点 Editor 自身の保存だけ document notification を抑止できる", async () => {
    await uiUpdateEvent(
      { eventId: "e1", baseVersion: 0, title: "editor" },
      { suppressDocumentNotification: true },
    );
    expect(h.notifySameRendererDocumentWrite).not.toHaveBeenCalled();
  });

  it("delete は読み込み時点の aggregate version をCAS payloadへ渡す", async () => {
    await agentDeleteEvent("e1", { baseVersion: 7 });
    expect(h.invoke).toHaveBeenCalledWith("agent_event_delete", {
      payload: expect.objectContaining({
        eventId: "e1",
        baseVersion: 7,
      }),
    });
    expect(h.notifySameRendererDocumentWrite).toHaveBeenCalledWith(
      { kind: "chronicle-event", id: "e1" },
      {
        domain: "event",
        opType: "event.delete",
        entityId: "e1",
      },
    );
  });

  it("手動 delete も選択行の version を伝播する", async () => {
    await uiDeleteEvent("e1", { baseVersion: 4 });
    expect(h.invoke).toHaveBeenCalledWith("agent_event_delete", {
      payload: expect.objectContaining({
        eventId: "e1",
        baseVersion: 4,
        surface: "manual",
      }),
    });
  });

  it("起点 UI は delete と participants の document notification を抑止できる", async () => {
    await uiDeleteEvent("e1", {
      baseVersion: 4,
      suppressDocumentNotification: true,
    });
    await uiSetEventParticipants("e1", ["c1"], {
      baseVersion: 4,
      suppressDocumentNotification: true,
    });

    expect(h.notifySameRendererDocumentWrite).not.toHaveBeenCalled();
    expect(h.invoke).toHaveBeenNthCalledWith(1, "agent_event_delete", {
      payload: expect.objectContaining({
        eventId: "e1",
        baseVersion: 4,
      }),
    });
    expect(h.invoke).toHaveBeenNthCalledWith(
      2,
      "agent_event_set_participants",
      {
        payload: expect.objectContaining({
          eventId: "e1",
          codexEntryIds: ["c1"],
          baseVersion: 4,
        }),
      },
    );
  });

  it("Event row undo/redo も同一rendererのDocument Sessionへ通知する", async () => {
    await agentUpdateEvent({ eventId: "e1", baseVersion: 0, title: "tracked" });
    const command = h.push.mock.calls[0][0];
    h.notifySameRendererDocumentWrite.mockClear();

    await command.undo();
    expect(h.notifySameRendererDocumentWrite).toHaveBeenLastCalledWith(
      { kind: "chronicle-event", id: "e1" },
      {
        domain: "event",
        opType: "event.update",
        entityId: "e1",
      },
    );

    await command.redo();
    expect(h.notifySameRendererDocumentWrite).toHaveBeenCalledTimes(2);
  });

  it("手動 UI 経路 uiCreateEvent は detail に AI マークを足さない (surface=manual)", async () => {
    await uiCreateEvent({ title: "t", detail: DETAIL_DOC });
    expect(hasAuthorshipMark(lastDetailDoc())).toBe(false);
  });
});

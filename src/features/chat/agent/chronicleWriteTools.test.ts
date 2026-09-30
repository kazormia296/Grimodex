import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  agentCreateEvent: vi.fn(async () => ({ id: "e-new", title: "戴冠" })),
  agentUpdateEvent: vi.fn(async () => undefined),
  agentDeleteEvent: vi.fn(async () => undefined),
  agentSetEventParticipants: vi.fn(async () => undefined),
  agentLinkSceneEvent: vi.fn(async () => undefined),
  agentUnlinkSceneEvent: vi.fn(async () => undefined),
  agentAddEventRelation: vi.fn(async () => undefined),
  agentRemoveEventRelation: vi.fn(async () => undefined),
}));
vi.mock("@/features/agent-writes/event", () => m);

// write-by-id ゲート(isEventVisibleForWrite)の依存をモック。対象 event は
// 非 secret として可視扱いにし、既存の「対応関数を呼ぶ」契約を維持する。
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: {
    getState: () => ({ projectId: "p1", nodes: [], activeSceneId: "s1" }),
  },
}));
const apiMock = vi.hoisted(() => ({
  listEvents: vi.fn(async () => [
    {
      id: "e1",
      secret: false,
      revealSceneId: null as string | null,
      version: 4,
    },
    {
      id: "a",
      secret: false,
      revealSceneId: null as string | null,
      version: 2,
    },
    {
      id: "b",
      secret: false,
      revealSceneId: null as string | null,
      version: 3,
    },
  ]),
  listSceneEventsForProject: vi.fn(async () => []),
}));
vi.mock("@/features/chronicle/api", () => apiMock);
// 共有キャッシュ(chronicleToolCache)が codex 名 loader を持つため軽量 mock。
vi.mock("@/features/codex/api", () => ({
  listCodexMatchTargets: vi.fn(async () => []),
}));

import {
  createEventTool,
  updateEventTool,
  deleteEventTool,
  stampSceneEventTool,
  unstampSceneEventTool,
  setEventParticipantsTool,
  addEventRelationTool,
  removeEventRelationTool,
} from "./chronicleWriteTools";
import { invalidateChronicleToolCache } from "./chronicleToolCache";

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockClear();
  apiMock.listEvents.mockClear();
  apiMock.listSceneEventsForProject.mockClear();
  // ターン内共有キャッシュをテスト間で持ち越さない（runAgentLoop の毎ターン破棄相当）。
  invalidateChronicleToolCache();
});

describe("createEventTool", () => {
  it("title 必須", async () => {
    const r = await createEventTool({});
    expect(r.error).toBe("title is required");
    expect(m.agentCreateEvent).not.toHaveBeenCalled();
  });

  it("入力を parse して agentCreateEvent を呼び id を返す", async () => {
    const r = await createEventTool(
      {
        title: "戴冠",
        kind: "generic",
        primaryCodexId: "c1",
        startTime: 12,
        participantCodexIds: ["c2", "c3"],
        sceneIds: ["s1"],
      },
      "agent-tool:event-request",
    );
    expect(m.agentCreateEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "agent-tool:event-request",
        title: "戴冠",
        kind: "generic",
        primaryCodexId: "c1",
        startTime: 12,
        participantCodexIds: ["c2", "c3"],
        sceneIds: ["s1"],
      }),
    );
    expect((r.content as { id: string }).id).toBe("e-new");
  });

  it("不正 kind は generic に丸める", async () => {
    await createEventTool(
      { title: "x", kind: "bogus" },
      "event-invalid-kind-request",
    );
    expect(m.agentCreateEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "generic" }),
    );
  });

  it("agentCreateEvent の例外は error として返す（throw しない）", async () => {
    m.agentCreateEvent.mockRejectedValueOnce(new Error("policy off"));
    const r = await createEventTool({ title: "x" }, "event-error-request");
    expect(r.error).toBe("policy off");
    expect(r.content).toBeNull();
  });
});

describe("durable Chronicle request identity", () => {
  it("全 mutating tool は Executor 由来 requestId 欠落時に writer を呼ばない", async () => {
    const results = await Promise.all([
      createEventTool({ title: "x" }),
      updateEventTool({ eventId: "e1", title: "x" }),
      deleteEventTool({ eventId: "e1" }),
      stampSceneEventTool({ sceneId: "s1", eventId: "e1" }),
      unstampSceneEventTool({ sceneId: "s1", eventId: "e1" }),
      setEventParticipantsTool({ eventId: "e1", codexEntryIds: [] }),
      addEventRelationTool({ causeEventId: "a", effectEventId: "b" }),
      removeEventRelationTool({ causeEventId: "a", effectEventId: "b" }),
    ]);

    for (const result of results) {
      expect(result.error).toBe("request identity is required");
    }
    for (const writer of Object.values(m)) {
      expect(writer).not.toHaveBeenCalled();
    }
  });
});

describe("update/delete", () => {
  it("update_event は eventId 必須", async () => {
    expect((await updateEventTool({})).error).toBe("eventId is required");
  });
  it("update_event は可視性確認時の version を CAS base に渡す", async () => {
    await updateEventTool(
      { eventId: "e1", title: "updated" },
      "event-update-request",
    );
    expect(m.agentUpdateEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "e1",
        baseVersion: 4,
        title: "updated",
      }),
      { requestId: "event-update-request" },
    );
  });
  it("delete_event は agentDeleteEvent を呼ぶ", async () => {
    await deleteEventTool({ eventId: "e1" }, "event-delete-request");
    expect(m.agentDeleteEvent).toHaveBeenCalledWith("e1", {
      baseVersion: 4,
      requestId: "event-delete-request",
    });
  });
});

describe("scene stamp/unstamp", () => {
  it("stamp は sceneId+eventId 必須", async () => {
    expect((await stampSceneEventTool({ sceneId: "s1" })).error).toContain(
      "required",
    );
  });
  it("stamp/unstamp が対応関数を呼ぶ", async () => {
    await stampSceneEventTool(
      { sceneId: "s1", eventId: "e1" },
      "event-stamp-request",
    );
    expect(m.agentLinkSceneEvent).toHaveBeenCalledWith("s1", "e1", {
      requestId: "event-stamp-request",
    });
    await unstampSceneEventTool(
      { sceneId: "s1", eventId: "e1" },
      "event-unstamp-request",
    );
    expect(m.agentUnlinkSceneEvent).toHaveBeenCalledWith("s1", "e1", {
      requestId: "event-unstamp-request",
    });
  });
});

describe("participants / relations", () => {
  it("set_event_participants は codex 配列を渡す", async () => {
    await setEventParticipantsTool(
      {
        eventId: "e1",
        codexEntryIds: ["c1", "c2"],
      },
      "event-participants-request",
    );
    expect(m.agentSetEventParticipants).toHaveBeenCalledWith(
      "e1",
      ["c1", "c2"],
      { baseVersion: 4, requestId: "event-participants-request" },
    );
  });
  it("relation add/remove は cause+effect 必須＋呼び出し", async () => {
    expect((await addEventRelationTool({ causeEventId: "a" })).error).toContain(
      "required",
    );
    await addEventRelationTool(
      { causeEventId: "a", effectEventId: "b" },
      "event-relation-add-request",
    );
    expect(m.agentAddEventRelation).toHaveBeenCalledWith("a", "b", {
      requestId: "event-relation-add-request",
    });
    await removeEventRelationTool(
      { causeEventId: "a", effectEventId: "b" },
      "event-relation-remove-request",
    );
    expect(m.agentRemoveEventRelation).toHaveBeenCalledWith("a", "b", {
      requestId: "event-relation-remove-request",
    });
  });
});

describe("ターン内共有キャッシュ", () => {
  it("relation add は cause/effect 2 回の可視性チェックで listEvents を 1 回に畳む", async () => {
    await addEventRelationTool(
      { causeEventId: "a", effectEventId: "b" },
      "event-relation-cache-request",
    );
    expect(m.agentAddEventRelation).toHaveBeenCalledWith("a", "b", {
      requestId: "event-relation-cache-request",
    });
    expect(apiMock.listEvents).toHaveBeenCalledTimes(1);
  });

  it("write 後はキャッシュを破棄し、次のチェックで再ロードする", async () => {
    await updateEventTool(
      { eventId: "e1", title: "x" },
      "event-update-cache-request-1",
    );
    await updateEventTool(
      { eventId: "e1", title: "y" },
      "event-update-cache-request-2",
    );
    expect(m.agentUpdateEvent).toHaveBeenCalledTimes(2);
    expect(apiMock.listEvents).toHaveBeenCalledTimes(2);
  });
});

describe("AI 秘匿 write-by-id ゲート", () => {
  it("hidden な secret event への update/delete は呼ばず generic not found", async () => {
    apiMock.listEvents.mockResolvedValueOnce([
      { id: "sec", secret: true, revealSceneId: null, version: 5 },
    ]);
    const r = await updateEventTool({ eventId: "sec", title: "leak" });
    expect(r.error).toBe("Event not found");
    expect(m.agentUpdateEvent).not.toHaveBeenCalled();

    // 次ターン相当としてキャッシュを破棄し、2 個目の mockResolvedValueOnce を使わせる。
    invalidateChronicleToolCache();
    apiMock.listEvents.mockResolvedValueOnce([
      { id: "sec", secret: true, revealSceneId: null, version: 5 },
    ]);
    const d = await deleteEventTool({ eventId: "sec" });
    expect(d.error).toBe("Event not found");
    expect(m.agentDeleteEvent).not.toHaveBeenCalled();
  });
});

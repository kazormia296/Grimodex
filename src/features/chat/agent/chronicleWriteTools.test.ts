import { CHRONICLE_EVENT_DATE_REQUIRED } from "@/../electron/shared/chronicleEventDate";
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  agentCreateEvent: vi.fn(async (_input: Record<string, unknown>) => ({
    id: "e-new",
    title: "戴冠",
  })),
  agentUpdateEvent: vi.fn(async (_input: Record<string, unknown>) => undefined),
  agentDeleteEvent: vi.fn(async () => undefined),
  agentSetEventParticipants: vi.fn(async () => undefined),
  agentLinkSceneEvent: vi.fn(async () => undefined),
  agentUnlinkSceneEvent: vi.fn(async () => undefined),
  agentAddEventRelation: vi.fn(async () => undefined),
  agentRemoveEventRelation: vi.fn(async () => undefined),
}));
vi.mock("@/features/agent-writes/event", () => m);

// write-by-id は現在 project の出来事を対象にする。
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: {
    getState: () => ({ projectId: "p1", nodes: [], activeSceneId: "s1" }),
  },
}));
const apiMock = vi.hoisted(() => ({
  listEvents: vi.fn(async (projectId: string) =>
    [
      {
        id: "e1",
        projectId: "p1",
        secret: true,
        revealSceneId: null as string | null,
        version: 4,
      },
      {
        id: "a",
        projectId: "p1",
        secret: true,
        revealSceneId: null as string | null,
        version: 2,
      },
      {
        id: "b",
        projectId: "p1",
        secret: false,
        revealSceneId: null as string | null,
        version: 3,
      },
      {
        id: "other-project-event",
        projectId: "p2",
        secret: true,
        revealSceneId: null as string | null,
        version: 9,
      },
    ].filter((event) => event.projectId === projectId),
  ),
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

  it.each([
    [{ title: "dated" }, CHRONICLE_EVENT_DATE_REQUIRED],
    [{ title: "dated", startTime: 1 }, "precision is required"],
    [
      { title: "dated", startTime: "1", precision: "exact" },
      CHRONICLE_EVENT_DATE_REQUIRED,
    ],
    [
      { title: "dated", startTime: 1, precision: "certain" },
      "precision is required",
    ],
    [
      {
        title: "dated",
        startTime: 1,
        precision: "exact",
        startGranularity: "none",
      },
      CHRONICLE_EVENT_DATE_REQUIRED,
    ],
  ])("必須日時・確度と粒度を検証する: %j", async (input, error) => {
    const result = await createEventTool(input);
    expect(result.error).toContain(error);
    expect(m.agentCreateEvent).not.toHaveBeenCalled();
  });

  it("入力を parse して agentCreateEvent を呼び id を返す", async () => {
    const r = await createEventTool(
      {
        title: "戴冠",
        kind: "generic",
        precision: "approx",
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
        precision: "approx",
        participantCodexIds: ["c2", "c3"],
        sceneIds: ["s1"],
      }),
    );
    expect(m.agentCreateEvent.mock.calls[0]?.[0]).not.toHaveProperty("secret");
    expect((r.content as { id: string }).id).toBe("e-new");
  });

  it.each([true, "true", 1, null])(
    "secret=%j は Native writer を呼ばずに拒否する",
    async (secret) => {
      const r = await createEventTool(
        { title: "x", secret },
        "event-secret-rejected-request",
      );
      expect(r.error).toBe(
        "secret is no longer supported: events cannot be hidden from the AI. Omit it.",
      );
      expect(m.agentCreateEvent).not.toHaveBeenCalled();
    },
  );

  it("secret=false は捨てて Native writer に渡さない", async () => {
    await createEventTool(
      { title: "x", startTime: 1, precision: "exact", secret: false },
      "event-secret-false-request",
    );
    expect(m.agentCreateEvent.mock.calls[0]?.[0]).not.toHaveProperty("secret");
  });

  it("不正 kind は generic に丸める", async () => {
    await createEventTool(
      { title: "x", kind: "bogus", startTime: 1, precision: "exact" },
      "event-invalid-kind-request",
    );
    expect(m.agentCreateEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "generic" }),
    );
  });

  it("agentCreateEvent の例外は error として返す（throw しない）", async () => {
    m.agentCreateEvent.mockRejectedValueOnce(new Error("policy off"));
    const r = await createEventTool(
      { title: "x", startTime: 1, precision: "exact" },
      "event-error-request",
    );
    expect(r.error).toBe("policy off");
    expect(r.content).toBeNull();
  });
});

describe("durable Chronicle request identity", () => {
  it("全 mutating tool は Executor 由来 requestId 欠落時に writer を呼ばない", async () => {
    const results = await Promise.all([
      createEventTool({ title: "x", startTime: 1, precision: "exact" }),
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

  it.each([
    [{ eventId: "e1", startTime: null }, CHRONICLE_EVENT_DATE_REQUIRED],
    [
      { eventId: "e1", startGranularity: "none" },
      CHRONICLE_EVENT_DATE_REQUIRED,
    ],
    [{ eventId: "e1", precision: "certain" }, "precision must be one of"],
  ])("update_event は日時削除・無効値を拒否する: %j", async (input, error) => {
    const result = await updateEventTool(input, "event-update-request");
    expect(result.error).toContain(error);
    expect(m.agentUpdateEvent).not.toHaveBeenCalled();
  });
  it("project 内 event lookup で得た version を CAS base に渡す", async () => {
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
    expect(m.agentUpdateEvent.mock.calls[0]?.[0]).not.toHaveProperty("secret");
  });

  it.each([true, "true", 1, null])(
    "update_event の secret=%j は Native writer を呼ばずに拒否する",
    async (secret) => {
      const r = await updateEventTool(
        { eventId: "e1", secret },
        "event-update-secret-rejected-request",
      );
      expect(r.error).toBe(
        "secret is no longer supported: events cannot be hidden from the AI. Omit it.",
      );
      expect(m.agentUpdateEvent).not.toHaveBeenCalled();
    },
  );

  it("update_event の secret=false は捨てて Native writer に渡さない", async () => {
    await updateEventTool(
      { eventId: "e1", precision: "approx", secret: false },
      "event-update-secret-false-request",
    );
    expect(m.agentUpdateEvent.mock.calls[0]?.[0]).not.toHaveProperty("secret");
    expect(m.agentUpdateEvent.mock.calls[0]?.[0]).toHaveProperty(
      "precision",
      "approx",
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
  it("stamp/unstamp allow a secret event by id", async () => {
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
  it("set_event_participants allows a secret event by id", async () => {
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
  it("relation add/remove allow a secret event endpoint", async () => {
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
  it("relation add は cause/effect の存在確認で listEvents を 1 回に畳む", async () => {
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

describe("write-by-id project scope", () => {
  it("allows secret project events and retains the event version for update/delete", async () => {
    await updateEventTool(
      { eventId: "e1", title: "updated" },
      "secret-update-request",
    );
    expect(m.agentUpdateEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "e1", baseVersion: 4 }),
      { requestId: "secret-update-request" },
    );

    await deleteEventTool({ eventId: "e1" }, "secret-delete-request");
    expect(m.agentDeleteEvent).toHaveBeenCalledWith("e1", {
      baseVersion: 4,
      requestId: "secret-delete-request",
    });
    expect(apiMock.listSceneEventsForProject).not.toHaveBeenCalled();
  });

  it("does not find events outside the current project or absent ids", async () => {
    for (const eventId of ["other-project-event", "missing-event"]) {
      expect((await updateEventTool({ eventId, title: "updated" })).error).toBe(
        "Event not found",
      );
    }
    expect(m.agentUpdateEvent).not.toHaveBeenCalled();
  });
});

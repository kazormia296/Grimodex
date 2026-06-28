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

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockClear();
});

describe("createEventTool", () => {
  it("title 必須", async () => {
    const r = await createEventTool({});
    expect(r.error).toBe("title is required");
    expect(m.agentCreateEvent).not.toHaveBeenCalled();
  });

  it("入力を parse して agentCreateEvent を呼び id を返す", async () => {
    const r = await createEventTool({
      title: "戴冠",
      kind: "generic",
      primaryCodexId: "c1",
      startTime: 12,
      participantCodexIds: ["c2", "c3"],
      sceneIds: ["s1"],
    });
    expect(m.agentCreateEvent).toHaveBeenCalledWith(
      expect.objectContaining({
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
    await createEventTool({ title: "x", kind: "bogus" });
    expect(m.agentCreateEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "generic" }),
    );
  });

  it("agentCreateEvent の例外は error として返す（throw しない）", async () => {
    m.agentCreateEvent.mockRejectedValueOnce(new Error("policy off"));
    const r = await createEventTool({ title: "x" });
    expect(r.error).toBe("policy off");
    expect(r.content).toBeNull();
  });
});

describe("update/delete", () => {
  it("update_event は eventId 必須", async () => {
    expect((await updateEventTool({})).error).toBe("eventId is required");
  });
  it("delete_event は agentDeleteEvent を呼ぶ", async () => {
    await deleteEventTool({ eventId: "e1" });
    expect(m.agentDeleteEvent).toHaveBeenCalledWith("e1");
  });
});

describe("scene stamp/unstamp", () => {
  it("stamp は sceneId+eventId 必須", async () => {
    expect((await stampSceneEventTool({ sceneId: "s1" })).error).toContain(
      "required",
    );
  });
  it("stamp/unstamp が対応関数を呼ぶ", async () => {
    await stampSceneEventTool({ sceneId: "s1", eventId: "e1" });
    expect(m.agentLinkSceneEvent).toHaveBeenCalledWith("s1", "e1");
    await unstampSceneEventTool({ sceneId: "s1", eventId: "e1" });
    expect(m.agentUnlinkSceneEvent).toHaveBeenCalledWith("s1", "e1");
  });
});

describe("participants / relations", () => {
  it("set_event_participants は codex 配列を渡す", async () => {
    await setEventParticipantsTool({
      eventId: "e1",
      codexEntryIds: ["c1", "c2"],
    });
    expect(m.agentSetEventParticipants).toHaveBeenCalledWith("e1", [
      "c1",
      "c2",
    ]);
  });
  it("relation add/remove は cause+effect 必須＋呼び出し", async () => {
    expect((await addEventRelationTool({ causeEventId: "a" })).error).toContain(
      "required",
    );
    await addEventRelationTool({ causeEventId: "a", effectEventId: "b" });
    expect(m.agentAddEventRelation).toHaveBeenCalledWith("a", "b");
    await removeEventRelationTool({ causeEventId: "a", effectEventId: "b" });
    expect(m.agentRemoveEventRelation).toHaveBeenCalledWith("a", "b");
  });
});

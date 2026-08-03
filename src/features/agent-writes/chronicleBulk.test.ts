import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  bumpRevision: vi.fn(),
  push: vi.fn(),
  notify: vi.fn(),
  scheduleEventIndex: vi.fn(),
  applyUndoJournal: vi.fn(),
  reloadTree: vi.fn(),
  runAuthoritativeMutation: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("@/features/timelapse/recorder", () => ({
  getRecorderSessionId: () => "session-1",
}));
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "project-1",
}));
vi.mock("@/store/globalHistoryStore", () => ({
  useGlobalHistoryStore: {
    getState: () => ({ isReplaying: false, push: mocks.push }),
  },
}));
vi.mock("@/features/chronicle/chronicleStore", () => ({
  useChronicleStore: {
    getState: () => ({ bumpRevision: mocks.bumpRevision }),
  },
}));
vi.mock("@/features/semantic-search/scheduler", () => ({
  scheduleEventIndex: mocks.scheduleEventIndex,
}));
vi.mock("@/features/concurrency/documentWriteNotification", () => ({
  notifySameRendererDocumentWrite: mocks.notify,
}));
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: {
    getState: () => ({ reloadTreeOrThrow: mocks.reloadTree }),
  },
}));
vi.mock("@/features/concurrency/mutationAuthority", () => ({
  captureMutationAuthority: () => ({
    projectId: "project-1",
    workspacePath: "/workspace",
    workspaceOpenRevision: 3,
  }),
  isCurrentMutationAuthority: () => true,
  runAuthoritativeMutation: mocks.runAuthoritativeMutation,
}));
vi.mock("./undoJournal", () => ({
  applyUndoJournal: mocks.applyUndoJournal,
}));

import { uiMutateChronicleBulk } from "./chronicleBulk";

describe("uiMutateChronicleBulk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invoke.mockResolvedValue({
      eventResults: [
        { kind: "eventDelete", eventId: "e1", version: null },
        { kind: "eventClearDate", eventId: "e2", version: 4 },
        { kind: "eventSetLane", eventId: "e3", version: 6 },
      ],
      sceneResults: [],
      changeEventUid: "ce1",
      undoJournalId: "uj1",
    });
    mocks.applyUndoJournal.mockResolvedValue(undefined);
    mocks.reloadTree.mockResolvedValue(undefined);
    mocks.runAuthoritativeMutation.mockImplementation(
      async (_authority: unknown, mutation: () => Promise<unknown>) => ({
        status: "current",
        value: await mutation(),
      }),
    );
  });

  it("mixed selection を1 IPC・1 revision・1 history entryとして発行する", async () => {
    await uiMutateChronicleBulk([
      { kind: "eventDelete", eventId: "e1", baseVersion: 2 },
      { kind: "eventClearDate", eventId: "e2", baseVersion: 3 },
      {
        kind: "eventSetLane",
        eventId: "e3",
        baseVersion: 5,
        primaryCodexId: "c1",
        laneGroup: null,
      },
    ]);

    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith("agent_chronicle_bulk_mutate", {
      payload: {
        requestId: expect.any(String),
        projectId: "project-1",
        sessionId: "session-1",
        surface: "manual",
        operations: [
          { kind: "eventDelete", eventId: "e1", baseVersion: 2 },
          { kind: "eventClearDate", eventId: "e2", baseVersion: 3 },
          {
            kind: "eventSetLane",
            eventId: "e3",
            baseVersion: 5,
            primaryCodexId: "c1",
            laneGroup: null,
          },
        ],
      },
    });
    expect(mocks.bumpRevision).toHaveBeenCalledTimes(1);
    expect(mocks.push).toHaveBeenCalledTimes(1);
    expect(mocks.notify).toHaveBeenCalledTimes(3);
    expect(mocks.scheduleEventIndex).toHaveBeenCalledWith("e2");
    expect(mocks.scheduleEventIndex).toHaveBeenCalledWith("e3");
    expect(mocks.push).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "uj1",
        affectedEntities: [
          { kind: "chronicle", entityId: "e1" },
          { kind: "chronicle", entityId: "e2" },
          { kind: "chronicle", entityId: "e3" },
        ],
      }),
    );
  });

  it("同一scope・同一payloadの同時実行は1 IPC・1 publicationへsingle-flightする", async () => {
    let resolveInvoke: (value: {
      eventResults: Array<{
        kind: "eventSetDate";
        eventId: string;
        version: number;
      }>;
      sceneResults: [];
      changeEventUid: string;
      undoJournalId: string;
    }) => void = () => {};
    const native = new Promise<{
      eventResults: Array<{
        kind: "eventSetDate";
        eventId: string;
        version: number;
      }>;
      sceneResults: [];
      changeEventUid: string;
      undoJournalId: string;
    }>((resolve) => {
      resolveInvoke = resolve;
    });
    mocks.invoke.mockReturnValueOnce(native);
    const operations = [
      {
        kind: "eventSetDate" as const,
        eventId: "e-date",
        baseVersion: 3,
        startTime: 10,
        startMinute: 30,
        startGranularity: "time" as const,
        endTime: null,
        endMinute: null,
        endGranularity: "none" as const,
      },
    ];

    const first = uiMutateChronicleBulk(operations);
    const second = uiMutateChronicleBulk(operations);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);

    resolveInvoke({
      eventResults: [{ kind: "eventSetDate", eventId: "e-date", version: 4 }],
      sceneResults: [],
      changeEventUid: "ce-date",
      undoJournalId: "uj-date",
    });
    await Promise.all([first, second]);

    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.bumpRevision).toHaveBeenCalledTimes(1);
    expect(mocks.push).toHaveBeenCalledTimes(1);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });

  it("forward の outcome unknown は同じ requestId と完全payloadで再試行する", async () => {
    const unknown = { outcome: "unknown", code: "IPC_TIMEOUT" };
    const operations = [
      { kind: "eventClearDate" as const, eventId: "e2", baseVersion: 3 },
    ];
    mocks.invoke.mockRejectedValueOnce(unknown);

    await expect(uiMutateChronicleBulk(operations)).rejects.toBe(unknown);
    const firstPayload = mocks.invoke.mock.calls[0][1].payload;

    await uiMutateChronicleBulk(operations);
    const retriedPayload = mocks.invoke.mock.calls[1][1].payload;

    expect(retriedPayload).toEqual(firstPayload);
    expect(retriedPayload.requestId).toBe(firstPayload.requestId);
    expect(mocks.push).toHaveBeenCalledTimes(1);
  });

  it("native成功後のpublication失敗も同じ forward requestId で再開する", async () => {
    const publicationFailure = new Error("history publication failed");
    mocks.push.mockImplementationOnce(() => {
      throw publicationFailure;
    });
    const operations = [
      { kind: "eventClearDate" as const, eventId: "e2", baseVersion: 3 },
    ];

    await expect(uiMutateChronicleBulk(operations)).rejects.toBe(
      publicationFailure,
    );
    const firstPayload = mocks.invoke.mock.calls[0][1].payload;

    await uiMutateChronicleBulk(operations);

    expect(mocks.invoke.mock.calls[1][1].payload).toEqual(firstPayload);
    expect(mocks.invoke.mock.calls[1][1].payload.requestId).toBe(
      firstPayload.requestId,
    );
    expect(mocks.push).toHaveBeenCalledTimes(2);
  });

  it("native未実行のstale precheckは pending requestId を解放する", async () => {
    const randomUuid = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000002");
    mocks.runAuthoritativeMutation.mockResolvedValueOnce({ status: "stale" });
    const operations = [
      { kind: "eventClearDate" as const, eventId: "e2", baseVersion: 3 },
    ];

    await expect(uiMutateChronicleBulk(operations)).rejects.toThrow(
      "authority changed",
    );
    expect(mocks.invoke).not.toHaveBeenCalled();

    await uiMutateChronicleBulk(operations);
    expect(mocks.invoke.mock.calls[0][1].payload.requestId).toBe(
      "00000000-0000-4000-8000-000000000002",
    );
    randomUuid.mockRestore();
  });

  it("value付きstale completionは committed requestId を保持する", async () => {
    mocks.runAuthoritativeMutation.mockImplementationOnce(
      async (_authority: unknown, mutation: () => Promise<unknown>) => ({
        status: "stale",
        value: await mutation(),
      }),
    );
    const operations = [
      { kind: "eventClearDate" as const, eventId: "e2", baseVersion: 3 },
    ];

    await expect(uiMutateChronicleBulk(operations)).rejects.toThrow(
      "authority changed",
    );
    const committedPayload = mocks.invoke.mock.calls[0][1].payload;

    await uiMutateChronicleBulk(operations);
    expect(mocks.invoke.mock.calls[1][1].payload).toEqual(committedPayload);
  });

  it("同方向 undo の unknown retry は requestId を保持し、確定後は新しいIDにする", async () => {
    await uiMutateChronicleBulk([
      { kind: "eventClearDate", eventId: "e2", baseVersion: 3 },
    ]);
    const command = mocks.push.mock.calls[0][0] as {
      undo: () => Promise<void>;
      redo: () => Promise<void>;
    };
    const unknown = { outcome: "unknown", code: "IPC_TIMEOUT" };
    mocks.applyUndoJournal.mockRejectedValueOnce(unknown);

    await expect(command.undo()).rejects.toBe(unknown);
    await command.undo();
    await command.redo();
    await command.undo();

    const requestIds = mocks.applyUndoJournal.mock.calls.map(
      (call) => call[2] as string,
    );
    expect(requestIds[1]).toBe(requestIds[0]);
    expect(requestIds[3]).not.toBe(requestIds[1]);
  });

  it("bulk delete の undo は復元した Event の意味索引を再構築する", async () => {
    await uiMutateChronicleBulk([
      { kind: "eventDelete", eventId: "e-deleted", baseVersion: 3 },
    ]);
    const command = mocks.push.mock.calls[0][0] as {
      undo: () => Promise<void>;
    };
    mocks.scheduleEventIndex.mockClear();

    await command.undo();

    expect(mocks.scheduleEventIndex).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleEventIndex).toHaveBeenCalledWith("e-deleted");
  });

  it("scene replay はreload失敗を伝播し、再開まで同じrequestIdを保持する", async () => {
    mocks.invoke.mockResolvedValueOnce({
      eventResults: [],
      sceneResults: [
        {
          kind: "sceneClearDate",
          sceneId: "scene-1",
          updatedAt: "2026-07-29T01:00:00.000Z",
        },
      ],
      changeEventUid: "ce-scene",
      undoJournalId: "uj-scene",
    });
    await uiMutateChronicleBulk([
      {
        kind: "sceneClearDate",
        sceneId: "scene-1",
        baseUpdatedAt: "2026-07-29T00:00:00.000Z",
      },
    ]);
    const command = mocks.push.mock.calls[0][0] as {
      undo: () => Promise<void>;
      redo: () => Promise<void>;
    };
    const reloadFailure = new Error("tree reload failed");
    mocks.reloadTree.mockRejectedValueOnce(reloadFailure);

    await expect(command.undo()).rejects.toBe(reloadFailure);
    const firstUndoRequestId = mocks.applyUndoJournal.mock.calls[0][2];

    await command.undo();

    expect(mocks.applyUndoJournal).toHaveBeenNthCalledWith(
      1,
      "uj-scene",
      "undo",
      expect.any(String),
    );
    expect(mocks.applyUndoJournal.mock.calls[1][2]).toBe(firstUndoRequestId);
    expect(mocks.reloadTree).toHaveBeenNthCalledWith(1, "project-1", 3);
    expect(mocks.reloadTree).toHaveBeenNthCalledWith(2, "project-1", 3);
    expect(mocks.bumpRevision).toHaveBeenCalledTimes(2);

    await command.redo();
    await command.undo();
    expect(mocks.applyUndoJournal.mock.calls[3][2]).not.toBe(
      firstUndoRequestId,
    );
  });

  it("空 selection は IPC 前に拒否する", async () => {
    await expect(uiMutateChronicleBulk([])).rejects.toThrow(
      "requires at least one operation",
    );
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

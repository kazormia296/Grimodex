import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  reloadTree: vi.fn().mockResolvedValue(undefined),
  loadCodex: vi.fn().mockResolvedValue(undefined),
  loadSnippets: vi.fn().mockResolvedValue(undefined),
  loadForeshadows: vi.fn().mockResolvedValue(undefined),
  bumpChronicle: vi.fn(),
  loadPlot: vi.fn().mockResolvedValue(undefined),
  loadLabels: vi.fn().mockResolvedValue(undefined),
  dirtyTabs: new Set<string>(),
  // When true, the mocked drizzle query rejects like a stalled db_execute
  // (e.g. blocked behind the native save dialog during timelapse export).
  dbReject: false,
  dbResponses: [] as Array<unknown[] | Promise<unknown[]>>,
}));

// pollTick() reads change_events via the drizzle proxy (db.select()...). Mock it
// so a transient IPC/DB failure can be simulated; defaults to resolving [] so the
// fan-out tests (which never touch db) are unaffected.
vi.mock("@/db/client", () => {
  const makeQuery = () => {
    const q: Record<string, unknown> = {
      from: () => q,
      where: () => q,
      orderBy: () => q,
      limit: () => q,
      then: (resolve: (v: unknown[]) => void, reject: (e: unknown) => void) => {
        if (h.dbReject) {
          reject(new Error("IPC timeout after 10000ms: db_execute"));
          return;
        }
        void Promise.resolve(h.dbResponses.shift() ?? []).then(resolve, reject);
      },
    };
    return q;
  };
  return { db: { select: () => makeQuery() } };
});

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: {
    getState: () => ({
      reloadTreeOrThrow: h.reloadTree,
    }),
  },
}));

vi.mock("@/features/codex/codexStore", () => ({
  useCodexStore: {
    getState: () => ({ loadEntries: h.loadCodex }),
  },
}));

vi.mock("@/features/snippets/snippetStore", () => ({
  useSnippetStore: {
    getState: () => ({ loadEntries: h.loadSnippets }),
  },
}));

vi.mock("@/features/editor/tabStore", () => ({
  useTabStore: {
    getState: () => ({ dirtyTabIds: h.dirtyTabs, setTabDirty: vi.fn() }),
  },
}));

vi.mock("@/features/editor/editorSessionStore", () => ({
  useEditorSessionStore: {
    getState: () => ({ dirtyDocumentIds: h.dirtyTabs }),
  },
}));

vi.mock("@/features/foreshadow/foreshadowStore", () => ({
  useForeshadowStore: {
    getState: () => ({ load: h.loadForeshadows }),
  },
}));

vi.mock("@/features/chronicle/chronicleStore", () => ({
  useChronicleStore: {
    getState: () => ({ bumpRevision: h.bumpChronicle }),
  },
}));

vi.mock("@/features/plot-threads/plotThreadStore", () => ({
  usePlotThreadStore: {
    getState: () => ({ load: h.loadPlot }),
  },
}));

vi.mock("@/features/labels/labelStore", () => ({
  useLabelStore: {
    getState: () => ({ load: h.loadLabels }),
  },
}));

import {
  processExternalEventsForTest,
  stopExternalWriteFeed,
  startExternalWriteFeed,
  pollExternalWritesForTest,
  getExternalWriteCursorForTest,
} from "./externalWriteFeed";
import { useExternalWriteStore } from "./externalWriteStore";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { useInlineAiStore } from "@/features/editor/inlineAi/inlineAiStore";
import {
  encodeDocumentKey,
  type DocumentKey,
} from "@/features/editor/document/documentKey";
import { PhaseVersionConflictError } from "@/features/codex/phaseOcc";

const editorStateKey = (key: DocumentKey): string => encodeDocumentKey(key);

const ev = (
  partial: Partial<{
    sequence: number;
    domain: string;
    sceneId: string | null;
    entityType: string | null;
    entityId: string | null;
    opType: string;
    payload: string;
  }>,
) => ({
  id: 1,
  eventUid: "uid",
  projectId: "p1",
  sessionId: "other",
  sequence: partial.sequence ?? 1,
  domain: partial.domain ?? "codex",
  opType: partial.opType ?? "entry.create",
  entityType: partial.entityType ?? null,
  entityId: partial.entityId ?? null,
  sceneId: partial.sceneId ?? null,
  payload: partial.payload ?? "{}",
  timestamp: Date.now(),
  prevHash: "0",
  hash: "1",
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("externalWriteFeed fan-out", () => {
  beforeEach(() => {
    stopExternalWriteFeed();
    h.reloadTree.mockClear();
    h.loadCodex.mockClear();
    h.loadSnippets.mockClear();
    h.loadForeshadows.mockClear();
    h.bumpChronicle.mockClear();
    h.loadPlot.mockClear();
    h.loadLabels.mockClear();
    h.dirtyTabs = new Set();
    useExternalWriteStore.getState().clear();
    useGlobalHistoryStore.getState().clear();
    useInlineAiStore.getState().reset();
  });

  it("reloads codex store on codex domain events", async () => {
    await processExternalEventsForTest([ev({ domain: "codex" })], "p1");
    expect(h.loadCodex).toHaveBeenCalledTimes(1);
  });

  it("reloads tree on grid domain events", async () => {
    await processExternalEventsForTest([ev({ domain: "grid" })], "p1");
    expect(h.reloadTree).toHaveBeenCalledWith("p1");
  });

  it("reloads foreshadow store on foreshadow domain events", async () => {
    await processExternalEventsForTest(
      [
        ev({
          domain: "foreshadow",
          opType: "foreshadow.create",
          entityType: "foreshadow",
          entityId: "f1",
        }),
      ],
      "p1",
    );
    expect(h.loadForeshadows).toHaveBeenCalledWith("p1");
  });

  it("bumps chronicle revision on event (chronicle) domain events", async () => {
    await processExternalEventsForTest(
      [
        ev({
          domain: "event",
          opType: "event.create",
          entityType: "event",
          entityId: "e1",
        }),
      ],
      "p1",
    );
    expect(h.bumpChronicle).toHaveBeenCalledTimes(1);
  });

  it("reloads plot threads on plot domain events", async () => {
    await processExternalEventsForTest(
      [ev({ domain: "plot", opType: "plot.update" })],
      "p1",
    );
    expect(h.loadPlot).toHaveBeenCalledWith("p1");
  });

  it("reloads labels on labels domain events", async () => {
    await processExternalEventsForTest(
      [ev({ domain: "labels", opType: "label.create" })],
      "p1",
    );
    expect(h.loadLabels).toHaveBeenCalledWith("p1");
  });

  it("pushes conflict for dirty editor scene", async () => {
    h.dirtyTabs.add("scene-1");
    await processExternalEventsForTest(
      [
        ev({
          domain: "editor",
          sceneId: "scene-1",
          entityType: "scene",
          entityId: "scene-1",
          opType: "body.update",
        }),
      ],
      "p1",
    );
    expect(useExternalWriteStore.getState().conflicts).toHaveLength(1);
    expect(
      useExternalWriteStore.getState().reloadNonce[
        editorStateKey({
          kind: "tree",
          id: "scene-1",
          storage: "database",
        })
      ],
    ).toBeUndefined();
  });

  it("bumps reload nonce for clean editor scene", async () => {
    await processExternalEventsForTest(
      [
        ev({
          domain: "editor",
          sceneId: "scene-2",
          entityType: "scene",
          entityId: "scene-2",
        }),
      ],
      "p1",
    );
    expect(
      useExternalWriteStore.getState().reloadNonce[
        editorStateKey({
          kind: "tree",
          id: "scene-2",
          storage: "database",
        })
      ],
    ).toBe(1);
  });

  it("pushes conflict instead of reloading clean editor scene while inline AI is pending", async () => {
    useInlineAiStore.getState().startGeneration({
      commandId: "continue",
      mode: "insert",
      originalRange: null,
      originalText: "",
      insertPos: 1,
      abortController: new AbortController(),
    });
    useInlineAiStore.getState().finishGeneration("m");

    await processExternalEventsForTest(
      [
        ev({
          domain: "editor",
          sceneId: "scene-pending",
          entityType: "scene",
          entityId: "scene-pending",
          opType: "body.update",
        }),
      ],
      "p1",
    );

    expect(useExternalWriteStore.getState().conflicts).toHaveLength(1);
    expect(useExternalWriteStore.getState().conflicts[0]).toMatchObject({
      sceneId: "scene-pending",
      domain: "editor",
      opType: "body.update",
      entityId: "scene-pending",
    });
    expect(
      useExternalWriteStore.getState().reloadNonce[
        editorStateKey({
          kind: "tree",
          id: "scene-pending",
          storage: "database",
        })
      ],
    ).toBeUndefined();
  });

  it("pushes conflict for dirty snippet tab", async () => {
    h.dirtyTabs.add("snippet-1");
    await processExternalEventsForTest(
      [
        ev({
          domain: "snippet",
          entityType: "snippet",
          entityId: "snippet-1",
          opType: "snippet.update",
        }),
      ],
      "p1",
    );
    expect(useExternalWriteStore.getState().conflicts).toHaveLength(1);
    expect(useExternalWriteStore.getState().conflicts[0].sceneId).toBe(
      "snippet-1",
    );
  });

  it("bumps reload nonce for clean snippet tab", async () => {
    await processExternalEventsForTest(
      [
        ev({
          domain: "snippet",
          entityType: "snippet",
          entityId: "snippet-2",
          opType: "snippet.create",
        }),
      ],
      "p1",
    );
    expect(
      useExternalWriteStore.getState().reloadNonce[
        editorStateKey({ kind: "snippet", id: "snippet-2" })
      ],
    ).toBe(1);
  });

  it("pushes a conflict for a dirty Chronicle Event editor", async () => {
    h.dirtyTabs.add("event-1");

    await processExternalEventsForTest(
      [
        ev({
          domain: "event",
          entityType: "event",
          entityId: "event-1",
          opType: "event.update",
        }),
      ],
      "p1",
    );

    expect(useExternalWriteStore.getState().conflicts).toEqual([
      expect.objectContaining({
        documentKey: { kind: "chronicle-event", id: "event-1" },
        sceneId: "event-1",
      }),
    ]);
  });

  it("reloads a clean Chronicle Event editor", async () => {
    await processExternalEventsForTest(
      [
        ev({
          domain: "event",
          entityType: "event",
          entityId: "event-2",
          opType: "event.update",
        }),
      ],
      "p1",
    );

    expect(
      useExternalWriteStore.getState().reloadNonce[
        editorStateKey({ kind: "chronicle-event", id: "event-2" })
      ],
    ).toBe(1);
  });

  it("does not treat event relation metadata as a document-body change", async () => {
    h.dirtyTabs.add("event-relation");

    await processExternalEventsForTest(
      [
        ev({
          domain: "event",
          entityType: "event",
          entityId: "event-relation",
          opType: "event.relation_add",
        }),
      ],
      "p1",
    );

    expect(h.bumpChronicle).toHaveBeenCalledOnce();
    expect(useExternalWriteStore.getState().conflicts).toHaveLength(0);
    expect(
      useExternalWriteStore.getState().reloadNonce[
        editorStateKey({ kind: "chronicle-event", id: "event-relation" })
      ],
    ).toBeUndefined();
  });

  it("invalidates stale Chronicle history for an externally updated event", async () => {
    useGlobalHistoryStore.getState().push({
      kind: "chronicle",
      label: "stale event edit",
      entityId: "event-history",
      undo: async () => {},
      redo: async () => {},
    });

    await processExternalEventsForTest(
      [
        ev({
          domain: "event",
          entityType: "event",
          entityId: "event-history",
          opType: "event.update",
        }),
      ],
      "p1",
    );

    expect(useGlobalHistoryStore.getState().past).toHaveLength(0);
  });

  it("invalidates both event histories for an external causal relation change", async () => {
    for (const entityId of ["cause-event", "effect-event", "other-event"]) {
      useGlobalHistoryStore.getState().push({
        kind: "chronicle",
        label: entityId,
        entityId,
        undo: async () => {},
        redo: async () => {},
      });
    }

    await processExternalEventsForTest(
      [
        ev({
          domain: "event",
          entityType: "event",
          entityId: "cause-event",
          opType: "event.relation_add",
          payload: JSON.stringify({
            causeEventId: "cause-event",
            effectEventId: "effect-event",
          }),
        }),
      ],
      "p1",
    );

    expect(
      useGlobalHistoryStore.getState().past.map((command) => command.entityId),
    ).toEqual(["other-event"]);
    expect(useExternalWriteStore.getState().conflicts).toHaveLength(0);
  });

  it("invalidates counterpart relation history when an external event delete cascades relations", async () => {
    for (const entityId of ["deleted-event", "relation-cause", "other-event"]) {
      useGlobalHistoryStore.getState().push({
        kind: "chronicle",
        label: entityId,
        entityId,
        undo: async () => {},
        redo: async () => {},
      });
    }

    await processExternalEventsForTest(
      [
        ev({
          domain: "event",
          entityType: "event",
          entityId: "deleted-event",
          opType: "event.delete",
          payload: JSON.stringify({
            relatedEventIds: ["relation-cause"],
          }),
        }),
      ],
      "p1",
    );

    expect(
      useGlobalHistoryStore.getState().past.map((command) => command.entityId),
    ).toEqual(["other-event"]);
  });

  it("invalidates the event and scene histories for an external stamp change", async () => {
    useGlobalHistoryStore.getState().push({
      kind: "chronicle",
      label: "event edit",
      entityId: "stamped-event",
      undo: async () => {},
      redo: async () => {},
    });
    useGlobalHistoryStore.getState().push({
      kind: "scenes",
      label: "scene edit",
      entityId: "stamped-scene",
      undo: async () => {},
      redo: async () => {},
    });
    useGlobalHistoryStore.getState().push({
      kind: "scenes",
      label: "unrelated scene edit",
      entityId: "other-scene",
      undo: async () => {},
      redo: async () => {},
    });

    await processExternalEventsForTest(
      [
        ev({
          domain: "event",
          sceneId: "stamped-scene",
          entityType: "event",
          entityId: "stamped-event",
          opType: "event.stamp",
          payload: JSON.stringify({
            eventId: "stamped-event",
            sceneId: "stamped-scene",
          }),
        }),
      ],
      "p1",
    );

    expect(
      useGlobalHistoryStore.getState().past.map((command) => command.entityId),
    ).toEqual(["other-scene"]);
    expect(useExternalWriteStore.getState().conflicts).toHaveLength(0);
  });

  it("degrades safely when external relation payload JSON is malformed", async () => {
    for (const entityId of ["cause-event", "effect-event"]) {
      useGlobalHistoryStore.getState().push({
        kind: "chronicle",
        label: entityId,
        entityId,
        undo: async () => {},
        redo: async () => {},
      });
    }

    await expect(
      processExternalEventsForTest(
        [
          ev({
            domain: "event",
            entityType: "event",
            entityId: "cause-event",
            opType: "event.relation_remove",
            payload: "{not-json",
          }),
        ],
        "p1",
      ),
    ).resolves.toBeUndefined();

    expect(
      useGlobalHistoryStore.getState().past.map((command) => command.entityId),
    ).toEqual(["effect-event"]);
  });
});

// A stalled db_execute (e.g. the change_events poll firing while the native save
// dialog blocks IPC during timelapse export) hits ipcQueue's 10s timeout and
// rejects. pollTick is fired via `void pollTick()` in setInterval, so an
// unguarded reject escapes as a [Global] unhandled rejection. pollTick must
// swallow it and retain the cursor for the next tick.
describe("externalWriteFeed pollTick resilience", () => {
  beforeEach(() => {
    stopExternalWriteFeed();
    h.dbReject = false;
    h.dbResponses = [];
  });

  it("does not reject when the poll's DB read fails (IPC timeout)", async () => {
    // Arm the poller for project p1 without touching db (processExternalEventsForTest
    // sets state.projectId directly), then make the next DB read reject.
    await processExternalEventsForTest([], "p1");
    h.dbReject = true;

    await expect(pollExternalWritesForTest()).resolves.toBeUndefined();
    // Cursor is never advanced on the failing path, so the next tick retries.
    expect(getExternalWriteCursorForTest()).toBe(0);
  });

  it("drops an old Project poll after stop/start without fan-out or cursor corruption", async () => {
    const oldRows = deferred<ReturnType<typeof ev>[]>();
    let oldPoll: Promise<void> | null = null;
    try {
      h.dbResponses.push([]);
      await startExternalWriteFeed("project-a");

      h.dbResponses.push(oldRows.promise);
      oldPoll = pollExternalWritesForTest();
      await vi.waitFor(() => expect(h.dbResponses).toHaveLength(0));

      h.dbResponses.push([{ sequence: 4 }]);
      await startExternalWriteFeed("project-b");
      h.dbResponses.push([
        {
          ...ev({ sequence: 5, domain: "codex" }),
          projectId: "project-b",
        },
      ]);
      await pollExternalWritesForTest();

      expect(h.loadCodex).toHaveBeenCalledOnce();
      expect(getExternalWriteCursorForTest()).toBe(5);

      oldRows.resolve([
        {
          ...ev({ sequence: 99, domain: "grid" }),
          projectId: "project-a",
        },
      ]);
      await oldPoll;

      expect(h.reloadTree).not.toHaveBeenCalled();
      expect(getExternalWriteCursorForTest()).toBe(5);
    } finally {
      oldRows.resolve([]);
      await Promise.allSettled(oldPoll ? [oldPoll] : []);
      stopExternalWriteFeed();
    }
  });

  it("ignores a stale initial cursor read after a later feed start wins", async () => {
    const oldTail = deferred<Array<{ sequence: number }>>();
    let oldStart: Promise<void> | null = null;
    try {
      h.dbResponses.push(oldTail.promise);
      oldStart = startExternalWriteFeed("project-a");
      await vi.waitFor(() => expect(h.dbResponses).toHaveLength(0));

      h.dbResponses.push([{ sequence: 7 }]);
      await startExternalWriteFeed("project-b");
      expect(getExternalWriteCursorForTest()).toBe(7);

      oldTail.resolve([{ sequence: 99 }]);
      await oldStart;
      expect(getExternalWriteCursorForTest()).toBe(7);
    } finally {
      oldTail.resolve([]);
      await Promise.allSettled(oldStart ? [oldStart] : []);
      stopExternalWriteFeed();
    }
  });
});

// Importing this module registers handleUndoConflict via setUndoConflictHandler
// (a top-level side effect). These tests pin that the conflict-surfacing logic —
// moved out of globalHistoryStore to break the projectStore↔treeStore import
// cycle — still fires. (This file has been the site of two regressions across
// three touches; the feature was previously asserted only by "body copied
// correctly", never by a test.)
describe("undo version-conflict surfacing (registered handler)", () => {
  beforeEach(() => {
    h.dirtyTabs = new Set();
    useExternalWriteStore.getState().clear();
    useGlobalHistoryStore.getState().clear();
  });

  function pushConflicting(entityId: string) {
    useGlobalHistoryStore.getState().push({
      kind: "codex",
      label: "stale",
      entityId,
      undo: async () => {
        throw new Error(
          `codex entry '${entityId}' version 2 conflict during journal restore`,
        );
      },
      redo: async () => {},
    });
  }

  function pushConflictingChronicle(entityId: string) {
    useGlobalHistoryStore.getState().push({
      kind: "chronicle",
      label: "stale event",
      entityId,
      undo: async () => {
        throw new Error(
          `event '${entityId}' version 2 conflict during journal restore`,
        );
      },
      redo: async () => {},
    });
  }

  it("pushes a conflict banner when the entity's tab is dirty", async () => {
    h.dirtyTabs.add("entry-1");
    pushConflicting("entry-1");
    await useGlobalHistoryStore.getState().undo();

    const conflicts = useExternalWriteStore.getState().conflicts;
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      sceneId: "entry-1",
      domain: "codex",
      opType: "undo.version_conflict",
      entityId: "entry-1",
    });
    // Conflict drops only the failed entry; history is not wiped.
    expect(useGlobalHistoryStore.getState().past).toHaveLength(0);
  });

  it("bumps reload nonce (no banner) when the entity's tab is clean", async () => {
    pushConflicting("entry-2");
    await useGlobalHistoryStore.getState().undo();

    expect(useExternalWriteStore.getState().conflicts).toHaveLength(0);
    expect(
      useExternalWriteStore.getState().reloadNonce[
        editorStateKey({ kind: "codex", id: "entry-2", phaseId: null })
      ],
    ).toBe(1);
  });

  it("surfaces a Chronicle undo conflict against the exact event document", async () => {
    h.dirtyTabs.add("event-undo");
    pushConflictingChronicle("event-undo");
    await useGlobalHistoryStore.getState().undo();

    expect(useExternalWriteStore.getState().conflicts).toEqual([
      expect.objectContaining({
        documentKey: { kind: "chronicle-event", id: "event-undo" },
        sceneId: "event-undo",
        domain: "event",
        opType: "undo.version_conflict",
      }),
    ]);
  });

  it("surfaces and retains a Phase undo conflict against the exact Phase document", async () => {
    const documentKey: DocumentKey = {
      kind: "codex",
      id: "entry-phase",
      phaseId: "phase-undo",
    };
    h.dirtyTabs.add("entry-phase");
    useGlobalHistoryStore.getState().push({
      kind: "phase",
      label: "stale phase",
      entityId: "phase-undo",
      documentKey,
      retainOnVersionConflict: true,
      undo: async () => {
        throw new PhaseVersionConflictError("phase-undo");
      },
      redo: async () => {},
    });

    await useGlobalHistoryStore.getState().undo();

    expect(useExternalWriteStore.getState().conflicts).toEqual([
      expect.objectContaining({
        documentKey,
        sceneId: "entry-phase",
        domain: "codex",
        opType: "undo.version_conflict",
        entityId: "phase-undo",
      }),
    ]);
    expect(useGlobalHistoryStore.getState().past).toHaveLength(1);
    expect(useGlobalHistoryStore.getState().future).toEqual([]);
  });
});

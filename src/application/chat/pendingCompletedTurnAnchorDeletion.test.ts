import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletedTurnPersistenceInput } from "./pendingCompletedTurnPersistence";

const persistenceMocks = vi.hoisted(() => {
  const deleteWhere = vi.fn().mockResolvedValue(undefined);
  const selectWhere = vi
    .fn()
    .mockResolvedValue([{ id: "codex-1", projectId: "project-1", version: 7 }]);
  return {
    deleteWhere,
    deleteFrom: vi.fn(() => ({ where: deleteWhere })),
    selectWhere,
    selectFrom: vi.fn(() => ({ where: selectWhere })),
    invokeTypedWriter: vi.fn().mockResolvedValue({
      changeEventUid: "delete-change-event",
      maintenanceTransactionId: "delete-maintenance-transaction",
      undoJournalId: "delete-undo-journal",
    }),
    scheduleImeExportRefresh: vi.fn(),
  };
});

vi.mock("@/db/client", () => ({
  db: {
    delete: persistenceMocks.deleteFrom,
    select: () => ({ from: persistenceMocks.selectFrom }),
  },
}));

vi.mock("@/lib/tauri", () => ({
  invoke: persistenceMocks.invokeTypedWriter,
}));

vi.mock("@/features/ime/scheduler", () => ({
  scheduleImeExportRefresh: persistenceMocks.scheduleImeExportRefresh,
}));

vi.mock("@/features/codex/mentionRescanQueue", () => ({
  enqueueRescan: vi.fn(),
}));

vi.mock("@/features/semantic-search/scheduler", () => ({
  scheduleCodexIndex: vi.fn(),
}));

import {
  PendingCompletedTurnPersistenceError,
  pendingCompletedTurnPersistence,
} from "./pendingCompletedTurnPersistence";
import { deleteCodexEntry } from "@/features/codex/api";
import { deleteSnippet } from "@/features/snippets/api";

const deletionTargets = [
  {
    name: "Codex entry",
    persistenceKind: "typed" as const,
    run: () => deleteCodexEntry("project-1", "codex-1"),
  },
  {
    name: "Snippet",
    persistenceKind: "snippet-typed" as const,
    run: () => deleteSnippet("project-1", "snippet-1"),
  },
] as const;

function completedTurnInput(
  turnId: string,
  retry: () => Promise<void>,
): CompletedTurnPersistenceInput {
  return {
    turnId,
    workspaceIdentity: {
      path: "/workspaces/novel",
      openRevision: 7,
    },
    projectId: "project-1",
    sessionId: "session-1",
    userMessage: {
      id: `${turnId}-user`,
      sessionId: "session-1",
      role: "user",
      content: "unsaved question",
      createdAt: "2026-07-30T00:00:00.000Z",
    },
    assistantMessage: {
      id: `${turnId}-assistant`,
      sessionId: "session-1",
      role: "assistant",
      content: "unsaved answer",
      createdAt: "2026-07-30T00:00:00.001Z",
    },
    retry,
  };
}

async function leaveCompletedTurnPending(turnId: string): Promise<() => void> {
  let persistenceAvailable = false;
  const retry = vi.fn(async () => {
    if (!persistenceAvailable) throw new Error("database unavailable");
  });

  await expect(
    pendingCompletedTurnPersistence.persist(completedTurnInput(turnId, retry)),
  ).rejects.toThrow("database unavailable");

  return () => {
    persistenceAvailable = true;
  };
}

describe.each(deletionTargets)(
  "$name low-level deletion",
  ({ name, persistenceKind, run }) => {
    beforeEach(() => {
      pendingCompletedTurnPersistence.discard();
      persistenceMocks.deleteFrom.mockClear();
      persistenceMocks.deleteWhere.mockClear();
      persistenceMocks.selectFrom.mockClear();
      persistenceMocks.selectWhere.mockClear();
      persistenceMocks.invokeTypedWriter.mockClear();
      persistenceMocks.scheduleImeExportRefresh.mockClear();
    });

    afterEach(() => {
      pendingCompletedTurnPersistence.discard();
    });

    it("does not reach persistence while a completed Chat turn is pending and resumes after retry", async () => {
      const restorePersistence = await leaveCompletedTurnPending(
        `retry-${name}`,
      );

      await expect(run()).rejects.toBeInstanceOf(
        PendingCompletedTurnPersistenceError,
      );
      expect(persistenceMocks.deleteFrom).not.toHaveBeenCalled();
      expect(persistenceMocks.selectFrom).not.toHaveBeenCalled();
      expect(persistenceMocks.invokeTypedWriter).not.toHaveBeenCalled();

      restorePersistence();
      await pendingCompletedTurnPersistence.retry();
      await run();

      if (persistenceKind === "typed") {
        expect(persistenceMocks.selectFrom).toHaveBeenCalledOnce();
        expect(persistenceMocks.selectWhere).toHaveBeenCalledOnce();
        expect(persistenceMocks.invokeTypedWriter).toHaveBeenCalledWith(
          "codex_delete",
          {
            payload: expect.objectContaining({
              projectId: "project-1",
              entryId: "codex-1",
              baseVersion: 7,
            }),
          },
        );
        expect(persistenceMocks.deleteFrom).not.toHaveBeenCalled();
      } else {
        expect(persistenceMocks.selectFrom).toHaveBeenCalledOnce();
        expect(persistenceMocks.selectWhere).toHaveBeenCalledOnce();
        expect(persistenceMocks.invokeTypedWriter).toHaveBeenCalledWith(
          "snippet_delete",
          {
            payload: expect.objectContaining({
              projectId: "project-1",
              snippetId: "snippet-1",
              baseVersion: 7,
            }),
          },
        );
        expect(persistenceMocks.deleteFrom).not.toHaveBeenCalled();
      }
    });

    it("does not reach persistence while pending and resumes after explicit discard", async () => {
      await leaveCompletedTurnPending(`discard-${name}`);

      await expect(run()).rejects.toBeInstanceOf(
        PendingCompletedTurnPersistenceError,
      );
      expect(persistenceMocks.deleteFrom).not.toHaveBeenCalled();
      expect(persistenceMocks.selectFrom).not.toHaveBeenCalled();
      expect(persistenceMocks.invokeTypedWriter).not.toHaveBeenCalled();

      expect(pendingCompletedTurnPersistence.discard()).toBe(1);
      await run();

      if (persistenceKind === "typed") {
        expect(persistenceMocks.selectFrom).toHaveBeenCalledOnce();
        expect(persistenceMocks.selectWhere).toHaveBeenCalledOnce();
        expect(persistenceMocks.invokeTypedWriter).toHaveBeenCalledOnce();
        expect(persistenceMocks.deleteFrom).not.toHaveBeenCalled();
      } else {
        expect(persistenceMocks.selectFrom).toHaveBeenCalledOnce();
        expect(persistenceMocks.selectWhere).toHaveBeenCalledOnce();
        expect(persistenceMocks.invokeTypedWriter).toHaveBeenCalledWith(
          "snippet_delete",
          expect.any(Object),
        );
        expect(persistenceMocks.deleteFrom).not.toHaveBeenCalled();
      }
    });
  },
);

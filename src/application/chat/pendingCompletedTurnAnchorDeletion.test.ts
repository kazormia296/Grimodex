import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletedTurnPersistenceInput } from "./pendingCompletedTurnPersistence";

const persistenceMocks = vi.hoisted(() => {
  const deleteWhere = vi.fn().mockResolvedValue(undefined);
  return {
    deleteWhere,
    deleteFrom: vi.fn(() => ({ where: deleteWhere })),
    scheduleImeExportRefresh: vi.fn(),
  };
});

vi.mock("@/db/client", () => ({
  db: {
    delete: persistenceMocks.deleteFrom,
  },
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
    run: () => deleteCodexEntry("project-1", "codex-1"),
  },
  {
    name: "Snippet",
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

describe.each(deletionTargets)("$name low-level deletion", ({ name, run }) => {
  beforeEach(() => {
    pendingCompletedTurnPersistence.discard();
    persistenceMocks.deleteFrom.mockClear();
    persistenceMocks.deleteWhere.mockClear();
    persistenceMocks.scheduleImeExportRefresh.mockClear();
  });

  afterEach(() => {
    pendingCompletedTurnPersistence.discard();
  });

  it("does not reach persistence while a completed Chat turn is pending and resumes after retry", async () => {
    const restorePersistence = await leaveCompletedTurnPending(`retry-${name}`);

    await expect(run()).rejects.toBeInstanceOf(
      PendingCompletedTurnPersistenceError,
    );
    expect(persistenceMocks.deleteFrom).not.toHaveBeenCalled();

    restorePersistence();
    await pendingCompletedTurnPersistence.retry();
    await run();

    expect(persistenceMocks.deleteFrom).toHaveBeenCalledOnce();
    expect(persistenceMocks.deleteWhere).toHaveBeenCalledOnce();
  });

  it("does not reach persistence while pending and resumes after explicit discard", async () => {
    await leaveCompletedTurnPending(`discard-${name}`);

    await expect(run()).rejects.toBeInstanceOf(
      PendingCompletedTurnPersistenceError,
    );
    expect(persistenceMocks.deleteFrom).not.toHaveBeenCalled();

    expect(pendingCompletedTurnPersistence.discard()).toBe(1);
    await run();

    expect(persistenceMocks.deleteFrom).toHaveBeenCalledOnce();
    expect(persistenceMocks.deleteWhere).toHaveBeenCalledOnce();
  });
});

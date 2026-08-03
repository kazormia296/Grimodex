import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { deleteFromDb, scheduleImeExportRefresh } = vi.hoisted(() => ({
  deleteFromDb: vi.fn(),
  scheduleImeExportRefresh: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: {
    delete: deleteFromDb,
  },
}));

vi.mock("@/features/ime/scheduler", () => ({
  scheduleImeExportRefresh,
}));

import { registerCodexAnchorLifecycle } from "@/application/codex/codexAnchorLifecycle";
import { deleteCodexEntry } from "@/features/codex/api";
import { setSnippetDeletedHandler } from "@/features/snippets/anchorNotify";
import { deleteSnippet } from "@/features/snippets/api";
import {
  __resetChatNavigationGuardForTests,
  ChatAnchorDeletionBlockedError,
  tryAcquireChatTurnAdmissionLease,
} from "./chatNavigationGuard";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function deferNextDelete() {
  const durableDelete = deferred<void>();
  const where = vi.fn(() => durableDelete.promise);
  deleteFromDb.mockReturnValueOnce({ where });
  return { durableDelete, where };
}

describe("Chat anchor deletion admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetChatNavigationGuardForTests();
    registerCodexAnchorLifecycle({ onDeleted: () => {} });
    setSnippetDeletedHandler(() => {});
  });

  afterEach(() => {
    __resetChatNavigationGuardForTests();
    registerCodexAnchorLifecycle({ onDeleted: () => {} });
    setSnippetDeletedHandler(() => {});
  });

  it("holds Codex deletion authority through DB deletion and scope reconciliation", async () => {
    const { durableDelete, where } = deferNextDelete();
    const notified = vi.fn();
    let admissionDuringNotification:
      | ReturnType<typeof tryAcquireChatTurnAdmissionLease>
      | undefined;
    registerCodexAnchorLifecycle({
      onDeleted: (entryId) => {
        notified(entryId);
        admissionDuringNotification = tryAcquireChatTurnAdmissionLease();
      },
    });

    const deleting = deleteCodexEntry("project-1", "codex-1");
    expect(where).toHaveBeenCalledOnce();
    expect(tryAcquireChatTurnAdmissionLease()).toBeNull();

    durableDelete.resolve(undefined);
    await deleting;

    expect(notified).toHaveBeenCalledWith("codex-1");
    expect(admissionDuringNotification).toBeNull();
    expect(scheduleImeExportRefresh).toHaveBeenCalledWith("project-1");
    const admissionAfterDelete = tryAcquireChatTurnAdmissionLease();
    expect(admissionAfterDelete).not.toBeNull();
    admissionAfterDelete?.release();
  });

  it("rejects Codex deletion before DB access while Chat owns admission", async () => {
    const chatAdmission = tryAcquireChatTurnAdmissionLease();
    expect(chatAdmission).not.toBeNull();

    await expect(
      deleteCodexEntry("project-1", "codex-1"),
    ).rejects.toBeInstanceOf(ChatAnchorDeletionBlockedError);
    expect(deleteFromDb).not.toHaveBeenCalled();

    chatAdmission?.release();
  });

  it("holds Snippet deletion authority through DB deletion and scope reconciliation", async () => {
    const { durableDelete, where } = deferNextDelete();
    const notified = vi.fn();
    let admissionDuringNotification:
      | ReturnType<typeof tryAcquireChatTurnAdmissionLease>
      | undefined;
    setSnippetDeletedHandler((snippetId) => {
      notified(snippetId);
      admissionDuringNotification = tryAcquireChatTurnAdmissionLease();
    });

    const deleting = deleteSnippet("project-1", "snippet-1");
    expect(where).toHaveBeenCalledOnce();
    expect(tryAcquireChatTurnAdmissionLease()).toBeNull();

    durableDelete.resolve(undefined);
    await deleting;

    expect(notified).toHaveBeenCalledWith("snippet-1");
    expect(admissionDuringNotification).toBeNull();
    const admissionAfterDelete = tryAcquireChatTurnAdmissionLease();
    expect(admissionAfterDelete).not.toBeNull();
    admissionAfterDelete?.release();
  });

  it("rejects Snippet deletion before DB access while Chat owns admission", async () => {
    const chatAdmission = tryAcquireChatTurnAdmissionLease();
    expect(chatAdmission).not.toBeNull();

    await expect(
      deleteSnippet("project-1", "snippet-1"),
    ).rejects.toBeInstanceOf(ChatAnchorDeletionBlockedError);
    expect(deleteFromDb).not.toHaveBeenCalled();

    chatAdmission?.release();
  });
});

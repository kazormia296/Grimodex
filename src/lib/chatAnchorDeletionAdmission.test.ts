import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  deleteFromDb,
  selectFromDb,
  selectWhere,
  invokeTypedWriter,
  scheduleImeExportRefresh,
} = vi.hoisted(() => {
  const selectWhere = vi
    .fn()
    .mockResolvedValue([{ id: "codex-1", projectId: "project-1", version: 7 }]);
  return {
    deleteFromDb: vi.fn(),
    selectFromDb: vi.fn(() => ({ where: selectWhere })),
    selectWhere,
    invokeTypedWriter: vi.fn(),
    scheduleImeExportRefresh: vi.fn(),
  };
});

vi.mock("@/db/client", () => ({
  db: {
    delete: deleteFromDb,
    select: () => ({ from: selectFromDb }),
  },
}));

vi.mock("@/lib/tauri", () => ({
  invoke: invokeTypedWriter,
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

function deferNextTypedDelete() {
  const durableDelete = deferred<{
    changeEventUid: string;
    maintenanceTransactionId: string;
    undoJournalId: string;
  }>();
  invokeTypedWriter.mockReturnValueOnce(durableDelete.promise);
  return { durableDelete };
}

const DELETE_RECEIPT = {
  changeEventUid: "delete-change-event",
  maintenanceTransactionId: "delete-maintenance-transaction",
  undoJournalId: "delete-undo-journal",
};

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
    const { durableDelete } = deferNextTypedDelete();
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
    expect(tryAcquireChatTurnAdmissionLease()).toBeNull();
    await vi.waitFor(() => expect(invokeTypedWriter).toHaveBeenCalledOnce());
    expect(selectFromDb).toHaveBeenCalledOnce();
    expect(selectWhere).toHaveBeenCalledOnce();
    expect(invokeTypedWriter).toHaveBeenCalledWith("codex_delete", {
      payload: expect.objectContaining({
        projectId: "project-1",
        entryId: "codex-1",
        baseVersion: 7,
      }),
    });

    durableDelete.resolve(DELETE_RECEIPT);
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
    expect(selectFromDb).not.toHaveBeenCalled();
    expect(invokeTypedWriter).not.toHaveBeenCalled();

    chatAdmission?.release();
  });

  it("holds Snippet deletion authority through DB deletion and scope reconciliation", async () => {
    const { durableDelete } = deferNextTypedDelete();
    const notified = vi.fn();
    let admissionDuringNotification:
      | ReturnType<typeof tryAcquireChatTurnAdmissionLease>
      | undefined;
    setSnippetDeletedHandler((snippetId) => {
      notified(snippetId);
      admissionDuringNotification = tryAcquireChatTurnAdmissionLease();
    });

    const deleting = deleteSnippet("project-1", "snippet-1");
    expect(tryAcquireChatTurnAdmissionLease()).toBeNull();
    await vi.waitFor(() => expect(invokeTypedWriter).toHaveBeenCalledOnce());
    expect(selectFromDb).toHaveBeenCalledOnce();
    expect(selectWhere).toHaveBeenCalledOnce();
    expect(invokeTypedWriter).toHaveBeenCalledWith("snippet_delete", {
      payload: expect.objectContaining({
        projectId: "project-1",
        snippetId: "snippet-1",
        baseVersion: 7,
      }),
    });

    durableDelete.resolve(DELETE_RECEIPT);
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
    expect(selectFromDb).not.toHaveBeenCalled();
    expect(invokeTypedWriter).not.toHaveBeenCalled();

    chatAdmission?.release();
  });
});

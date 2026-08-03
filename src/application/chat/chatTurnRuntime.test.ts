import { describe, expect, it, vi } from "vitest";
import { createChatTurnRuntime } from "./chatTurnRuntime";
import {
  collectQuiescenceProviderRecovery,
  discardQuiescenceProviders,
} from "@/lib/quiescenceProviders";
import { createPendingCompletedTurnPersistenceRegistry } from "./pendingCompletedTurnPersistence";

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

function completedTurnInput(turnId: string, retry: () => Promise<void>) {
  return {
    turnId,
    workspaceIdentity: {
      path: "/workspaces/novel",
      openRevision: 1,
    },
    projectId: "project-1",
    sessionId: "session-1",
    userMessage: {
      id: `${turnId}-user`,
      sessionId: "session-1",
      role: "user" as const,
      content: "question",
      createdAt: "2026-07-30T00:00:00.000Z",
    },
    assistantMessage: {
      id: `${turnId}-assistant`,
      sessionId: "session-1",
      role: "assistant" as const,
      content: "answer",
      createdAt: "2026-07-30T00:00:00.001Z",
    },
    retry,
  };
}

describe("createChatTurnRuntime", () => {
  it("keeps quiescence pending until the tracked turn resolves", async () => {
    const runtime = createChatTurnRuntime();
    const turn = deferred<void>();
    const tracked = runtime.trackTurn(turn.promise);
    const settled = vi.fn();
    const flushing = runtime.awaitPendingTurns().then(settled);

    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    turn.resolve();
    await tracked;
    await flushing;

    expect(settled).toHaveBeenCalledOnce();
    await expect(runtime.awaitPendingTurns()).resolves.toBeUndefined();
  });

  it("waits for turns added while an earlier tracked turn is settling", async () => {
    const runtime = createChatTurnRuntime();
    const first = deferred<void>();
    const second = deferred<void>();
    const firstTracked = runtime.trackTurn(first.promise);
    const settled = vi.fn();
    const flushing = runtime.awaitPendingTurns().then(settled);

    runtime.trackTurn(second.promise);
    first.resolve();
    await firstTracked;
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    second.resolve();
    await flushing;
    expect(settled).toHaveBeenCalledOnce();
  });

  it("removes a rejected turn after reporting its quiescence failure", async () => {
    const runtime = createChatTurnRuntime();
    const turn = deferred<void>();
    const tracked = runtime.trackTurn(turn.promise);
    const flushing = runtime.awaitPendingTurns();
    const failure = new Error("persistence failed");

    turn.reject(failure);

    await expect(tracked).rejects.toBe(failure);
    await expect(flushing).rejects.toThrow("persistence failed");
    expect(runtime.hasPendingTurns()).toBe(false);
    await expect(runtime.awaitPendingTurns()).resolves.toBeUndefined();
  });

  it("latches a turn failure that settles before the provider starts", async () => {
    const runtime = createChatTurnRuntime();
    const failure = new Error("old-scope persistence failed");
    const tracked = runtime.trackTurn(Promise.reject(failure));

    await expect(tracked).rejects.toBe(failure);
    await Promise.resolve();

    expect(runtime.hasPendingTurns()).toBe(true);
    await expect(runtime.awaitPendingTurns()).rejects.toThrow(
      "old-scope persistence failed",
    );
    expect(runtime.hasPendingTurns()).toBe(false);
  });

  it("keeps failed completed-turn persistence sticky until a retry succeeds", async () => {
    const runtime = createChatTurnRuntime();
    let databaseAvailable = false;
    const retry = vi.fn(async () => {
      if (!databaseAvailable) {
        throw new Error("chat database unavailable");
      }
    });

    await expect(
      runtime.persistCompletedTurn(completedTurnInput("turn-1", retry)),
    ).rejects.toThrow("chat database unavailable");
    expect(runtime.hasPendingTurns()).toBe(true);

    await expect(runtime.awaitPendingTurns()).rejects.toThrow(
      "chat database unavailable",
    );
    expect(runtime.hasPendingTurns()).toBe(true);

    await expect(runtime.awaitPendingTurns()).rejects.toThrow(
      "chat database unavailable",
    );
    expect(runtime.hasPendingTurns()).toBe(true);

    databaseAvailable = true;
    await expect(runtime.awaitPendingTurns()).resolves.toBeUndefined();
    expect(runtime.hasPendingTurns()).toBe(false);
    expect(retry).toHaveBeenCalledTimes(4);
  });

  it("keeps a completed-turn persistence retry single-flight", async () => {
    const runtime = createChatTurnRuntime();
    const persistence = deferred<void>();
    const retry = vi.fn(() => persistence.promise);
    const replacement = vi.fn(async () => {});

    const first = runtime.persistCompletedTurn(
      completedTurnInput("turn-1", retry),
    );
    const second = runtime.persistCompletedTurn(
      completedTurnInput("turn-1", replacement),
    );

    expect(second).toBe(first);
    await Promise.resolve();
    expect(retry).toHaveBeenCalledOnce();
    expect(replacement).not.toHaveBeenCalled();

    persistence.resolve();
    await Promise.all([first, second]);
    expect(runtime.hasPendingTurns()).toBe(false);
  });

  it("exports and explicitly discards unresolved completed Chat turns", async () => {
    const persistence = createPendingCompletedTurnPersistenceRegistry();
    const runtime = createChatTurnRuntime({
      registerQuiescence: true,
      pendingCompletedTurnPersistence: persistence,
    });
    await expect(
      runtime.persistCompletedTurn(
        completedTurnInput(
          "turn-recovery",
          vi.fn().mockRejectedValue(new Error("secret backend value")),
        ),
      ),
    ).rejects.toThrow();

    expect(collectQuiescenceProviderRecovery()).toContainEqual(
      expect.objectContaining({
        kind: "chat-completed-turn",
        turnId: "turn-recovery",
        userMessage: expect.objectContaining({ content: "question" }),
        assistantMessage: expect.objectContaining({ content: "answer" }),
      }),
    );

    discardQuiescenceProviders();

    expect(runtime.hasPendingTurns()).toBe(false);
    await expect(runtime.awaitPendingTurns()).resolves.toBeUndefined();
  });
});

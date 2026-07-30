import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/features/chat/chatTypes";
import {
  PendingCompletedTurnPersistenceError,
  createPendingCompletedTurnPersistenceRegistry,
  type CompletedTurnPersistenceRegistration,
} from "./pendingCompletedTurnPersistence";

const workspaceIdentity = {
  path: "/workspaces/novel",
  openRevision: 7,
};

function message(
  id: string,
  role: ChatMessage["role"],
  content: string,
  createdAt: string,
): ChatMessage {
  return {
    id,
    sessionId: "session-1",
    role,
    content,
    createdAt,
  };
}

function persistenceInput(input: {
  turnId: string;
  retry: () => Promise<void>;
  sessionId?: string;
  projectId?: string;
  onRegister?: () => CompletedTurnPersistenceRegistration | void;
}) {
  const sessionId = input.sessionId ?? "session-1";
  return {
    turnId: input.turnId,
    workspaceIdentity,
    projectId: input.projectId ?? "project-1",
    sessionId,
    userMessage: {
      ...message(
        `${input.turnId}-user`,
        "user",
        `user ${input.turnId}`,
        "2026-07-30T00:00:00.000Z",
      ),
      sessionId,
    },
    assistantMessage: {
      ...message(
        `${input.turnId}-assistant`,
        "assistant",
        `assistant ${input.turnId}`,
        "2026-07-30T00:00:00.001Z",
      ),
      sessionId,
    },
    ...(input.onRegister ? { onRegister: input.onRegister } : {}),
    retry: input.retry,
  };
}

describe("pending completed Chat turn persistence", () => {
  it("retries pending turns serially in original insertion order", async () => {
    const registry = createPendingCompletedTurnPersistenceRegistry();
    const calls: string[] = [];
    const firstRetry = vi
      .fn()
      .mockRejectedValueOnce(new Error("first unavailable"))
      .mockImplementation(async () => {
        calls.push("turn-1");
      });
    const secondRetry = vi
      .fn()
      .mockRejectedValueOnce(new Error("second unavailable"))
      .mockImplementation(async () => {
        calls.push("turn-2");
      });

    await expect(
      registry.persist(
        persistenceInput({
          turnId: "turn-1",
          retry: firstRetry,
        }),
      ),
    ).rejects.toThrow("first unavailable");
    await expect(
      registry.persist(
        persistenceInput({
          turnId: "turn-2",
          retry: secondRetry,
        }),
      ),
    ).rejects.toThrow("second unavailable");

    await registry.retry();

    expect(calls).toEqual(["turn-1", "turn-2"]);
    expect(registry.has()).toBe(false);
  });

  it("stops serial retry at the first unresolved older turn", async () => {
    const registry = createPendingCompletedTurnPersistenceRegistry();
    const firstRetry = vi.fn().mockRejectedValue(new Error("still down"));
    const secondRetry = vi
      .fn()
      .mockRejectedValueOnce(new Error("initial failure"))
      .mockResolvedValue(undefined);

    await expect(
      registry.persist(
        persistenceInput({ turnId: "turn-1", retry: firstRetry }),
      ),
    ).rejects.toThrow("still down");
    await expect(
      registry.persist(
        persistenceInput({
          turnId: "turn-2",
          retry: secondRetry,
        }),
      ),
    ).rejects.toThrow("initial failure");
    firstRetry.mockClear();
    secondRetry.mockClear();

    await expect(registry.retry()).rejects.toThrow("still down");

    expect(firstRetry).toHaveBeenCalledOnce();
    expect(secondRetry).not.toHaveBeenCalled();
    expect(registry.has()).toBe(true);
  });

  it("keeps immutable recovery payloads and never serializes retry errors", async () => {
    const registry = createPendingCompletedTurnPersistenceRegistry();
    const input = persistenceInput({
      turnId: "turn-1",
      retry: vi
        .fn()
        .mockRejectedValue(new Error("secret database message contents")),
    });

    await expect(registry.persist(input)).rejects.toThrow();
    input.userMessage.content = "mutated after registration";

    expect(registry.recovery()).toEqual([
      {
        kind: "chat-completed-turn",
        version: 1,
        turnId: "turn-1",
        workspaceIdentity,
        projectId: "project-1",
        sessionId: "session-1",
        userMessage: expect.objectContaining({
          content: "user turn-1",
          createdAt: "2026-07-30T00:00:00.000Z",
        }),
        assistantMessage: expect.objectContaining({
          content: "assistant turn-1",
          createdAt: "2026-07-30T00:00:00.001Z",
        }),
      },
    ]);
    expect(JSON.stringify(registry.recovery())).not.toContain(
      "secret database",
    );
  });

  it("matches destructive targets by workspace, Project, and Session", async () => {
    const registry = createPendingCompletedTurnPersistenceRegistry();
    await expect(
      registry.persist(
        persistenceInput({
          turnId: "turn-1",
          retry: vi.fn().mockRejectedValue(new Error("down")),
        }),
      ),
    ).rejects.toThrow();

    expect(() =>
      registry.assertNone({
        kind: "session",
        workspaceIdentity,
        projectId: "project-1",
        sessionId: "session-1",
      }),
    ).toThrow(PendingCompletedTurnPersistenceError);
    expect(() =>
      registry.assertNone({
        kind: "session",
        workspaceIdentity: { ...workspaceIdentity, openRevision: 8 },
        projectId: "project-1",
        sessionId: "session-1",
      }),
    ).not.toThrow();
    expect(() =>
      registry.assertNone({
        kind: "project",
        workspaceIdentity,
        projectId: "project-2",
      }),
    ).not.toThrow();
    expect(() =>
      registry.assertNone({
        kind: "session-id",
        sessionId: "session-1",
      }),
    ).toThrow(PendingCompletedTurnPersistenceError);
    expect(() =>
      registry.assertNone({
        kind: "message-id",
        messageId: "turn-1-assistant",
      }),
    ).toThrow(PendingCompletedTurnPersistenceError);
    expect(() =>
      registry.assertNone({
        kind: "message-id",
        messageId: "unrelated-message",
      }),
    ).not.toThrow();
  });

  it("runs registration side effects exactly once across retries", async () => {
    const registry = createPendingCompletedTurnPersistenceRegistry();
    const onRegister = vi.fn();
    const retry = vi
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValue(undefined);
    const input = persistenceInput({
      turnId: "turn-1",
      retry,
      onRegister,
    });

    await expect(registry.persist(input)).rejects.toThrow("down");
    await registry.persist(input);

    expect(onRegister).toHaveBeenCalledOnce();
  });

  it("publishes a registration only after persistence succeeds, exactly once", async () => {
    const registry = createPendingCompletedTurnPersistenceRegistry();
    const onPersisted = vi.fn();
    const onDiscarded = vi.fn();
    const retry = vi
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValue(undefined);
    const input = persistenceInput({
      turnId: "turn-1",
      retry,
      onRegister: () => ({ onPersisted, onDiscarded }),
    });

    await expect(registry.persist(input)).rejects.toThrow("down");
    expect(onPersisted).not.toHaveBeenCalled();
    expect(onDiscarded).not.toHaveBeenCalled();

    await registry.retry();
    await registry.retry();

    expect(onPersisted).toHaveBeenCalledOnce();
    expect(onDiscarded).not.toHaveBeenCalled();
    expect(registry.has()).toBe(false);
  });

  it("discards an unresolved registration exactly once without publishing it", async () => {
    const registry = createPendingCompletedTurnPersistenceRegistry();
    const onPersisted = vi.fn();
    const onDiscarded = vi.fn();

    await expect(
      registry.persist(
        persistenceInput({
          turnId: "turn-1",
          retry: vi.fn().mockRejectedValue(new Error("down")),
          onRegister: () => ({ onPersisted, onDiscarded }),
        }),
      ),
    ).rejects.toThrow("down");

    expect(registry.discard()).toBe(1);
    expect(registry.discard()).toBe(0);
    expect(onDiscarded).toHaveBeenCalledOnce();
    expect(onPersisted).not.toHaveBeenCalled();
    expect(registry.has()).toBe(false);
  });

  it("does not publish when an in-flight retry resolves after explicit discard", async () => {
    const registry = createPendingCompletedTurnPersistenceRegistry();
    const onPersisted = vi.fn();
    const onDiscarded = vi.fn();
    let resolveRetry!: () => void;
    const retry = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRetry = resolve;
        }),
    );

    const attempt = registry.persist(
      persistenceInput({
        turnId: "turn-1",
        retry,
        onRegister: () => ({ onPersisted, onDiscarded }),
      }),
    );
    await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce());

    expect(registry.discard()).toBe(1);
    expect(onDiscarded).toHaveBeenCalledOnce();
    expect(onPersisted).not.toHaveBeenCalled();

    resolveRetry();
    await expect(attempt).resolves.toBeUndefined();

    expect(onPersisted).not.toHaveBeenCalled();
    expect(onDiscarded).toHaveBeenCalledOnce();
    expect(registry.has()).toBe(false);
  });

  it("discards only the explicitly targeted pending turn", async () => {
    const registry = createPendingCompletedTurnPersistenceRegistry();
    for (const [turnId, sessionId] of [
      ["turn-1", "session-1"],
      ["turn-2", "session-2"],
    ] as const) {
      await expect(
        registry.persist(
          persistenceInput({
            turnId,
            sessionId,
            retry: vi.fn().mockRejectedValue(new Error("down")),
          }),
        ),
      ).rejects.toThrow();
    }

    expect(
      registry.discard({
        kind: "session",
        workspaceIdentity,
        projectId: "project-1",
        sessionId: "session-1",
      }),
    ).toBe(1);
    expect(
      registry.has({
        kind: "session",
        workspaceIdentity,
        projectId: "project-1",
        sessionId: "session-1",
      }),
    ).toBe(false);
    expect(registry.has()).toBe(true);
  });
});

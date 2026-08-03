import type { ChatMessage } from "@/features/chat/chatTypes";
import type { WorkspaceIdentity } from "@/runtime/workspaceIdentity";
import { chatPersistenceDeletionGuard } from "@/lib/chatPersistenceDeletionGuard";

export type ImmutableCompletedTurnMessage = Readonly<
  Pick<
    ChatMessage,
    | "id"
    | "sessionId"
    | "role"
    | "content"
    | "model"
    | "tokensIn"
    | "tokensOut"
    | "durationMs"
    | "metadata"
    | "createdAt"
  >
>;

export interface CompletedTurnPersistenceInput {
  turnId: string;
  workspaceIdentity: WorkspaceIdentity | null;
  projectId: string;
  sessionId: string;
  userMessage: ImmutableCompletedTurnMessage;
  assistantMessage?: ImmutableCompletedTurnMessage;
  /**
   * Synchronous one-shot hook for side effects that must retain the turn's
   * original ordering even when the first durable write fails.
   */
  onRegister?: () => CompletedTurnPersistenceRegistration | void;
  retry: () => Promise<void>;
}

export interface CompletedTurnPersistenceRegistration {
  /** Makes any order reservation visible only after all durable writes pass. */
  onPersisted?: () => void;
  /** Removes the reservation when the user explicitly abandons this payload. */
  onDiscarded?: () => void;
}

export type PendingCompletedTurnPersistenceTarget =
  | { kind: "all" }
  | { kind: "session-id"; sessionId: string }
  | { kind: "message-id"; messageId: string }
  | {
      kind: "project";
      workspaceIdentity: WorkspaceIdentity | null;
      projectId: string;
    }
  | {
      kind: "session";
      workspaceIdentity: WorkspaceIdentity | null;
      projectId: string;
      sessionId: string;
    }
  | {
      kind: "message";
      workspaceIdentity: WorkspaceIdentity | null;
      projectId: string;
      sessionId: string;
      messageId: string;
    };

export interface CompletedTurnRecovery {
  kind: "chat-completed-turn";
  version: 1;
  turnId: string;
  workspaceIdentity: WorkspaceIdentity | null;
  projectId: string;
  sessionId: string;
  userMessage: ImmutableCompletedTurnMessage;
  assistantMessage?: ImmutableCompletedTurnMessage;
}

interface PendingCompletedTurnPersistence extends Omit<
  CompletedTurnPersistenceInput,
  "retry" | "onRegister"
> {
  retry: () => Promise<void>;
  registration: CompletedTurnPersistenceRegistration | null;
  lastError: unknown;
  inFlight: Promise<void> | null;
  discarded: boolean;
}

export class PendingCompletedTurnPersistenceError extends Error {
  constructor() {
    super(
      "A completed Chat turn is still waiting to be saved. Retry or export recovery data before changing its history.",
    );
    this.name = "PendingCompletedTurnPersistenceError";
  }
}

function cloneWorkspaceIdentity(
  identity: WorkspaceIdentity | null,
): WorkspaceIdentity | null {
  return identity ? { ...identity } : null;
}

function cloneMessage(
  message: ImmutableCompletedTurnMessage,
): ImmutableCompletedTurnMessage {
  return {
    id: message.id,
    sessionId: message.sessionId,
    role: message.role,
    content: message.content,
    ...(message.model !== undefined ? { model: message.model } : {}),
    ...(message.tokensIn !== undefined ? { tokensIn: message.tokensIn } : {}),
    ...(message.tokensOut !== undefined
      ? { tokensOut: message.tokensOut }
      : {}),
    ...(message.durationMs !== undefined
      ? { durationMs: message.durationMs }
      : {}),
    ...(message.metadata !== undefined ? { metadata: message.metadata } : {}),
    createdAt: message.createdAt,
  };
}

function sameWorkspace(
  left: WorkspaceIdentity | null,
  right: WorkspaceIdentity | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.path === right.path && left.openRevision === right.openRevision;
}

function matchesTarget(
  pending: PendingCompletedTurnPersistence,
  target: PendingCompletedTurnPersistenceTarget,
): boolean {
  if (target.kind === "all") return true;
  if (target.kind === "session-id") {
    return pending.sessionId === target.sessionId;
  }
  if (target.kind === "message-id") {
    return (
      pending.userMessage.id === target.messageId ||
      pending.assistantMessage?.id === target.messageId
    );
  }
  if (
    !sameWorkspace(pending.workspaceIdentity, target.workspaceIdentity) ||
    pending.projectId !== target.projectId
  ) {
    return false;
  }
  if (target.kind === "project") return true;
  if (pending.sessionId !== target.sessionId) return false;
  if (target.kind === "session") return true;
  return (
    pending.userMessage.id === target.messageId ||
    pending.assistantMessage?.id === target.messageId
  );
}

export interface PendingCompletedTurnPersistenceRegistry {
  persist: (input: CompletedTurnPersistenceInput) => Promise<void>;
  has: (target?: PendingCompletedTurnPersistenceTarget) => boolean;
  retry: (target?: PendingCompletedTurnPersistenceTarget) => Promise<void>;
  assertNone: (target?: PendingCompletedTurnPersistenceTarget) => void;
  discard: (target?: PendingCompletedTurnPersistenceTarget) => number;
  recovery: (
    target?: PendingCompletedTurnPersistenceTarget,
  ) => CompletedTurnRecovery[];
}

export function createPendingCompletedTurnPersistenceRegistry(): PendingCompletedTurnPersistenceRegistry {
  const pendingByTurnId = new Map<string, PendingCompletedTurnPersistence>();
  const allTarget: PendingCompletedTurnPersistenceTarget = { kind: "all" };
  const hasPending = (
    target: PendingCompletedTurnPersistenceTarget = allTarget,
  ): boolean =>
    [...pendingByTurnId.values()].some((pending) =>
      matchesTarget(pending, target),
    );

  const retryPending = (
    pending: PendingCompletedTurnPersistence,
  ): Promise<void> => {
    if (pending.inFlight) return pending.inFlight;

    const attempt = Promise.resolve()
      .then(() => pending.retry())
      .then(
        () => {
          if (pending.discarded) return;
          pending.registration?.onPersisted?.();
          if (pendingByTurnId.get(pending.turnId) === pending) {
            pendingByTurnId.delete(pending.turnId);
          }
        },
        (error: unknown) => {
          pending.lastError = error;
          throw error;
        },
      );
    pending.inFlight = attempt;
    void attempt
      .finally(() => {
        if (pending.inFlight === attempt) pending.inFlight = null;
      })
      .catch(() => {});
    return attempt;
  };

  return {
    persist(input) {
      let pending = pendingByTurnId.get(input.turnId);
      if (!pending) {
        const registration = input.onRegister?.() ?? null;
        pending = {
          turnId: input.turnId,
          workspaceIdentity: cloneWorkspaceIdentity(input.workspaceIdentity),
          projectId: input.projectId,
          sessionId: input.sessionId,
          userMessage: cloneMessage(input.userMessage),
          ...(input.assistantMessage
            ? { assistantMessage: cloneMessage(input.assistantMessage) }
            : {}),
          retry: input.retry,
          registration,
          lastError: null,
          inFlight: null,
          discarded: false,
        };
        pendingByTurnId.set(input.turnId, pending);
      }
      return retryPending(pending);
    },

    has: hasPending,

    async retry(target = allTarget) {
      // Map preserves completed-turn registration order. Stop at the first
      // unresolved older turn so no later retry can overtake it.
      for (const pending of [...pendingByTurnId.values()]) {
        if (!matchesTarget(pending, target)) continue;
        await retryPending(pending);
      }
    },

    assertNone(target = allTarget) {
      if (hasPending(target)) {
        throw new PendingCompletedTurnPersistenceError();
      }
    },

    discard(target = allTarget) {
      let discarded = 0;
      for (const [turnId, pending] of pendingByTurnId) {
        if (!matchesTarget(pending, target)) continue;
        pending.discarded = true;
        try {
          pending.registration?.onDiscarded?.();
        } finally {
          pendingByTurnId.delete(turnId);
          discarded += 1;
        }
      }
      return discarded;
    },

    recovery(target = allTarget) {
      return [...pendingByTurnId.values()]
        .filter((pending) => matchesTarget(pending, target))
        .map(
          (pending): CompletedTurnRecovery => ({
            kind: "chat-completed-turn",
            version: 1,
            turnId: pending.turnId,
            workspaceIdentity: cloneWorkspaceIdentity(
              pending.workspaceIdentity,
            ),
            projectId: pending.projectId,
            sessionId: pending.sessionId,
            userMessage: cloneMessage(pending.userMessage),
            ...(pending.assistantMessage
              ? {
                  assistantMessage: cloneMessage(pending.assistantMessage),
                }
              : {}),
          }),
        );
    },
  };
}

/**
 * The production renderer has one Chat persistence authority. Low-level
 * destructive repositories consult this same registry so they cannot bypass
 * the Zustand action guards.
 */
export const pendingCompletedTurnPersistence =
  createPendingCompletedTurnPersistenceRegistry();

chatPersistenceDeletionGuard.installPendingAssertion(() => {
  pendingCompletedTurnPersistence.assertNone();
});

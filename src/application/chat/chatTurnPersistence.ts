export class ChatTurnPersistenceError extends Error {
  constructor(cause: unknown) {
    super(
      cause instanceof Error
        ? cause.message
        : "Failed to persist the completed chat turn",
      { cause },
    );
    this.name = "ChatTurnPersistenceError";
  }
}

interface CompletedTurnPersistenceSteps {
  persistUser: () => Promise<void>;
  persistAssistant?: () => Promise<void>;
  finalize?: () => Promise<void>;
}

/**
 * Preserves per-row progress across lifecycle retries. Message IDs are stable,
 * but a user insert can succeed before the assistant insert fails; retrying
 * only the unfinished step avoids turning that partial success into a primary
 * key conflict.
 */
export function createRetryableCompletedTurnPersistence(
  steps: CompletedTurnPersistenceSteps,
): () => Promise<void> {
  let userPersisted = false;
  let assistantPersisted = steps.persistAssistant === undefined;
  let finalized = steps.finalize === undefined;

  return async () => {
    if (!userPersisted) {
      await steps.persistUser();
      userPersisted = true;
    }
    if (!assistantPersisted && steps.persistAssistant) {
      await steps.persistAssistant();
      assistantPersisted = true;
    }
    if (!finalized && steps.finalize) {
      await steps.finalize();
      finalized = true;
    }
  };
}

type PendingChatPersistenceAssertion = () => void;

export interface ChatPersistenceDeletionGuard {
  assertDeletionAllowed: () => void;
  installPendingAssertion: (
    assertion: PendingChatPersistenceAssertion,
  ) => () => void;
}

/**
 * Neutral leaf guard for feature-owned deletes that can mutate a Chat
 * persistence target through foreign-key actions. The Chat runtime installs
 * the production assertion; Codex and Snippet APIs depend only on this leaf.
 */
export function createChatPersistenceDeletionGuard(): ChatPersistenceDeletionGuard {
  const pendingAssertions = new Set<PendingChatPersistenceAssertion>();

  return {
    assertDeletionAllowed() {
      for (const assertion of pendingAssertions) assertion();
    },

    installPendingAssertion(assertion) {
      pendingAssertions.add(assertion);
      return () => {
        pendingAssertions.delete(assertion);
      };
    },
  };
}

export const chatPersistenceDeletionGuard =
  createChatPersistenceDeletionGuard();

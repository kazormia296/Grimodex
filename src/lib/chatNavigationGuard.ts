type ChatNavigationBlocker = () => boolean;

let blocker: ChatNavigationBlocker | null = null;
let activeTreeNavigationToken: symbol | null = null;
let activeAnchorDeletionToken: symbol | null = null;
const activeChatAdmissionTokens = new Set<symbol>();

export interface ChatNavigationLease {
  release(): void;
}

export class ChatAnchorDeletionBlockedError extends Error {
  constructor() {
    super(
      "Cannot delete a Chat scope anchor while a Chat turn owns persistence authority.",
    );
    this.name = "ChatAnchorDeletionBlockedError";
  }
}

/**
 * Leaf registration keeps Tree/Editor navigation independent from the Chat
 * Store module while still letting Chat own its turn-persistence authority.
 */
export function setChatNavigationBlocker(
  next: ChatNavigationBlocker | null,
): void {
  blocker = next;
}

export function isChatNavigationBlocked(): boolean {
  return activeChatAdmissionTokens.size > 0 || (blocker?.() ?? false);
}

/**
 * Atomically reserves Tree navigation before its first async persistence step.
 * Chat owns the blocker callback; a preflight admission token closes the small
 * gap before Chat publishes `isStreaming`.
 */
export function tryAcquireTreeNavigationLease(): ChatNavigationLease | null {
  if (
    activeTreeNavigationToken !== null ||
    activeChatAdmissionTokens.size > 0 ||
    isChatNavigationBlocked()
  ) {
    return null;
  }
  const token = Symbol("tree-navigation");
  activeTreeNavigationToken = token;
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      if (activeTreeNavigationToken === token) {
        activeTreeNavigationToken = null;
      }
    },
  };
}

/**
 * Synchronous Chat send admission. Holding this through the tracked turn keeps
 * an async Tree create/delete from starting before Chat publishes its runtime
 * state or completed-turn persistence registration.
 */
export function tryAcquireChatTurnAdmissionLease(): ChatNavigationLease | null {
  if (
    activeTreeNavigationToken !== null ||
    activeAnchorDeletionToken !== null
  ) {
    return null;
  }
  const token = Symbol("chat-turn-admission");
  activeChatAdmissionTokens.add(token);
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      activeChatAdmissionTokens.delete(token);
    },
  };
}

/**
 * Reserves a Codex/Snippet anchor delete through its durable write and
 * synchronous Chat scope reconciliation. The Chat blocker includes streaming
 * and unresolved completed-turn persistence; the admission tokens close its
 * preflight publication gap.
 */
export function tryAcquireChatAnchorDeletionLease(): ChatNavigationLease | null {
  if (
    activeAnchorDeletionToken !== null ||
    activeChatAdmissionTokens.size > 0 ||
    isChatNavigationBlocked()
  ) {
    return null;
  }
  const token = Symbol("chat-anchor-deletion");
  activeAnchorDeletionToken = token;
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      if (activeAnchorDeletionToken === token) {
        activeAnchorDeletionToken = null;
      }
    },
  };
}

/** Chat scope/session admission uses this while a Tree mutation is in flight. */
export function isTreeNavigationLeaseActive(): boolean {
  return activeTreeNavigationToken !== null;
}

export function __resetChatNavigationGuardForTests(): void {
  blocker = null;
  activeTreeNavigationToken = null;
  activeAnchorDeletionToken = null;
  activeChatAdmissionTokens.clear();
}

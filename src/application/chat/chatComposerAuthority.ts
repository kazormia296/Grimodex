import type { ChatState } from "./chatStoreTypes";
import {
  captureSessionMutationAuthority,
  getSessionMutationTail,
  hasPendingSessionMutations,
  isSessionMutationAuthorityCurrent,
  type SessionMutationAuthority,
} from "./chatSessionAuthority";

export interface ChatComposerAuthority {
  activeSessionId: string | null;
  sessionMutation: SessionMutationAuthority;
  aiRoute: string;
}

interface ChatComposerAuthorityPorts {
  get: () => ChatState;
  captureAiRoute: (state: ChatState) => string;
}

export function createChatComposerAuthority(
  ports: ChatComposerAuthorityPorts,
): {
  capture: () => ChatComposerAuthority;
  awaitCurrent: (authority: ChatComposerAuthority) => Promise<boolean>;
  awaitWritable: (authority: ChatComposerAuthority) => Promise<boolean>;
} {
  const capture = (): ChatComposerAuthority => {
    const state = ports.get();
    return {
      activeSessionId: state.activeSessionId,
      sessionMutation: captureSessionMutationAuthority(state),
      aiRoute: ports.captureAiRoute(state),
    };
  };

  const awaitCurrent = async (
    authority: ChatComposerAuthority,
  ): Promise<boolean> => {
    while (hasPendingSessionMutations()) {
      const tail = getSessionMutationTail();
      await tail;
      if (tail === getSessionMutationTail()) break;
    }
    const state = ports.get();
    const currentAuthority = capture();
    return (
      !hasPendingSessionMutations() &&
      state.activeSessionId === authority.activeSessionId &&
      isSessionMutationAuthorityCurrent(authority.sessionMutation, state) &&
      currentAuthority.aiRoute === authority.aiRoute
    );
  };

  const awaitWritable = async (
    authority: ChatComposerAuthority,
  ): Promise<boolean> => {
    if (!(await awaitCurrent(authority))) return false;
    const state = ports.get();
    return (
      !state.isStreaming &&
      !state.isLoadingSessions &&
      !state.isLoadingMessages &&
      state.activeSessionId === authority.activeSessionId &&
      isSessionMutationAuthorityCurrent(authority.sessionMutation, state)
    );
  };

  return { capture, awaitCurrent, awaitWritable };
}

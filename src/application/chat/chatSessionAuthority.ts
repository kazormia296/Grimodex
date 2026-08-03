import type { ChatState } from "./chatStoreTypes";
import {
  getCurrentImeWorkspaceIdentity,
  isCurrentImeWorkspaceIdentity,
  type ImeWorkspaceIdentity,
} from "@/features/ime/workspaceScope";
import { getCurrentProjectId } from "@/application/project/currentProjectAuthority";
import {
  resolveScopeSessionKey,
  scopeSessionKeysEqual,
  type ChatScope,
  type ScopeSessionKey,
} from "@/features/chat/chatScope";
import type { ChatSession } from "@/features/chat/chatTypes";

// Async session reads can finish after a scope/project transition. Only the
// newest request for each surface may publish its result.
let _sessionListGeneration = 0;
let _sessionSelectionGeneration = 0;
// Exact session authority epoch. Unlike the list/selection generations this is
// captured by every queued mutation, so an A -> B -> A round trip with reused
// Project/scope ids cannot make an operation from the first A current again.
let _sessionScopeGeneration = 0;
// Session create/select/delete operations cross IPC and can otherwise finish
// after a later Send has captured the old session. Serialize those mutations,
// and make Send wait for every mutation that was requested before it. A
// mutation requested after Send starts re-checks `isStreaming` inside the
// queue and either stops intentionally (select) or becomes a no-op.
let _sessionMutationTail: Promise<void> = Promise.resolve();
let _pendingSessionMutationCount = 0;

export interface SessionMutationAuthority {
  scopeGeneration: number;
  workspaceIdentity: ImeWorkspaceIdentity | null;
  projectId: string;
  chatScope: ChatScope;
  scopeKey: ScopeSessionKey;
}

export function captureSessionMutationAuthority(
  state: Pick<
    ChatState,
    "activeProjectId" | "activeSceneId" | "chatScope" | "scopeAnchorId"
  >,
): SessionMutationAuthority {
  return {
    scopeGeneration: _sessionScopeGeneration,
    workspaceIdentity: getCurrentImeWorkspaceIdentity(),
    projectId: state.activeProjectId ?? getCurrentProjectId(),
    chatScope: state.chatScope,
    scopeKey: resolveScopeSessionKey(
      state.chatScope,
      state.activeSceneId,
      state.scopeAnchorId,
    ),
  };
}

export function isCapturedWorkspaceCurrent(
  workspaceIdentity: ImeWorkspaceIdentity | null,
): boolean {
  if (workspaceIdentity) {
    return isCurrentImeWorkspaceIdentity(workspaceIdentity);
  }
  return getCurrentImeWorkspaceIdentity() === null;
}

export function isSessionMutationAuthorityCurrent(
  authority: SessionMutationAuthority,
  state: Pick<
    ChatState,
    "activeProjectId" | "activeSceneId" | "chatScope" | "scopeAnchorId"
  >,
): boolean {
  if (authority.scopeGeneration !== _sessionScopeGeneration) return false;
  if (!isCapturedWorkspaceCurrent(authority.workspaceIdentity)) return false;
  if (
    (state.activeProjectId ?? getCurrentProjectId()) !== authority.projectId
  ) {
    return false;
  }
  if (state.chatScope !== authority.chatScope) return false;
  return scopeSessionKeysEqual(
    resolveScopeSessionKey(
      state.chatScope,
      state.activeSceneId,
      state.scopeAnchorId,
    ),
    authority.scopeKey,
  );
}

export function invalidateSessionScopeAuthority(): void {
  _sessionScopeGeneration += 1;
  _sessionListGeneration += 1;
  _sessionSelectionGeneration += 1;
}

export function sessionScopeChanged(
  current: Pick<ChatState, "activeSceneId" | "chatScope" | "scopeAnchorId">,
  next: {
    activeSceneId: string | null | undefined;
    chatScope: ChatScope;
    scopeAnchorId: string | null | undefined;
  },
): boolean {
  return (
    current.chatScope !== next.chatScope ||
    !scopeSessionKeysEqual(
      resolveScopeSessionKey(
        current.chatScope,
        current.activeSceneId,
        current.scopeAnchorId,
      ),
      resolveScopeSessionKey(
        next.chatScope,
        next.activeSceneId,
        next.scopeAnchorId,
      ),
    )
  );
}

export function clearedSessionScopeState(): Partial<ChatState> {
  return {
    sessions: [],
    activeSessionId: null,
    messages: [],
    streamingDraft: null,
    isLoadingSessions: false,
    isLoadingMessages: false,
    summaryCount: 0,
    maxSummaryGeneration: 0,
    sessionStableCodexIds: [],
    sessionStableContextInitialized: false,
    sessionAgentToolsSnapshot: null,
    cacheInvalidatedReason: null,
    excludedAutoEntryIds: [],
    threadFocusOverride: null,
    chatRecallPromoteSuggestion: null,
    agentProgress: null,
    agentContinuation: null,
    subAgentProgress: null,
    pendingUserQuestion: null,
  };
}

export interface SessionListLoadAuthority {
  generation: number;
  session: SessionMutationAuthority;
}

export function requestedSessionListScopeKey(
  nodeId?: string | null,
  codexAnchorId?: string | null,
  snippetAnchorId?: string | null,
): ScopeSessionKey {
  return {
    nodeId,
    codexAnchorId: codexAnchorId ?? undefined,
    snippetAnchorId: snippetAnchorId ?? undefined,
  };
}

export function isSessionListLoadAuthorityCurrent(
  authority: SessionListLoadAuthority,
  state: Pick<
    ChatState,
    "activeProjectId" | "activeSceneId" | "chatScope" | "scopeAnchorId"
  >,
): boolean {
  return (
    authority.generation === _sessionListGeneration &&
    isSessionMutationAuthorityCurrent(authority.session, state)
  );
}

export function isSessionTargetForAuthority(
  session: Pick<
    ChatSession,
    "projectId" | "nodeId" | "codexAnchorId" | "snippetAnchorId"
  >,
  authority: SessionMutationAuthority,
): boolean {
  if (session.projectId !== authority.projectId) return false;
  switch (authority.chatScope) {
    case "scene":
    case "folder":
      return (
        typeof authority.scopeKey.nodeId === "string" &&
        session.nodeId === authority.scopeKey.nodeId &&
        (session.codexAnchorId ?? null) === null &&
        (session.snippetAnchorId ?? null) === null
      );
    case "project":
      return (
        (session.nodeId ?? null) === null &&
        (session.codexAnchorId ?? null) === null &&
        (session.snippetAnchorId ?? null) === null
      );
    case "codex":
      return (
        typeof authority.scopeKey.codexAnchorId === "string" &&
        (session.nodeId ?? null) === null &&
        session.codexAnchorId === authority.scopeKey.codexAnchorId &&
        (session.snippetAnchorId ?? null) === null
      );
    case "snippet":
      return (
        typeof authority.scopeKey.snippetAnchorId === "string" &&
        (session.nodeId ?? null) === null &&
        (session.codexAnchorId ?? null) === null &&
        session.snippetAnchorId === authority.scopeKey.snippetAnchorId
      );
  }
}

export function isSameCapturedSession(
  current: ChatSession,
  captured: ChatSession,
): boolean {
  return (
    current.id === captured.id &&
    current.projectId === captured.projectId &&
    (current.nodeId ?? null) === (captured.nodeId ?? null) &&
    (current.codexAnchorId ?? null) === (captured.codexAnchorId ?? null) &&
    (current.snippetAnchorId ?? null) === (captured.snippetAnchorId ?? null)
  );
}

export function enqueueSessionMutation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  _pendingSessionMutationCount += 1;
  const pending = _sessionMutationTail.then(operation, operation);
  _sessionMutationTail = pending.then(
    () => {
      _pendingSessionMutationCount -= 1;
    },
    () => {
      _pendingSessionMutationCount -= 1;
    },
  );
  return pending;
}

export function nextSessionListGeneration(): number {
  return ++_sessionListGeneration;
}

export function nextSessionSelectionGeneration(): number {
  return ++_sessionSelectionGeneration;
}

export function isSessionSelectionGenerationCurrent(
  generation: number,
): boolean {
  return generation === _sessionSelectionGeneration;
}

export function hasPendingSessionMutations(): boolean {
  return _pendingSessionMutationCount > 0;
}

export function getSessionMutationTail(): Promise<void> {
  return _sessionMutationTail;
}

import type { ChatStoreActionPorts } from "./chatStoreActionPorts";
import type { ChatState } from "./chatStoreTypes";
import {
  captureSessionMutationAuthority,
  clearedSessionScopeState,
  enqueueSessionMutation,
  invalidateSessionScopeAuthority,
  isSameCapturedSession,
  isSessionListLoadAuthorityCurrent,
  isSessionMutationAuthorityCurrent,
  isSessionSelectionGenerationCurrent,
  isSessionTargetForAuthority,
  nextSessionListGeneration,
  nextSessionSelectionGeneration,
  requestedSessionListScopeKey,
  type SessionListLoadAuthority,
} from "./chatSessionAuthority";
import { flushStrictQuiescence } from "@/application/lifecycle/quiescenceCoordinator";
import {
  acquireQuiescenceLease,
  canScheduleQuiescenceMutation,
} from "@/application/lifecycle/quiescenceLease";
import type {
  ChatMessage,
  ChatSession,
  ChatSummary,
} from "@/features/chat/chatTypes";
import { scopeSessionKeysEqual } from "@/features/chat/chatScope";
import { isIpcLifecycleCancellation } from "@/lib/tauri";
import { isTreeNavigationLeaseActive } from "@/lib/chatNavigationGuard";

interface ChatSessionRepository {
  listSessions: (
    projectId: string,
    nodeId?: string | null,
    codexAnchorId?: string | null,
    snippetAnchorId?: string | null,
  ) => Promise<ChatSession[]>;
  getSessionForProject: (
    sessionId: string,
    projectId: string,
  ) => Promise<ChatSession | null>;
  createSession: (
    projectId: string,
    title: string,
    nodeId?: string,
    codexAnchorId?: string,
    snippetAnchorId?: string,
  ) => Promise<ChatSession>;
  deleteSession: (sessionId: string) => Promise<void>;
  listMessages: (sessionId: string) => Promise<ChatMessage[]>;
  listSummaries: (sessionId: string) => Promise<ChatSummary[]>;
  addSystemMessage: (
    sessionId: string,
    content: string,
  ) => Promise<ChatMessage>;
  archiveSessionThread: (input: {
    projectId: string;
    sessionId: string;
    expectedWorkspacePath: string;
  }) => Promise<void>;
  clearProjectChatHistory: (projectId: string) => Promise<void>;
}

interface ChatSessionActionRuntime {
  snapshotAgentTools: () => ChatState["sessionAgentToolsSnapshot"];
  resetRecallPromote: () => void;
  hasPendingCompletedTurnPersistence: () => boolean;
  translate: (key: string, options?: Record<string, unknown>) => string;
  notifyError: (message: string) => void;
  reportError: (operation: string, error: unknown) => void;
  reportWarning: (operation: string, error: unknown) => void;
}

type ChatSessionActions = Pick<
  ChatState,
  | "createLinkedSession"
  | "loadSessions"
  | "selectSession"
  | "createNewSession"
  | "ensureSession"
  | "deleteSession"
  | "clearProjectChatHistory"
>;

export function createChatSessionStoreActions(
  ports: ChatStoreActionPorts & {
    repository: ChatSessionRepository;
    runtime: ChatSessionActionRuntime;
  },
): ChatSessionActions {
  const { get, set, repository, runtime } = ports;
  const blockSessionMutation = (): boolean => {
    if (!canScheduleQuiescenceMutation() || isTreeNavigationLeaseActive()) {
      return true;
    }
    if (!runtime.hasPendingCompletedTurnPersistence()) return false;
    runtime.notifyError(
      runtime.translate("chat.pendingCompletedTurnPersistence"),
    );
    return true;
  };

  return {
    clearProjectChatHistory: (projectId: string) => {
      // Admission must close synchronously with the confirmed user action.
      // Otherwise a new turn can start before the first await and recreate a
      // session that the destructive DELETE is about to remove.
      const quiescenceLease = acquireQuiescenceLease("data-delete");
      const authority = captureSessionMutationAuthority(get());
      const failStaleAuthority = (): never => {
        throw new Error("Chat history clear authority changed");
      };

      const operation = enqueueSessionMutation(async () => {
        try {
          if (
            authority.projectId !== projectId ||
            !isSessionMutationAuthorityCurrent(authority, get())
          ) {
            failStaleAuthority();
          }

          await flushStrictQuiescence(undefined, {
            transition: quiescenceLease.transition,
          });

          if (!isSessionMutationAuthorityCurrent(authority, get())) {
            failStaleAuthority();
          }

          // Strict quiescence has drained old work. Keep reads sealed across
          // the destructive statement and the in-memory authority reset.
          quiescenceLease.sealReadsForAuthorityCommit();
          await repository.clearProjectChatHistory(projectId);

          if (!isSessionMutationAuthorityCurrent(authority, get())) {
            failStaleAuthority();
          }

          invalidateSessionScopeAuthority();
          get()._cancelPendingUserQuestion();
          runtime.resetRecallPromote();
          set({
            ...clearedSessionScopeState(),
            error: null,
          });
        } catch (error) {
          runtime.reportError("clearProjectChatHistory", error);
          throw error;
        } finally {
          quiescenceLease.release();
        }
      });

      // The lease belongs to this operation even if the session queue itself
      // unexpectedly rejects before invoking it.
      return operation.catch((error: unknown) => {
        quiescenceLease.release();
        throw error;
      });
    },

    createLinkedSession: async () => {
      if (blockSessionMutation()) return;
      const invocationState = get();
      if (invocationState.isStreaming) return;
      const authority = captureSessionMutationAuthority(invocationState);
      const ref = invocationState.sessions.find(
        (session) => session.id === invocationState.activeSessionId,
      );
      if (ref && !isSessionTargetForAuthority(ref, authority)) return;
      return enqueueSessionMutation(async () => {
        const queuedState = get();
        if (
          queuedState.isStreaming ||
          !isSessionMutationAuthorityCurrent(authority, queuedState) ||
          queuedState.activeSessionId !== (ref?.id ?? null)
        ) {
          return;
        }
        const { projectId, scopeKey } = authority;
        try {
          const session = await repository.createSession(
            projectId,
            ref ? `Linked: ${ref.title}` : "New session",
            scopeKey.nodeId === null ? undefined : scopeKey.nodeId,
            scopeKey.codexAnchorId,
            scopeKey.snippetAnchorId,
          );
          if (
            get().isStreaming ||
            session.projectId !== projectId ||
            !isSessionTargetForAuthority(session, authority) ||
            !isSessionMutationAuthorityCurrent(authority, get()) ||
            get().activeSessionId !== (ref?.id ?? null)
          ) {
            return;
          }
          set((state) => ({
            sessions: [session, ...state.sessions],
            activeSessionId: session.id,
            messages: [],
            summaryCount: 0,
            maxSummaryGeneration: 0,
            sessionStableCodexIds: [],
            sessionStableContextInitialized: false,
            sessionAgentToolsSnapshot: runtime.snapshotAgentTools(),
            cacheInvalidatedReason: null,
            excludedAutoEntryIds: [],
            threadFocusOverride: null,
          }));
          if (ref) {
            if (
              !isSessionMutationAuthorityCurrent(authority, get()) ||
              get().activeSessionId !== session.id
            ) {
              return;
            }
            const linkMessage = await repository.addSystemMessage(
              session.id,
              runtime.translate("chat.linkedSessionReference", {
                title: ref.title,
                sessionId: ref.id,
              }),
            );
            if (
              isSessionMutationAuthorityCurrent(authority, get()) &&
              get().activeSessionId === session.id
            ) {
              set({ messages: [linkMessage] });
            }
          }
        } catch (error) {
          runtime.notifyError(runtime.translate("chat.createSessionFailed"));
          runtime.reportError("createLinkedSession", error);
        }
      });
    },

    loadSessions: async (
      nodeId?: string | null,
      codexAnchorId?: string | null,
      snippetAnchorId?: string | null,
    ) => {
      if (blockSessionMutation()) return false;
      const invocationState = get();
      if (invocationState.isStreaming) return false;
      const capturedActiveSessionId = invocationState.activeSessionId;
      const sessionAuthority = captureSessionMutationAuthority(invocationState);
      const requestedScopeKey = requestedSessionListScopeKey(
        nodeId,
        codexAnchorId,
        snippetAnchorId,
      );
      if (
        !scopeSessionKeysEqual(requestedScopeKey, sessionAuthority.scopeKey)
      ) {
        return false;
      }
      const authority: SessionListLoadAuthority = {
        generation: nextSessionListGeneration(),
        session: sessionAuthority,
      };
      const { projectId } = sessionAuthority;
      set({ isLoadingSessions: true });
      try {
        const sessions = await repository.listSessions(
          projectId,
          nodeId,
          codexAnchorId,
          snippetAnchorId,
        );
        if (!isSessionListLoadAuthorityCurrent(authority, get())) {
          return false;
        }
        const currentBeforePublish = get();
        if (
          currentBeforePublish.isStreaming ||
          currentBeforePublish.activeSessionId !== capturedActiveSessionId
        ) {
          set({ isLoadingSessions: false });
          return false;
        }
        if (
          sessions.some(
            (session) =>
              !isSessionTargetForAuthority(session, sessionAuthority),
          )
        ) {
          throw new Error("chat session scope mismatch");
        }
        const current = get();
        const activeSessionStillExists =
          current.activeSessionId === null ||
          sessions.some((session) => session.id === current.activeSessionId);
        if (activeSessionStillExists) {
          set({ sessions, isLoadingSessions: false });
        } else {
          set({
            ...clearedSessionScopeState(),
            sessions,
            isLoadingSessions: false,
          });
        }
        return true;
      } catch (error) {
        if (!isSessionListLoadAuthorityCurrent(authority, get())) {
          return false;
        }
        const currentBeforeFailure = get();
        if (
          currentBeforeFailure.isStreaming ||
          currentBeforeFailure.activeSessionId !== capturedActiveSessionId
        ) {
          set({ isLoadingSessions: false });
          return false;
        }
        set({ isLoadingSessions: false });
        if (isIpcLifecycleCancellation(error)) return false;
        runtime.notifyError(runtime.translate("chat.loadSessionsFailed"));
        runtime.reportError("loadSessions", error);
        return false;
      }
    },

    selectSession: async (sessionId: string | null) => {
      if (blockSessionMutation()) return;
      const invocationState = get();
      if (invocationState.isStreaming) return;
      const authority = captureSessionMutationAuthority(invocationState);
      const capturedSession =
        sessionId === null
          ? undefined
          : invocationState.sessions.find(
              (session) => session.id === sessionId,
            );
      if (
        capturedSession &&
        !isSessionTargetForAuthority(capturedSession, authority)
      ) {
        return;
      }
      const { projectId } = authority;
      return enqueueSessionMutation(async () => {
        const generation = nextSessionSelectionGeneration();
        if (!isSessionMutationAuthorityCurrent(authority, get())) return;
        // Session changes are destructive to the visible turn. Stop is an
        // explicit user action; selection must not stop and immediately tear
        // down a stream whose final persistence is still in flight.
        if (get().isStreaming) return;
        if (!isSessionMutationAuthorityCurrent(authority, get())) return;
        get()._cancelPendingUserQuestion();
        runtime.resetRecallPromote();
        if (sessionId === null) {
          set({
            activeSessionId: null,
            messages: [],
            isLoadingMessages: false,
            summaryCount: 0,
            maxSummaryGeneration: 0,
            sessionStableCodexIds: [],
            sessionStableContextInitialized: false,
            sessionAgentToolsSnapshot: null,
            excludedAutoEntryIds: [],
            threadFocusOverride: null,
            chatRecallPromoteSuggestion: null,
            agentContinuation: null,
            subAgentProgress: null,
          });
          return;
        }
        set({
          isLoadingMessages: true,
          activeSessionId: sessionId,
          messages: [],
          chatRecallPromoteSuggestion: null,
          agentContinuation: null,
          subAgentProgress: null,
        });
        try {
          if (!isSessionMutationAuthorityCurrent(authority, get())) return;
          const session = await repository.getSessionForProject(
            sessionId,
            projectId,
          );
          if (
            !isSessionSelectionGenerationCurrent(generation) ||
            !isSessionMutationAuthorityCurrent(authority, get()) ||
            get().activeSessionId !== sessionId
          ) {
            return;
          }
          if (
            !session ||
            !isSessionTargetForAuthority(session, authority) ||
            (capturedSession &&
              !isSameCapturedSession(session, capturedSession))
          ) {
            throw new Error("chat session scope mismatch");
          }
          if (!isSessionMutationAuthorityCurrent(authority, get())) return;
          const [messages, summaries] = await Promise.all([
            repository.listMessages(sessionId),
            repository.listSummaries(sessionId),
          ]);
          if (
            !isSessionSelectionGenerationCurrent(generation) ||
            !isSessionMutationAuthorityCurrent(authority, get()) ||
            get().activeSessionId !== sessionId
          ) {
            return;
          }
          set({
            activeSessionId: sessionId,
            messages,
            isLoadingMessages: false,
            summaryCount: summaries.length,
            maxSummaryGeneration:
              summaries.length > 0
                ? Math.max(...summaries.map((summary) => summary.generation))
                : 0,
            sessionStableCodexIds: [],
            sessionStableContextInitialized: false,
            sessionAgentToolsSnapshot: runtime.snapshotAgentTools(),
            cacheInvalidatedReason: null,
            excludedAutoEntryIds: [],
            threadFocusOverride: null,
          });
        } catch (error) {
          if (
            !isSessionSelectionGenerationCurrent(generation) ||
            !isSessionMutationAuthorityCurrent(authority, get()) ||
            get().activeSessionId !== sessionId
          ) {
            return;
          }
          set({
            activeSessionId: null,
            messages: [],
            isLoadingMessages: false,
          });
          if (isIpcLifecycleCancellation(error)) return;
          runtime.notifyError(runtime.translate("chat.loadMessagesFailed"));
          runtime.reportError("selectSession", error);
        }
      });
    },

    createNewSession: async (
      projectId: string,
      title: string,
      nodeId?: string,
      codexAnchorId?: string,
      snippetAnchorId?: string,
    ) => {
      if (blockSessionMutation()) return;
      const invocationState = get();
      if (invocationState.isStreaming) return;
      const authority = captureSessionMutationAuthority(invocationState);
      if (
        !isSessionTargetForAuthority(
          {
            projectId,
            nodeId: nodeId ?? null,
            codexAnchorId: codexAnchorId ?? null,
            snippetAnchorId: snippetAnchorId ?? null,
          },
          authority,
        )
      ) {
        return;
      }
      return enqueueSessionMutation(async () => {
        if (
          get().isStreaming ||
          !isSessionMutationAuthorityCurrent(authority, get())
        ) {
          return;
        }
        try {
          const session = await repository.createSession(
            projectId,
            title,
            nodeId,
            codexAnchorId,
            snippetAnchorId,
          );
          if (
            get().isStreaming ||
            !isSessionTargetForAuthority(session, authority) ||
            !isSessionMutationAuthorityCurrent(authority, get())
          ) {
            return;
          }
          set((state) => ({
            sessions: [session, ...state.sessions],
            activeSessionId: session.id,
            messages: [],
            summaryCount: 0,
            maxSummaryGeneration: 0,
            sessionStableCodexIds: [],
            sessionStableContextInitialized: false,
            sessionAgentToolsSnapshot: runtime.snapshotAgentTools(),
            cacheInvalidatedReason: null,
            excludedAutoEntryIds: [],
            threadFocusOverride: null,
          }));
        } catch (error) {
          runtime.reportError("createNewSession", error);
          if (isSessionMutationAuthorityCurrent(authority, get())) {
            runtime.notifyError(runtime.translate("chat.createSessionFailed"));
          }
        }
      });
    },

    ensureSession: async () => {
      if (blockSessionMutation()) return null;
      const invocationState = get();
      if (invocationState.isLoadingSessions) return null;
      const authority = captureSessionMutationAuthority(invocationState);
      const capturedSessionId = invocationState.activeSessionId;
      const capturedSession = capturedSessionId
        ? invocationState.sessions.find(
            (session) => session.id === capturedSessionId,
          )
        : undefined;
      if (
        capturedSessionId &&
        (!capturedSession ||
          !isSessionTargetForAuthority(capturedSession, authority))
      ) {
        return null;
      }
      return enqueueSessionMutation(async () => {
        const queuedState = get();
        if (
          queuedState.isLoadingSessions ||
          queuedState.isStreaming ||
          !isSessionMutationAuthorityCurrent(authority, queuedState) ||
          queuedState.activeSessionId !== capturedSessionId
        ) {
          return null;
        }
        if (capturedSessionId) return capturedSessionId;
        const { projectId, scopeKey } = authority;
        try {
          const session = await repository.createSession(
            projectId,
            "New session",
            scopeKey.nodeId === null ? undefined : scopeKey.nodeId,
            scopeKey.codexAnchorId,
            scopeKey.snippetAnchorId,
          );
          if (
            get().isLoadingSessions ||
            get().isStreaming ||
            !isSessionTargetForAuthority(session, authority) ||
            !isSessionMutationAuthorityCurrent(authority, get()) ||
            get().activeSessionId !== capturedSessionId
          ) {
            return null;
          }
          set((state) => ({
            sessions: [session, ...state.sessions],
            activeSessionId: session.id,
          }));
          return session.id;
        } catch (error) {
          runtime.reportError("ensureSession", error);
          return null;
        }
      });
    },

    deleteSession: async (sessionId: string) => {
      if (blockSessionMutation()) return;
      const invocationState = get();
      if (invocationState.isStreaming) return;
      const authority = captureSessionMutationAuthority(invocationState);
      const capturedSession = invocationState.sessions.find(
        (session) => session.id === sessionId,
      );
      if (
        !capturedSession ||
        !isSessionTargetForAuthority(capturedSession, authority)
      ) {
        return;
      }
      return enqueueSessionMutation(async () => {
        if (
          get().isStreaming ||
          !isSessionMutationAuthorityCurrent(authority, get())
        ) {
          return;
        }
        try {
          const { projectId, workspaceIdentity } = authority;
          const ownedSession = await repository.getSessionForProject(
            sessionId,
            projectId,
          );
          if (
            !ownedSession ||
            !isSameCapturedSession(ownedSession, capturedSession) ||
            !isSessionTargetForAuthority(ownedSession, authority) ||
            !isSessionMutationAuthorityCurrent(authority, get())
          ) {
            return;
          }
          if (workspaceIdentity) {
            await repository
              .archiveSessionThread({
                projectId,
                sessionId,
                expectedWorkspacePath: workspaceIdentity.path,
              })
              .catch((error: unknown) =>
                runtime.reportWarning("archive Codex session thread", error),
              );
          }
          if (
            get().isStreaming ||
            !isSessionMutationAuthorityCurrent(authority, get()) ||
            blockSessionMutation()
          ) {
            return;
          }
          await repository.deleteSession(sessionId);
          if (!isSessionMutationAuthorityCurrent(authority, get())) return;
          const { activeSessionId } = get();
          set((state) => ({
            sessions: state.sessions.filter(
              (session) => session.id !== sessionId,
            ),
            ...(activeSessionId === sessionId
              ? {
                  activeSessionId: null,
                  messages: [],
                  excludedAutoEntryIds: [],
                  threadFocusOverride: null,
                }
              : {}),
          }));
        } catch (error) {
          runtime.reportError("deleteSession", error);
          if (isSessionMutationAuthorityCurrent(authority, get())) {
            runtime.notifyError(runtime.translate("chat.deleteSessionFailed"));
          }
        }
      });
    },
  };
}

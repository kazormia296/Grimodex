import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { X, MoreVertical, Plus } from "lucide-react";
import { toast } from "sonner";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { formatInstant } from "@/lib/time";
import { useChatStore } from "@/features/chat/chatStore";
import { getCurrentProjectId } from "@/features/project/projectStore";
import {
  resolveScopeSessionKey,
  scopeSessionKeysEqual,
  type ChatScope,
  type ScopeSessionKey,
} from "../chatScope";
import * as chatApi from "@/features/chat/chatApi";
import type { ChatSession } from "@/features/chat/chatTypes";
import { SessionRowSkeletonList } from "@/components/ui/skeleton-patterns";
import { useAnchoredPopover } from "@/components/ui/useAnchoredPopover";
import { useQuiescentDraftParticipant } from "@/application/lifecycle/useQuiescentDraftParticipant";
import {
  useLatestValueDraftController,
  type LatestValueDraftPersistContext,
} from "@/application/lifecycle/latestValueDraftController";
import type { QuiescenceParticipantFlushOptions } from "@/application/lifecycle/quiescenceParticipants";
import {
  getCurrentImeWorkspaceIdentity,
  isCurrentImeWorkspaceIdentity,
  type ImeWorkspaceIdentity,
} from "@/features/ime/workspaceScope";

interface SessionsPanelProps {
  sceneTitle: string;
  activeSceneId: string;
  onClose: () => void;
  mutationsDisabled?: boolean;
}

interface PanelSessionScopeAuthority {
  workspaceIdentity: ImeWorkspaceIdentity | null;
  projectId: string;
  chatScope: ChatScope;
  scopeKey: ScopeSessionKey;
}

function capturePanelSessionScopeAuthority(
  expectedScope: ChatScope,
  expectedKey: ScopeSessionKey,
): PanelSessionScopeAuthority | null {
  const state = useChatStore.getState();
  const currentKey = resolveScopeSessionKey(
    state.chatScope,
    state.activeSceneId,
    state.scopeAnchorId,
  );
  if (
    state.chatScope !== expectedScope ||
    !scopeSessionKeysEqual(currentKey, expectedKey)
  ) {
    return null;
  }
  return {
    workspaceIdentity: getCurrentImeWorkspaceIdentity(),
    projectId: state.activeProjectId ?? getCurrentProjectId(),
    chatScope: state.chatScope,
    scopeKey: currentKey,
  };
}

function isPanelSessionScopeAuthorityCurrent(
  authority: PanelSessionScopeAuthority,
): boolean {
  const state = useChatStore.getState();
  return (
    (authority.workspaceIdentity
      ? isCurrentImeWorkspaceIdentity(authority.workspaceIdentity)
      : getCurrentImeWorkspaceIdentity() === null) &&
    (state.activeProjectId ?? getCurrentProjectId()) === authority.projectId &&
    state.chatScope === authority.chatScope &&
    scopeSessionKeysEqual(
      resolveScopeSessionKey(
        state.chatScope,
        state.activeSceneId,
        state.scopeAnchorId,
      ),
      authority.scopeKey,
    )
  );
}

interface SessionItemProps {
  session: ChatSession;
  isActive: boolean;
  onSelect: () => void;
  onRename: (
    newTitle: string,
    context?: LatestValueDraftPersistContext,
  ) => Promise<void>;
  onDelete: () => void;
  mutationsDisabled: boolean;
}

function SessionItem({
  session,
  isActive,
  onSelect,
  onRename,
  onDelete,
  mutationsDisabled,
}: SessionItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(session.title);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editingRef = useRef(false);
  const mountedRef = useRef(true);
  const renameController = useLatestValueDraftController(
    `chat-session-title:${session.id}`,
    session.title,
    async (next, context) => {
      const trimmed = next.trim();
      if (trimmed && trimmed !== session.title) {
        if (context.preexistingDraft) {
          await onRename(trimmed, context);
        } else {
          await onRename(trimmed);
        }
      }
    },
  );
  // セッションメニューはチャットパネル内のドロワーにあり、inline absolute だと
  // 祖先 stacking context に埋もれる。document.body へ portal して脱出する。
  const { popoverRef, style } = useAnchoredPopover(
    menuTriggerRef,
    menuOpen,
    () => setMenuOpen(false),
    "bottom-end",
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  useEffect(() => {
    if (editingRef.current || renameController.dirty) return;
    renameController.reset(session.title);
    setEditValue(session.title);
  }, [renameController, session.title]);

  const { t } = useTranslation();

  const handleRenameSubmit = async (
    options?: QuiescenceParticipantFlushOptions,
  ): Promise<void> => {
    if (!editingRef.current) return;
    if (!renameController.latestValue.trim()) {
      renameController.reset(session.title);
    } else {
      await renameController.save(options);
    }
    editingRef.current = false;
    if (mountedRef.current) {
      setEditValue(renameController.latestValue.trim() || session.title);
      setIsEditing(false);
    }
  };

  const cancelRename = () => {
    editingRef.current = false;
    renameController.reset(session.title);
    if (mountedRef.current) {
      setEditValue(session.title);
      setIsEditing(false);
    }
  };

  useQuiescentDraftParticipant({
    id: `chat-session-title:${session.id}`,
    enabled: isEditing,
    isDirty: () => editingRef.current && renameController.dirty,
    flush: handleRenameSubmit,
    discard: cancelRename,
    recovery: () =>
      editingRef.current
        ? {
            kind: "chat-session-title",
            sessionId: session.id,
            title: renameController.latestValue,
          }
        : null,
  });

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      void handleRenameSubmit().catch(() => {});
    } else if (e.key === "Escape") {
      cancelRename();
    }
  };

  const date =
    formatInstant(session.updatedAt, undefined, {
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }) ?? session.updatedAt;

  return (
    <div
      className={`group relative flex items-start gap-2 rounded px-2 py-2 cursor-pointer hover:bg-accent ${
        isActive ? "bg-accent/60" : ""
      }`}
      onClick={() => {
        if (!isEditing) onSelect();
      }}
    >
      <span className="mt-0.5 text-xs text-primary select-none">
        {isActive ? "●" : "○"}
      </span>
      <div className="flex-1 min-w-0">
        {isEditing ? (
          <input
            ref={inputRef}
            value={editValue}
            onChange={(e) => {
              renameController.markDirty(
                e.target.value.trim() ? e.target.value : session.title,
              );
              setEditValue(e.target.value);
            }}
            onKeyDown={handleKeyDown}
            onBlur={() => void handleRenameSubmit().catch(() => {})}
            onClick={(e) => e.stopPropagation()}
            className="w-full rounded border border-input bg-background px-1 py-0 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          />
        ) : (
          <p className="truncate text-xs font-medium text-foreground">
            {session.title}
          </p>
        )}
        <p className="text-[10px] text-muted-foreground">{date}</p>
      </div>
      <div className="relative">
        <button
          ref={menuTriggerRef}
          type="button"
          aria-label={t("chat.sessionMenu")}
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          className="invisible group-hover:visible rounded p-0.5 hover:bg-muted text-muted-foreground"
        >
          <MoreVertical className="h-3 w-3" />
        </button>
        {menuOpen &&
          style &&
          createPortal(
            <div
              ref={popoverRef}
              style={style}
              className="z-[100] w-28 rounded border border-border bg-popover shadow-md"
            >
              <button
                type="button"
                disabled={mutationsDisabled}
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                  if (editingRef.current) return;
                  editingRef.current = true;
                  renameController.reset(session.title);
                  setEditValue(session.title);
                  setIsEditing(true);
                }}
                className="w-full px-3 py-1.5 text-left text-xs hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
              >
                {t("chat.sessionRename")}
              </button>
              <button
                type="button"
                disabled={mutationsDisabled}
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                  onDelete();
                }}
                className="w-full px-3 py-1.5 text-left text-xs text-destructive hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
              >
                {t("common.delete")}
              </button>
            </div>,
            document.body,
          )}
      </div>
    </div>
  );
}

export function SessionsPanel({
  sceneTitle,
  activeSceneId,
  onClose,
  mutationsDisabled = false,
}: SessionsPanelProps) {
  const sessions = useChatStore((s) => s.sessions);
  const isLoadingSessions = useChatStore((s) => s.isLoadingSessions);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const selectSession = useChatStore((s) => s.selectSession);
  const createNewSession = useChatStore((s) => s.createNewSession);
  const deleteSession = useChatStore((s) => s.deleteSession);
  const chatScope = useChatStore((s) => s.chatScope);
  const scopeAnchorId = useChatStore((s) => s.scopeAnchorId);
  const { t } = useTranslation();

  const sessionKey = useMemo(
    () => resolveScopeSessionKey(chatScope, activeSceneId, scopeAnchorId),
    [activeSceneId, chatScope, scopeAnchorId],
  );

  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadSessions(
      sessionKey.nodeId,
      sessionKey.codexAnchorId,
      sessionKey.snippetAnchorId,
    );
  }, [loadSessions, sessionKey]);

  const handleSelect = useCallback(
    (sessionId: string) => {
      selectSession(sessionId);
      onClose();
    },
    [selectSession, onClose],
  );

  const handleRename = useCallback(
    async (sessionId: string, newTitle: string) => {
      const authority = capturePanelSessionScopeAuthority(
        chatScope,
        sessionKey,
      );
      if (!authority) return;
      try {
        await chatApi.updateSessionTitle(sessionId, newTitle);
        if (!isPanelSessionScopeAuthorityCurrent(authority)) return;
        await loadSessions(
          authority.scopeKey.nodeId,
          authority.scopeKey.codexAnchorId,
          authority.scopeKey.snippetAnchorId,
        );
      } catch (e) {
        debugLog.error("SessionsPanel", "rename failed", errorDetail(e));
        if (isPanelSessionScopeAuthorityCurrent(authority)) {
          toast.error(t("chat.sessionRenameFailed"));
        }
        throw e;
      }
    },
    [sessionKey, chatScope, loadSessions, t],
  );

  const handleDelete = useCallback(
    async (sessionId: string) => {
      if (mutationsDisabled) return;
      const confirmed = window.confirm(t("chat.sessionDeleteConfirm"));
      if (!confirmed) return;
      const authority = capturePanelSessionScopeAuthority(
        chatScope,
        sessionKey,
      );
      if (!authority) return;
      try {
        await deleteSession(sessionId);
        if (!isPanelSessionScopeAuthorityCurrent(authority)) return;
        await loadSessions(
          authority.scopeKey.nodeId,
          authority.scopeKey.codexAnchorId,
          authority.scopeKey.snippetAnchorId,
        );
      } catch (e) {
        debugLog.error("SessionsPanel", "delete failed", errorDetail(e));
        if (isPanelSessionScopeAuthorityCurrent(authority)) {
          toast.error(t("chat.deleteSessionFailed"));
        }
      }
    },
    [sessionKey, chatScope, deleteSession, loadSessions, t, mutationsDisabled],
  );

  const handleCreate = useCallback(async () => {
    if (mutationsDisabled) return;
    const authority = capturePanelSessionScopeAuthority(chatScope, sessionKey);
    if (!authority) return;
    try {
      await createNewSession(
        authority.projectId,
        "New session",
        authority.scopeKey.nodeId === null
          ? undefined
          : authority.scopeKey.nodeId,
        authority.scopeKey.codexAnchorId,
        authority.scopeKey.snippetAnchorId,
      );
      if (!isPanelSessionScopeAuthorityCurrent(authority)) return;
      const loaded = await loadSessions(
        authority.scopeKey.nodeId,
        authority.scopeKey.codexAnchorId,
        authority.scopeKey.snippetAnchorId,
      );
      if (!loaded || !isPanelSessionScopeAuthorityCurrent(authority)) return;
      onClose();
    } catch (e) {
      debugLog.error("SessionsPanel", "create failed", errorDetail(e));
      if (isPanelSessionScopeAuthorityCurrent(authority)) {
        toast.error(t("chat.createSessionFailed"));
      }
    }
  }, [
    sessionKey,
    chatScope,
    createNewSession,
    loadSessions,
    onClose,
    t,
    mutationsDisabled,
  ]);

  // Close on click outside
  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === overlayRef.current) {
      onClose();
    }
  };

  return (
    <div
      ref={overlayRef}
      className="absolute inset-0 z-20"
      onClick={handleOverlayClick}
    >
      <div className="absolute inset-y-0 right-0 z-30 w-64 bg-background border-l border-border shadow-lg flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-foreground truncate">
              Sessions for: {sceneTitle}
            </p>
          </div>
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={onClose}
            className="ml-2 rounded p-0.5 hover:bg-muted text-muted-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Session list */}
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {isLoadingSessions ? (
            <SessionRowSkeletonList testId="sessions-panel-loading" />
          ) : sessions.length === 0 ? (
            <p className="text-center text-xs text-muted-foreground mt-4">
              {t("chat.noSessions")}
            </p>
          ) : (
            sessions.map((session) => (
              <SessionItem
                key={session.id}
                session={session}
                isActive={session.id === activeSessionId}
                onSelect={() => handleSelect(session.id)}
                onRename={(newTitle) => handleRename(session.id, newTitle)}
                onDelete={() => handleDelete(session.id)}
                mutationsDisabled={mutationsDisabled}
              />
            ))
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-border p-2">
          <button
            type="button"
            onClick={handleCreate}
            disabled={mutationsDisabled}
            className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" />
            New session
          </button>
        </div>
      </div>
    </div>
  );
}

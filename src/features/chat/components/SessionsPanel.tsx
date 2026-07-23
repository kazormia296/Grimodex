import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { X, MoreVertical, Plus } from "lucide-react";
import { toast } from "sonner";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { formatInstant } from "@/lib/time";
import { useChatStore } from "@/features/chat/chatStore";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { resolveScopeSessionKey } from "../chatScope";
import * as chatApi from "@/features/chat/chatApi";
import type { ChatSession } from "@/features/chat/chatTypes";
import { SessionRowSkeletonList } from "@/components/ui/skeleton-patterns";
import { useAnchoredPopover } from "@/components/ui/useAnchoredPopover";

interface SessionsPanelProps {
  sceneTitle: string;
  activeSceneId: string;
  onClose: () => void;
  mutationsDisabled?: boolean;
}

interface SessionItemProps {
  session: ChatSession;
  isActive: boolean;
  onSelect: () => void;
  onRename: (newTitle: string) => void;
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
  // セッションメニューはチャットパネル内のドロワーにあり、inline absolute だと
  // 祖先 stacking context に埋もれる。document.body へ portal して脱出する。
  const { popoverRef, style } = useAnchoredPopover(
    menuTriggerRef,
    menuOpen,
    () => setMenuOpen(false),
    "bottom-end",
  );

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const { t } = useTranslation();

  const handleRenameSubmit = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== session.title) {
      onRename(trimmed);
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      handleRenameSubmit();
    } else if (e.key === "Escape") {
      setEditValue(session.title);
      setIsEditing(false);
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
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleRenameSubmit}
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

  const sessionKey = resolveScopeSessionKey(
    chatScope,
    activeSceneId,
    scopeAnchorId,
  );

  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadSessions(
      sessionKey.nodeId,
      sessionKey.codexAnchorId,
      sessionKey.snippetAnchorId,
    );
  }, [
    sessionKey.nodeId,
    sessionKey.codexAnchorId,
    sessionKey.snippetAnchorId,
    loadSessions,
  ]);

  const handleSelect = useCallback(
    (sessionId: string) => {
      selectSession(sessionId);
      onClose();
    },
    [selectSession, onClose],
  );

  const handleRename = useCallback(
    async (sessionId: string, newTitle: string) => {
      try {
        await chatApi.updateSessionTitle(sessionId, newTitle);
        await loadSessions(
          sessionKey.nodeId,
          sessionKey.codexAnchorId,
          sessionKey.snippetAnchorId,
        );
      } catch (e) {
        debugLog.error("SessionsPanel", "rename failed", errorDetail(e));
        toast.error(t("chat.sessionRenameFailed"));
      }
    },
    [
      sessionKey.nodeId,
      sessionKey.codexAnchorId,
      sessionKey.snippetAnchorId,
      loadSessions,
      t,
    ],
  );

  const handleDelete = useCallback(
    async (sessionId: string) => {
      if (mutationsDisabled) return;
      const confirmed = window.confirm(t("chat.sessionDeleteConfirm"));
      if (!confirmed) return;
      try {
        await deleteSession(sessionId);
        await loadSessions(
          sessionKey.nodeId,
          sessionKey.codexAnchorId,
          sessionKey.snippetAnchorId,
        );
      } catch (e) {
        debugLog.error("SessionsPanel", "delete failed", errorDetail(e));
        toast.error(t("chat.deleteSessionFailed"));
      }
    },
    [
      sessionKey.nodeId,
      sessionKey.codexAnchorId,
      sessionKey.snippetAnchorId,
      deleteSession,
      loadSessions,
      t,
      mutationsDisabled,
    ],
  );

  const handleCreate = useCallback(async () => {
    if (mutationsDisabled) return;
    try {
      await createNewSession(
        getCurrentProjectId(),
        "New session",
        sessionKey.nodeId === null ? undefined : sessionKey.nodeId,
        sessionKey.codexAnchorId,
        sessionKey.snippetAnchorId,
      );
      await loadSessions(
        sessionKey.nodeId,
        sessionKey.codexAnchorId,
        sessionKey.snippetAnchorId,
      );
      onClose();
    } catch (e) {
      debugLog.error("SessionsPanel", "create failed", errorDetail(e));
      toast.error(t("chat.createSessionFailed"));
    }
  }, [
    sessionKey.nodeId,
    sessionKey.codexAnchorId,
    sessionKey.snippetAnchorId,
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

import { useState, useEffect, useRef, useCallback } from "react";
import { X, MoreVertical, Plus } from "lucide-react";
import { toast } from "sonner";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { useChatStore } from "@/features/chat/chatStore";
import * as chatApi from "@/features/chat/chatApi";
import type { ChatSession } from "@/features/chat/chatTypes";

interface SessionsPanelProps {
  sceneTitle: string;
  activeSceneId: string;
  onClose: () => void;
}

interface SessionItemProps {
  session: ChatSession;
  isActive: boolean;
  onSelect: () => void;
  onRename: (newTitle: string) => void;
  onDelete: () => void;
}

function SessionItem({
  session,
  isActive,
  onSelect,
  onRename,
  onDelete,
}: SessionItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(session.title);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  useEffect(() => {
    if (!menuOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen]);

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

  const date = new Date(session.updatedAt).toLocaleDateString();

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
      <div className="relative" ref={menuRef}>
        <button
          type="button"
          aria-label="セッションメニュー"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          className="invisible group-hover:visible rounded p-0.5 hover:bg-muted text-muted-foreground"
        >
          <MoreVertical className="h-3 w-3" />
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-5 z-40 w-28 rounded border border-border bg-popover shadow-md">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen(false);
                setIsEditing(true);
              }}
              className="w-full px-3 py-1.5 text-left text-xs hover:bg-accent"
            >
              名前を変更
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen(false);
                onDelete();
              }}
              className="w-full px-3 py-1.5 text-left text-xs text-destructive hover:bg-accent"
            >
              削除
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function SessionsPanel({
  sceneTitle,
  activeSceneId,
  onClose,
}: SessionsPanelProps) {
  const sessions = useChatStore((s) => s.sessions);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const selectSession = useChatStore((s) => s.selectSession);
  const createNewSession = useChatStore((s) => s.createNewSession);
  const deleteSession = useChatStore((s) => s.deleteSession);

  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadSessions(activeSceneId || undefined);
  }, [activeSceneId, loadSessions]);

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
        await loadSessions(activeSceneId || undefined);
      } catch (e) {
        debugLog.error("SessionsPanel", "rename failed", errorDetail(e));
        toast.error("名前の変更に失敗しました");
      }
    },
    [activeSceneId, loadSessions],
  );

  const handleDelete = useCallback(
    async (sessionId: string) => {
      const confirmed = window.confirm(
        "このセッションを削除しますか？メッセージもすべて削除されます。",
      );
      if (!confirmed) return;
      try {
        await deleteSession(sessionId);
        await loadSessions(activeSceneId || undefined);
      } catch (e) {
        debugLog.error("SessionsPanel", "delete failed", errorDetail(e));
        toast.error("セッションの削除に失敗しました");
      }
    },
    [activeSceneId, deleteSession, loadSessions],
  );

  const handleCreate = useCallback(async () => {
    try {
      await createNewSession(
        "default-project",
        "New session",
        activeSceneId || undefined,
      );
      await loadSessions(activeSceneId || undefined);
      onClose();
    } catch (e) {
      debugLog.error("SessionsPanel", "create failed", errorDetail(e));
      toast.error("セッションの作成に失敗しました");
    }
  }, [activeSceneId, createNewSession, loadSessions, onClose]);

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
            aria-label="閉じる"
            onClick={onClose}
            className="ml-2 rounded p-0.5 hover:bg-muted text-muted-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Session list */}
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {sessions.length === 0 ? (
            <p className="text-center text-xs text-muted-foreground mt-4">
              セッションがありません
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
              />
            ))
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-border p-2">
          <button
            type="button"
            onClick={handleCreate}
            className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
            New session
          </button>
        </div>
      </div>
    </div>
  );
}

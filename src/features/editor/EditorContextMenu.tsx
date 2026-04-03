import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { nanoid } from "nanoid";
import { createCodexEntry, BUILTIN_CODEX_TYPES } from "@/features/codex/api";
import { createSnippet } from "@/features/snippets/api";
import { useSceneStore } from "@/features/tree/store";
import { cn } from "@/lib/utils";

const PROJECT_ID = "default-project";

type MenuMode = "root" | "codex" | "snippet";

interface Position {
  x: number;
  y: number;
}

interface EditorContextMenuProps {
  editor: Editor | null;
  containerRef: React.RefObject<HTMLElement | null>;
}

/**
 * C-6: Right-click context menu for editor selection.
 * "コデックスに追加" / "スニペットとして保存"
 */
export function EditorContextMenu({ editor, containerRef }: EditorContextMenuProps) {
  const [pos, setPos] = useState<Position | null>(null);
  const [mode, setMode] = useState<MenuMode>("root");
  const [selectedText, setSelectedText] = useState("");
  const [codexName, setCodexName] = useState("");
  const [codexType, setCodexType] = useState<string>(BUILTIN_CODEX_TYPES[0]);
  const [snippetTitle, setSnippetTitle] = useState("");
  const [snippetTags, setSnippetTags] = useState("");
  const [saving, setSaving] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const activeSceneId = useSceneStore((s) => s.activeSceneId);

  const close = useCallback(() => {
    setPos(null);
    setMode("root");
    setCodexName("");
    setSnippetTitle("");
    setSnippetTags("");
    setSaving(false);
  }, []);

  // Context menu handler
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !editor) return;

    function onContextMenu(e: MouseEvent) {
      if (!editor) return;
      const text = editor.state.selection.empty
        ? ""
        : editor.state.doc.textBetween(
            editor.state.selection.from,
            editor.state.selection.to,
            " ",
          );
      if (!text.trim()) return;

      e.preventDefault();
      setSelectedText(text);
      setCodexName(text.trim().slice(0, 60));
      setSnippetTitle(text.trim().slice(0, 60));
      setMode("root");
      setPos({ x: e.clientX, y: e.clientY });
    }

    container.addEventListener("contextmenu", onContextMenu);
    return () => container.removeEventListener("contextmenu", onContextMenu);
  }, [editor, containerRef]);

  // Close on outside click or Escape
  useEffect(() => {
    if (!pos) return;

    function onMouseDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        close();
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }

    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [pos, close]);

  const handleSaveCodex = async () => {
    if (!codexName.trim()) return;
    setSaving(true);
    try {
      await createCodexEntry({
        id: nanoid(),
        projectId: PROJECT_ID,
        type: codexType,
        name: codexName.trim(),
        summary: selectedText,
      });
      close();
    } finally {
      setSaving(false);
    }
  };

  const handleSaveSnippet = async () => {
    if (!snippetTitle.trim()) return;
    setSaving(true);
    try {
      await createSnippet({
        id: nanoid(),
        projectId: PROJECT_ID,
        title: snippetTitle.trim(),
        content: selectedText,
        sceneId: activeSceneId || undefined,
        tags: snippetTags.trim() || undefined,
      });
      close();
    } finally {
      setSaving(false);
    }
  };

  if (!pos) return null;

  // Adjust position to stay within viewport
  const menuWidth = 220;
  const x = Math.min(pos.x, window.innerWidth - menuWidth - 8);
  const y = pos.y;

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-50 rounded-md border border-border bg-popover shadow-md"
      style={{ left: x, top: y, minWidth: menuWidth }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {mode === "root" && (
        <div className="flex flex-col py-1">
          <div className="px-3 py-1 text-xs text-muted-foreground truncate border-b border-border mb-1">
            「{selectedText.slice(0, 30)}{selectedText.length > 30 ? "…" : ""}」
          </div>
          <button
            type="button"
            className="px-3 py-1.5 text-sm text-left hover:bg-accent"
            onClick={() => setMode("codex")}
          >
            コデックスに追加…
          </button>
          <button
            type="button"
            className="px-3 py-1.5 text-sm text-left hover:bg-accent"
            onClick={() => setMode("snippet")}
          >
            スニペットとして保存…
          </button>
        </div>
      )}

      {mode === "codex" && (
        <div className="flex flex-col gap-2 p-3">
          <p className="text-xs font-medium text-foreground">コデックスに追加</p>
          <select
            value={codexType}
            onChange={(e) => setCodexType(e.target.value)}
            className="rounded border border-border bg-background px-2 py-1 text-xs"
          >
            {BUILTIN_CODEX_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <input
            autoFocus
            value={codexName}
            onChange={(e) => setCodexName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSaveCodex();
              if (e.key === "Escape") close();
            }}
            placeholder="名前"
            className="rounded border border-border bg-background px-2 py-1 text-xs"
          />
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              onClick={close}
              className="rounded px-2 py-1 text-xs hover:bg-accent"
            >
              キャンセル
            </button>
            <button
              type="button"
              disabled={saving || !codexName.trim()}
              onClick={handleSaveCodex}
              className={cn(
                "rounded px-2 py-1 text-xs bg-primary text-primary-foreground hover:opacity-90",
                (saving || !codexName.trim()) && "opacity-50 pointer-events-none",
              )}
            >
              追加
            </button>
          </div>
        </div>
      )}

      {mode === "snippet" && (
        <div className="flex flex-col gap-2 p-3">
          <p className="text-xs font-medium text-foreground">スニペットとして保存</p>
          <input
            autoFocus
            value={snippetTitle}
            onChange={(e) => setSnippetTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSaveSnippet();
              if (e.key === "Escape") close();
            }}
            placeholder="タイトル"
            className="rounded border border-border bg-background px-2 py-1 text-xs"
          />
          <input
            value={snippetTags}
            onChange={(e) => setSnippetTags(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
            }}
            placeholder="タグ（省略可）"
            className="rounded border border-border bg-background px-2 py-1 text-xs"
          />
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              onClick={close}
              className="rounded px-2 py-1 text-xs hover:bg-accent"
            >
              キャンセル
            </button>
            <button
              type="button"
              disabled={saving || !snippetTitle.trim()}
              onClick={handleSaveSnippet}
              className={cn(
                "rounded px-2 py-1 text-xs bg-primary text-primary-foreground hover:opacity-90",
                (saving || !snippetTitle.trim()) && "opacity-50 pointer-events-none",
              )}
            >
              保存
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}

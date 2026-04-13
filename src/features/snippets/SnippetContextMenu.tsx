import { useEffect, useRef } from "react";
import { Copy, FilePlus, Pencil, TextCursorInput, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { copyWithAttribution } from "@/lib/clipboardAttribution";
import type { AuthorshipSource } from "@/features/attribution/AuthorshipMark";
import { useEditorStore } from "@/features/editor/editorStore";
import { useTreeStore } from "@/features/tree/treeStore";
import type { Snippet } from "./api";
import { useSnippetStore } from "./snippetStore";

interface SnippetContextMenuProps {
  snippet: Snippet;
  x: number;
  y: number;
  onClose: () => void;
  onEdit: (snippet: Snippet) => void;
  onDelete: (id: string) => void;
}

export function SnippetContextMenu({
  snippet,
  x,
  y,
  onClose,
  onEdit,
  onDelete,
}: SnippetContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const create = useSnippetStore((s) => s.create);
  const incrementUsageCount = useSnippetStore((s) => s.incrementUsageCount);
  const setActiveScene = useTreeStore((s) => s.setActiveScene);

  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [onClose]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function handleInsertAtCursor() {
    const { insertFromSnippet } = useEditorStore.getState();
    const source = (snippet.contentSource as "ai" | "human") ?? "human";
    const success = insertFromSnippet(
      snippet.id,
      snippet.content,
      source,
      null,
    );
    if (success) {
      void incrementUsageCount(snippet.id);
      toast.success("挿入しました");
    }
    onClose();
  }

  function handleCopy() {
    const source = (snippet.contentSource as AuthorshipSource) ?? "human";
    copyWithAttribution(snippet.content, source);
    toast.success("コピーしました");
    onClose();
  }

  function handleEdit() {
    onEdit(snippet);
    onClose();
  }

  async function handleDuplicate() {
    await create({
      title: `${snippet.title} (copy)`,
      content: snippet.content,
      tagsCache: snippet.tagsCache ?? undefined,
    });
    onClose();
  }

  function handleGoToScene() {
    if (snippet.sceneId) {
      setActiveScene(snippet.sceneId);
    }
    onClose();
  }

  function handleDelete() {
    onDelete(snippet.id);
    onClose();
  }

  return (
    <div
      ref={menuRef}
      data-testid="snippet-context-menu"
      style={{ left: `${x}px`, top: `${y}px` }}
      className="fixed z-50 min-w-[180px] rounded-lg border border-border bg-background shadow-lg"
    >
      <div className="border-b border-border px-3 py-2">
        <p className="truncate text-xs font-semibold">{snippet.title}</p>
      </div>

      <div className="py-1">
        <button
          type="button"
          data-testid="snippet-context-insert"
          onClick={handleInsertAtCursor}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
        >
          <TextCursorInput className="h-3.5 w-3.5 text-muted-foreground" />
          カーソル位置に挿入
        </button>

        <button
          type="button"
          data-testid="snippet-context-copy"
          onClick={handleCopy}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
        >
          <Copy className="h-3.5 w-3.5 text-muted-foreground" />
          コピー
        </button>

        <button
          type="button"
          data-testid="snippet-context-edit"
          onClick={handleEdit}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
        >
          <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
          編集
        </button>

        <div className="my-1 border-t border-border" />

        <button
          type="button"
          data-testid="snippet-context-duplicate"
          onClick={() => void handleDuplicate()}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
        >
          <FilePlus className="h-3.5 w-3.5 text-muted-foreground" />
          複製
        </button>

        {snippet.sceneId && (
          <button
            type="button"
            data-testid="snippet-context-go-to-scene"
            onClick={handleGoToScene}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
          >
            <span className="h-3.5 w-3.5 shrink-0 text-muted-foreground">
              📄
            </span>
            シーンへ移動
          </button>
        )}

        <div className="my-1 border-t border-border" />

        <button
          type="button"
          data-testid="snippet-context-delete"
          onClick={handleDelete}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-destructive hover:bg-destructive/10"
        >
          <Trash2 className="h-3.5 w-3.5" />
          削除
        </button>
      </div>
    </div>
  );
}

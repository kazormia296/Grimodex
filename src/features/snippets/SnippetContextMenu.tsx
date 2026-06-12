import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Bookmark,
  ChevronRight,
  Copy,
  FilePlus,
  FileText,
  MapPin,
  Pencil,
  TextCursorInput,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { copyWithAttribution } from "@/lib/clipboardAttribution";
import type { AuthorshipSource } from "@/features/attribution/AuthorshipMark";
import { useEditorStore } from "@/features/editor/editorStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { CreateForeshadowDialog } from "@/features/foreshadow/CreateForeshadowDialog";
import { useForeshadowStore } from "@/features/foreshadow/foreshadowStore";
import type { Snippet } from "./api";
import { useSnippetStore } from "./snippetStore";
import { useAddToMapBoards } from "@/features/map/hooks/useAddToMapBoards";
import { getCurrentProjectId } from "@/features/project/projectStore";

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
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const create = useSnippetStore((s) => s.create);
  const incrementUsageCount = useSnippetStore((s) => s.incrementUsageCount);
  const setActiveScene = useTreeStore((s) => s.setActiveScene);
  const createForeshadow = useForeshadowStore((s) => s.create);
  const [foreshadowDialogOpen, setForeshadowDialogOpen] = useState(false);
  const [mapMenuOpen, setMapMenuOpen] = useState(false);
  const { boards, addToBoard } = useAddToMapBoards(getCurrentProjectId());

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
      undefined,
      snippet.sourceChatMessageId,
    );
    if (success) {
      void incrementUsageCount(snippet.id);
      toast.success(t("snippets.inserted"));
    }
    onClose();
  }

  function handleCopy() {
    const source = (snippet.contentSource as AuthorshipSource) ?? "human";
    copyWithAttribution(snippet.content, source);
    toast.success(t("snippets.copied"));
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

  function handleOpenForeshadowDialog() {
    setForeshadowDialogOpen(true);
  }

  async function handleSaveForeshadow(data: {
    title: string;
    intent: string | null;
    loadBearing:
      | import("@/features/foreshadow/types").ForeshadowLoadBearing
      | null;
  }) {
    await createForeshadow({
      projectId: getCurrentProjectId(),
      title: data.title,
      intent: data.intent,
      loadBearing: data.loadBearing,
    });
    toast.success(
      t("foreshadow.store.createSuccess", "伏線として登録しました"),
    );
    onClose();
  }

  if (foreshadowDialogOpen) {
    return (
      <CreateForeshadowDialog
        open={true}
        projectId={getCurrentProjectId()}
        initialTitle={snippet.title.slice(0, 60)}
        initialIntent={snippet.content.slice(0, 200)}
        onSave={handleSaveForeshadow}
        onClose={() => setForeshadowDialogOpen(false)}
      />
    );
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
          {t("snippets.contextMenu.insertAtCursor")}
        </button>

        <button
          type="button"
          data-testid="snippet-context-copy"
          onClick={handleCopy}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
        >
          <Copy className="h-3.5 w-3.5 text-muted-foreground" />
          {t("snippets.contextMenu.copy")}
        </button>

        <button
          type="button"
          data-testid="snippet-context-edit"
          onClick={handleEdit}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
        >
          <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
          {t("snippets.contextMenu.edit")}
        </button>

        <div className="my-1 border-t border-border" />

        <button
          type="button"
          data-testid="snippet-context-duplicate"
          onClick={() => void handleDuplicate()}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
        >
          <FilePlus className="h-3.5 w-3.5 text-muted-foreground" />
          {t("snippets.contextMenu.duplicate")}
        </button>

        {boards.length > 0 && (
          <div
            className="relative"
            onMouseEnter={() => setMapMenuOpen(true)}
            onMouseLeave={() => setMapMenuOpen(false)}
          >
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
            >
              <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
              <span>Map に追加</span>
              <ChevronRight className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
            </button>
            {mapMenuOpen && (
              <div className="absolute left-full top-0 ml-1 min-w-[160px] rounded-md border border-border bg-popover py-1 shadow-md">
                {boards.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => {
                      void addToBoard(b.id, {
                        nodeRefType: "snippet",
                        snippetId: snippet.id,
                      });
                      onClose();
                    }}
                    className="flex w-full items-center px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent"
                  >
                    {b.title}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {snippet.sceneId && (
          <button
            type="button"
            data-testid="snippet-context-go-to-scene"
            onClick={handleGoToScene}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
          >
            <FileText
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
              aria-hidden
            />
            {t("snippets.contextMenu.goToScene")}
          </button>
        )}

        <button
          type="button"
          data-testid="snippet-context-register-foreshadow"
          onClick={handleOpenForeshadowDialog}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
        >
          <Bookmark className="h-3.5 w-3.5 text-muted-foreground" />
          {t("snippets.contextMenu.registerAsForeshadow")}
        </button>

        <div className="my-1 border-t border-border" />

        <button
          type="button"
          data-testid="snippet-context-delete"
          onClick={handleDelete}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-destructive hover:bg-destructive/10"
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t("snippets.contextMenu.delete")}
        </button>
      </div>
    </div>
  );
}

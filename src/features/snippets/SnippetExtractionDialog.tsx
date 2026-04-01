import { useState, useEffect } from "react";
import type { NewSnippet } from "./api";

interface SnippetExtractionDialogProps {
  open: boolean;
  initialContent: string;
  messageId: string;
  messageRole?: "user" | "assistant";
  onSave: (
    data: Pick<NewSnippet, "title" | "content" | "tags"> & {
      sourceChatMessageId: string;
    },
  ) => Promise<void>;
  onClose: () => void;
}

export function SnippetExtractionDialog({
  open,
  initialContent,
  messageId,
  onSave,
  onClose,
}: SnippetExtractionDialogProps) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState(initialContent);
  const [tags, setTags] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setTitle("");
      setContent(initialContent);
      setTags("");
      setIsSaving(false);
    }
  }, [open, initialContent]);

  if (!open) return null;

  const canSave = title.trim().length > 0 && !isSaving;

  const handleSave = async () => {
    if (!canSave) return;
    setIsSaving(true);
    await onSave({
      title: title.trim(),
      content,
      tags: tags.trim(),
      sourceChatMessageId: messageId,
    });
    setIsSaving(false);
    onClose();
  };

  return (
    <div
      data-testid="snippet-extraction-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-lg">
        <h3 className="mb-4 text-sm font-semibold text-foreground">
          Snippetとして保存
        </h3>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              タイトル
            </label>
            <input
              data-testid="snippet-title-input"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Snippetのタイトル"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              内容
            </label>
            <textarea
              data-testid="snippet-content-input"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={5}
              className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              タグ（カンマ区切り）
            </label>
            <input
              data-testid="snippet-tags-input"
              type="text"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="タグ1,タグ2"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            data-testid="snippet-cancel-button"
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent"
          >
            キャンセル
          </button>
          <button
            type="button"
            data-testid="snippet-save-button"
            onClick={handleSave}
            disabled={!canSave}
            className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

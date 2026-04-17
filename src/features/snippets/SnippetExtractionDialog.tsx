import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { NewSnippet } from "./api";
import { AnimatedOverlay } from "@/components/ui/animated-overlay";

interface SnippetExtractionDialogProps {
  open: boolean;
  initialContent: string;
  messageId: string;
  messageRole?: "user" | "assistant";
  onSave: (
    data: Pick<NewSnippet, "title" | "content" | "tagsCache"> & {
      sourceChatMessageId: string;
      contentSource?: string;
    },
  ) => Promise<void>;
  onClose: () => void;
}

export function SnippetExtractionDialog({
  open,
  initialContent,
  messageId,
  messageRole,
  onSave,
  onClose,
}: SnippetExtractionDialogProps) {
  const { t } = useTranslation();
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

  const canSave = title.trim().length > 0 && !isSaving;

  const handleSave = async () => {
    if (!canSave) return;
    setIsSaving(true);
    await onSave({
      title: title.trim(),
      content,
      tagsCache: tags.trim()
        ? JSON.stringify(
            tags
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean),
          )
        : undefined,
      sourceChatMessageId: messageId,
      ...(messageRole !== undefined && {
        contentSource: messageRole === "assistant" ? "ai" : "human",
      }),
    });
    setIsSaving(false);
    onClose();
  };

  return (
    <AnimatedOverlay
      open={open}
      onClose={onClose}
      className="w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-lg"
      testId="snippet-extraction-dialog"
    >
      <h3 className="mb-4 text-sm font-semibold text-foreground">
        {t("snippets.extraction.title")}
      </h3>

      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            {t("snippets.extraction.titleLabel")}
          </label>
          <input
            data-testid="snippet-title-input"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("snippets.extraction.titlePlaceholder")}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            {t("snippets.extraction.contentLabel")}
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
            {t("snippets.extraction.tagsLabel")}
          </label>
          <input
            data-testid="snippet-tags-input"
            type="text"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder={t("snippets.extraction.tagsPlaceholder")}
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
          {t("common.cancel")}
        </button>
        <button
          type="button"
          data-testid="snippet-save-button"
          onClick={handleSave}
          disabled={!canSave}
          className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none"
        >
          {t("common.save")}
        </button>
      </div>
    </AnimatedOverlay>
  );
}

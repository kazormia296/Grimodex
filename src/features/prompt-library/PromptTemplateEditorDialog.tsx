import { useState } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AnimatedOverlay } from "@/components/ui/animated-overlay";
import { Button } from "@/components/ui/button";

interface PromptTemplateEditorDialogProps {
  /** ダイアログのタイトル（新規 / 編集で出し分け）。 */
  heading: string;
  initialTitle: string;
  initialContent: string;
  onSubmit: (title: string, content: string) => void;
  onClose: () => void;
}

/**
 * プロンプトテンプレートの新規作成 / 編集ダイアログ。
 * タイトル + 本文の 2 フィールドのみ（v1 はパラメータ置換なし）。
 */
export function PromptTemplateEditorDialog({
  heading,
  initialTitle,
  initialContent,
  onSubmit,
  onClose,
}: PromptTemplateEditorDialogProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(initialTitle);
  const [content, setContent] = useState(initialContent);
  const canSubmit = title.trim().length > 0 && content.trim().length > 0;

  return (
    <AnimatedOverlay
      open
      onClose={onClose}
      className="relative flex max-h-[80vh] w-[520px] max-w-[90vw] flex-col rounded-lg bg-background shadow-lg"
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{heading}</h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-muted-foreground hover:bg-accent"
          aria-label={t("common.close")}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            {t("promptLibrary.editor.titleLabel")}
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
            placeholder={t("promptLibrary.editor.titlePlaceholder")}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            {t("promptLibrary.editor.contentLabel")}
          </label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={8}
            maxLength={8000}
            placeholder={t("promptLibrary.editor.contentPlaceholder")}
            className="w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      </div>

      <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!canSubmit}
          onClick={() => onSubmit(title.trim(), content)}
        >
          {t("common.save")}
        </Button>
      </div>
    </AnimatedOverlay>
  );
}

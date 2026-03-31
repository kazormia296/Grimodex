import { useState } from "react";
import { useEditorStore } from "./editorStore";

export function VerticalPreview() {
  const [open, setOpen] = useState(false);
  const editor = useEditorStore((s) => s.editor);

  if (!open) {
    return (
      <button
        type="button"
        aria-label="縦書きプレビュー"
        className="text-xs px-2 py-0.5 text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(true)}
        data-testid="vertical-preview-toggle"
      >
        縦書き
      </button>
    );
  }

  const html = editor?.getHTML() ?? "";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80"
      data-testid="vertical-preview-overlay"
    >
      <div className="relative w-[90vw] h-[85vh] rounded-lg border border-border bg-background shadow-lg flex flex-col">
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <h2 className="text-sm font-semibold">縦書きプレビュー</h2>
          <button
            type="button"
            aria-label="閉じる"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => setOpen(false)}
          >
            ✕
          </button>
        </div>
        <div
          className="vertical-preview flex-1 overflow-auto p-8"
          dangerouslySetInnerHTML={{ __html: html }}
          data-testid="vertical-preview-content"
        />
      </div>
    </div>
  );
}

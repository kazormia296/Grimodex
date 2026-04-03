import { useEditorStore } from "./editorStore";

interface VerticalPreviewProps {
  open: boolean;
  onClose: () => void;
}

export function VerticalPreview({ open, onClose }: VerticalPreviewProps) {
  const editor = useEditorStore((s) => s.editor);

  if (!open) return null;

  const html = editor?.getHTML() ?? "";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80"
      data-testid="vertical-preview-overlay"
    >
      <div className="relative flex h-[85vh] w-[90vw] flex-col rounded-lg border border-border bg-background shadow-lg">
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <h2 className="text-sm font-semibold">縦書きプレビュー</h2>
          <button
            type="button"
            aria-label="閉じる"
            className="text-muted-foreground hover:text-foreground"
            onClick={onClose}
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

import { useTranslation } from "react-i18next";
import { useEditorStore } from "./editorStore";
import { AnimatedOverlay } from "@/components/ui/animated-overlay";

interface VerticalPreviewProps {
  open: boolean;
  onClose: () => void;
}

export function VerticalPreview({ open, onClose }: VerticalPreviewProps) {
  const { t } = useTranslation();
  const editor = useEditorStore((s) => s.editor);

  const html = editor?.getHTML() ?? "";

  return (
    <AnimatedOverlay
      open={open}
      onClose={onClose}
      backdropClassName="bg-background/80 backdrop-blur-sm"
      className="relative flex h-[85vh] w-[90vw] flex-col rounded-lg border border-border bg-background shadow-lg"
      testId="vertical-preview-overlay"
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <h2 className="text-sm font-semibold">{t("verticalPreview.title")}</h2>
        <button
          type="button"
          aria-label={t("common.close")}
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
    </AnimatedOverlay>
  );
}

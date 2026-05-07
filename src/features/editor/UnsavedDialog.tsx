import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

interface UnsavedDialogProps {
  count: number;
  onSaveAndClose: () => void;
  onCloseWithoutSave: () => void;
  onCancel: () => void;
}

export function UnsavedDialog({
  count,
  onSaveAndClose,
  onCloseWithoutSave,
  onCancel,
}: UnsavedDialogProps) {
  const { t } = useTranslation();
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return createPortal(
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === overlayRef.current) onCancel();
      }}
    >
      <div className="min-w-[360px] rounded-lg border border-border bg-popover p-5 shadow-xl">
        <p className="mb-4 text-sm text-foreground">
          {count === 1
            ? t("editor.tab.unsavedOne")
            : t("editor.tab.unsavedMany", { count })}
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={onCloseWithoutSave}
            className="rounded px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent"
          >
            {t("editor.tab.closeWithoutSave")}
          </button>
          <button
            type="button"
            onClick={onSaveAndClose}
            className="rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90"
          >
            {t("editor.tab.saveAndClose")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

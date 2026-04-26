import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { AnimatedOverlay } from "@/components/ui/animated-overlay";

interface CreateForeshadowDialogProps {
  open: boolean;
  projectId: string;
  onSave: (data: { title: string; intent: string | null }) => Promise<void>;
  onClose: () => void;
  initialTitle?: string;
  initialIntent?: string;
}

export function CreateForeshadowDialog({
  open,
  projectId: _projectId,
  onSave,
  onClose,
  initialTitle = "",
  initialIntent = "",
}: CreateForeshadowDialogProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(initialTitle);
  const [intent, setIntent] = useState(initialIntent);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setTitle(initialTitle);
      setIntent(initialIntent);
      setIsSaving(false);
    }
    // initialTitle/initialIntent はダイアログ開時のスナップショットとして使う
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const canSave = title.trim().length > 0 && !isSaving;

  const handleSave = async () => {
    if (!canSave) return;
    setIsSaving(true);
    try {
      await onSave({ title: title.trim(), intent: intent.trim() || null });
      onClose();
    } finally {
      setIsSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSave();
    if (e.key === "Escape") onClose();
  };

  return (
    <AnimatedOverlay
      open={open}
      onClose={onClose}
      className="w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-lg"
      testId="create-foreshadow-dialog"
    >
      <h3 className="mb-4 text-sm font-semibold text-foreground">
        {t("foreshadow.create.heading")}
      </h3>

      <div className="space-y-3" onKeyDown={handleKeyDown}>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            {t("foreshadow.create.titleLabel")}
          </label>
          <input
            data-testid="foreshadow-title-input"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("foreshadow.create.titlePlaceholder")}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            {t("foreshadow.create.intentLabel")}
          </label>
          <textarea
            data-testid="foreshadow-intent-input"
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            placeholder={t("foreshadow.create.intentPlaceholder")}
            rows={3}
            className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          data-testid="foreshadow-cancel-button"
          onClick={onClose}
          className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent"
        >
          {t("common.cancel")}
        </button>
        <button
          type="button"
          data-testid="foreshadow-save-button"
          onClick={handleSave}
          disabled={!canSave}
          className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
        >
          {t("common.save")}
        </button>
      </div>
    </AnimatedOverlay>
  );
}

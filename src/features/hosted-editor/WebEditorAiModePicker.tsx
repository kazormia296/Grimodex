import { useTranslation } from "react-i18next";
import type { BrowserAiMode } from "@/features/chat/types";

interface WebEditorAiModePickerProps {
  mode: BrowserAiMode;
  onSelect: (mode: BrowserAiMode) => void;
}

export function WebEditorAiModePicker({
  mode,
  onSelect,
}: WebEditorAiModePickerProps) {
  const { t } = useTranslation();
  return (
    <div className="mb-3 rounded-md border border-border bg-muted/20 p-3">
      <p className="mb-2 text-xs font-medium text-muted-foreground">
        {t("hostedEditor.ai.modeLabel")}
      </p>
      <div className="flex flex-wrap gap-2">
        {(
          [
            ["http", "hostedEditor.ai.modeHttp"],
            ["webgpu", "hostedEditor.ai.modeWebGpu"],
          ] as const
        ).map(([candidate, labelKey]) => (
          <button
            key={candidate}
            type="button"
            onClick={() => onSelect(candidate)}
            className={`rounded-md border px-3 py-1.5 text-sm ${
              mode === candidate
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border hover:bg-accent"
            }`}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {mode === "webgpu"
          ? t("hostedEditor.ai.modeWebGpuDescription")
          : t("hostedEditor.ai.modeHttpDescription")}
      </p>
    </div>
  );
}

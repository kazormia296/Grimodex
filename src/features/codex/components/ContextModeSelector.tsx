import { useTranslation } from "react-i18next";
import type { CodexContextMode } from "@/db/schema";

interface ContextModeSelectorProps {
  value: CodexContextMode;
  onChange: (value: CodexContextMode) => void;
}

export function ContextModeSelector({
  value,
  onChange,
}: ContextModeSelectorProps) {
  const { t } = useTranslation();
  const options: {
    value: CodexContextMode;
    labelKey: string;
    descKey: string;
  }[] = [
    { value: "always", labelKey: "always", descKey: "alwaysDesc" },
    { value: "mentioned", labelKey: "mentioned", descKey: "mentionedDesc" },
    { value: "suppress", labelKey: "manual", descKey: "manualDesc" },
    { value: "hidden", labelKey: "hidden", descKey: "hiddenDesc" },
  ];

  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-muted-foreground">
        {t("codex.tracking.contextLabel")}
      </label>
      <select
        data-testid="context-mode-selector"
        value={value}
        onChange={(e) => onChange(e.target.value as CodexContextMode)}
        className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {t(`codex.tracking.${opt.labelKey}`)} —{" "}
            {t(`codex.tracking.${opt.descKey}`)}
          </option>
        ))}
      </select>
    </div>
  );
}

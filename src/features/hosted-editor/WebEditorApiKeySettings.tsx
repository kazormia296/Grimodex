import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SettingRow } from "@/features/settings/components/SettingRow";

interface WebEditorApiKeySettingsProps {
  hasApiKey: boolean;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onDelete: () => void;
}

export function WebEditorApiKeySettings({
  hasApiKey,
  value,
  onChange,
  onSave,
  onDelete,
}: WebEditorApiKeySettingsProps) {
  const { t } = useTranslation();

  return (
    <SettingRow label={t("settings.ai.apiKey")}>
      {hasApiKey ? (
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
            {t("settings.ai.keySet")}
            <Check className="h-3.5 w-3.5" aria-hidden />
          </span>
          <button
            type="button"
            onClick={onDelete}
            className="rounded-md border border-destructive px-2 py-1 text-xs text-destructive"
          >
            {t("settings.ai.deleteKey")}
          </button>
        </div>
      ) : (
        <div className="flex gap-2">
          <input
            type="password"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && onSave()}
            className="w-64 rounded-md border border-input bg-background px-2 py-1 text-sm"
            autoComplete="off"
            placeholder="API key"
          />
          <button
            type="button"
            onClick={onSave}
            disabled={!value.trim()}
            className="rounded-md bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-50"
          >
            {t("settings.ai.saveKey")}
          </button>
        </div>
      )}
    </SettingRow>
  );
}

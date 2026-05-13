import { useTranslation } from "react-i18next";
import { groupModelsByDeveloper, type AiModel } from "./types";

interface ModelPickerProps {
  models: AiModel[];
  value: string;
  onChange: (modelId: string) => void;
  isLoading?: boolean;
  disabled?: boolean;
  /** Text shown as the empty-value option (e.g. "Select a model"). */
  placeholder?: string;
  className?: string;
}

/**
 * Shared <select> for picking an AI model. Groups options by developer
 * (anthropic / openai / google …) via groupModelsByDeveloper.
 *
 * Used by Settings > AI and the preflight provider step so the model
 * picker behaves consistently in both places.
 */
export function ModelPicker({
  models,
  value,
  onChange,
  isLoading,
  disabled,
  placeholder,
  className,
}: ModelPickerProps) {
  const { t } = useTranslation();
  const grouped = groupModelsByDeveloper(models);
  const devLabel = (dev: string) =>
    dev ? dev.charAt(0).toUpperCase() + dev.slice(1) : t("common.other");

  // Explicit placeholder always wins (e.g. "Same as chat model" for the
  // inline/title selectors). Otherwise fall back to loading/select labels.
  const emptyLabel =
    placeholder ??
    (isLoading ? t("settings.ai.loadingModels") : t("settings.ai.selectModel"));

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled || isLoading}
      className={
        className ??
        "rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
      }
    >
      <option value="">{emptyLabel}</option>
      {grouped.map(([dev, devModels]) => (
        <optgroup key={dev || "__other"} label={devLabel(dev)}>
          {devModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name || m.id}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

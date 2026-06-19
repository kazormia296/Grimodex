import { useTranslation } from "react-i18next";
import { ModelPicker } from "@/features/chat/ModelPicker";
import { useAiSettingsStore } from "@/features/chat/store";
import type { AbConfig } from "./abHarness";

export type AbMode = "model" | "prompt";

interface AbConfigFormProps {
  mode: AbMode;
  onModeChange: (mode: AbMode) => void;
  /** 既定 (A 側) のモデル名。表示専用。 */
  defaultModel: string;
  configB: AbConfig;
  onConfigBChange: (next: AbConfig) => void;
}

/**
 * A/B の軸 (モデル / プロンプト) と B 構成を入力するフォーム。
 * A 側は常に「現在の既定」(model=設定既定, promptVariant=なし)。
 * - model モード: B のモデルだけを選ぶ
 * - prompt モード: B の追記指示だけを入力 (モデルは A と同じ既定)
 */
export function AbConfigForm({
  mode,
  onModeChange,
  defaultModel,
  configB,
  onConfigBChange,
}: AbConfigFormProps) {
  const { t } = useTranslation();
  const { models, isLoadingModels } = useAiSettingsStore();

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onModeChange("model")}
          className={`rounded-md border px-3 py-1.5 text-sm ${
            mode === "model"
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border hover:bg-accent"
          }`}
        >
          {t("abTest.modeModel")}
        </button>
        <button
          type="button"
          onClick={() => onModeChange("prompt")}
          className={`rounded-md border px-3 py-1.5 text-sm ${
            mode === "prompt"
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border hover:bg-accent"
          }`}
        >
          {t("abTest.modePrompt")}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("abTest.sideA")}
          </div>
          <div className="rounded-md border border-border bg-muted/30 px-2 py-1.5 text-sm text-muted-foreground">
            {defaultModel.trim() || t("abTest.defaultModel")}
          </div>
        </div>

        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("abTest.sideB")}
          </div>
          {mode === "model" ? (
            <ModelPicker
              models={models}
              value={configB.model ?? ""}
              onChange={(model) => onConfigBChange({ ...configB, model })}
              isLoading={isLoadingModels}
              placeholder={t("abTest.defaultModel")}
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus:outline-none"
            />
          ) : (
            <textarea
              value={configB.promptVariant ?? ""}
              onChange={(e) =>
                onConfigBChange({ ...configB, promptVariant: e.target.value })
              }
              rows={3}
              placeholder={t("abTest.promptVariantPlaceholder")}
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus:outline-none"
            />
          )}
        </div>
      </div>
    </div>
  );
}

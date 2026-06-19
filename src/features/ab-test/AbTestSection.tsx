import { useTranslation } from "react-i18next";
import { ModelPicker } from "@/features/chat/ModelPicker";
import { useAiSettingsStore } from "@/features/chat/store";
import { SettingSection } from "@/features/settings/components/SettingSection";
import { SettingRow } from "@/features/settings/components/SettingRow";
import { SettingTextarea } from "@/features/settings/components/SettingTextarea";
import { useSettingsStore } from "@/features/settings/settingsStore";

/**
 * A/B 比較 (③) の設定節。AiCategory には import + 1 行設置だけ置き、
 * 実体はここに閉じる (統合衝突を最小化)。
 * - 既定の B モデル (モデル A/B の相手)
 * - 既定の B プロンプト追記 (プロンプト A/B の相手)
 * いずれも比較ダイアログを開いたときの初期値。空 = 未設定。
 */
export function AbTestSection() {
  const { t } = useTranslation();
  const { models, isLoadingModels } = useAiSettingsStore();
  const settingsStore = useSettingsStore();

  return (
    <SettingSection title={t("abTest.settingsTitle")}>
      <p className="mb-2 text-xs text-muted-foreground">
        {t("abTest.settingsIntro")}
      </p>
      <SettingRow
        label={t("abTest.defaultModelBLabel")}
        description={t("abTest.defaultModelBDesc")}
      >
        <ModelPicker
          models={models}
          value={settingsStore.get("abTest.defaultModelB", "")}
          onChange={(v) => settingsStore.set("abTest.defaultModelB", v)}
          isLoading={isLoadingModels}
          placeholder={t("abTest.defaultModel")}
        />
      </SettingRow>
      <div className="mt-2">
        <div className="mb-1 text-sm">
          {t("abTest.defaultPromptVariantBLabel")}
        </div>
        <div className="mb-1 text-xs text-muted-foreground">
          {t("abTest.defaultPromptVariantBDesc")}
        </div>
        <SettingTextarea
          value={settingsStore.get("abTest.defaultPromptVariantB", "")}
          onChange={(v) => settingsStore.set("abTest.defaultPromptVariantB", v)}
          placeholder={t("abTest.promptVariantPlaceholder")}
          rows={3}
          maxLength={2000}
        />
      </div>
    </SettingSection>
  );
}

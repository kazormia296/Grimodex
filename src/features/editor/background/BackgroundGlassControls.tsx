import { useTranslation } from "react-i18next";
import { SettingRow } from "@/features/settings/components/SettingRow";
import { SettingSlider } from "@/features/settings/components/SettingSlider";
import { SettingToggle } from "@/features/settings/components/SettingToggle";
import { useSettingBoolean } from "@/features/settings/useSettingControl";

const pixels = (value: number) => `${Math.round(value)}px`;
const percent = (value: number) => `${Math.round(value * 100)}%`;

export function BackgroundGlassControls() {
  const { t } = useTranslation();
  const enabled = useSettingBoolean(
    "editor.zenBackground.glass.enabled",
    true,
  ).value;

  return (
    <>
      <SettingRow
        label={t("settings.editor.zenGlassEnabled")}
        description={t("settings.editor.zenGlassEnabledDesc")}
      >
        <SettingToggle
          settingKey="editor.zenBackground.glass.enabled"
          defaultValue
        />
      </SettingRow>
      <SettingRow
        label={t("settings.editor.zenGlassBlur")}
        description={t("settings.editor.zenGlassBlurDesc")}
        disabled={!enabled}
      >
        <SettingSlider
          settingKey="editor.zenBackground.glass.blur"
          min={0}
          max={40}
          defaultValue={14}
          format={pixels}
          disabled={!enabled}
        />
      </SettingRow>
      <SettingRow
        label={t("settings.editor.zenGlassRefraction")}
        description={t("settings.editor.zenGlassRefractionDesc")}
        disabled={!enabled}
      >
        <SettingSlider
          settingKey="editor.zenBackground.glass.refraction"
          min={0}
          max={24}
          defaultValue={7}
          format={pixels}
          disabled={!enabled}
        />
      </SettingRow>
      <SettingRow
        label={t("settings.editor.zenGlassSaturation")}
        disabled={!enabled}
      >
        <SettingSlider
          settingKey="editor.zenBackground.glass.saturation"
          min={0}
          max={2}
          step={0.01}
          defaultValue={1.16}
          format={percent}
          disabled={!enabled}
        />
      </SettingRow>
      <SettingRow
        label={t("settings.editor.zenGlassShine")}
        description={t("settings.editor.zenGlassShineDesc")}
        disabled={!enabled}
      >
        <SettingSlider
          settingKey="editor.zenBackground.glass.shine"
          min={0}
          max={1}
          step={0.05}
          defaultValue={1}
          format={percent}
          disabled={!enabled}
        />
      </SettingRow>
    </>
  );
}

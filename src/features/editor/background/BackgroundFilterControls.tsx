import { useTranslation } from "react-i18next";
import { SettingRow } from "@/features/settings/components/SettingRow";
import { SettingSlider } from "@/features/settings/components/SettingSlider";
import { SettingToggle } from "@/features/settings/components/SettingToggle";
import { useSettingBoolean } from "@/features/settings/useSettingControl";

const percent = (value: number) => `${Math.round(value * 100)}%`;

export function BackgroundFilterControls() {
  const { t } = useTranslation();
  const dither = useSettingBoolean(
    "editor.zenBackground.dither.enabled",
    false,
  ).value;
  const halftone = useSettingBoolean(
    "editor.zenBackground.halftone.enabled",
    false,
  ).value;

  return (
    <>
      <SettingRow
        label={t("settings.editor.zenDither")}
        description={t("settings.editor.zenDitherDesc")}
      >
        <SettingToggle settingKey="editor.zenBackground.dither.enabled" />
      </SettingRow>
      <SettingRow
        label={t("settings.editor.zenDitherStrength")}
        disabled={!dither}
      >
        <SettingSlider
          settingKey="editor.zenBackground.dither.strength"
          min={0}
          max={1}
          step={0.05}
          defaultValue={0.35}
          format={percent}
          disabled={!dither}
        />
      </SettingRow>
      <SettingRow label={t("settings.editor.zenDitherSize")} disabled={!dither}>
        <SettingSlider
          settingKey="editor.zenBackground.dither.size"
          min={1}
          max={8}
          defaultValue={2}
          format={(value) => `${value}px`}
          disabled={!dither}
        />
      </SettingRow>
      <SettingRow
        label={t("settings.editor.zenDitherLevels")}
        disabled={!dither}
      >
        <SettingSlider
          settingKey="editor.zenBackground.dither.levels"
          min={2}
          max={12}
          defaultValue={6}
          disabled={!dither}
        />
      </SettingRow>
      <SettingRow
        label={t("settings.editor.zenHalftone")}
        description={t("settings.editor.zenHalftoneDesc")}
      >
        <SettingToggle settingKey="editor.zenBackground.halftone.enabled" />
      </SettingRow>
      <SettingRow
        label={t("settings.editor.zenHalftoneStrength")}
        disabled={!halftone}
      >
        <SettingSlider
          settingKey="editor.zenBackground.halftone.strength"
          min={0}
          max={1}
          step={0.05}
          defaultValue={0.3}
          format={percent}
          disabled={!halftone}
        />
      </SettingRow>
      <SettingRow
        label={t("settings.editor.zenHalftoneSize")}
        disabled={!halftone}
      >
        <SettingSlider
          settingKey="editor.zenBackground.halftone.size"
          min={3}
          max={24}
          defaultValue={8}
          format={(value) => `${value}px`}
          disabled={!halftone}
        />
      </SettingRow>
      <SettingRow
        label={t("settings.editor.zenHalftoneAngle")}
        disabled={!halftone}
      >
        <SettingSlider
          settingKey="editor.zenBackground.halftone.angle"
          min={0}
          max={90}
          defaultValue={15}
          format={(value) => `${value}°`}
          disabled={!halftone}
        />
      </SettingRow>
      <SettingRow
        label={t("settings.editor.zenHalftoneSoftness")}
        disabled={!halftone}
      >
        <SettingSlider
          settingKey="editor.zenBackground.halftone.softness"
          min={0}
          max={1}
          step={0.05}
          defaultValue={0.15}
          format={percent}
          disabled={!halftone}
        />
      </SettingRow>
    </>
  );
}

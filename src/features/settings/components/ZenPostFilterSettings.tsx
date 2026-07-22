import { useTranslation } from "react-i18next";
import { useSettingBoolean } from "../useSettingControl";
import { SettingRow } from "./SettingRow";
import { SettingSlider } from "./SettingSlider";
import { SettingToggle } from "./SettingToggle";

export function ZenPostFilterSettings() {
  const { t } = useTranslation();
  const dither = useSettingBoolean(
    "editor.zenBackground.dither.enabled",
    false,
  ).value;
  const halftone = useSettingBoolean(
    "editor.zenBackground.halftone.enabled",
    false,
  ).value;
  const percent = (value: number) => `${Math.round(value * 100)}%`;

  return (
    <>
      <SettingRow
        label={t("settings.editor.zenDither")}
        description={t("settings.editor.zenDitherDesc")}
      >
        <SettingToggle settingKey="editor.zenBackground.dither.enabled" />
      </SettingRow>
      <SettingRow label={t("settings.editor.zenDitherStrength")}>
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
      <SettingRow label={t("settings.editor.zenDitherSize")}>
        <SettingSlider
          settingKey="editor.zenBackground.dither.size"
          min={1}
          max={8}
          defaultValue={2}
          format={(value) => `${value}px`}
          disabled={!dither}
        />
      </SettingRow>
      <SettingRow label={t("settings.editor.zenDitherLevels")}>
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
      <SettingRow label={t("settings.editor.zenHalftoneStrength")}>
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
      <SettingRow label={t("settings.editor.zenHalftoneSize")}>
        <SettingSlider
          settingKey="editor.zenBackground.halftone.size"
          min={3}
          max={24}
          defaultValue={8}
          format={(value) => `${value}px`}
          disabled={!halftone}
        />
      </SettingRow>
      <SettingRow label={t("settings.editor.zenHalftoneAngle")}>
        <SettingSlider
          settingKey="editor.zenBackground.halftone.angle"
          min={0}
          max={90}
          defaultValue={15}
          format={(value) => `${value}°`}
          disabled={!halftone}
        />
      </SettingRow>
      <SettingRow label={t("settings.editor.zenHalftoneSoftness")}>
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

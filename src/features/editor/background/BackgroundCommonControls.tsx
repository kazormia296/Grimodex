import { useTranslation } from "react-i18next";
import { SettingColorInput } from "@/features/settings/components/SettingColorInput";
import { SettingDropdown } from "@/features/settings/components/SettingDropdown";
import { SettingRow } from "@/features/settings/components/SettingRow";
import { SettingSlider } from "@/features/settings/components/SettingSlider";
import { SettingToggle } from "@/features/settings/components/SettingToggle";
import {
  PAPER_SHADER_DEFINITIONS,
  getPaperShaderDefinition,
} from "../zen/paperShaderCatalog";
import { useZenShaderConfig } from "../zen/useZenShaderConfig";
import { ZEN_BACKGROUND_DEFAULTS } from "../zen/zenBackgroundDefaults";
import { ZEN_SHADER_RESOLUTION_MODES } from "../zen/zenShaderResolution";

const percent = (value: number) => `${Math.round(value)}%`;
const signedPercent = (value: number) => `${Math.round(value * 100)}%`;

export function BackgroundCommonControls() {
  const { t } = useTranslation();
  const config = useZenShaderConfig();
  const definition = getPaperShaderDefinition(config.shader);
  const shaderOptions = PAPER_SHADER_DEFINITIONS.map(({ id, name }) => ({
    value: id,
    label: name,
  }));
  const paletteOptions = ["theme", "custom"].map((mode) => ({
    value: mode,
    label: t(`settings.editor.zenPalette_${mode}`),
  }));
  const speedModeOptions = ["slow", "fast"].map((mode) => ({
    value: mode,
    label: t(`settings.editor.zenSpeedMode_${mode}`),
  }));
  const resolutionModeOptions = ZEN_SHADER_RESOLUTION_MODES.map((mode) => ({
    value: mode,
    label: t(`settings.editor.zenResolutionMode_${mode}`),
  }));

  return (
    <>
      <SettingRow
        label={t("editor.background.enabled")}
        description={t("editor.background.enabledDescription")}
      >
        <SettingToggle settingKey="editor.zenBackground.enabled" defaultValue />
      </SettingRow>
      <SettingRow
        label={t("settings.editor.zenBackgroundShader")}
        description={t("editor.background.shaderDescription")}
      >
        <SettingDropdown
          settingKey="editor.zenBackground.shader"
          options={shaderOptions}
          defaultValue={ZEN_BACKGROUND_DEFAULTS.shader}
        />
      </SettingRow>
      <SettingRow label={t("settings.editor.zenOpacity")}>
        <SettingSlider
          settingKey="editor.zenBackground.opacity"
          min={0}
          max={100}
          defaultValue={ZEN_BACKGROUND_DEFAULTS.opacity}
          format={percent}
        />
      </SettingRow>
      <SettingRow
        label={t("settings.editor.zenResolutionMode")}
        description={t("settings.editor.zenResolutionModeDesc")}
      >
        <SettingDropdown
          settingKey="editor.zenBackground.resolutionMode"
          options={resolutionModeOptions}
          defaultValue={ZEN_BACKGROUND_DEFAULTS.resolutionMode}
        />
      </SettingRow>
      <SettingRow
        label={t("settings.editor.zenSpeedMode")}
        description={t("settings.editor.zenSpeedModeDesc")}
        disabled={!definition.animated}
      >
        <SettingDropdown
          settingKey="editor.zenBackground.speedMode"
          options={speedModeOptions}
          defaultValue={ZEN_BACKGROUND_DEFAULTS.speedMode}
          disabled={!definition.animated}
        />
      </SettingRow>
      <SettingRow
        label={t("settings.editor.zenSpeed")}
        description={t("settings.editor.zenSpeedDesc")}
        disabled={!definition.animated}
      >
        <SettingSlider
          settingKey="editor.zenBackground.speedPercent"
          min={0}
          max={100}
          defaultValue={ZEN_BACKGROUND_DEFAULTS.speedPercent}
          format={percent}
          disabled={!definition.animated}
        />
      </SettingRow>
      <SettingRow label={t("settings.editor.zenScale")}>
        <SettingSlider
          settingKey="editor.zenBackground.scale"
          min={0.25}
          max={4}
          step={0.05}
          defaultValue={ZEN_BACKGROUND_DEFAULTS.scale}
          format={(value) => `${value.toFixed(2)}×`}
        />
      </SettingRow>
      <SettingRow label={t("settings.editor.zenRotation")}>
        <SettingSlider
          settingKey="editor.zenBackground.rotation"
          min={0}
          max={360}
          step={5}
          defaultValue={ZEN_BACKGROUND_DEFAULTS.rotation}
          format={(value) => `${value}°`}
        />
      </SettingRow>
      <SettingRow label={t("settings.editor.zenOffsetX")}>
        <SettingSlider
          settingKey="editor.zenBackground.offsetX"
          min={-1}
          max={1}
          step={0.05}
          defaultValue={ZEN_BACKGROUND_DEFAULTS.offsetX}
          format={signedPercent}
        />
      </SettingRow>
      <SettingRow label={t("settings.editor.zenOffsetY")}>
        <SettingSlider
          settingKey="editor.zenBackground.offsetY"
          min={-1}
          max={1}
          step={0.05}
          defaultValue={ZEN_BACKGROUND_DEFAULTS.offsetY}
          format={signedPercent}
        />
      </SettingRow>
      <SettingRow label={t("settings.editor.zenPalette")}>
        <SettingDropdown
          settingKey="editor.zenBackground.paletteMode"
          options={paletteOptions}
          defaultValue={ZEN_BACKGROUND_DEFAULTS.paletteMode}
        />
      </SettingRow>
      {config.paletteMode === "custom" && (
        <>
          {config.customColors.map((color, index) => (
            <SettingRow
              key={index}
              label={t("settings.editor.zenColor", { index: index + 1 })}
            >
              <SettingColorInput
                settingKey={`editor.zenBackground.color${index + 1}`}
                defaultValue={color}
              />
            </SettingRow>
          ))}
          <SettingRow label={t("settings.editor.zenColorBack")}>
            <SettingColorInput
              settingKey="editor.zenBackground.colorBack"
              defaultValue={config.customColorBack}
            />
          </SettingRow>
        </>
      )}
    </>
  );
}

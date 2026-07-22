import { useTranslation } from "react-i18next";
import { ZenShaderSurface } from "@/features/editor/zen/ZenShaderSurface";
import { useZenShaderConfig } from "@/features/editor/zen/useZenShaderConfig";
import { SettingColorInput } from "./SettingColorInput";
import { SettingDropdown } from "./SettingDropdown";
import { SettingRow } from "./SettingRow";
import { SettingSlider } from "./SettingSlider";
import { ZenPostFilterSettings } from "./ZenPostFilterSettings";
import { ZenShaderPropertyControls } from "./ZenShaderPropertyControls";

export function ZenBackgroundSettings() {
  const { t } = useTranslation();
  const config = useZenShaderConfig();
  const shaderOptions = [
    "mesh-gradient",
    "grain-gradient",
    "neuro-noise",
    "warp",
    "static-mesh-gradient",
  ].map((value) => ({
    value,
    label: t(`settings.editor.zenShader_${value}`),
  }));
  const paletteOptions = ["theme", "custom"].map((value) => ({
    value,
    label: t(`settings.editor.zenPalette_${value}`),
  }));
  const percent = (value: number) => `${Math.round(value * 100)}%`;

  return (
    <>
      <div
        data-testid="zen-background-preview"
        className="relative mb-3 h-36 overflow-hidden rounded-lg border border-border bg-background"
        aria-label={t("settings.editor.zenBackgroundPreview")}
      >
        <ZenShaderSurface config={config} playing={false} preview />
        <div className="zen-settings-preview-paper absolute inset-y-3 left-1/2 w-[42%] -translate-x-1/2 rounded-sm" />
      </div>
      <SettingRow
        label={t("settings.editor.zenBackgroundShader")}
        description={t("settings.editor.zenBackgroundShaderDesc")}
      >
        <SettingDropdown
          settingKey="editor.zenBackground.shader"
          options={shaderOptions}
          defaultValue="mesh-gradient"
        />
      </SettingRow>
      <SettingRow label={t("settings.editor.zenOpacity")}>
        <SettingSlider
          settingKey="editor.zenBackground.opacity"
          min={0}
          max={40}
          defaultValue={10}
          format={(value) => `${value}%`}
        />
      </SettingRow>
      <SettingRow
        label={t("settings.editor.zenSpeed")}
        description={t("settings.editor.zenSpeedDesc")}
      >
        <SettingSlider
          settingKey="editor.zenBackground.speed"
          min={0}
          max={1}
          step={0.01}
          defaultValue={0.08}
          format={(value) => `${value.toFixed(2)}×`}
          disabled={config.shader === "static-mesh-gradient"}
        />
      </SettingRow>
      <SettingRow label={t("settings.editor.zenScale")}>
        <SettingSlider
          settingKey="editor.zenBackground.scale"
          min={0.25}
          max={4}
          step={0.05}
          defaultValue={1.15}
          format={(value) => `${value.toFixed(2)}×`}
        />
      </SettingRow>
      <SettingRow label={t("settings.editor.zenRotation")}>
        <SettingSlider
          settingKey="editor.zenBackground.rotation"
          min={0}
          max={360}
          step={5}
          defaultValue={0}
          format={(value) => `${value}°`}
        />
      </SettingRow>
      <SettingRow label={t("settings.editor.zenOffsetX")}>
        <SettingSlider
          settingKey="editor.zenBackground.offsetX"
          min={-1}
          max={1}
          step={0.05}
          defaultValue={0}
          format={percent}
        />
      </SettingRow>
      <SettingRow label={t("settings.editor.zenOffsetY")}>
        <SettingSlider
          settingKey="editor.zenBackground.offsetY"
          min={-1}
          max={1}
          step={0.05}
          defaultValue={0}
          format={percent}
        />
      </SettingRow>
      <SettingRow label={t("settings.editor.zenPalette")}>
        <SettingDropdown
          settingKey="editor.zenBackground.paletteMode"
          options={paletteOptions}
          defaultValue="theme"
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
      <ZenShaderPropertyControls shader={config.shader} />
      <ZenPostFilterSettings />
    </>
  );
}

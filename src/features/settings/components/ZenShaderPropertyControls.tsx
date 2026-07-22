import { useTranslation } from "react-i18next";
import type { ZenShaderId } from "@/features/editor/zen/zenShaderConfig";
import { SettingDropdown } from "./SettingDropdown";
import { SettingRow } from "./SettingRow";
import { SettingSlider } from "./SettingSlider";
import { ZEN_SHADER_SLIDERS } from "./zenShaderControlDefinitions";

export function ZenShaderPropertyControls({ shader }: { shader: ZenShaderId }) {
  const { t } = useTranslation();
  const formatPercent = (value: number) => `${Math.round(value * 100)}%`;
  const grainShapes = [
    "wave",
    "dots",
    "truchet",
    "corners",
    "ripple",
    "blob",
    "sphere",
  ].map((value) => ({
    value,
    label: t(`settings.editor.zenGrainShape_${value}`),
  }));
  const warpShapes = ["checks", "stripes", "edge"].map((value) => ({
    value,
    label: t(`settings.editor.zenWarpShape_${value}`),
  }));

  return (
    <>
      {shader === "grain-gradient" && (
        <SettingRow label={t("settings.editor.zenGrainShape")}>
          <SettingDropdown
            settingKey="editor.zenBackground.grain.shape"
            options={grainShapes}
            defaultValue="corners"
          />
        </SettingRow>
      )}
      {shader === "warp" && (
        <SettingRow label={t("settings.editor.zenWarpShape")}>
          <SettingDropdown
            settingKey="editor.zenBackground.warp.shape"
            options={warpShapes}
            defaultValue="edge"
          />
        </SettingRow>
      )}
      {ZEN_SHADER_SLIDERS[shader].map((control) => (
        <SettingRow
          key={control.suffix}
          label={t(`settings.editor.${control.label}`)}
        >
          <SettingSlider
            settingKey={`editor.zenBackground.${control.suffix}`}
            min={control.min}
            max={control.max}
            step={control.step}
            defaultValue={control.defaultValue}
            format={control.percent ? formatPercent : undefined}
          />
        </SettingRow>
      ))}
    </>
  );
}

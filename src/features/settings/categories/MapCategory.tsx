import { useTranslation } from "react-i18next";
import { SettingSection } from "../components/SettingSection";
import { SettingRow } from "../components/SettingRow";
import { SettingDropdown } from "../components/SettingDropdown";
import { useSettingControl, useSettingNumber } from "../useSettingControl";
import { PALETTES, getPalette } from "@/lib/stickyPalettes";

const PALETTE_OPTIONS = Object.values(PALETTES).map((p) => ({
  value: p.id,
  label: p.label,
}));

export function MapCategory() {
  const { t } = useTranslation();
  const EDGE_STYLE_OPTIONS = [
    { value: "solid", label: t("settings.map.edgeStyleSolid") },
    { value: "dashed", label: t("settings.map.edgeStyleDashed") },
    { value: "dotted", label: t("settings.map.edgeStyleDotted") },
  ];
  const { value: paletteId } = useSettingControl(
    "map.defaultStickyPaletteId",
    "post-it-playful",
  );
  const { value: colorSlot, setValue: setColorSlot } = useSettingNumber(
    "map.defaultStickyColorSlot",
    0,
  );

  const palette = getPalette(paletteId);

  return (
    <div className="flex flex-col gap-6">
      <SettingSection title={t("settings.map.stickyDefaults")}>
        <SettingRow
          label={t("settings.map.palette")}
          description={t("settings.map.paletteDesc")}
        >
          <SettingDropdown
            settingKey="map.defaultStickyPaletteId"
            options={PALETTE_OPTIONS}
            defaultValue="post-it-playful"
          />
        </SettingRow>
        <SettingRow
          label={t("settings.map.defaultColor")}
          description={t("settings.map.defaultColorDesc")}
        >
          <div className="flex flex-wrap gap-1.5">
            {palette.colors.map((c, i) => {
              const isSelected = colorSlot === i;
              return (
                <button
                  key={i}
                  type="button"
                  title={c.label}
                  onClick={() => setColorSlot(i)}
                  className="relative h-6 w-6 rounded-full border-2 transition-transform hover:scale-110"
                  style={{
                    backgroundColor: c.hex,
                    borderColor: isSelected
                      ? "var(--foreground)"
                      : "transparent",
                    outline: isSelected
                      ? "2px solid var(--foreground)"
                      : "none",
                    outlineOffset: "1px",
                  }}
                />
              );
            })}
          </div>
        </SettingRow>
      </SettingSection>

      <SettingSection title={t("settings.map.edgeDefaults")}>
        <SettingRow
          label={t("settings.map.defaultEdgeStyle")}
          description={t("settings.map.defaultEdgeStyleDesc")}
        >
          <SettingDropdown
            settingKey="map.defaultEdgeStyle"
            options={EDGE_STYLE_OPTIONS}
            defaultValue="solid"
          />
        </SettingRow>
      </SettingSection>
    </div>
  );
}

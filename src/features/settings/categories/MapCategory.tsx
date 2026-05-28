import { SettingSection } from "../components/SettingSection";
import { SettingRow } from "../components/SettingRow";
import { SettingDropdown } from "../components/SettingDropdown";
import { useSettingControl, useSettingNumber } from "../useSettingControl";
import { PALETTES, getPalette } from "@/lib/stickyPalettes";

const EDGE_STYLE_OPTIONS = [
  { value: "solid", label: "実線 (Solid)" },
  { value: "dashed", label: "破線 (Dashed)" },
  { value: "dotted", label: "点線 (Dotted)" },
];

const PALETTE_OPTIONS = Object.values(PALETTES).map((p) => ({
  value: p.id,
  label: p.label,
}));

export function MapCategory() {
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
      <SettingSection title="Sticky 既定値">
        <SettingRow
          label="パレット"
          description="新規 Sticky 作成時の既定パレット。"
        >
          <SettingDropdown
            settingKey="map.defaultStickyPaletteId"
            options={PALETTE_OPTIONS}
            defaultValue="post-it-playful"
          />
        </SettingRow>
        <SettingRow
          label="既定色"
          description="新規 Sticky 作成時の色 (パレット内 slot)。"
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

      <SettingSection title="Edge 既定値">
        <SettingRow
          label="既定スタイル"
          description="ノード間にエッジを描画するときの既定線種。"
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

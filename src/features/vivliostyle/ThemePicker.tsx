import { useTranslation } from "react-i18next";
import { VIVLIOSTYLE_THEMES, VIVLIOSTYLE_THEME_IDS } from "./themes";
import type { VivliostyleThemeId } from "./themes";

// ────────────────────────────────────────────────────────────────────
// 組版テーマ選択（ラジオグループ）。ExportSettingsPanel のラジオ行と
// 同じ素の <input type="radio"> + label の流儀。
// ────────────────────────────────────────────────────────────────────

interface Props {
  value: VivliostyleThemeId;
  onChange: (theme: VivliostyleThemeId) => void;
  disabled?: boolean;
}

export function ThemePicker({ value, onChange, disabled }: Props) {
  const { t } = useTranslation();

  return (
    <fieldset disabled={disabled}>
      <legend className="mb-1.5 text-xs font-medium text-muted-foreground">
        {t("vivliostyle.theme.label")}
      </legend>
      <div className="flex flex-col gap-1">
        {VIVLIOSTYLE_THEME_IDS.map((id) => (
          <label
            key={id}
            className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-accent/50"
          >
            <input
              type="radio"
              name="vivliostyle-theme"
              value={id}
              checked={value === id}
              onChange={() => onChange(id)}
              className="h-3.5 w-3.5"
            />
            {t(VIVLIOSTYLE_THEMES[id].labelKey)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

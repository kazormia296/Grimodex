import { useTranslation } from "react-i18next";
import type { VivliostyleFormat } from "./types";

// ────────────────────────────────────────────────────────────────────
// 出力形式（PDF / EPUB）のセグメント選択。ExportDialog のモード切替
// タブと同じ意匠。
// ────────────────────────────────────────────────────────────────────

interface Props {
  value: VivliostyleFormat;
  onChange: (format: VivliostyleFormat) => void;
  disabled?: boolean;
}

export function FormatPicker({ value, onChange, disabled }: Props) {
  const { t } = useTranslation();
  return (
    <fieldset disabled={disabled}>
      <legend className="mb-1.5 text-xs font-medium text-muted-foreground">
        {t("vivliostyle.format.label")}
      </legend>
      <div
        role="radiogroup"
        aria-label={t("vivliostyle.format.label")}
        className="inline-flex rounded-md border border-border p-0.5"
      >
        {(["pdf", "epub"] as const).map((f) => (
          <button
            key={f}
            type="button"
            role="radio"
            aria-checked={value === f}
            onClick={() => onChange(f)}
            className={`rounded px-2.5 py-1 text-xs transition-colors ${
              value === f
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent"
            }`}
          >
            {t(`vivliostyle.format.${f}`)}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

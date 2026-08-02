import { useSettingNumber } from "../useSettingControl";
import { useSettingRowA11y } from "./SettingRow";

interface SettingNumberInputProps {
  settingKey: string;
  min?: number;
  max?: number;
  step?: number;
  defaultValue?: number;
  /** Short unit label rendered after the input (e.g. "字" / " chars"). */
  unit?: string;
  /** Placeholder shown when the value is 0 (treated as "unset"). */
  placeholder?: string;
  disabled?: boolean;
}

/**
 * Free-form integer input for a numeric setting (no upper bound enforced unless
 * `max` is given). Mirrors the Toolbar's targetCharCount field: a value of 0 is
 * shown as an empty field so the placeholder can hint the fallback/"off" state.
 */
export function SettingNumberInput({
  settingKey,
  min = 0,
  max,
  step = 1,
  defaultValue = 0,
  unit,
  placeholder,
  disabled = false,
}: SettingNumberInputProps) {
  const { value, setValue } = useSettingNumber(settingKey, defaultValue);
  const rowA11y = useSettingRowA11y();

  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value === 0 ? "" : value}
        placeholder={placeholder}
        disabled={disabled}
        aria-labelledby={rowA11y?.labelId}
        aria-describedby={rowA11y?.descriptionId}
        onChange={(e) => {
          const v = parseInt(e.target.value, 10);
          if (Number.isNaN(v)) {
            setValue(0);
            return;
          }
          const clamped =
            max != null ? Math.min(max, Math.max(min, v)) : Math.max(min, v);
          setValue(clamped);
        }}
        className="w-24 rounded-md border border-input bg-background px-2 py-1 text-right text-sm tabular-nums focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
      />
      {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
    </div>
  );
}

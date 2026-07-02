import { useSettingControl } from "../useSettingControl";
import { useSettingRowA11y } from "./SettingRow";

interface Option {
  value: string;
  label: string;
}

interface SettingDropdownProps {
  settingKey: string;
  options: Option[];
  defaultValue?: string;
  disabled?: boolean;
}

export function SettingDropdown({
  settingKey,
  options,
  defaultValue = "",
  disabled = false,
}: SettingDropdownProps) {
  const { value, setValue } = useSettingControl(settingKey, defaultValue);
  const rowA11y = useSettingRowA11y();

  return (
    <select
      value={value}
      disabled={disabled}
      aria-labelledby={rowA11y?.labelId}
      aria-describedby={rowA11y?.descriptionId}
      onChange={(e) => setValue(e.target.value)}
      className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

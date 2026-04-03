import { useSettingControl } from "../useSettingControl";

interface Option {
  value: string;
  label: string;
}

interface SettingDropdownProps {
  settingKey: string;
  options: Option[];
  defaultValue?: string;
}

export function SettingDropdown({
  settingKey,
  options,
  defaultValue = "",
}: SettingDropdownProps) {
  const { value, setValue } = useSettingControl(settingKey, defaultValue);

  return (
    <select
      value={value}
      onChange={(e) => setValue(e.target.value)}
      className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

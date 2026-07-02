import { useSettingControl } from "../useSettingControl";
import { useSettingRowA11y } from "./SettingRow";

interface SettingTextInputProps {
  settingKey: string;
  defaultValue?: string;
  placeholder?: string;
}

export function SettingTextInput({
  settingKey,
  defaultValue = "",
  placeholder,
}: SettingTextInputProps) {
  const { value, setValue } = useSettingControl(settingKey, defaultValue);
  const rowA11y = useSettingRowA11y();

  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      aria-labelledby={rowA11y?.labelId}
      aria-describedby={rowA11y?.descriptionId}
      onChange={(e) => setValue(e.target.value)}
      className="w-48 rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
    />
  );
}

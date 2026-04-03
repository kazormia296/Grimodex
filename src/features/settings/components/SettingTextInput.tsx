import { useSettingControl } from "../useSettingControl";

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

  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      className="w-48 rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
    />
  );
}

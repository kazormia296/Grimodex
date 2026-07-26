import { useSettingBoolean } from "../useSettingControl";
import { useSettingRowA11y } from "./SettingRow";
import { Switch } from "@/components/ui/switch";

interface SettingToggleProps {
  settingKey: string;
  defaultValue?: boolean;
  disabled?: boolean;
}

export function SettingToggle({
  settingKey,
  defaultValue = false,
  disabled = false,
}: SettingToggleProps) {
  const { value, setValue } = useSettingBoolean(settingKey, defaultValue);
  const rowA11y = useSettingRowA11y();

  return (
    <Switch
      checked={value}
      onCheckedChange={setValue}
      disabled={disabled}
      aria-labelledby={rowA11y?.labelId}
      aria-describedby={rowA11y?.descriptionId}
    />
  );
}

interface ControlledToggleProps {
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}

export function ControlledToggle({
  value,
  onChange,
  disabled = false,
}: ControlledToggleProps) {
  const rowA11y = useSettingRowA11y();

  return (
    <Switch
      checked={value}
      onCheckedChange={onChange}
      disabled={disabled}
      aria-labelledby={rowA11y?.labelId}
      aria-describedby={rowA11y?.descriptionId}
    />
  );
}

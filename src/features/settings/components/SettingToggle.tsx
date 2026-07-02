import { useSettingBoolean } from "../useSettingControl";
import { useSettingRowA11y } from "./SettingRow";

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
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-labelledby={rowA11y?.labelId}
      aria-describedby={rowA11y?.descriptionId}
      disabled={disabled}
      onClick={() => setValue(!value)}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${
        value ? "bg-primary" : "bg-muted"
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          value ? "translate-x-4" : "translate-x-0"
        }`}
      />
    </button>
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
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-labelledby={rowA11y?.labelId}
      aria-describedby={rowA11y?.descriptionId}
      disabled={disabled}
      onClick={() => onChange(!value)}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${
        value ? "bg-primary" : "bg-muted"
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          value ? "translate-x-4" : "translate-x-0"
        }`}
      />
    </button>
  );
}

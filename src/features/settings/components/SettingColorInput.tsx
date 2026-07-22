import { useSettingControl } from "../useSettingControl";
import { useSettingRowA11y } from "./SettingRow";

interface SettingColorInputProps {
  settingKey: string;
  defaultValue: string;
}

export function SettingColorInput({
  settingKey,
  defaultValue,
}: SettingColorInputProps) {
  const { value, setValue } = useSettingControl(settingKey, defaultValue);
  const rowA11y = useSettingRowA11y();

  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        value={/^#[\da-f]{6}$/i.test(value) ? value : defaultValue}
        aria-labelledby={rowA11y?.labelId}
        aria-describedby={rowA11y?.descriptionId}
        onChange={(event) => setValue(event.target.value)}
        className="h-7 w-10 cursor-pointer rounded border border-input bg-background p-0.5"
      />
      <span className="w-16 font-mono text-xs text-muted-foreground">
        {value}
      </span>
    </div>
  );
}

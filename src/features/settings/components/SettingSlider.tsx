import { useSettingNumber } from "../useSettingControl";

interface SettingSliderProps {
  settingKey: string;
  min: number;
  max: number;
  step?: number;
  defaultValue?: number;
  format?: (v: number) => string;
}

export function SettingSlider({
  settingKey,
  min,
  max,
  step = 1,
  defaultValue = min,
  format,
}: SettingSliderProps) {
  const { value, setValue } = useSettingNumber(settingKey, defaultValue);

  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => setValue(parseFloat(e.target.value))}
        className="h-1.5 w-28 cursor-pointer appearance-none rounded-full bg-muted accent-primary"
      />
      <span className="w-12 text-right text-xs text-muted-foreground">
        {format ? format(value) : String(value)}
      </span>
    </div>
  );
}

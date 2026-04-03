import { useSettingsStore } from "./settingsStore";

export function useSettingControl(
  key: string,
  defaultValue: string = "",
): { value: string; setValue: (v: string) => void } {
  const value = useSettingsStore((s) => s.get(key, defaultValue));
  const set = useSettingsStore((s) => s.set);
  return { value, setValue: (v) => set(key, v) };
}

export function useSettingNumber(
  key: string,
  defaultValue: number = 0,
): { value: number; setValue: (v: number) => void } {
  const value = useSettingsStore((s) => s.getNumber(key, defaultValue));
  const set = useSettingsStore((s) => s.set);
  return { value, setValue: (v) => set(key, String(v)) };
}

export function useSettingBoolean(
  key: string,
  defaultValue: boolean = false,
): { value: boolean; setValue: (v: boolean) => void } {
  const value = useSettingsStore((s) => s.getBoolean(key, defaultValue));
  const set = useSettingsStore((s) => s.set);
  return { value, setValue: (v) => set(key, String(v)) };
}

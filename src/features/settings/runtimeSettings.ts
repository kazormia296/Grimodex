import { useSettingsStore } from "./settingsStore";

/**
 * Narrow imperative boundary for non-React feature services. Consumers depend
 * on setting operations rather than the concrete Zustand store.
 */
export function readRuntimeSetting(key: string, defaultValue?: string): string {
  return useSettingsStore.getState().get(key, defaultValue);
}

export function readRuntimeSettingBoolean(
  key: string,
  defaultValue?: boolean,
): boolean {
  return useSettingsStore.getState().getBoolean(key, defaultValue);
}

export function readRuntimeSettingNumber(
  key: string,
  defaultValue?: number,
): number {
  return useSettingsStore.getState().getNumber(key, defaultValue);
}

export function writeRuntimeSetting(key: string, value: string): void {
  useSettingsStore.getState().set(key, value);
}

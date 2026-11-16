import { useSettingsStore } from "./settingsStore";
import { KEY_SCOPE } from "./types";

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

/**
 * そのキーの保存先の層（KEY_SCOPE が決める global／project／legacy）に明示値として有るか。
 * 既定値だけ、または別の層（legacy など）にだけ値が有る場合は false。
 */
export function hasExplicitRuntimeSetting(key: string): boolean {
  const { layers } = useSettingsStore.getState();
  const scope = KEY_SCOPE[key];
  const layer =
    scope === "global"
      ? layers.global
      : scope === "project"
        ? layers.project
        : layers.legacy;
  return Object.hasOwn(layer, key);
}

/** 明示値を消して既定値（言語別の上書きを含む）に戻す。保存先からもキーを消す。 */
export function clearRuntimeSetting(key: string): void {
  useSettingsStore.getState().unset(key);
}

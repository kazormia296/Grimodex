import { useSettingsStore } from "@/features/settings/settingsStore";

/**
 * Mochi layout (D案) toggle — independent of the glass effect.
 *
 * ON  : gapped "mochi" cards (dome gradient + rim shadow, rounded, no lines).
 * OFF : the legacy splitter-line layout (abutting panes, 1px dividers).
 */
export const MOCHI_LAYOUT_SETTING = "display.mochiLayout";
export const MOCHI_LAYOUT_DEFAULT = true;

/** Read the mochi-layout toggle outside React (store / pure-util callers). */
export function isMochiLayout(): boolean {
  return useSettingsStore
    .getState()
    .getBoolean(MOCHI_LAYOUT_SETTING, MOCHI_LAYOUT_DEFAULT);
}

/** React hook form — re-renders the consumer when the toggle changes. */
export function useMochiLayout(): boolean {
  return useSettingsStore((s) =>
    s.getBoolean(MOCHI_LAYOUT_SETTING, MOCHI_LAYOUT_DEFAULT),
  );
}

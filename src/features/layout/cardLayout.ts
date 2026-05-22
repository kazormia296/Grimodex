import { useSettingsStore } from "@/features/settings/settingsStore";

/**
 * Card layout (D案) toggle — independent of the glass effect.
 *
 * ON  : gapped cards (dome gradient + rim shadow, rounded, no lines).
 * OFF : the legacy splitter-line layout (abutting panes, 1px dividers).
 */
export const CARD_LAYOUT_SETTING = "display.cardLayout";
export const CARD_LAYOUT_DEFAULT = true;

/** Read the card-layout toggle outside React (store / pure-util callers). */
export function isCardLayout(): boolean {
  return useSettingsStore
    .getState()
    .getBoolean(CARD_LAYOUT_SETTING, CARD_LAYOUT_DEFAULT);
}

/** React hook form — re-renders the consumer when the toggle changes. */
export function useCardLayout(): boolean {
  return useSettingsStore((s) =>
    s.getBoolean(CARD_LAYOUT_SETTING, CARD_LAYOUT_DEFAULT),
  );
}

import { useMemo } from "react";
import { useSettingsStore } from "@/features/settings/settingsStore";
import {
  parseZenBackgroundEnabled,
  parseZenGlassConfig,
} from "./zenBackgroundAppearanceConfig";

export function useZenBackgroundEnabled() {
  return useSettingsStore((state) => parseZenBackgroundEnabled(state.cache));
}

export function useZenGlassConfig() {
  const enabled = useSettingsStore(
    (state) => state.cache["editor.zenBackground.glass.enabled"],
  );
  const blur = useSettingsStore(
    (state) => state.cache["editor.zenBackground.glass.blur"],
  );
  const refraction = useSettingsStore(
    (state) => state.cache["editor.zenBackground.glass.refraction"],
  );
  const saturation = useSettingsStore(
    (state) => state.cache["editor.zenBackground.glass.saturation"],
  );
  const shine = useSettingsStore(
    (state) => state.cache["editor.zenBackground.glass.shine"],
  );

  return useMemo(
    () =>
      parseZenGlassConfig({
        "editor.zenBackground.glass.enabled": enabled,
        "editor.zenBackground.glass.blur": blur,
        "editor.zenBackground.glass.refraction": refraction,
        "editor.zenBackground.glass.saturation": saturation,
        "editor.zenBackground.glass.shine": shine,
      }),
    [blur, enabled, refraction, saturation, shine],
  );
}

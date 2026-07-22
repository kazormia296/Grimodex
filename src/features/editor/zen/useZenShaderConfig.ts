import { useMemo } from "react";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { parseZenShaderConfig } from "./zenShaderConfig";

export function useZenShaderConfig() {
  const cache = useSettingsStore((state) => state.cache);
  return useMemo(() => parseZenShaderConfig(cache), [cache]);
}

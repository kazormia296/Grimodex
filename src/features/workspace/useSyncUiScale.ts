import { useEffect } from "react";
import { syncUiScaleFromGlobalSettings } from "@/lib/uiScale";
import { useWorkspaceStore } from "./store";

/** Keeps WebView/CSS zoom and `--ui-scale` in sync with `globalSettings.uiScale`. */
export function useSyncUiScale(): void {
  const globalSettings = useWorkspaceStore((s) => s.globalSettings);

  useEffect(() => {
    const abort = { cancelled: false };
    void syncUiScaleFromGlobalSettings(globalSettings, abort);
    return () => {
      abort.cancelled = true;
    };
  }, [globalSettings]);
}

import { useEffect } from "react";
import { shouldSkipTauriProductionGate } from "@/features/updater/useUpdateChecker";
import { evaluateReleaseNotesGate } from "./fetchReleaseNotes";
import { useWorkspaceStore } from "@/features/workspace/store";

export function useReleaseNotesGate(): void {
  const globalSettings = useWorkspaceStore((s) => s.globalSettings);
  const updateGlobalSettings = useWorkspaceStore((s) => s.updateGlobalSettings);
  const uiLanguage = useWorkspaceStore(
    (s) => s.globalSettings?.uiLanguage ?? "ja",
  );
  useEffect(() => {
    if (shouldSkipTauriProductionGate()) return;
    let cancelled = false;
    void evaluateReleaseNotesGate({
      globalSettings,
      updateGlobalSettings,
      uiLanguage,
      isCancelled: () => cancelled,
    });
    return () => {
      cancelled = true;
    };
  }, [globalSettings, updateGlobalSettings, uiLanguage]);
}

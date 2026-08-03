import { useEffect } from "react";

import type { RuntimeCapabilities } from "@/runtime/runtimeCapabilities";
import { useAiStreamingAnnouncer } from "@/features/chat/useAiStreamingAnnouncer";
import { useCodexSelectionSync } from "@/features/codex/multiwindow/codexSelectionRouting";
import { startCodexLockListener } from "@/features/codex/multiwindow/codexEditLockStore";
import { initializeExternalMounts } from "@/features/external-mount/mountManager";
import { useLicenseStore } from "@/features/license/store";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { getProject } from "@/features/project/api";
import { useImeExportSync } from "@/features/ime/useImeExportSync";
import { useSettingsStore } from "@/features/settings/settingsStore";
import {
  applyScreenshotUiState,
  bootstrapScreenshotWorkspace,
  clearScreenshotStageReady,
  isScreenshotCapture,
  markScreenshotStageReady,
} from "@/screenshot-scenes/screenshotBootstrap";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { usePhaseStore } from "@/features/codex/phaseStore";

interface EditorRuntimeHostProps {
  runtimeCapabilities: RuntimeCapabilities;
  seedAndOpenSample: (language: string, policy: string) => Promise<void>;
  onCloseSettings: () => void;
}

export function EditorRuntimeHost({
  runtimeCapabilities,
  seedAndOpenSample,
  onCloseSettings,
}: EditorRuntimeHostProps) {
  useImeExportSync();
  useAiStreamingAnnouncer();
  useCodexSelectionSync();

  useEffect(() => {
    startCodexLockListener();
  }, []);

  useEffect(() => {
    if (!runtimeCapabilities.externalMount) return;
    void initializeExternalMounts().catch(() => {});
  }, [runtimeCapabilities.externalMount]);

  useEffect(() => {
    if (!runtimeCapabilities.secureSecretStore) return;
    void useLicenseStore.getState().refresh();
  }, [runtimeCapabilities.secureSecretStore]);

  useEffect(() => {
    function onRestartTutorial() {
      onCloseSettings();
      const lang =
        useWorkspaceStore.getState().globalSettings?.uiLanguage ?? "ja";
      const policy =
        useWorkspaceStore.getState().globalSettings?.defaultAiPolicy ??
        JSON.stringify({
          preset: "off",
          toggles: { chat: false, bodyWrite: false, analysis: false },
        });
      void seedAndOpenSample(lang, policy);
    }

    window.addEventListener("restart-sample-tour", onRestartTutorial);
    return () =>
      window.removeEventListener("restart-sample-tour", onRestartTutorial);
  }, [onCloseSettings, seedAndOpenSample]);

  useEffect(() => {
    void (async () => {
      clearScreenshotStageReady();
      if (!isScreenshotCapture()) return;

      const project = await getProject(getCurrentProjectId());
      if (project?.language) {
        document.documentElement.lang = project.language;
        useSettingsStore.getState().applyProjectLanguage(project.language);
      }
      if (project?.phaseResolutionMode) {
        usePhaseStore.getState().setResolutionMode(project.phaseResolutionMode);
      }
      await bootstrapScreenshotWorkspace();
      applyScreenshotUiState();
      markScreenshotStageReady();
    })();
  }, []);

  useEffect(() => {
    useGlobalHistoryStore.getState().clear();
  }, []);

  return null;
}

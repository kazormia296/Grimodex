import { useEffect, useState } from "react";

import { useQuiescenceLeaseActive } from "@/application/lifecycle/useQuiescenceLeaseActive";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { EditorRuntimeHost } from "@/features/editor/EditorRuntimeHost";
import { EditorWorkspaceShell } from "@/features/editor/EditorWorkspaceShell";
import { GlobalCommandHost } from "@/features/editor/GlobalCommandHost";
import { WorkspaceProjectionController } from "@/features/editor/WorkspaceProjectionController";
import { useWorkspaceStore } from "@/features/workspace/store";
import type { SettingsCategory } from "@/features/settings/types";
import type { TransferTab } from "@/features/transfer/TransferDialog";
import type { ExportDialogMode } from "@/features/export/ExportDialog";
import { getPanelWindowTarget } from "@/features/layout/multiwindow/panelWindow";
import { shouldMountZenAmbientBackdrop } from "@/features/editor/zen/zenAmbientBackdropPolicy";
import { isMac } from "@/lib/platform";
import { getScreenshotPanelId } from "@/screenshot-scenes/screenshotBootstrap";
import { useRuntimeCapabilities } from "@/runtime/runtimeCapabilitiesContext";
import { useViewportProfile } from "@/runtime/useViewportProfile";
import { shouldUseAdaptiveWorkspace } from "@/features/layout/adaptive/adaptiveWorkspacePolicy";

export function EditorWorkspaceController() {
  const lifecycleLocked = useQuiescenceLeaseActive();
  const runtimeCapabilities = useRuntimeCapabilities();
  const screenshotPanelId = getScreenshotPanelId();
  const panelWindowTarget = getPanelWindowTarget();
  const panelWindow = panelWindowTarget !== null;
  const soloPanelId = screenshotPanelId ?? panelWindowTarget;
  const mountZenAmbientBackdrop = shouldMountZenAmbientBackdrop({
    panelWindowTarget,
    screenshotPanelId,
  });
  const zenMode = useCursorSettingsStore((state) => state.zenMode);
  const editorZenMode = zenMode && !panelWindow && !screenshotPanelId;
  const adaptiveWorkspaceEnabled = shouldUseAdaptiveWorkspace({
    featureEnabled: import.meta.env.VITE_ADAPTIVE_WORKSPACE !== "false",
    panelWindow,
    screenshotPanelId,
  });
  const viewport = useViewportProfile({ observeNode: false });
  const workspaceProfile = adaptiveWorkspaceEnabled ? viewport.profile : "wide";
  const phoneWorkspace =
    adaptiveWorkspaceEnabled && workspaceProfile === "phone";
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialCategory, setSettingsInitialCategory] =
    useState<SettingsCategory>("project");
  const [showExport, setShowExport] = useState(false);
  const [exportModeRequest, setExportModeRequest] = useState<
    { mode: ExportDialogMode; seq: number } | undefined
  >(undefined);
  const [showSnapshotModal, setShowSnapshotModal] = useState(false);
  const [showTransferDialog, setShowTransferDialog] = useState(false);
  const [showHostedHandoff, setShowHostedHandoff] = useState(false);
  const [transferTab, setTransferTab] = useState<TransferTab>("import");
  const seedAndOpenSample = useWorkspaceStore(
    (state) => state.seedAndOpenSample,
  );
  const showSampleTour = useWorkspaceStore((state) => state.showSampleTour);
  const mac = isMac();

  useEffect(() => {
    function onOpenSettings(event: Event) {
      const detail = (event as CustomEvent<{ category?: SettingsCategory }>)
        .detail;
      setSettingsInitialCategory(detail?.category ?? "project");
      setShowSettings(true);
    }

    window.addEventListener("open-settings", onOpenSettings);
    return () => window.removeEventListener("open-settings", onOpenSettings);
  }, []);

  useEffect(() => {
    function onOpenExport() {
      if (!runtimeCapabilities.genericProjectTransfer) return;
      setShowExport(true);
    }

    window.addEventListener("open-export-dialog", onOpenExport);
    return () => window.removeEventListener("open-export-dialog", onOpenExport);
  }, [runtimeCapabilities.genericProjectTransfer]);

  useEffect(() => {
    function onOpenVivliostyle() {
      if (!runtimeCapabilities.genericProjectTransfer) return;
      setExportModeRequest((previous) => ({
        mode: "book",
        seq: (previous?.seq ?? 0) + 1,
      }));
      setShowExport(true);
    }

    window.addEventListener("open-vivliostyle-dialog", onOpenVivliostyle);
    return () =>
      window.removeEventListener("open-vivliostyle-dialog", onOpenVivliostyle);
  }, [runtimeCapabilities.genericProjectTransfer]);

  return (
    <>
      <EditorRuntimeHost
        runtimeCapabilities={runtimeCapabilities}
        seedAndOpenSample={seedAndOpenSample}
        onCloseSettings={() => setShowSettings(false)}
      />
      <WorkspaceProjectionController phoneWorkspace={phoneWorkspace} />
      <GlobalCommandHost
        phoneWorkspace={phoneWorkspace}
        runtimeCapabilities={runtimeCapabilities}
        onToggleExport={() => setShowExport((value) => !value)}
        onOpenSettings={() => {
          setSettingsInitialCategory("project");
          setShowSettings(true);
        }}
      />
      <EditorWorkspaceShell
        lifecycleLocked={lifecycleLocked}
        runtimeCapabilities={runtimeCapabilities}
        adaptiveWorkspaceEnabled={adaptiveWorkspaceEnabled}
        screenshotPanelId={screenshotPanelId}
        panelWindow={panelWindow}
        soloPanelId={soloPanelId}
        mountZenAmbientBackdrop={mountZenAmbientBackdrop}
        editorZenMode={editorZenMode}
        workspaceProfile={workspaceProfile}
        phoneWorkspace={phoneWorkspace}
        mac={mac}
        showSettings={showSettings}
        settingsInitialCategory={settingsInitialCategory}
        showExport={showExport}
        exportModeRequest={exportModeRequest}
        showSnapshotModal={showSnapshotModal}
        showTransferDialog={showTransferDialog}
        transferTab={transferTab}
        showHostedHandoff={showHostedHandoff}
        showSampleTour={showSampleTour}
        onOpenSettings={(category) => {
          setSettingsInitialCategory(category);
          setShowSettings(true);
        }}
        onCloseSettings={() => setShowSettings(false)}
        onToggleExport={() => setShowExport((value) => !value)}
        onCloseExport={() => setShowExport(false)}
        onOpenSnapshot={() => setShowSnapshotModal(true)}
        onCloseSnapshot={() => setShowSnapshotModal(false)}
        onOpenTransfer={(tab) => {
          setTransferTab(tab);
          setShowTransferDialog(true);
        }}
        onChangeTransferTab={setTransferTab}
        onCloseTransfer={() => setShowTransferDialog(false)}
        onSetHostedHandoff={setShowHostedHandoff}
      />
    </>
  );
}

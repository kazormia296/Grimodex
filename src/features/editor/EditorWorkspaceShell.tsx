import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";

import type { RuntimeCapabilities } from "@/runtime/runtimeCapabilities";
import type { WorkspaceViewportProfile } from "@/runtime/viewportProfile";
import type { PanelId } from "@/features/layout/panelIds";
import type { SettingsCategory } from "@/features/settings/types";
import type { TransferTab } from "@/features/transfer/TransferDialog";
import type { ExportDialogMode } from "@/features/export/ExportDialog";
import { WorkspaceMenu } from "@/features/workspace/WorkspaceMenu";
import { ProjectMenu } from "@/features/project/ProjectMenu";
import { LayoutShell } from "@/features/layout/LayoutShell";
import { ZenModeController } from "@/features/editor/ZenModeController";
import { BackgroundStudioHost } from "@/features/editor/background/BackgroundStudioHost";
import { AdaptiveWorkspaceShell } from "@/features/layout/adaptive/AdaptiveWorkspaceShell";
import { ConnectedMobileWorkspaceSurface } from "@/features/layout/adaptive/MobileWorkspaceSurfaces";
import { requestWebEditorHandoffImport } from "@/features/import/webEditorHandoffRequest";
import { EditorWorkspaceDialogs } from "@/features/editor/EditorWorkspaceDialogs";
import { EditorWorkspaceHeader } from "@/features/editor/EditorWorkspaceHeader";
import { EditorWorkspaceProviders } from "@/features/editor/EditorWorkspaceProviders";
import { isWorkLayerAvailable } from "@/features/editor/workLayerAvailability";
import { WorkLayerSurfaceHost } from "@/features/work-layer/WorkLayerSurfaceHost";

const ZenAmbientBackdrop = lazy(() =>
  import("@/features/editor/ZenAmbientBackdrop").then((module) => ({
    default: module.ZenAmbientBackdrop,
  })),
);

interface EditorWorkspaceShellProps {
  lifecycleLocked: boolean;
  runtimeCapabilities: RuntimeCapabilities;
  adaptiveWorkspaceEnabled: boolean;
  screenshotPanelId: PanelId | null;
  panelWindow: boolean;
  soloPanelId: PanelId | null;
  mountZenAmbientBackdrop: boolean;
  editorZenMode: boolean;
  workspaceProfile: WorkspaceViewportProfile;
  phoneWorkspace: boolean;
  mac: boolean;
  showSettings: boolean;
  settingsInitialCategory: SettingsCategory;
  showExport: boolean;
  exportModeRequest: { mode: ExportDialogMode; seq: number } | undefined;
  showSnapshotModal: boolean;
  showTransferDialog: boolean;
  transferTab: TransferTab;
  showHostedHandoff: boolean;
  showSampleTour: boolean;
  onOpenSettings: (category: SettingsCategory) => void;
  onCloseSettings: () => void;
  onToggleExport: () => void;
  onCloseExport: () => void;
  onOpenSnapshot: () => void;
  onCloseSnapshot: () => void;
  onOpenTransfer: (tab: TransferTab) => void;
  onChangeTransferTab: (tab: TransferTab) => void;
  onCloseTransfer: () => void;
  onSetHostedHandoff: (open: boolean) => void;
}

export function EditorWorkspaceShell({
  lifecycleLocked,
  runtimeCapabilities,
  adaptiveWorkspaceEnabled,
  screenshotPanelId,
  panelWindow,
  soloPanelId,
  mountZenAmbientBackdrop,
  editorZenMode,
  workspaceProfile,
  phoneWorkspace,
  mac,
  showSettings,
  settingsInitialCategory,
  showExport,
  exportModeRequest,
  showSnapshotModal,
  showTransferDialog,
  transferTab,
  showHostedHandoff,
  showSampleTour,
  onOpenSettings,
  onCloseSettings,
  onToggleExport,
  onCloseExport,
  onOpenSnapshot,
  onCloseSnapshot,
  onOpenTransfer,
  onChangeTransferTab,
  onCloseTransfer,
  onSetHostedHandoff,
}: EditorWorkspaceShellProps) {
  const { t } = useTranslation();
  const workLayerActive = isWorkLayerAvailable({
    lifecycleLocked,
    editorZenMode,
    phoneWorkspace,
    panelWindow,
    screenshotPanelId,
  });

  return (
    <EditorWorkspaceProviders
      activeWorkLayer={workLayerActive}
      profile={workspaceProfile}
    >
      <div
        className="app-shell flex h-screen flex-col"
        inert={lifecycleLocked ? true : undefined}
        aria-busy={lifecycleLocked || undefined}
        data-platform-mac={mac ? "true" : undefined}
        data-viewport-profile={workspaceProfile}
        data-mobile-workspace={phoneWorkspace ? "true" : undefined}
        data-zen-mode={editorZenMode ? "true" : undefined}
      >
        {!editorZenMode && (
          <a
            href="#main-content"
            className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 focus:rounded focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {t("a11y.skipToContent")}
          </a>
        )}
        <EditorWorkspaceHeader
          runtimeCapabilities={runtimeCapabilities}
          screenshotPanelId={screenshotPanelId}
          panelWindow={panelWindow}
          phoneWorkspace={phoneWorkspace}
          editorZenMode={editorZenMode}
          mac={mac}
          onOpenTransfer={onOpenTransfer}
          onOpenSnapshot={onOpenSnapshot}
          onToggleExport={onToggleExport}
          onOpenSettings={() => onOpenSettings("project")}
        />
        <EditorWorkspaceDialogs
          runtimeCapabilities={runtimeCapabilities}
          phoneWorkspace={phoneWorkspace}
          showSettings={showSettings}
          settingsInitialCategory={settingsInitialCategory}
          showExport={showExport}
          exportModeRequest={exportModeRequest}
          showSnapshotModal={showSnapshotModal}
          showTransferDialog={showTransferDialog}
          transferTab={transferTab}
          showHostedHandoff={showHostedHandoff}
          showSampleTour={showSampleTour}
          onCloseSettings={onCloseSettings}
          onCloseExport={onCloseExport}
          onCloseSnapshot={onCloseSnapshot}
          onChangeTransferTab={onChangeTransferTab}
          onCloseTransfer={onCloseTransfer}
          onSetHostedHandoff={onSetHostedHandoff}
        />
        <main
          id="main-content"
          tabIndex={-1}
          className="relative isolate flex min-h-0 flex-1 overflow-hidden outline-none"
        >
          {mountZenAmbientBackdrop && (
            <Suspense fallback={null}>
              <ZenAmbientBackdrop active={editorZenMode} />
            </Suspense>
          )}
          {adaptiveWorkspaceEnabled ? (
            <AdaptiveWorkspaceShell
              profile={workspaceProfile}
              zenMode={editorZenMode}
              editor={
                <LayoutShell
                  hidden={false}
                  soloPanelId={null}
                  zenMode={editorZenMode}
                  editorOnly={phoneWorkspace}
                />
              }
              renderMobileSurface={(surface) => (
                <ConnectedMobileWorkspaceSurface
                  surface={surface}
                  onOpenSettings={() => onOpenSettings("project")}
                  onOpenAiSettings={() => onOpenSettings("ai")}
                  onOpenImport={
                    runtimeCapabilities.localFileImport
                      ? () => onOpenTransfer("import")
                      : undefined
                  }
                  onOpenExport={
                    runtimeCapabilities.genericProjectTransfer
                      ? onToggleExport
                      : undefined
                  }
                  onContinueInGrimodex={
                    !runtimeCapabilities.genericProjectTransfer &&
                    runtimeCapabilities.browserDirectAi
                      ? () => onSetHostedHandoff(true)
                      : undefined
                  }
                  workspaceControls={
                    <div data-phone-workspace-controls className="grid gap-2">
                      <WorkspaceMenu />
                      <ProjectMenu
                        onOpenImport={
                          runtimeCapabilities.localFileImport
                            ? () => onOpenTransfer("import")
                            : undefined
                        }
                        onOpenExport={
                          runtimeCapabilities.genericProjectTransfer
                            ? () => onOpenTransfer("zip")
                            : undefined
                        }
                        onOpenSnapshot={onOpenSnapshot}
                        onOpenWebEditorHandoff={
                          runtimeCapabilities.genericProjectTransfer
                            ? requestWebEditorHandoffImport
                            : undefined
                        }
                      />
                    </div>
                  }
                />
              )}
            />
          ) : (
            <LayoutShell
              hidden={Boolean(screenshotPanelId) || panelWindow}
              soloPanelId={soloPanelId}
              zenMode={editorZenMode}
            />
          )}
          <WorkLayerSurfaceHost />
        </main>
        <ZenModeController />
        <BackgroundStudioHost zenMode={editorZenMode} />
      </div>
    </EditorWorkspaceProviders>
  );
}

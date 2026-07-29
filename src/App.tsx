import { lazy, Suspense, useEffect, useCallback, useState } from "react";
import { Toaster } from "sonner";

import { WelcomeScreen } from "@/features/workspace/WelcomeScreen";
import { LauncherScreen } from "@/features/workspace/LauncherScreen";
import { WorkspaceMenu } from "@/features/workspace/WorkspaceMenu";
import { ProjectMenu } from "@/features/project/ProjectMenu";
import { WorkspaceTrustDialog } from "@/features/workspace/WorkspaceTrustDialog";
import { EulaConsentDialog } from "@/features/legal/EulaConsentDialog";
import { ReleaseNotesDialog } from "@/features/release-notes/ReleaseNotesDialog";
import { useWorkspaceStore } from "@/features/workspace/store";
import type { SettingsCategory } from "@/features/settings/types";
import type { TransferTab } from "@/features/transfer/TransferDialog";
import { PanelToggleDropdown } from "@/features/layout/PanelToggleDropdown";
import { LayoutPresetDropdown } from "@/features/layout/LayoutPresetDropdown";
import { LayoutShell } from "@/features/layout/LayoutShell";
import { ReindexProgressToast } from "@/features/semantic-search/ReindexProgressToast";
import { PostEffectProgressToast } from "@/features/post-effect/PostEffectProgressToast";
import { ModelDownloadToast } from "@/features/semantic-search/ModelDownloadToast";
import { UpdateToast } from "@/features/updater/UpdateToast";
import { UpdateDot } from "@/features/updater/UpdateDot";
import { useUpdatePending } from "@/features/updater/updaterStore";
import { ReloadConflictDialog } from "@/features/external-mount/components/ReloadConflictDialog";
import { DebugLogViewer } from "@/lib/DebugLogViewer";
import { Settings, FileOutput } from "lucide-react";
import type { ExportDialogMode } from "@/features/export/ExportDialog";
import { GrimodexLogo } from "@/components/GrimodexLogo";
import { HeaderBarLayout } from "@/components/HeaderBarLayout";
import { LiveRegion } from "@/components/a11y/LiveRegion";
import { useTranslation } from "react-i18next";
import { WindowControls } from "@/components/WindowControls";
import { TitleBar } from "@/components/TitleBar";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { ZenModeController } from "@/features/editor/ZenModeController";
import { BackgroundStudioHost } from "@/features/editor/background/BackgroundStudioHost";
import { HistoryButtons } from "@/features/history/HistoryButtons";
import { isMac } from "@/lib/platform";
import { CloseSaveFailureDialog } from "@/components/CloseSaveFailureDialog";
import { useQuiescenceLeaseActive } from "@/application/lifecycle/useQuiescenceLeaseActive";
import { LifecycleStatus } from "@/application/lifecycle/LifecycleStatus";
import { getScreenshotPanelId } from "@/screenshot-scenes/screenshotBootstrap";
import { getPanelWindowTarget } from "@/features/layout/multiwindow/panelWindow";
import { shouldMountZenAmbientBackdrop } from "@/features/editor/zen/zenAmbientBackdropPolicy";
import { cn } from "@/lib/utils";
import { AdaptiveWorkspaceShell } from "@/features/layout/adaptive/AdaptiveWorkspaceShell";
import { ConnectedMobileWorkspaceSurface } from "@/features/layout/adaptive/MobileWorkspaceSurfaces";
import { shouldUseAdaptiveWorkspace } from "@/features/layout/adaptive/adaptiveWorkspacePolicy";
import { useRuntimeCapabilities } from "@/runtime/runtimeCapabilitiesContext";
import { useViewportProfile } from "@/runtime/useViewportProfile";
import { WorkspaceViewportProvider } from "@/runtime/workspaceViewportContext";
import { ApplicationBootstrapHost } from "@/application/bootstrap/ApplicationBootstrapHost";
import { requestWebEditorHandoffImport } from "@/features/import/webEditorHandoffRequest";
import { EditorRuntimeHost } from "@/features/editor/EditorRuntimeHost";
import { GlobalCommandHost } from "@/features/editor/GlobalCommandHost";
import { WorkspaceProjectionController } from "@/features/editor/WorkspaceProjectionController";

const SettingsDialog = lazy(() =>
  import("@/features/settings/SettingsDialog").then((m) => ({
    default: m.SettingsDialog,
  })),
);
const ZenAmbientBackdrop = lazy(() =>
  import("@/features/editor/ZenAmbientBackdrop").then((module) => ({
    default: module.ZenAmbientBackdrop,
  })),
);
const ProjectSnapshotModal = lazy(() =>
  import("@/features/revision/ProjectSnapshotModal").then((m) => ({
    default: m.ProjectSnapshotModal,
  })),
);
const TransferDialog = lazy(() =>
  import("@/features/transfer/TransferDialog").then((m) => ({
    default: m.TransferDialog,
  })),
);
const ExportDialog = lazy(() =>
  import("@/features/export/ExportDialog").then((m) => ({
    default: m.ExportDialog,
  })),
);
const SampleTour = lazy(() =>
  import("@/features/onboarding/SampleTour").then((m) => ({
    default: m.SampleTour,
  })),
);
const HostedEditorTrialBar = lazy(() =>
  import("@/features/hosted-editor/HostedEditorTrialBar").then((m) => ({
    default: m.HostedEditorTrialBar,
  })),
);
const HostedEditorHandoffDialog = lazy(() =>
  import("@/features/hosted-editor/HostedEditorHandoffDialog").then((m) => ({
    default: m.HostedEditorHandoffDialog,
  })),
);
const WebEditorWorkspaceImportDialog = lazy(() =>
  import("@/features/import/WebEditorWorkspaceImportDialog").then((m) => ({
    default: m.WebEditorWorkspaceImportDialog,
  })),
);

/* ── App root ── */

function App() {
  const runtimeCapabilities = useRuntimeCapabilities();
  const view = useWorkspaceStore((s) => s.view);
  const activeWorkspacePath = useWorkspaceStore((s) => s.activeWorkspacePath);
  const { t } = useTranslation();
  const [showWebEditorImport, setShowWebEditorImport] = useState(false);
  const requestWebEditorImport = useCallback(
    () => setShowWebEditorImport(true),
    [],
  );

  return (
    <>
      <ApplicationBootstrapHost
        onWebEditorImportRequested={requestWebEditorImport}
        runtimeCapabilities={runtimeCapabilities}
        renderCloseFailureDialog={(dialogProps) => (
          <CloseSaveFailureDialog {...dialogProps} />
        )}
      />
      <Toaster position="bottom-right" richColors />
      <LiveRegion />
      <LifecycleStatus />
      {view === "loading" && (
        <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background text-foreground">
          <TitleBar />
          <GrimodexLogo height={40} className="text-foreground" />
          <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
        </div>
      )}
      {view === "welcome" && <WelcomeScreen />}
      {view === "launcher" && <LauncherScreen />}
      {view === "editor" && <EditorScreen key={activeWorkspacePath ?? ""} />}
      <WorkspaceTrustDialog />
      <EulaConsentDialog />
      <ReleaseNotesDialog />
      {runtimeCapabilities.genericProjectTransfer && showWebEditorImport && (
        <Suspense fallback={null}>
          <WebEditorWorkspaceImportDialog
            open
            onClose={() => setShowWebEditorImport(false)}
          />
        </Suspense>
      )}
      <DebugLogViewer />
    </>
  );
}

function EditorScreen() {
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
  const { t } = useTranslation();
  // 更新が保留中か (⚙ ボタンの SR ラベル用。UpdateDot も同じ store を読む)。
  const updatePending = useUpdatePending();
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialCategory, setSettingsInitialCategory] =
    useState<SettingsCategory>("project");
  const [showExport, setShowExport] = useState(false);
  // エクスポートダイアログを特定タブで開く要求。seq（nonce）の変化で
  // ダイアログ既開時の再要求にもタブ切替が効く（undefined なら前回タブ維持）。
  const [exportModeRequest, setExportModeRequest] = useState<
    { mode: ExportDialogMode; seq: number } | undefined
  >(undefined);
  const [showSnapshotModal, setShowSnapshotModal] = useState(false);
  const [showTransferDialog, setShowTransferDialog] = useState(false);
  const [showHostedHandoff, setShowHostedHandoff] = useState(false);
  const [transferTab, setTransferTab] = useState<TransferTab>("import");
  const seedAndOpenSample = useWorkspaceStore((s) => s.seedAndOpenSample);
  const showSampleTour = useWorkspaceStore((s) => s.showSampleTour);
  const mac = isMac();

  // Open settings dialog when triggered by error handler or other sources
  useEffect(() => {
    function onOpenSettings(e: Event) {
      const detail = (e as CustomEvent<{ category?: SettingsCategory }>).detail;
      setSettingsInitialCategory(detail?.category ?? "project");
      setShowSettings(true);
    }
    window.addEventListener("open-settings", onOpenSettings);
    return () => window.removeEventListener("open-settings", onOpenSettings);
  }, []);

  // Open export dialog via custom event (e.g. from Settings > Data)
  useEffect(() => {
    function onOpenExport() {
      if (!runtimeCapabilities.genericProjectTransfer) return;
      setShowExport(true);
    }
    window.addEventListener("open-export-dialog", onOpenExport);
    return () => window.removeEventListener("open-export-dialog", onOpenExport);
  }, [runtimeCapabilities.genericProjectTransfer]);

  // Open export dialog on the book (Vivliostyle) tab via a custom event.
  useEffect(() => {
    function onOpenVivliostyle() {
      if (!runtimeCapabilities.genericProjectTransfer) return;
      setExportModeRequest((prev) => ({
        mode: "book",
        seq: (prev?.seq ?? 0) + 1,
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
      <WorkspaceViewportProvider profile={workspaceProfile}>
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
          {!editorZenMode &&
            !phoneWorkspace &&
            (panelWindow ? (
              // 別フローティング窓: ヘッダはドラッグ領域 + ウィンドウ操作のみに簡素化
              // (ロゴ/エクスポート/設定/プロジェクト切替はメイン窓の領分で、別窓に
              // 出すとややこしいため)。WindowControls は getCurrentWindow() で自窓を
              // 操作する。mac は decorations 側の扱いが別途必要(現状 Windows 前提)。
              <header
                data-header-bar
                className="flex h-9 shrink-0 items-center border-b border-border"
              >
                <div data-tauri-drag-region className="h-full flex-1" />
                {!mac && <WindowControls />}
              </header>
            ) : (
              <HeaderBarLayout
                mac={mac}
                className={cn(getScreenshotPanelId() && "no-screenshot")}
                left={
                  <>
                    <GrimodexLogo height={24} className="text-foreground" />
                    <WorkspaceMenu />
                    <ProjectMenu
                      onOpenImport={
                        runtimeCapabilities.localFileImport
                          ? () => {
                              setTransferTab("import");
                              setShowTransferDialog(true);
                            }
                          : undefined
                      }
                      onOpenExport={
                        runtimeCapabilities.genericProjectTransfer
                          ? () => {
                              setTransferTab("zip");
                              setShowTransferDialog(true);
                            }
                          : undefined
                      }
                      onOpenSnapshot={() => setShowSnapshotModal(true)}
                      onOpenWebEditorHandoff={
                        runtimeCapabilities.genericProjectTransfer
                          ? requestWebEditorHandoffImport
                          : undefined
                      }
                    />
                    <HistoryButtons />
                    {runtimeCapabilities.genericProjectTransfer && (
                      <button
                        type="button"
                        data-tour-target="export-button"
                        aria-label={t("app.exportLabel")}
                        title={t("app.exportTitle")}
                        onClick={() => setShowExport((v) => !v)}
                        className="flex h-8 shrink-0 items-center gap-1.5 rounded px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      >
                        <FileOutput className="h-4 w-4 shrink-0" />
                        <span className="hidden whitespace-nowrap text-sm xl:inline">
                          {t("app.exportLabel")}
                        </span>
                      </button>
                    )}
                  </>
                }
                center={null}
                right={
                  <>
                    <LayoutPresetDropdown />
                    <PanelToggleDropdown />
                    <button
                      type="button"
                      aria-label={
                        updatePending
                          ? t("app.settingsLabelUpdateAvailable", {
                              defaultValue: "設定（更新があります）",
                            })
                          : t("app.settingsLabel")
                      }
                      title={t("app.settingsTitle")}
                      onClick={() => {
                        setSettingsInitialCategory("project");
                        setShowSettings(true);
                      }}
                      className="relative flex h-8 shrink-0 items-center gap-1.5 rounded px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <Settings className="h-4 w-4 shrink-0" />
                      <span className="hidden whitespace-nowrap text-sm xl:inline">
                        {t("app.settingsLabel")}
                      </span>
                      <UpdateDot className="absolute right-1 top-1" />
                    </button>
                    {!mac && (
                      <>
                        <div className="h-4 w-px bg-border" />
                        <WindowControls />
                      </>
                    )}
                  </>
                }
              />
            ))}
          <Suspense fallback={null}>
            {showSettings && (
              <SettingsDialog
                open
                onClose={() => setShowSettings(false)}
                initialCategory={settingsInitialCategory}
                phoneWorkspace={phoneWorkspace}
              />
            )}
            {runtimeCapabilities.genericProjectTransfer && showExport && (
              <ExportDialog
                open
                onClose={() => setShowExport(false)}
                modeRequest={exportModeRequest}
              />
            )}
            {showSnapshotModal && (
              <ProjectSnapshotModal
                open
                onClose={() => setShowSnapshotModal(false)}
              />
            )}
            {runtimeCapabilities.localFileImport && showTransferDialog && (
              <TransferDialog
                open
                tab={transferTab}
                onTabChange={setTransferTab}
                onClose={() => setShowTransferDialog(false)}
              />
            )}
            {/* The current tour targets desktop-only panels such as Timeline.
              Do not mount its blocking spotlight in the phone projection. */}
            {showSampleTour && !phoneWorkspace && <SampleTour />}
          </Suspense>
          {!runtimeCapabilities.genericProjectTransfer &&
            runtimeCapabilities.browserDirectAi && (
              <Suspense fallback={null}>
                <HostedEditorHandoffDialog
                  open={showHostedHandoff}
                  onClose={() => setShowHostedHandoff(false)}
                  downloadHandoff={async () => {
                    const { downloadHostedEditorHandoff } =
                      await import("@/features/hosted-editor/downloadHostedEditorHandoff");
                    return downloadHostedEditorHandoff();
                  }}
                />
              </Suspense>
            )}
          <ReindexProgressToast />
          <ModelDownloadToast />
          <PostEffectProgressToast />
          <UpdateToast />
          <ReloadConflictDialog />
          {!runtimeCapabilities.genericProjectTransfer &&
            runtimeCapabilities.browserDirectAi && (
              <Suspense fallback={null}>
                <HostedEditorTrialBar
                  compact={phoneWorkspace}
                  onContinue={() => setShowHostedHandoff(true)}
                />
              </Suspense>
            )}
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
                    onOpenSettings={() => {
                      setSettingsInitialCategory("project");
                      setShowSettings(true);
                    }}
                    onOpenAiSettings={() => {
                      setSettingsInitialCategory("ai");
                      setShowSettings(true);
                    }}
                    onOpenImport={
                      runtimeCapabilities.localFileImport
                        ? () => {
                            setTransferTab("import");
                            setShowTransferDialog(true);
                          }
                        : undefined
                    }
                    onOpenExport={
                      runtimeCapabilities.genericProjectTransfer
                        ? () => setShowExport(true)
                        : undefined
                    }
                    onContinueInGrimodex={
                      !runtimeCapabilities.genericProjectTransfer &&
                      runtimeCapabilities.browserDirectAi
                        ? () => setShowHostedHandoff(true)
                        : undefined
                    }
                    workspaceControls={
                      <div data-phone-workspace-controls className="grid gap-2">
                        <WorkspaceMenu />
                        <ProjectMenu
                          onOpenImport={
                            runtimeCapabilities.localFileImport
                              ? () => {
                                  setTransferTab("import");
                                  setShowTransferDialog(true);
                                }
                              : undefined
                          }
                          onOpenExport={
                            runtimeCapabilities.genericProjectTransfer
                              ? () => {
                                  setTransferTab("zip");
                                  setShowTransferDialog(true);
                                }
                              : undefined
                          }
                          onOpenSnapshot={() => setShowSnapshotModal(true)}
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
          </main>
          <ZenModeController />
          <BackgroundStudioHost zenMode={editorZenMode} />
        </div>
      </WorkspaceViewportProvider>
    </>
  );
}

export default App;

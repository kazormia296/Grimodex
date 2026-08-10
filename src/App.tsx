import { lazy, Suspense, useCallback, useState } from "react";
import { Toaster } from "sonner";

import { WelcomeScreen } from "@/features/workspace/WelcomeScreen";
import { LauncherScreen } from "@/features/workspace/LauncherScreen";
import { WorkspaceTrustDialog } from "@/features/workspace/WorkspaceTrustDialog";
import { EulaConsentDialog } from "@/features/legal/EulaConsentDialog";
import { ReleaseNotesDialog } from "@/features/release-notes/ReleaseNotesDialog";
import { useWorkspaceStore } from "@/features/workspace/store";
import { DebugLogViewer } from "@/lib/DebugLogViewer";
import { GrimodexLogo } from "@/components/GrimodexLogo";
import { LiveRegion } from "@/components/a11y/LiveRegion";
import { useTranslation } from "react-i18next";
import { TitleBar } from "@/components/TitleBar";
import { CloseSaveFailureDialog } from "@/components/CloseSaveFailureDialog";
import { LifecycleStatus } from "@/application/lifecycle/LifecycleStatus";
import { useRuntimeCapabilities } from "@/runtime/runtimeCapabilitiesContext";
import { ApplicationBootstrapHost } from "@/application/bootstrap/ApplicationBootstrapHost";
import { EditorWorkspaceController } from "@/features/editor/EditorWorkspaceController";
import { RecoveryShell } from "@/features/workspace/recovery/RecoveryShell";

const WebEditorWorkspaceImportDialog = lazy(() =>
  import("@/features/import/WebEditorWorkspaceImportDialog").then((m) => ({
    default: m.WebEditorWorkspaceImportDialog,
  })),
);

// Root composition remains deliberately thin.
function App() {
  const runtimeCapabilities = useRuntimeCapabilities();
  const view = useWorkspaceStore((s) => s.view);
  const activeWorkspacePath = useWorkspaceStore((s) => s.activeWorkspacePath);
  const revision = useWorkspaceStore((s) => s.workspaceOpenRevision);
  const recoveryShell = useWorkspaceStore((s) => s.recoveryShell);
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);
  const setRecoveryCandidates = useWorkspaceStore(
    (s) => s.setRecoveryCandidates,
  );
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
      {view === "recovery" && (
        <RecoveryShell
          recovery={recoveryShell}
          onCandidatesUpdated={setRecoveryCandidates}
          onRetryOpen={(workspacePath) =>
            openWorkspace(workspacePath, "direct")
          }
        />
      )}
      {view === "editor" && (
        <EditorWorkspaceController key={`${activeWorkspacePath}:${revision}`} />
      )}
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

export default App;

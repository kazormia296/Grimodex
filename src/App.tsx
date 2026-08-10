import { lazy, Suspense, useCallback, useState } from "react";
import { Toaster } from "sonner";

import { WorkspaceTrustDialog } from "@/features/workspace/WorkspaceTrustDialog";
import { WorkspaceViewHost } from "@/features/workspace/WorkspaceViewHost";
import { EulaConsentDialog } from "@/features/legal/EulaConsentDialog";
import { ReleaseNotesDialog } from "@/features/release-notes/ReleaseNotesDialog";
import { DebugLogViewer } from "@/lib/DebugLogViewer";
import { LiveRegion } from "@/components/a11y/LiveRegion";
import { CloseSaveFailureDialog } from "@/components/CloseSaveFailureDialog";
import { LifecycleStatus } from "@/application/lifecycle/LifecycleStatus";
import { useRuntimeCapabilities } from "@/runtime/runtimeCapabilitiesContext";
import { ApplicationBootstrapHost } from "@/application/bootstrap/ApplicationBootstrapHost";

const WebEditorWorkspaceImportDialog = lazy(() =>
  import("@/features/import/WebEditorWorkspaceImportDialog").then((m) => ({
    default: m.WebEditorWorkspaceImportDialog,
  })),
);

// Root composition remains deliberately thin.
function App() {
  const runtimeCapabilities = useRuntimeCapabilities();
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
      <WorkspaceViewHost />
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

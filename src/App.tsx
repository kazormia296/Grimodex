import { lazy, Suspense, useCallback, useState } from "react";
import { Toaster } from "sonner";

import { WorkspaceViewHost } from "@/features/workspace/WorkspaceViewHost";
import { useWorkspaceStore } from "@/features/workspace/store";
import { EulaConsentDialog } from "@/features/legal/EulaConsentDialog";
import { useReleaseNotesStore } from "@/features/release-notes/releaseNotesStore";
import { useDebugLogStore } from "@/lib/debugLog";
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

const DebugLogViewer = lazy(() =>
  import("@/lib/DebugLogViewer").then((m) => ({
    default: m.DebugLogViewer,
  })),
);

const ReleaseNotesDialog = lazy(() =>
  import("@/features/release-notes/ReleaseNotesDialog").then((m) => ({
    default: m.ReleaseNotesDialog,
  })),
);

const WorkspaceTrustDialog = lazy(() =>
  import("@/features/workspace/WorkspaceTrustDialog").then((m) => ({
    default: m.WorkspaceTrustDialog,
  })),
);

// Root composition remains deliberately thin.
function App() {
  const runtimeCapabilities = useRuntimeCapabilities();
  const debugLogOpen = useDebugLogStore((state) => state.isOpen);
  const releaseNotesOpen = useReleaseNotesStore((state) => state.isOpen);
  const pendingTrustPath = useWorkspaceStore((state) => state.pendingTrustPath);
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
      {pendingTrustPath && (
        <Suspense fallback={null}>
          <WorkspaceTrustDialog />
        </Suspense>
      )}
      <EulaConsentDialog />
      {releaseNotesOpen && (
        <Suspense fallback={null}>
          <ReleaseNotesDialog />
        </Suspense>
      )}
      {runtimeCapabilities.genericProjectTransfer && showWebEditorImport && (
        <Suspense fallback={null}>
          <WebEditorWorkspaceImportDialog
            open
            onClose={() => setShowWebEditorImport(false)}
          />
        </Suspense>
      )}
      {debugLogOpen && (
        <Suspense fallback={null}>
          <DebugLogViewer />
        </Suspense>
      )}
    </>
  );
}

export default App;

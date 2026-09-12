import { useCallback, useState } from "react";
import { Toaster } from "sonner";

import { WorkspaceViewHost } from "@/features/workspace/WorkspaceViewHost";
import { LiveRegion } from "@/components/a11y/LiveRegion";
import { CloseSaveFailureDialog } from "@/components/CloseSaveFailureDialog";
import { ApplicationDialogs } from "@/components/ApplicationDialogs";
import { LifecycleStatus } from "@/application/lifecycle/LifecycleStatus";
import { useRuntimeCapabilities } from "@/runtime/runtimeCapabilitiesContext";
import { ApplicationBootstrapHost } from "@/application/bootstrap/ApplicationBootstrapHost";

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
      <ApplicationDialogs
        onCloseWebEditorImport={() => setShowWebEditorImport(false)}
        runtimeCapabilities={runtimeCapabilities}
        showWebEditorImport={showWebEditorImport}
      />
    </>
  );
}

export default App;

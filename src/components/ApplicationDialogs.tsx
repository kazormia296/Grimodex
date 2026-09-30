import { lazy, Suspense } from "react";

import { EulaConsentDialog } from "@/features/legal/EulaConsentDialog";
import { useReleaseNotesStore } from "@/features/release-notes/releaseNotesStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useDebugLogStore } from "@/lib/debugLog";
import type { RuntimeCapabilities } from "@/runtime/runtimeCapabilities";

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

interface ApplicationDialogsProps {
  onCloseWebEditorImport: () => void;
  runtimeCapabilities: RuntimeCapabilities;
  showWebEditorImport: boolean;
}

export function ApplicationDialogs({
  onCloseWebEditorImport,
  runtimeCapabilities,
  showWebEditorImport,
}: ApplicationDialogsProps) {
  const debugLogOpen = useDebugLogStore((state) => state.isOpen);
  const releaseNotesOpen = useReleaseNotesStore((state) => state.isOpen);
  const pendingTrustPath = useWorkspaceStore((state) => state.pendingTrustPath);

  return (
    <>
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
            onClose={onCloseWebEditorImport}
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

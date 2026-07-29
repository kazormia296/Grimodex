import { lazy, Suspense } from "react";

import type { RuntimeCapabilities } from "@/runtime/runtimeCapabilities";
import type { SettingsCategory } from "@/features/settings/types";
import type { TransferTab } from "@/features/transfer/TransferDialog";
import type { ExportDialogMode } from "@/features/export/ExportDialog";
import { ReindexProgressToast } from "@/features/semantic-search/ReindexProgressToast";
import { PostEffectProgressToast } from "@/features/post-effect/PostEffectProgressToast";
import { ModelDownloadToast } from "@/features/semantic-search/ModelDownloadToast";
import { UpdateToast } from "@/features/updater/UpdateToast";
import { ReloadConflictDialog } from "@/features/external-mount/components/ReloadConflictDialog";

const SettingsDialog = lazy(() =>
  import("@/features/settings/SettingsDialog").then((module) => ({
    default: module.SettingsDialog,
  })),
);
const ProjectSnapshotModal = lazy(() =>
  import("@/features/revision/ProjectSnapshotModal").then((module) => ({
    default: module.ProjectSnapshotModal,
  })),
);
const TransferDialog = lazy(() =>
  import("@/features/transfer/TransferDialog").then((module) => ({
    default: module.TransferDialog,
  })),
);
const ExportDialog = lazy(() =>
  import("@/features/export/ExportDialog").then((module) => ({
    default: module.ExportDialog,
  })),
);
const SampleTour = lazy(() =>
  import("@/features/onboarding/SampleTour").then((module) => ({
    default: module.SampleTour,
  })),
);
const HostedEditorTrialBar = lazy(() =>
  import("@/features/hosted-editor/HostedEditorTrialBar").then((module) => ({
    default: module.HostedEditorTrialBar,
  })),
);
const HostedEditorHandoffDialog = lazy(() =>
  import("@/features/hosted-editor/HostedEditorHandoffDialog").then(
    (module) => ({ default: module.HostedEditorHandoffDialog }),
  ),
);

interface EditorWorkspaceDialogsProps {
  runtimeCapabilities: RuntimeCapabilities;
  phoneWorkspace: boolean;
  showSettings: boolean;
  settingsInitialCategory: SettingsCategory;
  showExport: boolean;
  exportModeRequest: { mode: ExportDialogMode; seq: number } | undefined;
  showSnapshotModal: boolean;
  showTransferDialog: boolean;
  transferTab: TransferTab;
  showHostedHandoff: boolean;
  showSampleTour: boolean;
  onCloseSettings: () => void;
  onCloseExport: () => void;
  onCloseSnapshot: () => void;
  onChangeTransferTab: (tab: TransferTab) => void;
  onCloseTransfer: () => void;
  onSetHostedHandoff: (open: boolean) => void;
}

export function EditorWorkspaceDialogs({
  runtimeCapabilities,
  phoneWorkspace,
  showSettings,
  settingsInitialCategory,
  showExport,
  exportModeRequest,
  showSnapshotModal,
  showTransferDialog,
  transferTab,
  showHostedHandoff,
  showSampleTour,
  onCloseSettings,
  onCloseExport,
  onCloseSnapshot,
  onChangeTransferTab,
  onCloseTransfer,
  onSetHostedHandoff,
}: EditorWorkspaceDialogsProps) {
  return (
    <>
      <Suspense fallback={null}>
        {showSettings && (
          <SettingsDialog
            open
            onClose={onCloseSettings}
            initialCategory={settingsInitialCategory}
            phoneWorkspace={phoneWorkspace}
          />
        )}
        {runtimeCapabilities.genericProjectTransfer && showExport && (
          <ExportDialog
            open
            onClose={onCloseExport}
            modeRequest={exportModeRequest}
          />
        )}
        {showSnapshotModal && (
          <ProjectSnapshotModal open onClose={onCloseSnapshot} />
        )}
        {runtimeCapabilities.localFileImport && showTransferDialog && (
          <TransferDialog
            open
            tab={transferTab}
            onTabChange={onChangeTransferTab}
            onClose={onCloseTransfer}
          />
        )}
        {showSampleTour && !phoneWorkspace && <SampleTour />}
      </Suspense>
      {!runtimeCapabilities.genericProjectTransfer &&
        runtimeCapabilities.browserDirectAi && (
          <Suspense fallback={null}>
            <HostedEditorHandoffDialog
              open={showHostedHandoff}
              onClose={() => onSetHostedHandoff(false)}
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
              onContinue={() => onSetHostedHandoff(true)}
            />
          </Suspense>
        )}
    </>
  );
}

import { lazy, Suspense, useEffect } from "react";
import { useCurrentProjectId } from "@/features/project/projectStore";
import { isCodexStructureExtractionReviewEnabled } from "./codexStructureExtractionFlag";
import { useCodexCandidateHostStore } from "./codexCandidateHostStore";
import { useCodexCandidateDismissalActions } from "./useCodexCandidateDismissalActions";

const CodexStructureExtractDialog = lazy(() =>
  import("./CodexStructureExtractDialog").then((module) => ({
    default: module.CodexStructureExtractDialog,
  })),
);

export function CodexStructureReviewHostBody() {
  const projectId = useCurrentProjectId();
  const syncProject = useCodexCandidateHostStore((s) => s.syncProject);
  const structureOpen = useCodexCandidateHostStore((s) => s.structureOpen);
  const structureEverOpened = useCodexCandidateHostStore(
    (s) => s.structureEverOpened,
  );
  const setStructureOpen = useCodexCandidateHostStore(
    (s) => s.setStructureOpen,
  );
  const dismissed = useCodexCandidateHostStore((s) => s.dismissed);
  const dismissedLoaded = useCodexCandidateHostStore((s) => s.dismissedLoaded);
  const { handleRestoreDismissedKeys } = useCodexCandidateDismissalActions();

  useEffect(() => syncProject(projectId), [projectId, syncProject]);

  if (!isCodexStructureExtractionReviewEnabled() || !structureEverOpened) {
    return null;
  }

  return (
    <Suspense fallback={null}>
      <CodexStructureExtractDialog
        open={structureOpen}
        onOpenChange={setStructureOpen}
        onRestoreDismissedCandidates={handleRestoreDismissedKeys}
        dismissedCandidateKeys={dismissedLoaded ? dismissed : undefined}
      />
    </Suspense>
  );
}

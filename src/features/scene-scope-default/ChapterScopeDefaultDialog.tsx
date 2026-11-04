import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AnimatedOverlay } from "@/components/ui/animated-overlay";
import { useTreeStore } from "@/features/tree/treeStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { ScopeDefaultApplyPanel } from "./ScopeDefaultApplyPanel";
import { chapterSceneIds } from "./chapterScenes";

/** The chapter unit of "apply the default to unset scenes" (SDEF/1 R16). */
export function ChapterScopeDefaultDialog({
  folderId,
  title,
  onClose,
}: {
  folderId: string;
  title: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const nodes = useTreeStore((state) => state.nodes);
  const workspacePath = useWorkspaceStore((state) => state.activeWorkspacePath);
  const folder = nodes.find((node) => node.id === folderId);
  const sceneIds = useMemo(
    () => chapterSceneIds(nodes, folderId),
    [nodes, folderId],
  );
  return (
    <AnimatedOverlay
      open
      onClose={onClose}
      className="w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-lg"
      testId="chapter-scope-default-dialog"
    >
      <h3 className="mb-3 text-sm font-semibold text-foreground">
        {t("tree.applyScopeDefaultToChapter")}
        {title ? `: ${title}` : ""}
      </h3>
      {workspacePath && folder && (
        <ScopeDefaultApplyPanel
          workspacePath={workspacePath}
          projectId={folder.projectId}
          sceneIds={sceneIds}
        />
      )}
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent"
        >
          {t("common.close")}
        </button>
      </div>
    </AnimatedOverlay>
  );
}

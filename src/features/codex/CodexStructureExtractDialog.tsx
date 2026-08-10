import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, Sparkles } from "lucide-react";
import {
  useTreeStore,
  getDescendantScenesInOrder,
} from "@/features/tree/treeStore";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { captureMutationAuthority } from "@/features/concurrency/mutationAuthority";
import { CodexStructureExtractionProgress } from "./CodexStructureExtractionProgress";
import { CodexEntityProposalReview } from "./CodexEntityProposalReview";
import { CodexRelationProposalReview } from "./CodexRelationProposalReview";
import { useCodexStructureExtractionStore } from "./codexStructureExtractionStore";
import {
  applyCodexStructureExtractionReview,
  getCodexStructureReview,
  startCodexStructureExtraction,
} from "./codexStructureExtractionApi";
import { useCodexStore } from "./codexStore";

/**
 * Folder-scoped Codex Structure Extraction dialog
 * (Entity + Relation review → Atomic Commit).
 */
export function CodexStructureExtractDialog({
  open,
  onOpenChange,
  folderId: initialFolderId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folderId?: string;
}) {
  const nodes = useTreeStore((s) => s.nodes);
  const projection = useCodexStructureExtractionStore((s) => s.projection);
  const clearProjection = useCodexStructureExtractionStore(
    (s) => s.clearProjection,
  );
  const clearIfScopeMismatch = useCodexStructureExtractionStore(
    (s) => s.clearIfScopeMismatch,
  );
  const entries = useCodexStore((s) => s.entries);

  const folders = useMemo(
    () => nodes.filter((node) => node.nodeType === "folder"),
    [nodes],
  );

  const [folderId, setFolderId] = useState(initialFolderId ?? "");
  const [analyzing, setAnalyzing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewTab, setReviewTab] = useState<"entity" | "relation">("entity");

  useEffect(() => {
    if (!open) return;
    if (initialFolderId) setFolderId(initialFolderId);
    const workspace = useWorkspaceStore.getState();
    const projectId = getCurrentProjectId();
    if (projectId && workspace.activeWorkspacePath) {
      clearIfScopeMismatch({
        projectId,
        workspacePath: workspace.activeWorkspacePath,
        openRevision: workspace.workspaceOpenRevision,
      });
    }
  }, [open, initialFolderId, clearIfScopeMismatch]);

  const approvedCount = projection?.approvedCount ?? 0;

  const handleAnalyze = async () => {
    const projectId = getCurrentProjectId();
    const workspace = useWorkspaceStore.getState();
    if (!projectId || !workspace.activeWorkspacePath || !folderId) {
      setError("プロジェクトまたはフォルダが未選択です");
      return;
    }
    const sceneNodes = getDescendantScenesInOrder(
      useTreeStore.getState().nodes,
      folderId,
    );
    if (sceneNodes.length === 0) {
      setError("フォルダ配下に Scene がありません");
      return;
    }

    setAnalyzing(true);
    setError(null);
    try {
      const authority = captureMutationAuthority(
        projectId,
        getCurrentProjectId,
      );
      await startCodexStructureExtraction({
        projectId,
        folderId,
        sceneIds: sceneNodes.map((scene) => scene.id),
        authority,
        workspacePath: workspace.activeWorkspacePath,
        openRevision: workspace.workspaceOpenRevision,
        useAi: false,
      });
      getCodexStructureReview();
      setReviewTab("entity");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAnalyzing(false);
    }
  };

  const handleApply = async () => {
    const projectId = getCurrentProjectId();
    if (!projectId || !projection || approvedCount === 0) return;
    setApplying(true);
    setError(null);
    try {
      const applied = await applyCodexStructureExtractionReview({
        projectId,
        entries: entries.map((entry) => ({
          id: entry.id,
          version: entry.version,
          aliases: entry.aliases,
          type: entry.type,
        })),
      });
      toast.success(`Codex 構造を ${applied} 件取り込みました`);
      clearProjection();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  };

  const handleClose = (next: boolean) => {
    if (!next) {
      clearProjection();
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className="flex max-h-[90vh] w-full max-w-3xl flex-col gap-3 overflow-hidden"
        data-testid="codex-structure-extract-dialog"
      >
        <DialogHeader>
          <DialogTitle>Codex 構造抽出</DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">対象フォルダ</span>
            <select
              className="rounded border border-input bg-background px-2 py-1.5 text-sm"
              value={folderId}
              onChange={(event) => setFolderId(event.target.value)}
              data-testid="codex-structure-folder-select"
            >
              <option value="">選択してください</option>
              {folders.map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.title}
                </option>
              ))}
            </select>
          </label>

          {error && (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          )}

          {(analyzing || projection) && (
            <CodexStructureExtractionProgress
              analyzing={analyzing}
              coverage={projection?.coverage ?? null}
              taskCounts={projection?.taskCounts ?? null}
              entityCount={projection?.entityCount ?? 0}
              relationCount={projection?.relationCount ?? 0}
              unresolvedCount={projection?.unresolvedCount ?? 0}
            />
          )}

          {projection && (
            <>
              <div className="flex gap-1 border-b border-border pb-1">
                <button
                  type="button"
                  className={`rounded px-2 py-1 text-xs ${
                    reviewTab === "entity"
                      ? "bg-accent font-medium"
                      : "text-muted-foreground hover:bg-accent/50"
                  }`}
                  onClick={() => setReviewTab("entity")}
                  data-testid="codex-structure-tab-entity"
                >
                  Entity ({projection.entityCount})
                </button>
                <button
                  type="button"
                  className={`rounded px-2 py-1 text-xs ${
                    reviewTab === "relation"
                      ? "bg-accent font-medium"
                      : "text-muted-foreground hover:bg-accent/50"
                  }`}
                  onClick={() => setReviewTab("relation")}
                  data-testid="codex-structure-tab-relation"
                >
                  Relation ({projection.relationCount})
                </button>
              </div>
              {reviewTab === "entity" ? (
                <CodexEntityProposalReview boundToStore />
              ) : (
                <CodexRelationProposalReview boundToStore />
              )}
            </>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
            onClick={() => handleClose(false)}
          >
            閉じる
          </button>
          {projection && (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-primary/40 px-3 py-1.5 text-sm text-primary hover:bg-primary/10 disabled:opacity-40"
              disabled={analyzing || applying || approvedCount === 0}
              onClick={() => void handleApply()}
              data-testid="codex-structure-apply"
            >
              {applying ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : null}
              承認済みを取り込む
              {approvedCount > 0 ? ` (${approvedCount})` : ""}
            </button>
          )}
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            disabled={analyzing || applying || !folderId}
            onClick={() => void handleAnalyze()}
            data-testid="codex-structure-analyze"
          >
            {analyzing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Sparkles className="h-3.5 w-3.5" aria-hidden />
            )}
            解析する
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

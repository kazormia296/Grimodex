import { useEffect, useMemo, useRef, useState } from "react";
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
  buildCodexStructureCatalogs,
  restoreCodexStructureExtractionReview,
  startCodexStructureExtraction,
} from "./codexStructureExtractionApi";
import { useCodexStore } from "./codexStore";
import { listCodexRelations } from "./codexRelationApi";
import { buildExistingRelationCatalog } from "./extraction/existingRelationMatcher";

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
  const setProjection = useCodexStructureExtractionStore(
    (s) => s.setProjection,
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
  const generationRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    if (initialFolderId) setFolderId(initialFolderId);
    const workspace = useWorkspaceStore.getState();
    const projectId = getCurrentProjectId();
    if (!projectId || !workspace.activeWorkspacePath) return;
    const scope = {
      projectId,
      workspacePath: workspace.activeWorkspacePath,
      openRevision: workspace.workspaceOpenRevision,
      folderId: (initialFolderId ?? folderId) || undefined,
    };
    clearIfScopeMismatch(scope);
    const current = useCodexStructureExtractionStore.getState().projection;
    const matched =
      current &&
      current.projectId === scope.projectId &&
      current.workspacePath === scope.workspacePath &&
      current.openRevision === scope.openRevision &&
      (scope.folderId ? current.folderId === scope.folderId : true);
    if (matched) {
      if (current.folderId) setFolderId(current.folderId);
      return;
    }
    if (!scope.folderId) return;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    void restoreCodexStructureExtractionReview({
      projectId: scope.projectId,
      workspacePath: scope.workspacePath,
      openRevision: scope.openRevision,
      folderId: scope.folderId,
    })
      .then((restored) => {
        if (!restored) return;
        if (generationRef.current !== generation) return;
        const workspaceNow = useWorkspaceStore.getState();
        if (
          workspaceNow.activeWorkspacePath !== scope.workspacePath ||
          workspaceNow.workspaceOpenRevision !== scope.openRevision
        ) {
          return;
        }
        if (restored.folderId && restored.folderId !== scope.folderId) return;
        setProjection(restored);
        if (restored.folderId) setFolderId(restored.folderId);
        setReviewTab("entity");
      })
      .catch(() => {
        // Soft-fail: empty review until the user runs analyze.
      });
    // folderId intentionally omitted: open/initialFolder drive restore; user folder changes bump generation separately
    // eslint-disable-next-line react-hooks/exhaustive-deps -- folder changes are handled by the select onChange
  }, [open, initialFolderId, clearIfScopeMismatch, setProjection]);

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

    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setAnalyzing(true);
    setError(null);
    clearProjection();
    try {
      const authority = captureMutationAuthority(
        projectId,
        getCurrentProjectId,
      );
      const catalogs = buildCodexStructureCatalogs({
        entries: entries.map((entry) => ({
          id: entry.id,
          name: entry.name,
          aliases: entry.aliases,
          type: entry.type,
          version: entry.version,
        })),
      });
      const existingRelations = buildExistingRelationCatalog(
        (await listCodexRelations(projectId)).map((row) => ({
          id: row.id,
          fromCodexId: row.fromCodexId,
          toCodexId: row.toCodexId,
          relationType: row.relationType,
          directionality:
            row.directionality === "symmetric" ? "symmetric" : "directed",
          label: row.label,
          inverseLabel: row.inverseLabel,
          semanticKey: row.semanticKey,
        })),
      );
      const next = await startCodexStructureExtraction({
        projectId,
        folderId,
        sceneIds: sceneNodes.map((scene) => scene.id),
        authority,
        workspacePath: workspace.activeWorkspacePath,
        openRevision: workspace.workspaceOpenRevision,
        useAi: false,
        existingEntries: catalogs.existingCatalog,
        typeCatalog: catalogs.typeCatalog,
        existingRelations,
      });
      if (generationRef.current !== generation) return;
      setProjection(next);
      setReviewTab("entity");
    } catch (err) {
      if (generationRef.current === generation) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (generationRef.current === generation) {
        setAnalyzing(false);
      }
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
      generationRef.current += 1;
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
      // Invalidate in-flight restore/analyze publishes; keep warm projection
      // for the same folder/workspace until Apply or folder change.
      generationRef.current += 1;
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
              onChange={(event) => {
                generationRef.current += 1;
                setFolderId(event.target.value);
                clearProjection();
              }}
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
                <CodexEntityProposalReview />
              ) : (
                <CodexRelationProposalReview />
              )}
            </>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <button
            type="button"
            className="rounded border border-input px-3 py-1.5 text-sm"
            onClick={() => handleClose(false)}
            disabled={analyzing || applying}
          >
            閉じる
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
            onClick={() => void handleAnalyze()}
            disabled={!folderId || analyzing || applying}
            data-testid="codex-structure-analyze"
          >
            {analyzing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            解析
          </button>
          <button
            type="button"
            className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
            onClick={() => void handleApply()}
            disabled={approvedCount === 0 || analyzing || applying}
            data-testid="codex-structure-apply"
          >
            {applying ? "適用中…" : `適用 (${approvedCount})`}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

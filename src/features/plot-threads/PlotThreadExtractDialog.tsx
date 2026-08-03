import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Loader2, Sparkles } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useTreeStore } from "@/features/tree/treeStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { saveScene } from "@/features/editor/editorSaveRegistry";
import { loadSceneContents } from "@/features/tree/api";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { prosemirrorToText } from "@/lib/prosemirror";
import { type PlotPhaseType } from "@/db/schema";
import {
  usePlotThreadStore,
  type PlotThreadImportProposal,
  type PlotThreadImportResult,
} from "./plotThreadStore";
import { spreadThreadColors } from "./threadColors";
import {
  proposePlotThreads,
  type PlotThreadProposal,
} from "./extractThreadsApi";

export async function loadPlotThreadExtractionScenes(
  sceneNodes: readonly Pick<TreeNodeData, "id" | "title">[],
  loadContents: typeof loadSceneContents = loadSceneContents,
) {
  const contents = await loadContents(sceneNodes.map((scene) => scene.id));
  return sceneNodes.map((scene, orderIndex) => ({
    sceneId: scene.id,
    title: scene.title,
    // loadSceneContent returned "" for a missing row; keep that exact
    // extraction input instead of silently dropping the scene.
    bodyText: prosemirrorToText(contents.get(scene.id) ?? ""),
    orderIndex,
  }));
}

/**
 * Phase 4a: 既存本文（章/フォルダ）から LLM でプロットスレッド候補を抽出し、
 * 確認のうえ一括取り込み（1 undo）するウィザード。
 */
export function PlotThreadExtractDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const nodes = useTreeStore((s) => s.nodes);
  const threads = usePlotThreadStore((s) => s.threads);
  const importPlotThreads = usePlotThreadStore((s) => s.importPlotThreads);
  // 取り込むスレッドの色は Codex タイプと同じパレットから割り当てる（アクティブテーマ）。
  const colorTheme = useWorkspaceStore((s) => s.globalSettings?.colorTheme);

  const folders = useMemo(
    () => nodes.filter((n) => n.nodeType === "folder"),
    [nodes],
  );
  const titleById = useMemo(
    () => new Map(nodes.map((n) => [n.id, n.title] as const)),
    [nodes],
  );

  const [folderId, setFolderId] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [candidates, setCandidates] = useState<PlotThreadProposal[] | null>(
    null,
  );
  const [importResult, setImportResult] =
    useState<PlotThreadImportResult | null>(null);
  const preparedImportRef = useRef<{
    candidates: PlotThreadProposal[];
    projectId: string;
    proposals: PlotThreadImportProposal[];
  } | null>(null);

  const phaseLabel = (p: PlotPhaseType) => t(`plotThread.phaseType.${p}`);

  const handleSelectFolder = (id: string) => {
    setFolderId(id);
    setCandidates(null);
    setImportResult(null);
    preparedImportRef.current = null;
  };

  const handleAnalyze = async () => {
    if (!folderId || analyzing) return;
    setAnalyzing(true);
    setCandidates(null);
    setImportResult(null);
    preparedImportRef.current = null;
    try {
      // DB content を読む前に編集中シーンの未 flush 保存を確定（stale 本文回避）。
      const activeId = useTreeStore.getState().activeSceneId;
      if (activeId) await saveScene(activeId);

      const sceneNodes = useTreeStore
        .getState()
        .nodes.filter((n) => n.nodeType === "scene" && n.parentId === folderId)
        .sort((a, b) => (a.sortOrder < b.sortOrder ? -1 : 1));
      const scenes = await loadPlotThreadExtractionScenes(sceneNodes);
      const result = await proposePlotThreads({
        scenes,
        existingThreads: threads.map((th) => ({ name: th.name })),
      });
      setCandidates(result);
    } catch {
      toast.error(t("plotThread.extract.failed", "抽出に失敗しました"));
    } finally {
      setAnalyzing(false);
    }
  };

  const handleImport = async () => {
    if (!candidates || candidates.length === 0 || importing) return;
    const projectId = getCurrentProjectId();
    if (!projectId) return;
    setImporting(true);
    try {
      let prepared = preparedImportRef.current;
      if (
        !prepared ||
        prepared.candidates !== candidates ||
        prepared.projectId !== projectId
      ) {
        // 色と retryKey は最初のクリック時に固定する。partial result 後の
        // 再クリックで既存 thread 数が増えても、同じ候補を別 create と誤認しない。
        const colors = spreadThreadColors(
          candidates.length,
          usePlotThreadStore.getState().threads.length,
          colorTheme,
          typeof document !== "undefined" &&
            document.documentElement.classList.contains("dark"),
        );
        prepared = {
          candidates,
          projectId,
          proposals: candidates.map((c, i) => ({
            retryKey: crypto.randomUUID(),
            name: c.name,
            description: c.description ?? null,
            color: colors[i] ?? null,
            markers: c.markers.map((m) => ({
              nodeId: m.sceneId,
              phaseType: m.phaseType,
              note: m.note ?? null,
            })),
          })),
        };
        preparedImportRef.current = prepared;
      }
      const result = await importPlotThreads(projectId, prepared.proposals);
      setImportResult(result);
      const complete =
        !result.aborted &&
        result.skipped.length === 0 &&
        result.failed.length === 0;
      if (complete) {
        preparedImportRef.current = null;
        toast.success(
          t(
            "plotThread.extract.imported",
            "{{n}}本のスレッドを取り込みました",
            {
              n: result.createdThreads.length,
            },
          ),
        );
        onOpenChange(false);
      } else {
        toast.warning(
          t(
            "plotThread.extract.importPartial",
            "{{created}}本を取り込み、{{skipped}}件をスキップ、{{failed}}件が失敗しました",
            {
              created: result.createdThreads.length,
              skipped: result.skipped.length,
              failed: result.failed.length,
            },
          ),
        );
      }
    } catch {
      toast.error(
        t("plotThread.extract.importFailed", "取り込みを完了できませんでした"),
      );
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("plotThread.extract.title", "本文からスレッドを抽出")}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 text-sm">
          <p className="text-xs text-muted-foreground">
            {t(
              "plotThread.extract.hint",
              "選んだ章/フォルダの本文を AI が読み、サブプロット（スレッド）と起承転結マーカーを提案します。取り込みは1回の操作（Undo 可）。",
            )}
          </p>

          <div className="flex items-center gap-2">
            <select
              value={folderId}
              onChange={(e) => handleSelectFolder(e.target.value)}
              className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm focus:outline-none"
            >
              <option value="">
                {t("plotThread.extract.selectFolder", "章/フォルダを選択…")}
              </option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.title || t("plotThread.unnamed", "（無名）")}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleAnalyze}
              disabled={!folderId || analyzing}
              className="inline-flex shrink-0 items-center gap-1 rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {analyzing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Sparkles className="h-3.5 w-3.5" aria-hidden />
              )}
              {t("plotThread.extract.analyze", "解析")}
            </button>
          </div>

          {candidates !== null && (
            <div className="max-h-72 overflow-y-auto rounded border border-border">
              {candidates.length === 0 ? (
                <div className="px-3 py-3 text-xs text-muted-foreground">
                  {t(
                    "plotThread.extract.none",
                    "抽出できるサブプロットが見つかりませんでした。",
                  )}
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {candidates.map((c, ci) => (
                    <li key={ci} className="flex flex-col gap-1 px-3 py-2">
                      <span className="font-medium text-foreground">
                        {c.name}
                      </span>
                      {c.description && (
                        <span className="text-xs text-muted-foreground">
                          {c.description}
                        </span>
                      )}
                      <div className="flex flex-wrap gap-1">
                        {c.markers.map((m, mi) => (
                          <span
                            key={mi}
                            className="inline-flex items-center gap-1 rounded bg-accent/60 px-1.5 py-0.5 text-[10px] text-foreground"
                            title={titleById.get(m.sceneId) ?? m.sceneId}
                          >
                            <span className="max-w-[120px] truncate">
                              {titleById.get(m.sceneId) ?? m.sceneId}
                            </span>
                            <span className="text-muted-foreground">
                              {phaseLabel(m.phaseType)}
                            </span>
                          </span>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {importResult && (
            <div
              role="status"
              className="rounded border border-border bg-muted/40 px-3 py-2 text-xs"
            >
              <p className="font-medium text-foreground">
                {t(
                  "plotThread.extract.importResult",
                  "作成 {{created}}本 / スキップ {{skipped}}件 / 失敗 {{failed}}件",
                  {
                    created: importResult.createdThreads.length,
                    skipped: importResult.skipped.length,
                    failed: importResult.failed.length,
                  },
                )}
              </p>
              {importResult.aborted && (
                <p className="mt-1 text-destructive">
                  {t(
                    "plotThread.extract.importAborted",
                    "プロジェクトまたはワークスペースが切り替わったため、取り込みを中断しました。",
                  )}
                </p>
              )}
              {importResult.skipped.length + importResult.failed.length > 0 && (
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
                  {[...importResult.skipped, ...importResult.failed].map(
                    (issue, index) => (
                      <li
                        key={`${issue.kind}-${issue.proposalIndex}-${issue.markerIndex ?? "thread"}-${index}`}
                      >
                        {issue.label || t("plotThread.unnamed", "（無名）")} —{" "}
                        {t(
                          `plotThread.extract.issue.${issue.code}`,
                          issue.code,
                        )}
                      </li>
                    ),
                  )}
                </ul>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent"
          >
            {t("common.cancel", "キャンセル")}
          </button>
          <button
            type="button"
            onClick={handleImport}
            disabled={!candidates || candidates.length === 0 || importing}
            className="inline-flex items-center gap-1 rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {importing && (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            )}
            {t("plotThread.extract.import", "取り込む")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

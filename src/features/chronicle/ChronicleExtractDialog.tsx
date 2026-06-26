import { useMemo, useState } from "react";
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
import { getCurrentProjectId } from "@/features/project/projectStore";
import { saveScene } from "@/features/editor/editorSaveRegistry";
import { loadSceneContent } from "@/features/tree/api";
import { extractPlainText } from "@/features/codex/prosemirrorTextExtractor";
import { listEvents } from "./api";
import {
  proposeEvents,
  importExtractedEvents,
  type EventProposal,
} from "./extractEventsApi";

/**
 * 本文（章/フォルダ）から LLM で作中の出来事候補を抽出し、確認のうえ一括取り込みする
 * ウィザード。ライブ出力の品質検証は実機 QA（キー必須）に委ねる。
 */
export function ChronicleExtractDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported?: () => void;
}) {
  const { t } = useTranslation();
  const nodes = useTreeStore((s) => s.nodes);

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
  const [candidates, setCandidates] = useState<EventProposal[] | null>(null);

  const handleSelectFolder = (id: string) => {
    setFolderId(id);
    setCandidates(null);
  };

  const handleAnalyze = async () => {
    if (!folderId || analyzing) return;
    const projectId = getCurrentProjectId();
    if (!projectId) return;
    setAnalyzing(true);
    setCandidates(null);
    try {
      const activeId = useTreeStore.getState().activeSceneId;
      if (activeId) await saveScene(activeId);

      const sceneNodes = useTreeStore
        .getState()
        .nodes.filter((n) => n.nodeType === "scene" && n.parentId === folderId)
        .sort((a, b) => (a.sortOrder < b.sortOrder ? -1 : 1));
      const scenes = await Promise.all(
        sceneNodes.map(async (n, i) => ({
          sceneId: n.id,
          title: n.title,
          bodyText: extractPlainText(await loadSceneContent(n.id)),
          orderIndex: i,
        })),
      );
      const existing = await listEvents(projectId);
      const result = await proposeEvents({
        scenes,
        existingTitles: existing.map((e) => e.title).filter(Boolean),
      });
      setCandidates(result);
    } catch {
      toast.error(t("chronicle.extract.failed", "抽出に失敗しました"));
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
      const n = await importExtractedEvents(projectId, candidates);
      toast.success(
        t("chronicle.extract.imported", "{{n}}件の出来事を取り込みました", {
          n,
        }),
      );
      onImported?.();
      onOpenChange(false);
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("chronicle.extract.title", "本文から出来事を抽出")}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 text-sm">
          <p className="text-xs text-muted-foreground">
            {t(
              "chronicle.extract.hint",
              "選んだ章/フォルダの本文を AI が読み、作中の出来事を提案します。取り込むと年表に追加されます。",
            )}
          </p>

          <div className="flex items-center gap-2">
            <select
              value={folderId}
              onChange={(e) => handleSelectFolder(e.target.value)}
              className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm focus:outline-none"
            >
              <option value="">
                {t("chronicle.extract.selectFolder", "章/フォルダを選択…")}
              </option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.title || t("chronicle.unnamed", "（無名）")}
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
              {t("chronicle.extract.analyze", "解析")}
            </button>
          </div>

          {candidates !== null && (
            <div className="max-h-72 overflow-y-auto rounded border border-border">
              {candidates.length === 0 ? (
                <div className="px-3 py-3 text-xs text-muted-foreground">
                  {t(
                    "chronicle.extract.none",
                    "抽出できる出来事が見つかりませんでした。",
                  )}
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {candidates.map((c, ci) => (
                    <li key={ci} className="flex flex-col gap-1 px-3 py-2">
                      <span className="font-medium text-foreground">
                        {c.title}
                      </span>
                      {c.note && (
                        <span className="text-xs text-muted-foreground">
                          {c.note}
                        </span>
                      )}
                      <div className="flex flex-wrap gap-1">
                        {c.evidenceSceneIds.map((sid) => (
                          <span
                            key={sid}
                            className="inline-flex max-w-[140px] items-center truncate rounded bg-accent/60 px-1.5 py-0.5 text-[10px] text-foreground"
                            title={titleById.get(sid) ?? sid}
                          >
                            {titleById.get(sid) ?? sid}
                          </span>
                        ))}
                      </div>
                    </li>
                  ))}
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
            {t("chronicle.extract.import", "取り込む")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

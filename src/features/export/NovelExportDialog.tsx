import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { AnimatedOverlay } from "@/components/ui/animated-overlay";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { getProject } from "@/features/project/api";
import { listCodexEntriesForContext } from "@/features/codex/api";
import { currentCodexMentionResolver } from "@/features/codex/mentionNameResolver";
import { useTreeStore } from "@/features/tree/treeStore";
import { loadScenesFull } from "@/features/tree/api";
import { useSceneContentStore } from "@/features/editor/sceneContentStore";
import { saveTextFile } from "@/lib/exportFile";
import {
  ExportTree,
  buildInitialTreeState,
  type ExportTreeState,
} from "./ExportTree";
import {
  collectCheckedSceneIdsInOrder,
  generateNovelExport,
  type NovelExportCodexEntry,
} from "./novelExport";

interface Props {
  open: boolean;
  onClose: () => void;
}

function parseAliases(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((a) => typeof a === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * AIのべりすと (.novel) エクスポート UI 本体（AnimatedOverlay を含まない）。
 * 単体ダイアログ（NovelExportDialog）と統合ダイアログ（TransferDialog）の両方で再利用。
 */
export function NovelExportBody({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const nodes = useTreeStore((s) => s.nodes);
  const expandedIds = useTreeStore((s) => s.expandedIds);

  const [treeState, setTreeState] = useState<ExportTreeState>(() =>
    buildInitialTreeState(nodes, expandedIds),
  );
  const [isExporting, setIsExporting] = useState(false);

  useEffect(() => {
    // マウント時（＝ダイアログ表示時）にツリー選択を初期化する。
    setTreeState(buildInitialTreeState(nodes, expandedIds));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const checkedScenes = nodes.filter(
    (n) => n.nodeType === "scene" && treeState.checkedIds.has(n.id),
  );
  const sceneCount = checkedScenes.length;
  const charCount = checkedScenes.reduce((sum, n) => sum + n.charCount, 0);

  async function handleExport() {
    if (isExporting || sceneCount === 0) return;
    setIsExporting(true);
    try {
      const projectId = getCurrentProjectId();
      const project = await getProject(projectId);

      // シーン本文（DB + 編集中シーンの liveContent オーバーレイ）
      const sceneIds = collectCheckedSceneIdsInOrder(
        nodes,
        treeState.checkedIds,
      );
      const loaded = await loadScenesFull(sceneIds);
      const live = useSceneContentStore.getState().liveContent;
      const sceneDocs = sceneIds.map((id) => {
        const liveDoc = live[id];
        if (liveDoc) return JSON.stringify(liveDoc);
        return loaded.get(id)?.content ?? "{}";
      });

      // Codex → キャラクターブック。suppress/hidden は文脈注入と同じ基準で除外。
      // content は使うが icon/notes は使わないので context projection で取得。
      const codexEntries: NovelExportCodexEntry[] = (
        await listCodexEntriesForContext(projectId)
      )
        .filter(
          (e) => e.contextMode !== "suppress" && e.contextMode !== "hidden",
        )
        .sort((a, b) =>
          a.type === b.type
            ? a.name.localeCompare(b.name, "ja")
            : a.type.localeCompare(b.type, "ja"),
        )
        .map((e) => ({
          name: e.name,
          aliases: parseAliases(e.aliases),
          contentJson: e.content,
          summary: e.summary ?? "",
        }));

      const title = project?.title?.trim() || "novel";
      const content = generateNovelExport({
        title,
        outline: project?.outline ?? "",
        aiInstructions: project?.aiInstructions ?? "",
        sceneDocs,
        codexEntries,
        resolveMentionName: currentCodexMentionResolver(),
      });

      // 保存ダイアログは Rust 側 (security audit PIO-2)。キャンセルは null。
      const saved = await saveTextFile(
        `${title}.novel`,
        { name: "AI Novelist", extensions: ["novel"] },
        content,
        "text/plain;charset=utf-8",
      );
      if (saved !== null) {
        toast.success(t("novelExport.success"));
        onClose();
      }
    } catch (err) {
      toast.error(t("novelExport.failed", { error: String(err) }));
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-4">
      <h2 className="shrink-0 text-base font-semibold">
        {t("novelExport.title")}
      </h2>

      <p className="shrink-0 text-sm text-muted-foreground">
        {t("novelExport.description")}
      </p>

      <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-border">
        <ExportTree nodes={nodes} state={treeState} onChange={setTreeState} />
      </div>

      <div className="flex shrink-0 items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {t("novelExport.stats", { scenes: sceneCount, chars: charCount })}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isExporting}
            className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            data-testid="novel-export-submit"
            onClick={() => void handleExport()}
            disabled={isExporting || sceneCount === 0}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            <Download className="h-3.5 w-3.5" />
            {isExporting ? t("novelExport.exporting") : t("novelExport.export")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function NovelExportDialog({ open, onClose }: Props) {
  return (
    <AnimatedOverlay
      open={open}
      onClose={onClose}
      className="flex h-[min(560px,85vh)] w-[480px] max-w-[90vw] flex-col gap-4 rounded-lg border border-border bg-background p-6 shadow-xl"
    >
      <NovelExportBody onClose={onClose} />
    </AnimatedOverlay>
  );
}

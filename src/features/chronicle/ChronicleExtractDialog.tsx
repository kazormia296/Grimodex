import { useEffect, useMemo, useRef, useState } from "react";
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
import {
  useTreeStore,
  getDescendantScenesInOrder,
} from "@/features/tree/treeStore";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import {
  captureMutationAuthority,
  isCurrentMutationAuthority,
  runAuthoritativeMutation,
  type MutationAuthority,
} from "@/features/concurrency/mutationAuthority";
import { saveScene } from "@/features/editor/editorSaveRegistry";
import { loadSceneContents } from "@/features/tree/api";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { extractPlainText } from "@/features/codex/prosemirrorTextExtractor";
import { listEvents } from "./api";
import {
  proposeEvents,
  importExtractedEvents,
  type EventProposal,
} from "./extractEventsApi";
import {
  chronicleScopeKey,
  type ChronicleScope,
  type ChronicleScopeKey,
} from "./chronicleScope";

export interface ChronicleExtractionSession {
  scope: ChronicleScope;
  scopeKey: ChronicleScopeKey;
  projectId: string;
  generation: number;
  authority: MutationAuthority;
}

interface ChronicleExtractionResult {
  session: ChronicleExtractionSession;
  candidates: EventProposal[];
}

export async function loadChronicleExtractionScenes(
  sceneNodes: readonly Pick<TreeNodeData, "id" | "title">[],
  loadContents: typeof loadSceneContents = loadSceneContents,
) {
  const contents = await loadContents(sceneNodes.map((scene) => scene.id));
  return sceneNodes.map((scene, orderIndex) => ({
    sceneId: scene.id,
    title: scene.title,
    // Match loadSceneContent's missing-row contract.
    bodyText: extractPlainText(contents.get(scene.id) ?? ""),
    orderIndex,
  }));
}

/**
 * 本文（章/フォルダ）から LLM で作中の出来事候補を抽出し、確認のうえ一括取り込みする
 * ウィザード。ライブ出力の品質検証は実機 QA（キー必須）に委ねる。
 */
export function ChronicleExtractDialog({
  open,
  onOpenChange,
  onImported,
  scope,
  isActive = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported?: () => void;
  scope: ChronicleScope | null;
  isActive?: boolean;
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
  const [extractionResult, setExtractionResult] =
    useState<ChronicleExtractionResult | null>(null);
  const currentScopeKey = scope ? chronicleScopeKey(scope) : null;
  const generationRef = useRef(0);
  const dialogScopeKeyRef = useRef<ChronicleScopeKey | null>(null);
  const openRef = useRef(open);
  const isActiveRef = useRef(isActive);
  const currentScopeKeyRef = useRef<ChronicleScopeKey | null>(currentScopeKey);
  openRef.current = open;
  isActiveRef.current = isActive;
  currentScopeKeyRef.current = currentScopeKey;

  const candidates =
    isActive &&
    currentScopeKey &&
    extractionResult?.session.scopeKey === currentScopeKey
      ? extractionResult.candidates
      : null;

  const isSessionCurrent = (session: ChronicleExtractionSession): boolean => {
    const workspace = useWorkspaceStore.getState();
    return (
      generationRef.current === session.generation &&
      openRef.current &&
      isActiveRef.current &&
      currentScopeKeyRef.current === session.scopeKey &&
      workspace.workspaceHydrated &&
      !workspace.workspaceSwitchInProgress &&
      workspace.activeWorkspacePath === session.scope.workspacePath &&
      workspace.workspaceOpenRevision === session.scope.openRevision &&
      getCurrentProjectId() === session.projectId &&
      isCurrentMutationAuthority(session.authority)
    );
  };

  // ダイアログは親側で常時マウントされるため、開く（再オープン含む）たびに
  // 選択フォルダと抽出候補を初期化する。これをしないと前回の候補が残り、
  // 再度「取り込む」を押すと同じ出来事が UUID 違いで二重生成されてしまう。
  useEffect(() => {
    if (!open) {
      dialogScopeKeyRef.current = null;
      generationRef.current += 1;
      setFolderId("");
      setExtractionResult(null);
      setAnalyzing(false);
      setImporting(false);
      return;
    }

    if (!isActive || !currentScopeKey) {
      dialogScopeKeyRef.current = null;
      generationRef.current += 1;
      setExtractionResult(null);
      setAnalyzing(false);
      setImporting(false);
      onOpenChange(false);
      return;
    }

    if (dialogScopeKeyRef.current === null) {
      dialogScopeKeyRef.current = currentScopeKey;
      generationRef.current += 1;
      setFolderId("");
      setExtractionResult(null);
      setAnalyzing(false);
      setImporting(false);
      return;
    }

    if (dialogScopeKeyRef.current !== currentScopeKey) {
      dialogScopeKeyRef.current = null;
      generationRef.current += 1;
      setExtractionResult(null);
      setAnalyzing(false);
      setImporting(false);
      onOpenChange(false);
    }
  }, [currentScopeKey, isActive, onOpenChange, open]);

  const handleSelectFolder = (id: string) => {
    if (analyzing || importing) return;
    setFolderId(id);
    setExtractionResult(null);
  };

  const handleAnalyze = async () => {
    if (!folderId || analyzing || importing || !scope || !currentScopeKey) {
      return;
    }
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const session: ChronicleExtractionSession = {
      scope,
      scopeKey: currentScopeKey,
      projectId: scope.projectId,
      generation,
      authority: captureMutationAuthority(scope.projectId, getCurrentProjectId),
    };
    if (!isSessionCurrent(session)) return;

    setAnalyzing(true);
    setExtractionResult(null);
    try {
      const activeId = useTreeStore.getState().activeSceneId;
      if (activeId) await saveScene(activeId);
      if (!isSessionCurrent(session)) return;

      // 直下のシーンだけでなく、配下の全シーン（部>章>シーン等の入れ子も）を
      // DFS pre-order（ツリー表示順）で収集する。直下フィルタだと入れ子構造で
      // 候補が黙って空になる。
      const sceneNodes = getDescendantScenesInOrder(
        useTreeStore.getState().nodes,
        folderId,
      );
      const scenes = await loadChronicleExtractionScenes(sceneNodes);
      if (!isSessionCurrent(session)) return;
      const existing = await listEvents(session.projectId);
      if (!isSessionCurrent(session)) return;
      const result = await proposeEvents({
        scenes,
        existingTitles: existing.map((e) => e.title).filter(Boolean),
      });
      if (!isSessionCurrent(session)) return;
      setExtractionResult({ session, candidates: result });
    } catch {
      if (isSessionCurrent(session)) {
        toast.error(t("chronicle.extract.failed", "抽出に失敗しました"));
      }
    } finally {
      if (generationRef.current === session.generation) {
        setAnalyzing(false);
      }
    }
  };

  const handleImport = async () => {
    if (
      !extractionResult ||
      !candidates ||
      candidates.length === 0 ||
      importing
    ) {
      return;
    }
    const { session } = extractionResult;
    if (!isSessionCurrent(session)) {
      setExtractionResult(null);
      onOpenChange(false);
      return;
    }

    setImporting(true);
    try {
      const outcome = await runAuthoritativeMutation(session.authority, () =>
        importExtractedEvents(session.projectId, candidates),
      );
      if (outcome.status === "stale" || !isSessionCurrent(session)) {
        setExtractionResult(null);
        onOpenChange(false);
        return;
      }
      const n = outcome.value;
      toast.success(
        t(
          "chronicle.extract.imported",
          "{{count}}件のイベントを取り込みました",
          {
            count: n,
          },
        ),
      );
      // 取り込み成功後は候補を即クリアして、再オープン時の二重取り込みを防ぐ。
      setExtractionResult(null);
      onImported?.();
      onOpenChange(false);
    } catch {
      // 失敗時はダイアログを閉じず候補も保持し、再試行できる状態を保つ。
      if (isSessionCurrent(session)) {
        toast.error(t("chronicle.extract.failed", "抽出に失敗しました"));
      }
    } finally {
      if (generationRef.current === session.generation) {
        setImporting(false);
      }
    }
  };

  const handleDialogOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && importing) return;
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("chronicle.extract.title", "本文からイベントを抽出")}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 text-sm">
          <p className="text-xs text-muted-foreground">
            {t(
              "chronicle.extract.hint",
              "選んだ章/フォルダの本文を AI が読み、作中のイベントを提案します。取り込むと年表に追加されます。",
            )}
          </p>

          <div className="flex items-center gap-2">
            <select
              value={folderId}
              onChange={(e) => handleSelectFolder(e.target.value)}
              disabled={analyzing || importing}
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
              disabled={!folderId || analyzing || importing || !scope}
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
                    "抽出できるイベントが見つかりませんでした。",
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
            disabled={importing}
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

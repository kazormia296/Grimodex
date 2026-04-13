import { useEffect, useMemo, useState } from "react";
import { Pencil, Trash2, Plus } from "lucide-react";
import type { CodexEntry } from "../api";
import type { CodexEntryPhase } from "../phaseApi";
import { usePhaseStore } from "../phaseStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { PhaseDialog } from "./PhaseDialog";

interface TimelineTabProps {
  entry: CodexEntry;
}

const EMPTY_PHASES: CodexEntryPhase[] = [];

export function TimelineTab({ entry }: TimelineTabProps) {
  const rawPhases = usePhaseStore((s) => s.phasesByEntry[entry.id]);
  const phases = rawPhases ?? EMPTY_PHASES;
  const globalSceneOrder = usePhaseStore((s) => s.globalSceneOrder);
  const loadPhasesForEntry = usePhaseStore((s) => s.loadPhasesForEntry);
  const deletePhase = usePhaseStore((s) => s.deletePhase);
  const nodes = useTreeStore((s) => s.nodes);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingPhase, setEditingPhase] = useState<CodexEntryPhase | null>(
    null,
  );
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    void loadPhasesForEntry(entry.id);
  }, [entry.id, loadPhasesForEntry]);

  // シーン順でソートされたフェーズ
  const sortedPhases = useMemo(() => {
    return [...phases]
      .filter(
        (p) => p.anchorNodeId != null && globalSceneOrder.has(p.anchorNodeId),
      )
      .sort(
        (a, b) =>
          globalSceneOrder.get(a.anchorNodeId!)! -
          globalSceneOrder.get(b.anchorNodeId!)!,
      );
  }, [phases, globalSceneOrder]);

  // 現在有効なコンテンツ（新規フェーズ作成時のContent初期値として使用）
  // sortedPhasesを後ろから走査して最初のcontentOverrideを返す、なければベース
  const currentEffectiveContent = useMemo(() => {
    for (let i = sortedPhases.length - 1; i >= 0; i--) {
      if (sortedPhases[i].contentOverride !== null) {
        return sortedPhases[i].contentOverride!;
      }
    }
    return entry.content ?? "{}";
  }, [sortedPhases, entry.content]);

  // アンカーなし（順序不明）のフェーズ
  const unsortedPhases = useMemo(() => {
    return phases.filter(
      (p) => p.anchorNodeId == null || !globalSceneOrder.has(p.anchorNodeId),
    );
  }, [phases, globalSceneOrder]);

  // 現在のアクティブフェーズID
  const activePhaseId = useMemo(() => {
    if (!activeSceneId) return null;
    const currentOrder = globalSceneOrder.get(activeSceneId);
    if (currentOrder === undefined) return null;
    const applicable = sortedPhases.filter(
      (p) => globalSceneOrder.get(p.anchorNodeId!)! <= currentOrder,
    );
    return applicable[applicable.length - 1]?.id ?? null;
  }, [sortedPhases, globalSceneOrder, activeSceneId]);

  const getSceneTitle = (nodeId: string | null): string => {
    if (!nodeId) return "─";
    return nodes.find((n) => n.id === nodeId)?.title ?? nodeId;
  };

  const handleEdit = (phase: CodexEntryPhase) => {
    setEditingPhase(phase);
    setDialogOpen(true);
  };

  const handleAdd = () => {
    setEditingPhase(null);
    setDialogOpen(true);
  };

  const handleClose = () => {
    setDialogOpen(false);
    setEditingPhase(null);
  };

  const handleDeleteConfirm = async () => {
    if (!confirmDeleteId) return;
    await deletePhase(confirmDeleteId);
    setConfirmDeleteId(null);
  };

  const confirmPhase = phases.find((p) => p.id === confirmDeleteId);

  // フェーズ0件の空状態
  if (phases.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-8 text-center">
        <p className="text-[13px] font-medium text-foreground">
          フェーズが設定されていません。
        </p>
        <p className="max-w-[240px] text-xs text-muted-foreground">
          フェーズを追加すると、物語の進行に伴うこのエントリの変化を管理できます。
        </p>
        <button
          type="button"
          onClick={handleAdd}
          className="mt-1 flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
        >
          <Plus className="h-3.5 w-3.5" />
          Add phase
        </button>

        {dialogOpen && (
          <PhaseDialog
            entryId={entry.id}
            phase={null}
            onClose={handleClose}
            currentContent={currentEffectiveContent}
          />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-0">
      {/* Base state */}
      <div className="flex gap-2">
        <div className="flex flex-col items-center">
          <span className="mt-1 text-xs text-muted-foreground">●</span>
          <div className="mt-1 w-px flex-1 bg-border" />
        </div>
        <div className="pb-3 pt-0.5">
          <p className="text-xs font-semibold">Base state</p>
          {entry.summary && (
            <p className="mt-0.5 text-[11px] text-muted-foreground line-clamp-2">
              {entry.summary}
            </p>
          )}
        </div>
      </div>

      {/* Sorted phases */}
      {sortedPhases.map((phase) => {
        const isActive = phase.id === activePhaseId;
        return (
          <div key={phase.id}>
            {/* Scene separator */}
            <div className="flex items-center gap-2">
              <div className="flex w-4 justify-center">
                <div className="h-full w-px bg-border" />
              </div>
              <div className="flex flex-1 items-center gap-1 py-1">
                <div className="h-px flex-1 bg-border" />
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {getSceneTitle(phase.anchorNodeId)}
                </span>
                <div className="h-px flex-1 bg-border" />
              </div>
            </div>

            {/* Phase node */}
            <div className="flex gap-2">
              <div className="flex flex-col items-center">
                <span
                  className={`mt-1 text-xs ${isActive ? "text-primary" : "text-muted-foreground"}`}
                  title={isActive ? "現在のシーン" : undefined}
                >
                  {isActive ? "◉" : "●"}
                </span>
                <div className="mt-1 w-px flex-1 bg-border" />
              </div>
              <div className="flex-1 pb-3 pt-0.5">
                <div className="flex items-start justify-between gap-2">
                  <p
                    className={`text-xs font-semibold ${isActive ? "text-primary" : ""}`}
                  >
                    {phase.label}
                    {isActive && (
                      <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">
                        ← 現在のシーン
                      </span>
                    )}
                  </p>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => handleEdit(phase)}
                      className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(phase.id)}
                      className="rounded px-1.5 py-0.5 text-[11px] text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>

                {/* Diff view */}
                <div className="mt-1 space-y-0.5">
                  {phase.summaryOverride != null && (
                    <p className="text-[11px] text-muted-foreground">
                      <span className="text-foreground/60">summary →</span>{" "}
                      {phase.summaryOverride
                        ? `「${phase.summaryOverride}」`
                        : "(空)"}
                    </p>
                  )}
                  {phase.contentOverride != null && (
                    <p className="text-[11px] text-muted-foreground">
                      <span className="text-foreground/60">content →</span> 📝
                      (上書きあり)
                    </p>
                  )}
                  {phase.contextModeOverride != null && (
                    <p className="text-[11px] text-muted-foreground">
                      <span className="text-foreground/60">context →</span>{" "}
                      {phase.contextModeOverride}
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })}

      {/* アンカーなしフェーズ（末尾に表示） */}
      {unsortedPhases.map((phase) => (
        <div key={phase.id} className="flex gap-2">
          <div className="flex flex-col items-center">
            <span className="mt-1 text-xs text-muted-foreground">●</span>
            <div className="mt-1 w-px flex-1 bg-border" />
          </div>
          <div className="flex-1 pb-3 pt-0.5">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-xs font-semibold">{phase.label}</p>
                <p className="text-[10px] text-muted-foreground">
                  アンカーシーン未設定
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => handleEdit(phase)}
                  className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDeleteId(phase.id)}
                  className="rounded px-1.5 py-0.5 text-[11px] text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            </div>
          </div>
        </div>
      ))}

      {/* Add phase button */}
      <div className="flex gap-2">
        <div className="flex w-4 justify-center">
          <div className="h-3 w-px bg-border" />
        </div>
        <div className="pb-2" />
      </div>
      <button
        type="button"
        onClick={handleAdd}
        className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border py-2 text-xs text-muted-foreground hover:border-primary hover:text-primary"
      >
        <Plus className="h-3.5 w-3.5" />
        Add phase
      </button>

      {/* Phase dialog */}
      {dialogOpen && (
        <PhaseDialog
          entryId={entry.id}
          phase={editingPhase}
          onClose={handleClose}
          currentContent={currentEffectiveContent}
        />
      )}

      {/* Delete confirm dialog */}
      {confirmDeleteId && confirmPhase && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-80 rounded-lg border border-border bg-background p-5 shadow-xl">
            <p className="text-sm font-semibold">
              このフェーズを削除しますか？
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              「{confirmPhase.label}」
              {confirmPhase.anchorNodeId
                ? `（${getSceneTitle(confirmPhase.anchorNodeId)}）`
                : ""}
              を削除すると、このフェーズの上書き内容がすべて失われます。この操作は元に戻せません。
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDeleteId(null)}
                className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={() => void handleDeleteConfirm()}
                className="rounded-md bg-destructive px-3 py-1.5 text-sm text-destructive-foreground hover:bg-destructive/90"
              >
                削除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

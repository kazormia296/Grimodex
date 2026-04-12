import { useEffect, useState } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
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
  const phases =
    usePhaseStore((s) => s.phasesByEntry[entry.id]) ?? EMPTY_PHASES;
  const loadPhasesForEntry = usePhaseStore((s) => s.loadPhasesForEntry);
  const deletePhase = usePhaseStore((s) => s.deletePhase);
  const nodes = useTreeStore((s) => s.nodes);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingPhase, setEditingPhase] = useState<CodexEntryPhase | null>(
    null,
  );

  useEffect(() => {
    void loadPhasesForEntry(entry.id);
  }, [entry.id, loadPhasesForEntry]);

  const getSceneTitle = (nodeId: string | null): string => {
    if (!nodeId) return "---";
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

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          フェーズ ({phases.length})
        </span>
        <button
          type="button"
          onClick={handleAdd}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
        >
          <Plus className="h-3.5 w-3.5" />
          フェーズを追加
        </button>
      </div>

      {/* Phase list */}
      {phases.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">
          フェーズはまだありません
        </p>
      ) : (
        <div className="space-y-2">
          {phases.map((phase) => (
            <div
              key={phase.id}
              className="rounded-md border border-border bg-muted/30 px-3 py-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{phase.label}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    @ {getSceneTitle(phase.anchorNodeId)}
                  </p>
                  {phase.summaryOverride && (
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                      {phase.summaryOverride}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => handleEdit(phase)}
                    className="rounded p-1 text-muted-foreground hover:bg-accent"
                    title="編集"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void deletePhase(phase.id)}
                    className="rounded p-1 text-destructive hover:bg-destructive/10"
                    title="削除"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Dialog */}
      {dialogOpen && (
        <PhaseDialog
          entryId={entry.id}
          phase={editingPhase}
          onClose={handleClose}
        />
      )}
    </div>
  );
}

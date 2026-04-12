import { useEffect, useMemo } from "react";
import type { CodexEntry } from "../api";
import type { CodexEntryPhase } from "../phaseApi";
import { usePhaseStore } from "../phaseStore";
import { useTreeStore } from "@/features/tree/treeStore";

const EMPTY_PHASES: CodexEntryPhase[] = [];

interface PhaseIndicatorProps {
  entry: CodexEntry;
}

export function PhaseIndicator({ entry }: PhaseIndicatorProps) {
  const phases =
    usePhaseStore((s) => s.phasesByEntry[entry.id]) ?? EMPTY_PHASES;
  const globalSceneOrder = usePhaseStore((s) => s.globalSceneOrder);
  const loadPhasesForEntry = usePhaseStore((s) => s.loadPhasesForEntry);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);

  useEffect(() => {
    void loadPhasesForEntry(entry.id);
  }, [entry.id, loadPhasesForEntry]);

  // currentSceneId基準で適用済みフェーズをインライン計算（resolvedStatesに依存しない）
  const activePhase = useMemo(() => {
    if (phases.length === 0 || !activeSceneId) return null;
    const currentOrder = globalSceneOrder.get(activeSceneId);
    if (currentOrder === undefined) return null;

    const sorted = phases
      .filter(
        (p) => p.anchorNodeId != null && globalSceneOrder.has(p.anchorNodeId),
      )
      .sort(
        (a, b) =>
          globalSceneOrder.get(a.anchorNodeId!)! -
          globalSceneOrder.get(b.anchorNodeId!)!,
      )
      .filter((p) => globalSceneOrder.get(p.anchorNodeId!)! <= currentOrder);

    return sorted[sorted.length - 1] ?? null;
  }, [phases, globalSceneOrder, activeSceneId]);

  // フェーズなし → 何も表示しない
  if (phases.length === 0) return null;

  return (
    <div className="mb-2 flex items-center gap-1.5">
      {activePhase ? (
        <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
          現在のフェーズ: {activePhase.label}
        </span>
      ) : (
        <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          フェーズなし
        </span>
      )}
    </div>
  );
}

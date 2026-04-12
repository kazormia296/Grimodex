import type { CodexEntry } from "../api";
import type { CodexEntryPhase } from "../phaseApi";
import { usePhaseStore } from "../phaseStore";

const EMPTY_PHASES: CodexEntryPhase[] = [];

interface PhaseIndicatorProps {
  entry: CodexEntry;
}

export function PhaseIndicator({ entry }: PhaseIndicatorProps) {
  const phases =
    usePhaseStore((s) => s.phasesByEntry[entry.id]) ?? EMPTY_PHASES;
  const resolvedState = usePhaseStore((s) => s.getResolvedState(entry.id));

  if (phases.length === 0) return null;

  const appliedIds = resolvedState?.appliedPhaseIds ?? [];
  const lastAppliedId = appliedIds[appliedIds.length - 1] ?? null;
  const activePhase = lastAppliedId
    ? phases.find((p) => p.id === lastAppliedId)
    : null;

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

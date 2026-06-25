import { PLOT_PHASE_TYPES, type PlotPhaseType } from "@/db/schema";
import type { PhaseCell } from "./plotThreadAnalysis";

interface Props {
  threadId: string;
  cells: Record<PlotPhaseType, PhaseCell>;
  color: string | null;
  phaseLabels: Record<PlotPhaseType, string>;
  phasesReached: number;
}

/** 起承転結 5 段ステッパー: absent=薄い枠 / drafted=色枠 / written=色塗りのダイヤ。 */
export function PhaseStepper({
  threadId,
  cells,
  color,
  phaseLabels,
  phasesReached,
}: Props) {
  const c = color ?? "var(--primary)";
  return (
    <span
      data-testid={`phase-stepper-${threadId}`}
      className="inline-flex shrink-0 items-center gap-1"
    >
      <span className="inline-flex items-center gap-0.5">
        {PLOT_PHASE_TYPES.map((p) => {
          const cell = cells[p];
          const style =
            cell === "written"
              ? { backgroundColor: c, borderColor: c }
              : cell === "drafted"
                ? { backgroundColor: "transparent", borderColor: c }
                : {
                    backgroundColor: "transparent",
                    borderColor: "var(--border)",
                  };
          return (
            <span
              key={p}
              title={phaseLabels[p]}
              aria-label={phaseLabels[p]}
              data-cell={cell}
              className={`inline-block h-2 w-2 rotate-45 border ${
                cell === "absent" ? "opacity-50" : ""
              }`}
              style={style}
            />
          );
        })}
      </span>
      <span className="tabular-nums text-[10px] text-muted-foreground">
        {phasesReached}/{PLOT_PHASE_TYPES.length}
      </span>
    </span>
  );
}

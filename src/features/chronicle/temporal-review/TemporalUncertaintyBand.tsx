import type { TemporalVariableDomain } from "@/features/narrative-extraction/temporal/resolution";
import { MINUTES_PER_DAY } from "@/features/narrative-extraction/temporal/resolution";

export interface TemporalUncertaintyBandProps {
  /** Short row label, e.g. "開始" / "終了". */
  readonly label: string;
  readonly domain: TemporalVariableDomain;
}

function dayLabel(minute: number): string {
  return `day ${Math.floor(minute / MINUTES_PER_DAY)}`;
}

/**
 * Visualizes solver uncertainty (earliest..latest bound spread) for one
 * endpoint. This is deliberately never labeled "期間" (duration): duration is
 * a distance between two different endpoints of the *same* node, whereas
 * uncertainty here is the solver's remaining ambiguity about *one* endpoint's
 * placement. Callers that also want to show `ResolvedTemporalNode.duration`
 * must render it as its own separate row (see `TemporalConstraintCard`).
 */
export function TemporalUncertaintyBand({
  label,
  domain,
}: TemporalUncertaintyBandProps) {
  const { earliest, latest } = domain;
  const exact = earliest !== null && latest !== null && earliest === latest;
  const unknown = earliest === null && latest === null;
  const openStart = earliest === null && latest !== null;
  const openEnd = earliest !== null && latest === null;

  const describe = (): string => {
    if (unknown) return "不明";
    if (exact) return dayLabel(earliest!);
    if (openStart) return `〜${dayLabel(latest!)}`;
    if (openEnd) return `${dayLabel(earliest!)}〜`;
    return `${dayLabel(earliest!)} 〜 ${dayLabel(latest!)}`;
  };

  const bandStateLabel = unknown
    ? "不確実範囲不明"
    : exact
      ? "確定"
      : "不確実範囲";

  return (
    <div
      className="flex items-center gap-2 text-[10px] text-muted-foreground"
      data-testid="temporal-uncertainty-band"
      data-band-state={unknown ? "unknown" : exact ? "exact" : "bounded"}
    >
      <span className="w-6 shrink-0 text-foreground/70">{label}</span>
      <span
        className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={`${bandStateLabel}: ${describe()}`}
      >
        {unknown ? (
          <span className="absolute inset-0 bg-[repeating-linear-gradient(45deg,theme(colors.border)_0,theme(colors.border)_3px,transparent_3px,transparent_6px)]" />
        ) : exact ? (
          <span className="absolute inset-y-0 left-1/2 w-1 -translate-x-1/2 rounded-full bg-primary" />
        ) : (
          <span
            className={`absolute inset-y-0 rounded-full bg-amber-500/70 dark:bg-amber-400/60 ${
              openStart
                ? "left-0 right-1/2"
                : openEnd
                  ? "left-1/2 right-0"
                  : "inset-x-0"
            }`}
          />
        )}
      </span>
      <span className="shrink-0 tabular-nums">{describe()}</span>
    </div>
  );
}

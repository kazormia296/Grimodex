import { ATTRIBUTION_COLOR_VARS } from "./attributionColors";

interface BreakdownBarProps {
  human: number;
  ai: number;
  unknown: number;
  total: number;
  height?: number;
}

export function BreakdownBar({
  human,
  ai,
  unknown,
  total,
  height = 24,
}: BreakdownBarProps) {
  if (total === 0) return null;

  const segments = [
    { key: "human" as const, value: human },
    { key: "ai" as const, value: ai },
    { key: "unknown" as const, value: unknown },
  ].filter((s) => s.value > 0);

  return (
    <div
      className="flex w-full overflow-hidden rounded"
      style={{ height: `${height}px` }}
    >
      {segments.map(({ key, value }) => {
        const pct = Math.round((value / total) * 100);
        return (
          <div
            key={key}
            data-segment={key}
            title={`${key}: ${value} chars (${pct}%)`}
            style={{
              width: `${pct}%`,
              minWidth: "2px",
              backgroundColor: ATTRIBUTION_COLOR_VARS[key],
            }}
          />
        );
      })}
    </div>
  );
}

interface BreakdownBarProps {
  human: number;
  ai: number;
  unknown: number;
  total: number;
  height?: number;
}

const COLORS = {
  human: "oklch(0.65 0.10 220)",
  ai: "oklch(0.65 0.18 250)",
  unknown: "oklch(0.65 0.05 0)",
} as const;

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
              backgroundColor: COLORS[key],
            }}
          />
        );
      })}
    </div>
  );
}

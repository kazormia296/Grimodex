interface ForceLayoutProgressProps {
  alpha: number;
}

export function ForceLayoutProgress({ alpha }: ForceLayoutProgressProps) {
  const progress = Math.max(0, Math.min(100, (1 - alpha) * 100));

  return (
    <div className="pointer-events-none absolute bottom-4 left-1/2 z-50 -translate-x-1/2">
      <div className="flex items-center gap-2 rounded-lg bg-background/90 px-3 py-1.5 shadow-md backdrop-blur-sm">
        <div className="h-1.5 w-32 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all duration-100"
            style={{ width: `${progress}%` }}
          />
        </div>
        <span className="text-[10px] text-muted-foreground">
          レイアウト計算中…
        </span>
      </div>
    </div>
  );
}

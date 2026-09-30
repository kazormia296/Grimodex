import type { WorkLayerFindingView } from "./types";

interface ProjectionPipelineProps {
  readonly finding: WorkLayerFindingView;
  readonly activeLabel: string;
}

export function ProjectionPipeline({
  finding,
  activeLabel,
}: ProjectionPipelineProps) {
  return (
    <footer className="flex min-h-9 shrink-0 flex-wrap items-center rounded-b-sm border border-foreground/30 px-3 py-2 font-mono text-[8px] tracking-[0.1em] text-muted-foreground">
      <span>SOURCE CHANGE ✓</span>
      <span className="mx-1">→</span>
      <span>FRESHNESS ✓</span>
      <span className="mx-1">→</span>
      <span>VERIFY ✓</span>
      <span className="mx-1">→</span>
      <span>REBUILD ✓</span>
      <span className="mx-1">→</span>
      <span>RECHECK ◐</span>
      <span className="mx-1">→</span>
      <span className="font-bold text-foreground">{activeLabel}</span>
      <span className="ml-auto">
        RUN {finding.systemWork.runId} · EPOCH {finding.systemWork.epoch}
      </span>
    </footer>
  );
}

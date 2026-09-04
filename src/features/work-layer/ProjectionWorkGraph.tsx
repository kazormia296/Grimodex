import { cn } from "@/lib/utils";

import type { WorkLayerFindingView } from "./types";

interface ProjectionWorkGraphProps {
  readonly findings: readonly WorkLayerFindingView[];
  readonly selectedFindingId: string;
  readonly onSelect?: (findingId: string) => void;
  readonly className?: string;
}

export function ProjectionWorkGraph({
  findings,
  selectedFindingId,
  onSelect,
  className,
}: ProjectionWorkGraphProps) {
  return (
    <aside
      aria-label="WORK GRAPH"
      className={cn(
        "min-h-0 overflow-auto rounded-sm border border-foreground/30",
        className,
      )}
    >
      <div className="border-b border-foreground/30 px-3 py-2 font-mono text-[8px] tracking-[0.14em] text-muted-foreground">
        WORK GRAPH · {findings.length}
      </div>
      {findings.map((finding) => {
        const selected = selectedFindingId === finding.id;
        const content = (
          <>
            <span className="block font-mono text-[8px] tracking-[0.12em] text-muted-foreground">
              {finding.kind.toUpperCase()}
            </span>
            <span className="mt-1 block text-xs font-medium">
              {finding.title}
            </span>
            <span className="mt-1 block text-[10px] text-muted-foreground">
              {finding.states.freshness}
            </span>
          </>
        );
        return onSelect == null ? (
          <div
            key={finding.id}
            aria-current={selected ? "true" : undefined}
            className={cn(
              "border-b border-border px-3 py-3 text-left",
              selected && "bg-accent",
            )}
          >
            {content}
          </div>
        ) : (
          <button
            key={finding.id}
            type="button"
            aria-label={finding.title}
            aria-pressed={selected}
            onClick={() => onSelect(finding.id)}
            className={cn(
              "w-full border-b border-border px-3 py-3 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              selected && "bg-accent",
            )}
          >
            {content}
          </button>
        );
      })}
    </aside>
  );
}

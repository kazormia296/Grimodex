import type { TemporalConflict } from "@/features/narrative-extraction/temporal/conflict";
import type { TemporalNodeId } from "@/features/narrative-extraction/temporal/nodes";

export interface TemporalConflictCardProps {
  readonly conflict: TemporalConflict;
  readonly nodeLabel?: (nodeId: TemporalNodeId) => string;
}

/** Renders one solver-reported hard conflict (矛盾 tab). */
export function TemporalConflictCard({
  conflict,
  nodeLabel,
}: TemporalConflictCardProps) {
  const label = nodeLabel ?? ((id: TemporalNodeId) => id);

  return (
    <div
      className="flex flex-col gap-1.5 border-b border-destructive/30 bg-destructive/5 px-2 py-2 text-xs last:border-b-0"
      data-testid={`temporal-conflict-card-${conflict.conflictId}`}
    >
      <p className="font-medium text-destructive">{conflict.explanation}</p>

      {conflict.nodeIds.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {conflict.nodeIds.map((nodeId) => (
            <span
              key={nodeId}
              className="rounded bg-destructive/10 px-1 py-0.5 text-[10px] text-destructive"
            >
              {label(nodeId)}
            </span>
          ))}
        </div>
      )}

      {conflict.cycle.length > 0 && (
        <ol
          className="flex flex-col gap-0.5 text-[10px] text-muted-foreground"
          data-testid="temporal-conflict-cycle"
        >
          {conflict.cycle.map((step, index) => (
            <li key={`${step.constraintId}-${index}`}>
              {label(step.from.nodeId)}#{step.from.endpoint} →{" "}
              {label(step.to.nodeId)}#{step.to.endpoint}
              <span className="text-muted-foreground/70">
                {" "}
                ({step.constraintId})
              </span>
            </li>
          ))}
        </ol>
      )}

      {conflict.constraintIds.length > 0 && (
        <p className="text-[10px] text-muted-foreground">
          関連条件: {conflict.constraintIds.join(", ")}
        </p>
      )}
    </div>
  );
}

import type {
  ResolvedTemporalNode,
  TemporalNodeResolutionKind,
} from "@/features/narrative-extraction/temporal/resolution";
import type { TemporalConstraint } from "@/features/narrative-extraction/temporal/constraints";
import type { TemporalNodeId } from "@/features/narrative-extraction/temporal/nodes";
import { TemporalUncertaintyBand } from "./TemporalUncertaintyBand";

export type TemporalConstraintCardItem =
  | {
      readonly variant: "resolved";
      readonly node: ResolvedTemporalNode;
      readonly label?: string;
    }
  | {
      readonly variant: "relation";
      readonly constraint: Extract<
        TemporalConstraint,
        { readonly kind: "interval-relation" }
      >;
      readonly leftLabel?: string;
      readonly rightLabel?: string;
    };

export interface TemporalConstraintCardProps {
  readonly item: TemporalConstraintCardItem;
}

const RESOLUTION_LABEL: Record<TemporalNodeResolutionKind, string> = {
  exact: "確定",
  bounded: "範囲あり",
  "ordered-only": "順序のみ",
  symbolic: "象徴的",
  ambiguous: "曖昧",
  contradictory: "矛盾",
};

const RESOLUTION_TONE: Record<TemporalNodeResolutionKind, string> = {
  exact: "text-emerald-700 dark:text-emerald-400",
  bounded: "text-amber-700 dark:text-amber-400",
  "ordered-only": "text-muted-foreground",
  symbolic: "text-sky-700 dark:text-sky-400",
  ambiguous: "text-amber-700 dark:text-amber-400",
  contradictory: "text-destructive",
};

function nodeLabel(nodeId: TemporalNodeId, fallback?: string): string {
  return fallback ?? nodeId;
}

const RELATION_LABEL: Record<string, string> = {
  before: "より前",
  "before-or-equal": "以前",
  after: "より後",
  "after-or-equal": "以後",
  meets: "隣接",
  overlaps: "重複",
  during: "の間",
  contains: "を含む",
  starts: "と同時に始まる",
  finishes: "と同時に終わる",
  equals: "と同時",
};

/**
 * Renders one resolved temporal node (解決済み日時 tab) or one interval
 * relation constraint (相対関係 tab). Duration (a distance between a node's
 * own start/end) is always shown as its own labeled row, distinct from the
 * per-endpoint uncertainty bands rendered by `TemporalUncertaintyBand`.
 */
export function TemporalConstraintCard({ item }: TemporalConstraintCardProps) {
  if (item.variant === "relation") {
    const { constraint, leftLabel, rightLabel } = item;
    return (
      <div
        className="flex flex-col gap-1 border-b border-border px-2 py-2 text-xs last:border-b-0"
        data-testid={`temporal-relation-card-${constraint.id}`}
      >
        <div className="flex items-center gap-1 text-foreground">
          <span className="min-w-0 truncate font-medium">
            {nodeLabel(constraint.leftNodeId, leftLabel)}
          </span>
          <span className="shrink-0 text-muted-foreground">
            {RELATION_LABEL[constraint.relation] ?? constraint.relation}
          </span>
          <span className="min-w-0 truncate font-medium">
            {nodeLabel(constraint.rightNodeId, rightLabel)}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span
            className={`rounded px-1 py-0.5 ${
              constraint.strictness === "hard"
                ? "bg-destructive/10 text-destructive"
                : "bg-muted"
            }`}
          >
            {constraint.strictness === "hard" ? "確定条件" : "推定条件"}
          </span>
          <span>{constraint.authority}</span>
        </div>
      </div>
    );
  }

  const { node, label } = item;
  return (
    <div
      className="flex flex-col gap-1.5 border-b border-border px-2 py-2 text-xs last:border-b-0"
      data-testid={`temporal-resolved-card-${node.nodeId}`}
    >
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
          {nodeLabel(node.nodeId, label)}
        </span>
        <span
          className={`shrink-0 text-[10px] ${RESOLUTION_TONE[node.resolution]}`}
        >
          {RESOLUTION_LABEL[node.resolution]}
        </span>
      </div>

      <TemporalUncertaintyBand label="開始" domain={node.actualStart} />
      {node.actualEnd && (
        <TemporalUncertaintyBand label="終了" domain={node.actualEnd} />
      )}

      {node.duration && (
        <div
          className="flex items-center gap-2 text-[10px] text-muted-foreground"
          data-testid="temporal-duration-row"
        >
          <span className="w-6 shrink-0 text-foreground/70">期間</span>
          <span>
            {node.duration.earliest === node.duration.latest
              ? `${node.duration.earliest}分`
              : `${node.duration.earliest}〜${node.duration.latest}分`}
          </span>
        </div>
      )}

      {node.uncertaintyReason.length > 0 && (
        <p className="text-[10px] text-muted-foreground">
          {node.uncertaintyReason.join(" / ")}
        </p>
      )}
    </div>
  );
}

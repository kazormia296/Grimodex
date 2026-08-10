import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ResolvedTemporalNode } from "@/features/narrative-extraction/temporal/resolution";
import type { TemporalConflict } from "@/features/narrative-extraction/temporal/conflict";
import type { TemporalConstraint } from "@/features/narrative-extraction/temporal/constraints";
import type { TemporalNodeId } from "@/features/narrative-extraction/temporal/nodes";
import type { StoryRankLayer } from "@/features/narrative-extraction/temporal/solver/resolveStoryRanks";
import { TemporalConstraintCard } from "./TemporalConstraintCard";
import { TemporalConflictCard } from "./TemporalConflictCard";

export type TemporalReviewTab =
  | "resolved"
  | "relations"
  | "storyOrder"
  | "conflicts"
  | "unresolved";

export interface UnresolvedTemporalExpressionItem {
  readonly observationId: string;
  readonly surface: string;
  readonly reason: string;
}

export interface TemporalReviewPanelProps {
  readonly resolvedNodes: readonly ResolvedTemporalNode[];
  readonly relationConstraints?: readonly Extract<
    TemporalConstraint,
    { readonly kind: "interval-relation" }
  >[];
  readonly storyOrder?: readonly StoryRankLayer[];
  readonly conflicts?: readonly TemporalConflict[];
  readonly unresolvedExpressions?: readonly UnresolvedTemporalExpressionItem[];
  /** Optional display-name resolver; defaults to the raw opaque node id. */
  readonly nodeLabel?: (nodeId: TemporalNodeId) => string;
  readonly defaultTab?: TemporalReviewTab;
}

const TAB_DEFS: { id: TemporalReviewTab; label: string }[] = [
  { id: "resolved", label: "解決済み日時" },
  { id: "relations", label: "相対関係" },
  { id: "storyOrder", label: "作中順" },
  { id: "conflicts", label: "矛盾" },
  { id: "unresolved", label: "未解決表現" },
];

function EmptyRow({ text }: { readonly text: string }) {
  return <p className="px-3 py-3 text-xs text-muted-foreground">{text}</p>;
}

/**
 * Minimal read-only review surface for the Temporal Constraint Graph (spec
 * PR4). Purely presentational: callers own fetching/solving and pass the
 * already-resolved data in. No global store dependency.
 */
export function TemporalReviewPanel({
  resolvedNodes,
  relationConstraints = [],
  storyOrder = [],
  conflicts = [],
  unresolvedExpressions = [],
  nodeLabel,
  defaultTab = "resolved",
}: TemporalReviewPanelProps) {
  const [activeTab, setActiveTab] = useState<TemporalReviewTab>(defaultTab);
  const label = nodeLabel ?? ((id: TemporalNodeId) => id);

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => setActiveTab(value as TemporalReviewTab)}
      className="flex h-full flex-col"
      data-testid="temporal-review-panel"
    >
      <TabsList aria-label="時間関係レビュー" className="gap-0.5">
        {TAB_DEFS.map(({ id, label: tabLabel }) => (
          <TabsTrigger
            key={id}
            value={id}
            data-testid={`temporal-review-tab-${id}`}
          >
            {tabLabel}
            {id === "conflicts" && conflicts.length > 0 && (
              <span className="ml-1 rounded-full bg-destructive px-1 text-[9px] text-destructive-foreground">
                {conflicts.length}
              </span>
            )}
          </TabsTrigger>
        ))}
      </TabsList>

      <TabsContent
        value="resolved"
        className="min-h-0 flex-1 overflow-y-auto rounded border border-border"
      >
        {resolvedNodes.length === 0 ? (
          <EmptyRow text="解決済みの日時はまだありません。" />
        ) : (
          resolvedNodes.map((node) => (
            <TemporalConstraintCard
              key={node.nodeId}
              item={{ variant: "resolved", node, label: label(node.nodeId) }}
            />
          ))
        )}
      </TabsContent>

      <TabsContent
        value="relations"
        className="min-h-0 flex-1 overflow-y-auto rounded border border-border"
      >
        {relationConstraints.length === 0 ? (
          <EmptyRow text="相対関係の候補はまだありません。" />
        ) : (
          relationConstraints.map((constraint) => (
            <TemporalConstraintCard
              key={constraint.id}
              item={{
                variant: "relation",
                constraint,
                leftLabel: label(constraint.leftNodeId),
                rightLabel: label(constraint.rightNodeId),
              }}
            />
          ))
        )}
      </TabsContent>

      <TabsContent
        value="storyOrder"
        className="min-h-0 flex-1 overflow-y-auto rounded border border-border"
        data-testid="temporal-review-story-order"
      >
        {storyOrder.length === 0 ? (
          <EmptyRow text="作中順はまだ確定していません。" />
        ) : (
          storyOrder.map((layer) => (
            <div
              key={layer.rank}
              className="flex items-start gap-2 border-b border-border px-2 py-1.5 text-xs last:border-b-0"
              data-testid={`temporal-story-order-layer-${layer.rank}`}
            >
              <span className="mt-0.5 shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                {layer.rank + 1}
              </span>
              <div className="flex min-w-0 flex-1 flex-wrap gap-1">
                {layer.nodeIds.map((nodeId) => (
                  <span
                    key={nodeId}
                    className="truncate rounded bg-accent/40 px-1 py-0.5 text-foreground"
                  >
                    {label(nodeId)}
                  </span>
                ))}
              </div>
            </div>
          ))
        )}
      </TabsContent>

      <TabsContent
        value="conflicts"
        className="min-h-0 flex-1 overflow-y-auto rounded border border-border"
      >
        {conflicts.length === 0 ? (
          <EmptyRow text="矛盾は検出されていません。" />
        ) : (
          conflicts.map((conflict) => (
            <TemporalConflictCard
              key={conflict.conflictId}
              conflict={conflict}
              nodeLabel={label}
            />
          ))
        )}
      </TabsContent>

      <TabsContent
        value="unresolved"
        className="min-h-0 flex-1 overflow-y-auto rounded border border-border"
        data-testid="temporal-review-unresolved"
      >
        {unresolvedExpressions.length === 0 ? (
          <EmptyRow text="未解決の時間表現はありません。" />
        ) : (
          unresolvedExpressions.map((item) => (
            <div
              key={item.observationId}
              className="flex flex-col gap-0.5 border-b border-border px-2 py-1.5 text-xs last:border-b-0"
              data-testid={`temporal-unresolved-row-${item.observationId}`}
            >
              <span className="font-medium text-foreground">
                「{item.surface}」
              </span>
              <span className="text-[10px] text-muted-foreground">
                {item.reason}
              </span>
            </div>
          ))
        )}
      </TabsContent>
    </Tabs>
  );
}

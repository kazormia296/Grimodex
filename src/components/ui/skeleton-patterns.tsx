import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

interface SkeletonRegionProps {
  children: React.ReactNode;
  className?: string;
  testId?: string;
  style?: React.CSSProperties;
}

function SkeletonRegion({
  children,
  className,
  testId,
  style,
}: SkeletonRegionProps) {
  const { t } = useTranslation();
  return (
    <div
      aria-busy="true"
      aria-label={t("common.loadingContent")}
      data-testid={testId}
      className={className}
      style={style}
    >
      {children}
    </div>
  );
}

const TREE_DEPTHS = [0, 0, 1, 1, 2, 0] as const;

export function TreeRowSkeleton({ depth = 0 }: { depth?: number }) {
  return (
    <div
      className="flex items-center gap-1 py-1"
      style={{ paddingLeft: `${depth * 12 + 4}px` }}
    >
      <Skeleton className="h-4 w-4 shrink-0 rounded-sm" />
      <Skeleton className="h-4 w-4 shrink-0 rounded-sm" />
      <Skeleton className="h-4 max-w-[55%] flex-1 rounded-sm" />
    </div>
  );
}

export function TreeRowSkeletonList({
  count = 5,
  className,
  testId = "tree-row-skeleton-list",
}: {
  count?: number;
  className?: string;
  testId?: string;
}) {
  return (
    <SkeletonRegion testId={testId} className={cn("py-1", className)}>
      {Array.from({ length: count }, (_, index) => (
        <TreeRowSkeleton
          key={index}
          depth={TREE_DEPTHS[index % TREE_DEPTHS.length]}
        />
      ))}
    </SkeletonRegion>
  );
}

export function ListRowSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex h-[52px] flex-col justify-center gap-1 border-b border-border px-3 py-2",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <Skeleton className="h-4 w-12 rounded-full" />
        <Skeleton className="h-4 max-w-[50%] flex-1 rounded-sm" />
      </div>
      <Skeleton className="h-3 w-[70%] rounded-sm" />
    </div>
  );
}

export function ListRowSkeletonList({
  count = 6,
  className,
  testId = "list-row-skeleton-list",
}: {
  count?: number;
  className?: string;
  testId?: string;
}) {
  return (
    <SkeletonRegion testId={testId} className={className}>
      {Array.from({ length: count }, (_, index) => (
        <ListRowSkeleton key={index} />
      ))}
    </SkeletonRegion>
  );
}

export function GridCardSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex min-h-[72px] flex-col gap-2 rounded border border-border/60 p-2",
        className,
      )}
    >
      <Skeleton className="h-3 w-[40%] rounded-sm" />
      <Skeleton className="h-3 w-full rounded-sm" />
      <Skeleton className="h-3 w-[80%] rounded-sm" />
    </div>
  );
}

export function GridCardSkeletonList({
  count = 6,
  columns = 2,
  className,
  testId = "grid-card-skeleton-list",
}: {
  count?: number;
  columns?: number;
  className?: string;
  testId?: string;
}) {
  return (
    <SkeletonRegion
      testId={testId}
      className={cn("p-2", className)}
      style={
        {
          display: "grid",
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gap: "4px",
        } as React.CSSProperties
      }
    >
      {Array.from({ length: count }, (_, index) => (
        <GridCardSkeleton key={index} />
      ))}
    </SkeletonRegion>
  );
}

export function SessionRowSkeleton() {
  return (
    <div className="flex items-start gap-2 rounded px-2 py-2">
      <Skeleton className="mt-0.5 h-4 w-4 shrink-0 rounded-sm" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <Skeleton className="h-3.5 w-[70%] rounded-sm" />
        <Skeleton className="h-3 w-[40%] rounded-sm" />
      </div>
    </div>
  );
}

export function SessionRowSkeletonList({
  count = 4,
  className,
  testId = "session-row-skeleton-list",
}: {
  count?: number;
  className?: string;
  testId?: string;
}) {
  return (
    <SkeletonRegion
      testId={testId}
      className={cn("space-y-0.5 p-2", className)}
    >
      {Array.from({ length: count }, (_, index) => (
        <SessionRowSkeleton key={index} />
      ))}
    </SkeletonRegion>
  );
}

/** Chat history panel: group header + session rows. */
export function ChatHistorySkeletonList({
  className,
  testId = "chat-history-loading",
}: {
  className?: string;
  testId?: string;
}) {
  return (
    <SkeletonRegion
      testId={testId}
      className={cn("space-y-3 px-2 py-2", className)}
    >
      {[0, 1].map((groupIndex) => (
        <div key={groupIndex}>
          <Skeleton className="mb-2 h-3 w-24 rounded-sm" />
          <SessionRowSkeleton />
          <SessionRowSkeleton />
        </div>
      ))}
    </SkeletonRegion>
  );
}

export function MessageBubbleSkeleton({
  align = "left",
}: {
  align?: "left" | "right";
}) {
  return (
    <div
      className={cn(
        "flex",
        align === "right" ? "justify-end" : "justify-start",
      )}
    >
      <div
        className={cn(
          "w-[75%] max-w-md space-y-2 rounded-lg border border-border/50 p-3",
          align === "right" ? "bg-primary/5" : "bg-muted/30",
        )}
      >
        <Skeleton className="h-3 w-full rounded-sm" />
        <Skeleton className="h-3 w-[85%] rounded-sm" />
        <Skeleton className="h-3 w-[60%] rounded-sm" />
      </div>
    </div>
  );
}

export function MessageBubbleSkeletonList({
  count = 3,
  className,
  testId = "message-bubble-skeleton-list",
}: {
  count?: number;
  className?: string;
  testId?: string;
}) {
  return (
    <SkeletonRegion
      testId={testId}
      className={cn("space-y-4 px-4 py-3", className)}
    >
      {Array.from({ length: count }, (_, index) => (
        <MessageBubbleSkeleton
          key={index}
          align={index % 2 === 0 ? "right" : "left"}
        />
      ))}
    </SkeletonRegion>
  );
}

export function ChipSkeletonList({
  count = 3,
  className,
  testId = "chip-skeleton-list",
}: {
  count?: number;
  className?: string;
  testId?: string;
}) {
  return (
    <SkeletonRegion
      testId={testId}
      className={cn("flex flex-wrap gap-1", className)}
    >
      {Array.from({ length: count }, (_, index) => (
        <Skeleton key={index} className="h-5 w-14 rounded-full" />
      ))}
    </SkeletonRegion>
  );
}

export function FormFieldSkeletonList({
  count = 3,
  className,
  testId = "form-field-skeleton-list",
}: {
  count?: number;
  className?: string;
  testId?: string;
}) {
  return (
    <SkeletonRegion testId={testId} className={cn("space-y-3", className)}>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="space-y-1.5">
          <Skeleton className="h-3 w-24 rounded-sm" />
          <Skeleton className="h-16 w-full rounded-md" />
        </div>
      ))}
    </SkeletonRegion>
  );
}

export function TimelineItemSkeletonList({
  count = 3,
  className,
  testId = "timeline-item-skeleton-list",
}: {
  count?: number;
  className?: string;
  testId?: string;
}) {
  return (
    <SkeletonRegion testId={testId} className={cn("space-y-3", className)}>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex gap-3">
          <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-1.5 pt-1">
            <Skeleton className="h-3.5 w-[45%] rounded-sm" />
            <Skeleton className="h-3 w-[70%] rounded-sm" />
          </div>
        </div>
      ))}
    </SkeletonRegion>
  );
}

export function ForeshadowItemSkeletonList({
  count = 4,
  className,
  testId = "foreshadow-item-skeleton-list",
}: {
  count?: number;
  className?: string;
  testId?: string;
}) {
  return (
    <SkeletonRegion testId={testId} className={className}>
      {Array.from({ length: count }, (_, index) => (
        <div
          key={index}
          className="flex items-start gap-2 border-b border-border/50 px-3 py-2"
        >
          <Skeleton className="mt-0.5 h-4 w-4 shrink-0 rounded-sm" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-[65%] rounded-sm" />
            <Skeleton className="h-3 w-[40%] rounded-sm" />
          </div>
        </div>
      ))}
    </SkeletonRegion>
  );
}

export function RevisionRowSkeletonList({
  count = 4,
  className,
  testId = "revision-row-skeleton-list",
}: {
  count?: number;
  className?: string;
  testId?: string;
}) {
  return (
    <SkeletonRegion
      testId={testId}
      className={cn("space-y-0.5 p-2", className)}
    >
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="rounded px-3 py-2">
          <Skeleton className="mb-1.5 h-3.5 w-[55%] rounded-sm" />
          <Skeleton className="h-3 w-[35%] rounded-sm" />
        </div>
      ))}
    </SkeletonRegion>
  );
}

export function TableRowSkeletonRows({
  count = 5,
  columns = 6,
  testId = "table-row-skeleton-rows",
}: {
  count?: number;
  columns?: number;
  testId?: string;
}) {
  return (
    <>
      {Array.from({ length: count }, (_, rowIndex) => (
        <tr
          key={rowIndex}
          className="border-t border-border"
          {...(rowIndex === 0
            ? { "data-testid": testId, "aria-busy": true as const }
            : {})}
        >
          {Array.from({ length: columns }, (_, colIndex) => (
            <td key={colIndex} className="px-2 py-2">
              <Skeleton className="h-3 max-w-[80px] rounded-sm" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

import { useCallback, useRef, type ReactNode, type RefCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/utils";

interface VirtualRange {
  startIndex: number;
  endIndex: number;
  overscan: number;
  count: number;
}

/**
 * Keep the visible window plus the active draggable row. Pinning one row avoids
 * unmounting the drag source without synchronously mounting every card in a
 * large column.
 */
export function extractGridVirtualIndexes(
  range: VirtualRange,
  pinnedIndex: number | null,
): number[] {
  const start = Math.max(0, range.startIndex - range.overscan);
  const end = Math.min(range.count - 1, range.endIndex + range.overscan);
  const indexes = Array.from(
    { length: Math.max(0, end - start + 1) },
    (_, offset) => start + offset,
  );
  if (
    pinnedIndex !== null &&
    pinnedIndex >= 0 &&
    pinnedIndex < range.count &&
    !indexes.includes(pinnedIndex)
  ) {
    indexes.push(pinnedIndex);
    indexes.sort((a, b) => a - b);
  }
  return indexes;
}

interface GridVirtualListProps<T extends { id: string }> {
  items: readonly T[];
  pinnedItemId?: string | null;
  compact: boolean;
  className?: string;
  renderItem: (item: T) => ReactNode;
  endRef: RefCallback<HTMLDivElement>;
  endClassName: string;
  testId?: string;
}

/**
 * Variable-height card window shared by chapter, container and loose columns.
 * The scroll element stays mounted across drag state changes, while TanStack
 * Virtual measures real card heights and limits DnD hooks to visible rows.
 */
export function GridVirtualList<T extends { id: string }>({
  items,
  pinnedItemId = null,
  compact,
  className,
  renderItem,
  endRef,
  endClassName,
  testId,
}: GridVirtualListProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedIndex = pinnedItemId
    ? items.findIndex((item) => item.id === pinnedItemId)
    : -1;
  const rangeExtractor = useCallback(
    (range: VirtualRange) =>
      extractGridVirtualIndexes(range, pinnedIndex >= 0 ? pinnedIndex : null),
    [pinnedIndex],
  );
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => items[index]?.id ?? index,
    estimateSize: () => (compact ? 168 : 248),
    overscan: 4,
    rangeExtractor,
  });
  const totalSize = virtualizer.getTotalSize();

  return (
    <div
      ref={scrollRef}
      className={cn("min-h-0 flex-1 overflow-y-auto p-2", className)}
      data-testid={testId}
    >
      <div
        className="relative w-full"
        style={{ height: `${totalSize + 16}px` }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const item = items[virtualItem.index];
          if (!item) return null;
          return (
            <div
              key={virtualItem.key}
              ref={virtualizer.measureElement}
              data-index={virtualItem.index}
              data-grid-virtual-row={item.id}
              className="absolute left-0 top-0 w-full pb-2"
              style={{
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              {renderItem(item)}
            </div>
          );
        })}
        <div
          ref={endRef}
          className={cn("absolute inset-x-0 h-4", endClassName)}
          style={{ top: `${totalSize}px` }}
        />
      </div>
    </div>
  );
}

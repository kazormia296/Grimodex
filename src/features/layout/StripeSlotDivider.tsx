import { cn } from "@/lib/utils";

interface StripeSlotDividerProps {
  orientation: "vertical" | "horizontal";
  /** Content Splitter 帯と同じ幅。`slotSplitterPx(cardLayout)` を渡す。 */
  thicknessPx: number;
}

/**
 * open slot 間の stripe 仕切り。content 側 Splitter の cross-axis 厚みと
 * 一致させることで、ストライプのアイコン群分割位置を slot 境界と揃える。
 */
export function StripeSlotDivider({
  orientation,
  thicknessPx,
}: StripeSlotDividerProps) {
  const isVertical = orientation === "vertical";

  return (
    <div
      className={cn(
        "relative flex shrink-0 items-center justify-center",
        isVertical ? "w-full" : "h-full",
      )}
      style={isVertical ? { height: thicknessPx } : { width: thicknessPx }}
    >
      <div
        data-stripe-divider
        aria-hidden
        className={cn(
          "shrink-0 rounded-full bg-muted-foreground/50",
          isVertical ? "h-px w-5" : "h-5 w-px",
        )}
      />
    </div>
  );
}

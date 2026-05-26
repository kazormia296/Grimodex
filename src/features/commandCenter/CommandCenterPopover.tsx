import type { RefObject } from "react";
import { AnimatedPopover } from "@/components/ui/animated-popover";
import { CommandCenterResultList } from "./CommandCenterResultList";
import { BAR_VISIBLE_LIMIT_PER_SECTION } from "./lib/constants";
import { selectPopoverOpen, useBarStore } from "./store/commandCenterStore";

interface CommandCenterPopoverProps {
  /** Bar 全体を囲む ref。AnimatedPopover の click-outside 検出に使う */
  containerRef: RefObject<HTMLElement | null>;
}

/**
 * 検索バー直下に開くポップオーバー。
 * 表示有無は `selectPopoverOpen()` (open && parsedQuery 非空) の派生値。
 * Escape / containerRef 外クリックで `open=false`。
 */
export function CommandCenterPopover({
  containerRef,
}: CommandCenterPopoverProps) {
  const popoverOpen = useBarStore(selectPopoverOpen);
  const setOpen = useBarStore((s) => s.setOpen);

  return (
    <AnimatedPopover
      open={popoverOpen}
      onClose={() => setOpen(false)}
      containerRef={containerRef}
      className="absolute left-0 right-0 top-full z-40 mt-1 overflow-hidden rounded-md border border-border bg-popover shadow-lg"
    >
      <CommandCenterResultList
        maxItemsPerSection={BAR_VISIBLE_LIMIT_PER_SECTION}
      />
    </AnimatedPopover>
  );
}

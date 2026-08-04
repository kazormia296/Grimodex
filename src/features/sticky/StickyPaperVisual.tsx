import type { CSSProperties, HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export interface StickyPaperVisualProps extends HTMLAttributes<HTMLDivElement> {
  paperColor?: string;
}

/**
 * Shared Map/editor paper shell. Editor overlays provide their own SVG mask
 * inside the shell; Map uses the existing skeuomorphic CSS treatment.
 */
export function StickyPaperVisual({
  paperColor,
  className,
  style,
  ...props
}: StickyPaperVisualProps) {
  const paperStyle = {
    ...(paperColor === undefined
      ? {}
      : ({ "--sticky-bg-light": paperColor } as CSSProperties)),
    ...style,
  } as CSSProperties;
  return (
    <div
      {...props}
      className={cn("sticky-paper", className)}
      style={paperStyle}
    />
  );
}

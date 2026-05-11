import * as React from "react";
import { cn } from "@/lib/utils";

interface CircularProgressProps extends React.SVGProps<SVGSVGElement> {
  /** Progress value 0–100. Values outside the range are clamped. */
  value: number;
  /** Diameter of the circle in px. */
  size?: number;
  /** Stroke width in px. */
  strokeWidth?: number;
  /** Tailwind class for the progress arc stroke. Defaults to `stroke-primary`. */
  strokeClass?: string;
  /** Render the inner percentage label. Defaults to true. */
  showLabel?: boolean;
  /** Override the inner label content (e.g. icon or custom string). */
  labelClassName?: string;
}

/**
 * Compact circular progress indicator. Used to visualize ratios like "context
 * window usage" inline next to a numeric label.
 *
 * - The track (background ring) uses `stroke-muted`.
 * - The progress arc uses the `strokeClass` (default `stroke-primary`) so
 *   callers can swap in tier-based colors (amber / destructive) without
 *   reaching into the component.
 * - Internally the SVG is rotated -90° so the arc starts at 12 o'clock.
 */
export function CircularProgress({
  value,
  size = 32,
  strokeWidth = 4,
  strokeClass = "stroke-primary",
  showLabel = true,
  labelClassName,
  className,
  ...props
}: CircularProgressProps) {
  const clamped = Math.min(100, Math.max(0, value));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (clamped / 100) * circumference;

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className={cn("-rotate-90", className)}
        aria-hidden={!showLabel}
        {...props}
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={strokeWidth}
          fill="none"
          className="stroke-muted"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={strokeWidth}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className={cn(
            "transition-[stroke-dashoffset] duration-500",
            strokeClass,
          )}
        />
      </svg>
      {showLabel && (
        <div
          className={cn(
            "absolute inset-0 flex items-center justify-center text-[10px] font-medium tabular-nums",
            labelClassName,
          )}
        >
          {Math.round(clamped)}%
        </div>
      )}
    </div>
  );
}

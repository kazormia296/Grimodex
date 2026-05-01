import { cn } from "@/lib/utils";
import type { SceneStatus } from "./treeStore";

const STATUS_BG: Record<SceneStatus, string> = {
  outline: "bg-[#888780]/20 text-[#888780]",
  draft: "bg-[#EF9F27]/20 text-[#EF9F27]",
  complete: "bg-[#1D9E75]/20 text-[#1D9E75]",
  revision: "bg-[#7F77DD]/20 text-[#7F77DD]",
  final: "bg-[#1D9E75]/20 text-[#1D9E75]",
};

const STATUS_DOT: Record<SceneStatus, string> = {
  outline: "bg-[#888780]",
  draft: "bg-[#EF9F27]",
  complete: "bg-[#1D9E75]",
  revision: "bg-[#7F77DD]",
  final: "bg-[#1D9E75]",
};

export { STATUS_DOT as STATUS_BADGE_DOT };
export { type SceneStatus };

const STATUS_LABELS: Record<SceneStatus, string> = {
  outline: "Outline",
  draft: "Draft",
  complete: "Complete",
  revision: "Revision",
  final: "Final",
};

interface StatusBadgeProps {
  status: string | null;
  iconOnly?: boolean;
  className?: string;
}

export function StatusBadge({ status, iconOnly, className }: StatusBadgeProps) {
  const s = (status as SceneStatus) ?? "outline";
  const label = STATUS_LABELS[s] ?? s;

  if (iconOnly) {
    return (
      <span
        title={label}
        className={cn(
          "inline-flex h-3 w-3 shrink-0 rounded-full",
          STATUS_DOT[s] ?? STATUS_DOT.outline,
          className,
        )}
      />
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
        STATUS_BG[s] ?? STATUS_BG.outline,
        className,
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          STATUS_DOT[s] ?? STATUS_DOT.outline,
        )}
      />
      {label}
    </span>
  );
}

export { STATUS_LABELS };

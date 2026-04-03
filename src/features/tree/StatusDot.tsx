import { cn } from "@/lib/utils";
import type { SceneStatus } from "./treeStore";

const STATUS_STYLES: Record<SceneStatus, string> = {
  outline: "bg-[#888780]",
  draft: "bg-[#EF9F27]",
  complete: "bg-[#1D9E75]",
  revision: "bg-[#7F77DD]",
  final: "bg-[#1D9E75] after:content-['✓']",
};

const STATUS_LABELS: Record<SceneStatus, string> = {
  outline: "Outline",
  draft: "Draft",
  complete: "Complete",
  revision: "Revision",
  final: "Final",
};

interface StatusDotProps {
  status: string | null;
  onClick?: (e: React.MouseEvent) => void;
  className?: string;
}

export function StatusDot({ status, onClick, className }: StatusDotProps) {
  const s = (status as SceneStatus) ?? "outline";

  return (
    <button
      type="button"
      title={STATUS_LABELS[s] ?? s}
      onClick={onClick}
      className={cn(
        "flex h-3 w-3 flex-shrink-0 items-center justify-center rounded-full text-[7px] font-bold text-white",
        STATUS_STYLES[s] ?? STATUS_STYLES.outline,
        onClick && "cursor-pointer hover:opacity-80",
        className,
      )}
    />
  );
}

export { STATUS_LABELS, type SceneStatus };

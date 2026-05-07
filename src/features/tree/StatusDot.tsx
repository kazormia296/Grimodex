import { forwardRef } from "react";
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

interface StatusDotProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  status: string | null;
}

export const StatusDot = forwardRef<HTMLButtonElement, StatusDotProps>(
  function StatusDot({ status, className, onClick, ...rest }, ref) {
    const s = (status as SceneStatus) ?? "outline";
    return (
      <button
        ref={ref}
        type="button"
        title={STATUS_LABELS[s] ?? s}
        onClick={onClick}
        className={cn(
          "flex h-3 w-3 flex-shrink-0 items-center justify-center rounded-full text-[7px] font-bold text-white",
          STATUS_STYLES[s] ?? STATUS_STYLES.outline,
          onClick && "cursor-pointer hover:opacity-80",
          className,
        )}
        {...rest}
      />
    );
  },
);

export { STATUS_LABELS, type SceneStatus };

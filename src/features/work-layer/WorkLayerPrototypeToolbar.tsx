import { cn } from "@/lib/utils";

import {
  WORK_LAYER_PROTOTYPE_MODES,
  type WorkLayerPrototypeMode,
} from "./workLayerPrototype";

interface WorkLayerPrototypeToolbarProps {
  readonly mode: WorkLayerPrototypeMode;
  readonly onModeChange: (mode: WorkLayerPrototypeMode) => void;
}

export function WorkLayerPrototypeToolbar({
  mode,
  onModeChange,
}: WorkLayerPrototypeToolbarProps) {
  return (
    <nav
      aria-label="Work Layer prototype states"
      className="flex flex-wrap items-center gap-1 border-b border-white/20 bg-zinc-950 px-3 py-2 font-mono text-zinc-300"
    >
      <span className="mr-1 text-[8px] tracking-[0.16em] text-zinc-500">
        WORK LAYER PROTOTYPE
      </span>
      {WORK_LAYER_PROTOTYPE_MODES.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-pressed={mode === item.id}
          onClick={() => onModeChange(item.id)}
          className={cn(
            "rounded-sm border border-zinc-600 px-2 py-1 text-[8px] tracking-[0.1em] hover:border-zinc-200 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white",
            mode === item.id && "border-white bg-white text-zinc-950",
          )}
        >
          {item.label}
        </button>
      ))}
      <span className="ml-auto text-[8px] tracking-[0.12em] text-zinc-500">
        ESC = 一段戻る
      </span>
    </nav>
  );
}

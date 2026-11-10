import { useState, type ReactNode } from "react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { ChevronRight } from "lucide-react";
import {
  CSS_DURATIONS,
  DURATIONS,
  EASINGS,
  useReducedMotion,
} from "@/lib/animation";
import { cn } from "@/lib/utils";

interface CollapsibleSectionProps {
  /** セクション見出しのラベル。 */
  title: ReactNode;
  /** 開いているか。 */
  open: boolean;
  /** 見出しクリックで開閉をトグルする。 */
  onToggle: () => void;
  /** 見出し右端に並べる操作(sort select・loading スピナー等)。 */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * パネル内の折りたたみ可能セクション。Scene Context パネルが Codex と
 * 関連過去シーンを縦積みするために使う汎用部品。
 *
 * 注意: `data-panel-header` は **付けない**。パネル最大化/右クリックメニューの
 * ジェスチャはパネル全体の `PanelHeader` だけが持つ。セクション見出しに付けると
 * `PanelChromeMenu` のダブルクリック最大化が二重発火する。
 */
export function CollapsibleSection({
  title,
  open,
  onToggle,
  actions,
  children,
  className,
}: CollapsibleSectionProps) {
  return (
    <div className={cn("flex flex-col", className)}>
      <div className="flex items-center gap-1 px-2 py-1">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex flex-1 items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
        >
          <ChevronRight
            className={cn(
              "size-3 shrink-0 transition-transform ease-out",
              open && "rotate-90",
            )}
            style={{ transitionDuration: CSS_DURATIONS.fast }}
            aria-hidden="true"
          />
          <span className="truncate">{title}</span>
        </button>
        {actions != null && (
          <div className="flex shrink-0 items-center gap-1">{actions}</div>
        )}
      </div>
      <AnimatePresence initial={false}>
        {open && <CollapsibleBody key="body">{children}</CollapsibleBody>}
      </AnimatePresence>
    </div>
  );
}

/**
 * 中身の開閉。ツリーの開閉（TreeNodeItem）と同じく、高さと opacity を
 * DURATIONS.normal で動かす。中身を切るのは動いている間だけ（開いたままの
 * 中身のフォーカスの枠を切らない）。閉じる途中の中身は操作できない。
 */
function CollapsibleBody({ children }: { children: ReactNode }) {
  const reduced = useReducedMotion();
  const isPresent = useIsPresent();
  const [animating, setAnimating] = useState(false);
  return (
    <motion.div
      data-collapsible-body
      inert={isPresent ? undefined : true}
      aria-hidden={isPresent ? undefined : true}
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{
        duration: reduced ? 0 : DURATIONS.normal,
        ease: EASINGS.easeOut,
      }}
      onAnimationStart={() => setAnimating(true)}
      // 外すのは開く動き（height: auto）が終わったときだけ。閉じる途中で
      // 開き直すと、止まった閉じる動きの完了の通知が後から届くことがある。
      onAnimationComplete={(definition) => {
        if (
          typeof definition === "object" &&
          definition !== null &&
          (definition as { height?: unknown }).height === "auto"
        ) {
          setAnimating(false);
        }
      }}
      style={{ overflow: animating || !isPresent ? "hidden" : undefined }}
    >
      {children}
    </motion.div>
  );
}

import {
  useCallback,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { CSS_EASINGS, DURATIONS, EASINGS, TAB_MOTION } from "@/lib/animation";
import { cn } from "@/lib/utils";

/**
 * エディタのタブ 1 つの外側。開く・閉じるの動き（ばね）。
 *
 * 閉じる間（幅を 0 へ縮める間）だけ中身を切る。開いている間に切ると、隣の
 * タブから滑ってくるアクティブの下線が、自分の箱で切れて端から伸びて見える。
 */
export function TabPresence({
  animateIn,
  instantExit,
  reduced,
  children,
}: {
  /** 開くときに動かすか（プレビューのタブの置き換えでは動かさない）。 */
  animateIn: boolean;
  /** 閉じる動きを 0 秒にする（プレビューの置き換え・動きを減らす）。 */
  instantExit: boolean;
  reduced: boolean;
  children: ReactNode;
}) {
  const isPresent = useIsPresent();
  return (
    <motion.div
      className="flex-shrink-0"
      data-tab-exiting={isPresent ? undefined : "true"}
      initial={
        !reduced && animateIn ? { opacity: 0, x: -8, scale: 0.92 } : false
      }
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={
        instantExit
          ? {
              opacity: 0,
              width: 0,
              scale: 0.92,
              transition: { duration: 0 },
            }
          : { opacity: 0, width: 0, scale: 0.92 }
      }
      transition={reduced ? { duration: 0 } : TAB_MOTION.spring}
      style={{ overflow: isPresent ? undefined : "hidden" }}
    >
      {children}
    </motion.div>
  );
}

/**
 * アクティブのタブの下線。グループごとに 1 本で、アクティブが移ると前の
 * タブの位置から滑る（layoutId）。測るのはアクティブが変わった時だけ
 * （TabBar は入力のたびに re-render されるので、毎回は測らない）。
 * グループをまたいでは滑らせない（layoutId に groupIndex を含める）。
 * TabBar を mount し直した（プロジェクトの切替、分割の開き直しなど）ときも
 * 古い位置から滑らせない（layoutId に TabBar ごとの scope を含める）。
 */
export function TabActiveIndicator({
  groupIndex,
  scope,
  activeTabId,
  reduced,
}: {
  groupIndex: number;
  /** TabBar の mount ごとの id（useId）。 */
  scope: string;
  activeTabId: string;
  reduced: boolean;
}) {
  return (
    <motion.span
      aria-hidden
      data-editor-tab-active-indicator
      layoutId={`editor-tab-active:${groupIndex}:${scope}`}
      layoutDependency={activeTabId}
      className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-primary"
      transition={reduced ? { duration: 0 } : TAB_MOTION.indicator}
    />
  );
}

/**
 * ドラッグ中に落とす位置を示す線。タブの上に重ねる（枠線で示すとタブの中身が
 * 1〜2px ずれる）。出入りは短くフェードする。
 */
export function TabDropIndicator({
  side,
  reduced,
}: {
  side: "left" | "right" | null;
  reduced: boolean;
}) {
  return (
    <AnimatePresence>
      {side && (
        <motion.span
          key={side}
          aria-hidden
          data-tab-drop-indicator={side}
          className={cn(
            "pointer-events-none absolute inset-y-0 z-10 w-0.5 bg-primary",
            side === "left" ? "left-0" : "-right-px",
          )}
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{
            opacity: 0,
            transition: { duration: reduced ? 0 : DURATIONS.fast },
          }}
          transition={{ duration: DURATIONS.fast, ease: EASINGS.easeOut }}
        />
      )}
    </AnimatePresence>
  );
}

const FLIP_ANIMATION_ID = "editor-tab-flip";

/**
 * タブの並べ替えの FLIP。ドロップの処理で reorderTab を呼ぶ直前に、返り値の
 * 関数で今の位置を控える。次の commit で新しい位置を測り、動いたタブを
 * 旧位置から滑らせる。測るのは控えた直後の 1 回だけ（入力ごとの re-render では
 * 測らない）。
 *
 * 動かすのは内側の [data-editor-tab-id]（外側の TabPresence は開く動きの x と
 * scale を持つので競合する）。位置はスクロール容器の中身の基準で控えるので、
 * タブ列をスクロールしていてもずれない。
 */
export function useTabReorderFlip(
  containerRef: RefObject<HTMLElement | null>,
  reduced: boolean,
): () => void {
  const beforeRef = useRef<Map<string, number> | null>(null);

  useLayoutEffect(() => {
    const before = beforeRef.current;
    if (!before) return;
    beforeRef.current = null;
    const container = containerRef.current;
    if (!container) return;
    for (const el of tabElements(container)) {
      const from = before.get(el.dataset.editorTabId!);
      if (from === undefined) continue;
      cancelFlip(el);
      const dx = from - contentLeft(el, container);
      if (Math.abs(dx) < 1) continue;
      el.animate(
        [{ transform: `translateX(${dx}px)` }, { transform: "none" }],
        {
          id: FLIP_ANIMATION_ID,
          duration: TAB_MOTION.reorderS * 1000,
          easing: CSS_EASINGS.easeOut,
        },
      );
    }
  });

  return useCallback(() => {
    const container = containerRef.current;
    if (!container || reduced || typeof container.animate !== "function") {
      return;
    }
    // 見えている位置（進行中の FLIP の分を含む）から次の FLIP を始める。
    const before = new Map<string, number>();
    for (const el of tabElements(container)) {
      before.set(el.dataset.editorTabId!, contentLeft(el, container));
    }
    beforeRef.current = before;
    // 並びが変わらなかった（commit が無かった）ときに、後の無関係な commit で
    // 古い位置から動かさない。
    requestAnimationFrame(() => {
      if (beforeRef.current === before) beforeRef.current = null;
    });
  }, [containerRef, reduced]);
}

/** 閉じる途中のタブは数えない。 */
function tabElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>("[data-editor-tab-id]"),
  ).filter((el) => !el.closest("[data-tab-exiting]"));
}

function contentLeft(el: HTMLElement, container: HTMLElement): number {
  return (
    el.getBoundingClientRect().left -
    container.getBoundingClientRect().left +
    container.scrollLeft
  );
}

function cancelFlip(el: HTMLElement) {
  if (typeof el.getAnimations !== "function") return;
  for (const animation of el.getAnimations()) {
    if (animation.id === FLIP_ANIMATION_ID) animation.cancel();
  }
}

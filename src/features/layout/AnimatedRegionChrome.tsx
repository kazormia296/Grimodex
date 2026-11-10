import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  usePresence,
  type AnimationPlaybackControls,
} from "motion/react";
import { cn } from "@/lib/utils";
import { EASINGS, LAYOUT_MOTION, useReducedMotion } from "@/lib/animation";
import {
  REGION_DRAWER,
  useLayoutMotionReady,
  type RegionChromeId,
} from "./layoutAnimation";
import { slotsKeptWhileClosing } from "./layoutStateUtils";
import { useLayoutStore } from "./layoutStore";

/** 閉じる間、カードを center の上に重ねる。 */
const EXITING_Z_INDEX = 20;

interface AnimatedRegionChromeProps {
  region: RegionChromeId;
  open: boolean;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/**
 * サイドと下のリージョンの引き出し（案 A）。
 *
 * grid の列・行は即時に確定する（毎フレームの grid 補間はしない。1bc28383）。
 * 開くときはリージョンのカードを stripe 側の辺から LAYOUT_MOTION.regionEnter で
 * 滑り出させ、閉じるときは直前の寸法のまま center の上に重ねて
 * LAYOUT_MOTION.regionExit で stripe へ滑り込ませる。本文の折り返し直しは
 * 1 回だけ（列が変わった時）で、本文そのものは動かない。
 *
 * 閉じる間は中身を残す（RegionContent が useIsPresent で直前の slot を保つ）。
 * ただし閉じた理由が panel の移動（DnD・「移動先」）なら、移動先でも同じ panel が
 * mount されるので、動かさずにすぐ外す。
 */
export const AnimatedRegionChrome = memo(function AnimatedRegionChrome({
  region,
  open,
  children,
  className,
  style,
}: AnimatedRegionChromeProps) {
  const reduced = useReducedMotion();
  const initialized = useLayoutStore((state) => state.initialized);
  const slots = useLayoutStore((state) => state.layout.regions[region].slots);
  // 開いている間の slot を控える。閉じた瞬間の store では active が消えている。
  const openSlotsRef = useRef(slots);
  if (open) openSlotsRef.current = slots;
  // initializeLayout() と同じ render で閉じた region が開く場合、その enter は
  // ユーザー操作ではなく起動 hydration。最終状態を静的に表示し、初期化完了後の
  // toggle だけをアニメーションする。ref は次回の open render で効けばよいので、
  // readiness 更新自体による余分な render は不要。
  const animationReadyRef = useRef(initialized);
  useEffect(() => {
    if (initialized) animationReadyRef.current = true;
  }, [initialized]);
  // 最初の render で開いているカードは動かさない（AnimatePresence の
  // initial={false} と同じ。LayoutShell の mount し直しも含む）。
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
  }, []);
  const motionReady = useLayoutMotionReady();
  const animateEntry =
    !reduced &&
    animationReadyRef.current &&
    mountedRef.current &&
    motionReady();

  return (
    <AnimatePresence initial={false}>
      {open && (
        <RegionDrawer
          key={`${region}-chrome`}
          region={region}
          className={className}
          style={style}
          animateEntry={animateEntry}
          openSlotsRef={openSlotsRef}
        >
          {children}
        </RegionDrawer>
      )}
    </AnimatePresence>
  );
});

interface RegionDrawerProps {
  region: RegionChromeId;
  className?: string;
  style?: CSSProperties;
  animateEntry: boolean;
  openSlotsRef: RefObject<
    ReadonlyArray<{ panels: ReadonlyArray<string>; activePanel: string | null }>
  >;
  children: ReactNode;
}

function RegionDrawer({
  region,
  className,
  style,
  animateEntry,
  openSlotsRef,
  children,
}: RegionDrawerProps) {
  const [isPresent, safeToRemove] = usePresence();
  const reduced = useReducedMotion();
  const drawer = REGION_DRAWER[region];
  const windowRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  // 開いている間のカードの寸法。閉じた commit では列が 0 になっていて測れない。
  const sizeRef = useRef<{ width: number; height: number } | null>(null);
  const presentRef = useRef(isPresent);
  const exitingRef = useRef(false);
  const offset = useMotionValue(0);
  const controlsRef = useRef<AnimationPlaybackControls | null>(null);
  const [sliding, setSliding] = useState(animateEntry);

  const distanceOf = (size: { width: number; height: number } | null) =>
    size ? (drawer.axis === "x" ? size.width : size.height) : 0;

  useLayoutEffect(() => {
    presentRef.current = isPresent;
  }, [isPresent]);

  // 開いている間の寸法を控え続ける（splitter のリサイズにも追従する）。
  useLayoutEffect(() => {
    const el = windowRef.current;
    if (!el) return;
    const record = () => {
      if (!presentRef.current) return;
      // 最大化中はリージョンが全面に伸びている。閉じる動きは通常の寸法で行う。
      if (useLayoutStore.getState().maximizedPanelId !== null) return;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        sizeRef.current = { width: rect.width, height: rect.height };
      }
    };
    record();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(record);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 開く: stripe 側に引いた位置から滑り出す。
  useLayoutEffect(() => {
    if (!animateEntry) return;
    const distance = distanceOf(sizeRef.current);
    if (distance <= 0) {
      setSliding(false);
      return;
    }
    const from = drawer.sign * distance;
    offset.jump(from);
    // motion の描画は次の frame なので、最初の paint で全開に見えないよう直接置く。
    if (cardRef.current) {
      cardRef.current.style.transform =
        drawer.axis === "x" ? `translateX(${from}px)` : `translateY(${from}px)`;
    }
    const controls = animate(offset, 0, {
      duration: LAYOUT_MOTION.regionEnter,
      ease: EASINGS.easeOut,
      onComplete: () => setSliding(false),
    });
    controlsRef.current = controls;
    return () => controls.stop();
    // mount 時の 1 回だけ。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isPresent) {
      if (!exitingRef.current) return;
      // 閉じる途中で開き直した: 今の位置から開いた位置へ続ける（巻き戻さない）。
      exitingRef.current = false;
      controlsRef.current?.stop();
      if (reduced) {
        offset.jump(0);
        setSliding(false);
        return;
      }
      setSliding(true);
      controlsRef.current = animate(offset, 0, {
        duration: LAYOUT_MOTION.regionEnter,
        ease: EASINGS.easeOut,
        onComplete: () => setSliding(false),
      });
      return;
    }

    exitingRef.current = true;
    controlsRef.current?.stop();
    const distance = distanceOf(sizeRef.current);
    // RegionContent と同じ基準。残す slot が無ければ（panel が移った）すぐ外す。
    const keepContent =
      slotsKeptWhileClosing(
        openSlotsRef.current ?? [],
        useLayoutStore.getState().layout.regions[region].slots,
      ).length > 0;
    if (reduced || distance <= 0 || !keepContent) {
      safeToRemove?.();
      return;
    }
    controlsRef.current = animate(offset, drawer.sign * distance, {
      duration: LAYOUT_MOTION.regionExit,
      ease: EASINGS.easeOut,
      onComplete: () => safeToRemove?.(),
    });
    // isPresent の変化だけで動く。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPresent]);

  useEffect(() => () => controlsRef.current?.stop(), []);

  const exitSize = isPresent ? null : sizeRef.current;
  // 滑っている間だけ窓を掛ける。開き直しの render では effect より先に
  // 描かれるので exitingRef も見る。
  const clipped = sliding || !isPresent || exitingRef.current;
  const windowStyle: CSSProperties = {
    ...style,
    ...(clipped ? { clipPath: drawer.clip } : null),
    ...(exitSize
      ? {
          position: "absolute",
          ...drawer.exitAnchor,
          width: exitSize.width,
          height: exitSize.height,
          zIndex: EXITING_Z_INDEX,
          pointerEvents: "none",
        }
      : null),
  };

  return (
    <div
      ref={windowRef}
      data-animated-region={region}
      data-exiting={isPresent ? undefined : "true"}
      aria-hidden={isPresent ? undefined : true}
      inert={isPresent ? undefined : true}
      className={cn(
        "h-full w-full min-h-0 min-w-0 overflow-visible",
        className,
      )}
      style={windowStyle}
    >
      <motion.div
        ref={cardRef}
        className="flex h-full w-full min-h-0 min-w-0 flex-col"
        style={drawer.axis === "x" ? { x: offset } : { y: offset }}
      >
        {children}
      </motion.div>
    </div>
  );
}

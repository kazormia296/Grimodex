import {
  createContext,
  memo,
  Suspense,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { animate, motion } from "motion/react";
import { EASINGS, LAYOUT_MOTION, useReducedMotion } from "@/lib/animation";
import type { ToolWindowPanelId } from "./layoutTypes";
import { chromeEnterTransition, chromeExitTransition } from "./layoutAnimation";
import { PANEL_COMPONENT_MAP } from "./panelComponents";
import { PanelChromeMenu } from "./PanelChromeMenu";
import { PanelLoadingSkeleton } from "./PanelLoadingSkeleton";

interface AnimatedSlotPanelProps {
  panelId: ToolWindowPanelId | null;
  /** Current panel-id list registered for this slot. Used to drop keepalive
   *  entries when a panel is moved away to another slot/region, so the source
   *  slot doesn't keep a hidden zombie instance running. */
  slotPanels: readonly ToolWindowPanelId[];
  /**
   * 切替で入る側を寄せる向き。stripe のアイコンが並ぶ向きに揃える
   * （左右のリージョンは縦、下と center は横）。
   */
  shiftAxis?: "x" | "y";
}

/**
 * Crossfade with per-slot keepalive: every panel that has ever been shown in
 * this slot stays mounted (faded out + inert) so subsequent switches skip the
 * unmount/remount cost — which was the main source of the "もたつき" felt on
 * same-slot panel swaps. Enter/exit run in parallel via opacity instead of
 * AnimatePresence `mode="wait"` (which would serialize exit→enter ≈ 0.35s).
 *
 * `data-slot-panel` is rendered only on the active panel so
 * PanelHighlightOverlay's `[data-slot-panel="${id}"]` query and
 * useFocusRects' MutationObserver continue to see the stack as if only the
 * visible panel exists — toggling that attribute on/off is what triggers
 * onboarding re-measure now that nodes don't enter/leave the DOM.
 *
 * The keepalive layers themselves never transform: the stable parent slot owns
 * the Glass/card compositing layer, and these layers only crossfade opacity.
 * Only the inner wrapper of the entering panel shifts by
 * LAYOUT_MOTION.panelShiftPx (from the side of the stripe icon order) and
 * settles back to `transform: none`.
 *
 * - 同じ slot で初めて表示するパネルも、層を 0 からフェードインする（slot の
 *   mount と同時の層は動かさない。slot の出入りはリージョンや slot の動きが担う）。
 * - lazy パネルの読み込み中は skeleton を見せ、読み終えた中身を
 *   LAYOUT_MOTION.contentIn でフェードインする。
 */
export const AnimatedSlotPanel = memo(function AnimatedSlotPanel({
  panelId,
  slotPanels,
  shiftAxis = "x",
}: AnimatedSlotPanelProps) {
  const reduced = useReducedMotion();

  const seenRef = useRef<Set<ToolWindowPanelId>>(new Set());
  const mountedRef = useRef(false);
  const prevActiveRef = useRef<ToolWindowPanelId | null>(panelId);
  // 切替で入る側の向き（-1: 前のアイコンから、1: 後ろのアイコンから）。
  // render の間に決め、層の effect が読む。
  const shiftSignRef = useRef<Partial<Record<ToolWindowPanelId, 1 | -1>>>({});
  // Drop entries that are no longer in this slot — happens when the user
  // drags the panel out to another slot/region. Without this prune the
  // source slot keeps rendering a hidden instance forever.
  const allowed = new Set(slotPanels);
  for (const id of seenRef.current) {
    if (!allowed.has(id)) seenRef.current.delete(id);
  }
  if (panelId) seenRef.current.add(panelId);

  const prevActive = prevActiveRef.current;
  if (panelId && prevActive && prevActive !== panelId) {
    const from = slotPanels.indexOf(prevActive);
    const to = slotPanels.indexOf(panelId);
    if (from >= 0 && to >= 0) {
      shiftSignRef.current[panelId] = to > from ? 1 : -1;
    }
  }
  prevActiveRef.current = panelId;

  useEffect(() => {
    mountedRef.current = true;
  }, []);

  if (seenRef.current.size === 0) return null;

  return (
    <>
      {Array.from(seenRef.current).map((id) => {
        const Component = PANEL_COMPONENT_MAP[id];
        if (!Component) return null;
        const isActive = id === panelId;
        return (
          // PanelChromeMenu はヘッダー帯 (data-panel-header) 限定の
          // 右クリックメニュー + dblclick 最大化をイベント委譲で付ける。
          // 非アクティブ層は inert なので実質アクティブ panel のみ反応する。
          <PanelChromeMenu key={id} panelId={id}>
            <motion.div
              data-slot-panel={isActive ? id : undefined}
              data-animated-slot-panel={id}
              aria-hidden={!isActive}
              inert={!isActive}
              className="absolute inset-0 flex min-h-0 min-w-0 flex-col overflow-hidden"
              // slot の mount と同時の層はそのまま見せる。後から足された層は
              // 0 からフェードインする（初めてのパネルも切替として見せる）。
              initial={mountedRef.current && !reduced ? { opacity: 0 } : false}
              animate={{ opacity: isActive ? 1 : 0 }}
              transition={
                isActive
                  ? chromeEnterTransition(reduced)
                  : chromeExitTransition(reduced)
              }
            >
              <ShiftOnActivate
                id={id}
                isActive={isActive}
                axis={shiftAxis}
                reduced={reduced}
                shiftSignRef={shiftSignRef}
              >
                {/* lazy パネル (chronicle 等) の初回 import 中は skeleton を見せる。 */}
                <Suspense fallback={<PanelLoadingSkeleton />}>
                  <FadeInAfterSuspend reduced={reduced}>
                    <Component isActive={isActive} />
                  </FadeInAfterSuspend>
                </Suspense>
              </ShiftOnActivate>
            </motion.div>
          </PanelChromeMenu>
        );
      })}
    </>
  );
});

/**
 * 層の内側の wrapper。切替で active になったときだけ、stripe のアイコンの並びの
 * 側から LAYOUT_MOTION.panelShiftPx 寄せて戻す。終われば transform は none。
 */
function ShiftOnActivate({
  id,
  isActive,
  axis,
  reduced,
  shiftSignRef,
  children,
}: {
  id: ToolWindowPanelId;
  isActive: boolean;
  axis: "x" | "y";
  reduced: boolean;
  shiftSignRef: RefObject<Partial<Record<ToolWindowPanelId, 1 | -1>>>;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
  }, []);
  useEffect(() => {
    if (!isActive) return;
    const sign = shiftSignRef.current?.[id];
    if (shiftSignRef.current) delete shiftSignRef.current[id];
    const el = ref.current;
    if (!sign || reduced || !el) return;
    const from = sign * LAYOUT_MOTION.panelShiftPx;
    const controls = animate(
      el,
      axis === "x" ? { x: [from, 0] } : { y: [from, 0] },
      { duration: LAYOUT_MOTION.groupEnter, ease: EASINGS.easeOut },
    );
    return () => {
      controls.stop();
      el.style.transform = "";
    };
  }, [isActive, id, axis, reduced, shiftSignRef]);
  return (
    <div ref={ref} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <LayerMountedContext.Provider value={mountedRef}>
        {children}
      </LayerMountedContext.Provider>
    </div>
  );
}

/**
 * Suspense の中身。suspend してから読み終えた（層より後に mount された）ときだけ
 * LAYOUT_MOTION.contentIn でフェードインする。suspend しなかったときは層の
 * フェードに任せる。
 */
function FadeInAfterSuspend({
  reduced,
  children,
}: {
  reduced: boolean;
  children: ReactNode;
}) {
  const layerMountedRef = useContext(LayerMountedContext);
  const [fade] = useState(() => !!layerMountedRef?.current && !reduced);
  return (
    <motion.div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      initial={fade ? { opacity: 0 } : false}
      animate={{ opacity: 1 }}
      transition={{ duration: LAYOUT_MOTION.contentIn, ease: EASINGS.easeOut }}
    >
      {children}
    </motion.div>
  );
}

/**
 * Suspense の外側（ShiftOnActivate）が mount 済みかどうか。Suspense の中の
 * 初回の render は、suspend しなければ外側と同じ commit（effect の前なので
 * false）、suspend したら読み終えた後の render（true）になる。
 */
const LayerMountedContext = createContext<RefObject<boolean> | null>(null);

import { memo, Suspense, useRef } from "react";
import { motion } from "motion/react";
import { useReducedMotion } from "@/lib/animation";
import type { ToolWindowPanelId } from "./layoutTypes";
import { chromeEnterTransition, chromeExitTransition } from "./layoutAnimation";
import { PANEL_COMPONENT_MAP } from "./panelComponents";
import { PanelChromeMenu } from "./PanelChromeMenu";

interface AnimatedSlotPanelProps {
  panelId: ToolWindowPanelId | null;
  /** Current panel-id list registered for this slot. Used to drop keepalive
   *  entries when a panel is moved away to another slot/region, so the source
   *  slot doesn't keep a hidden zombie instance running. */
  slotPanels: readonly ToolWindowPanelId[];
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
 * Transform (translate/scale) is intentionally avoided: the stable parent slot
 * owns the Glass/card compositing layer, while these keepalive children only
 * crossfade opacity. This prevents panel swaps from rebuilding the backdrop
 * filter or flashing an opaque outgoing surface.
 */
export const AnimatedSlotPanel = memo(function AnimatedSlotPanel({
  panelId,
  slotPanels,
}: AnimatedSlotPanelProps) {
  const reduced = useReducedMotion();

  const seenRef = useRef<Set<ToolWindowPanelId>>(new Set());
  // Drop entries that are no longer in this slot — happens when the user
  // drags the panel out to another slot/region. Without this prune the
  // source slot keeps rendering a hidden instance forever.
  const allowed = new Set(slotPanels);
  for (const id of seenRef.current) {
    if (!allowed.has(id)) seenRef.current.delete(id);
  }
  if (panelId) seenRef.current.add(panelId);

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
              initial={false}
              animate={{ opacity: isActive ? 1 : 0 }}
              transition={
                isActive
                  ? chromeEnterTransition(reduced)
                  : chromeExitTransition(reduced)
              }
            >
              {/* lazy パネル (chronicle 等) の初回 import 中はパネル背景だけ見せる。 */}
              <Suspense
                fallback={<div className="min-h-0 flex-1" aria-hidden />}
              >
                <Component isActive={isActive} />
              </Suspense>
            </motion.div>
          </PanelChromeMenu>
        );
      })}
    </>
  );
});

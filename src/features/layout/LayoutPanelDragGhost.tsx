import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { CSS_EASINGS, LAYOUT_MOTION, useReducedMotion } from "@/lib/animation";
import { PANEL_ICON_MAP } from "./panelIcons";
import { useLayoutStore } from "./layoutStore";
import type { ToolWindowPanelId } from "./layoutTypes";

/** ゴーストが現れるときの出だしの大きさ。 */
const APPEAR_SCALE = 0.85;

interface Landing {
  panel: ToolWindowPanelId;
  x: number;
  y: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Follows the pointer during stripe / dropdown pointer-drag sessions.
 *
 * - 現れるときは DURATIONS.fast で拡大しながらフェードインする。
 * - ドロップ（またはキャンセル）すると、ゴーストは着地先の stripe のアイコンへ
 *   飛び、アイコンの大きさに縮んで消える（LAYOUT_MOTION.groupEnter）。着地した
 *   アイコンの弾みは useStripeIconFlip が担う。アイコンが無い（stripe から外した）
 *   ときはその場で消える。
 */
export function LayoutPanelDragGhost() {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const draggingPanel = useLayoutStore((s) => s.draggingPanel);
  const dragSource = useLayoutStore((s) => s.panelDragSource);
  const dragOffset = useLayoutStore((s) => s.panelDragOffset);
  const stripeSwapMode = useLayoutStore((s) => s.stripeSwapMode);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [landing, setLanding] = useState<Landing | null>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const appearedRef = useRef(false);
  // 着地の始点。最後に描いたゴーストの位置と panel。
  const lastRef = useRef<Landing | null>(null);

  const offsetX = dragOffset?.x ?? 14;
  const offsetY = dragOffset?.y ?? 14;
  const visible =
    !!draggingPanel &&
    dragSource === "pointer" &&
    stripeSwapMode !== "axis-locked" &&
    !!pos;

  useEffect(() => {
    if (!draggingPanel || dragSource !== "pointer") {
      setPos(null);
      return;
    }
    setLanding(null);

    function onMove(e: PointerEvent) {
      setPos({ x: e.clientX, y: e.clientY });
    }

    document.addEventListener("pointermove", onMove);
    return () => document.removeEventListener("pointermove", onMove);
  }, [dragSource, draggingPanel]);

  // ドラッグが終わった: 最後に見えていたゴーストを着地させる。
  useLayoutEffect(() => {
    if (draggingPanel) return;
    const last = lastRef.current;
    lastRef.current = null;
    appearedRef.current = false;
    if (last && !reduced) setLanding(last);
  }, [draggingPanel, reduced]);

  useLayoutEffect(() => {
    if (visible && draggingPanel && pos) {
      lastRef.current = {
        panel: draggingPanel,
        x: pos.x,
        y: pos.y,
        offsetX,
        offsetY,
      };
    } else if (draggingPanel && stripeSwapMode === "axis-locked") {
      // 同じ stripe 内の並べ替え（アイコンそのものが動く）では着地させない。
      lastRef.current = null;
    }
  });

  // 現れる。
  useLayoutEffect(() => {
    const el = ghostRef.current;
    if (!visible || !el || appearedRef.current) return;
    appearedRef.current = true;
    if (reduced || typeof el.animate !== "function") return;
    el.animate(
      [
        { opacity: 0, transform: `scale(${APPEAR_SCALE})` },
        { opacity: 1, transform: "none" },
      ],
      { duration: LAYOUT_MOTION.contentIn * 1000, easing: CSS_EASINGS.easeOut },
    );
  }, [visible, reduced]);

  // 着地する。
  useLayoutEffect(() => {
    const el = ghostRef.current;
    if (!landing || !el) return;
    if (typeof el.animate !== "function") {
      setLanding(null);
      return;
    }
    const from = el.getBoundingClientRect();
    const icon = document.querySelector<HTMLElement>(
      `[data-stripe-icon="${landing.panel}"]`,
    );
    const to = icon?.getBoundingClientRect();
    const keyframes: Keyframe[] =
      to && to.width > 0
        ? [
            { transform: "none", opacity: 1, borderRadius: "9999px" },
            {
              transform: `translate(${to.left + to.width / 2 - (from.left + from.width / 2)}px, ${
                to.top + to.height / 2 - (from.top + from.height / 2)
              }px) scale(${to.width / from.width}, ${to.height / from.height})`,
              opacity: 0,
              borderRadius: "9999px",
            },
          ]
        : [
            { transform: "none", opacity: 1 },
            { transform: `scale(${APPEAR_SCALE})`, opacity: 0 },
          ];
    const animation = el.animate(keyframes, {
      duration: LAYOUT_MOTION.groupEnter * 1000,
      easing: CSS_EASINGS.easeOut,
      fill: "forwards",
    });
    animation.onfinish = () => setLanding(null);
    return () => {
      animation.onfinish = null;
      animation.cancel();
    };
  }, [landing]);

  const shown: Landing | null = visible
    ? { panel: draggingPanel!, x: pos!.x, y: pos!.y, offsetX, offsetY }
    : landing;
  if (!shown) return null;

  const Icon = PANEL_ICON_MAP[shown.panel];

  return createPortal(
    <div
      ref={ghostRef}
      data-panel-drag-ghost
      data-landing={visible ? undefined : "true"}
      className={cn(
        "pointer-events-none fixed z-[9999] flex items-center gap-1.5 rounded-full",
        "border border-primary/40 bg-popover/95 px-2 py-1 shadow-lg backdrop-blur-sm",
      )}
      style={{
        left: shown.x - shown.offsetX,
        top: shown.y - shown.offsetY,
        transformOrigin: "center",
      }}
    >
      <Icon className="h-4 w-4 shrink-0 text-foreground" />
      <span className="max-w-[10rem] truncate text-xs text-foreground">
        {t(`layout.panel.${shown.panel}`)}
      </span>
    </div>,
    document.body,
  );
}

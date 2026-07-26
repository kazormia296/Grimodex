import type { EditorView } from "@tiptap/pm/view";
import { isReducedMotion } from "@/lib/gsap";
import { CSS_DURATIONS, CSS_EASINGS } from "@/lib/animation";

const FLASH_MS = parseFloat(CSS_DURATIONS.normal);

/**
 * キーボード swap 後に移動 unit を一瞬ハイライトする。
 * インライン FLIP の代わり（設計書 §操作モードB）。
 */
export function flashUnitHighlight(
  view: EditorView,
  from: number,
  to: number,
): void {
  if (isReducedMotion() || typeof view.dom.animate !== "function") return;

  const start = view.coordsAtPos(from);
  const end = view.coordsAtPos(to);
  const left = Math.min(start.left, end.left);
  const top = Math.min(start.top, end.top);
  const width = Math.max(start.right, end.right) - left;
  const height = Math.max(start.bottom, end.bottom) - top;

  const overlay = document.createElement("div");
  overlay.setAttribute("aria-hidden", "true");
  overlay.style.position = "fixed";
  overlay.style.left = `${left}px`;
  overlay.style.top = `${top}px`;
  overlay.style.width = `${Math.max(width, 2)}px`;
  overlay.style.height = `${Math.max(height, 2)}px`;
  overlay.style.pointerEvents = "none";
  overlay.style.background =
    "color-mix(in srgb, var(--primary) 18%, transparent)";
  overlay.style.borderRadius = "3px";
  overlay.style.zIndex = "9999";
  document.body.appendChild(overlay);

  overlay.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: FLASH_MS,
    easing: CSS_EASINGS.easeOut,
  }).onfinish = () => overlay.remove();
}

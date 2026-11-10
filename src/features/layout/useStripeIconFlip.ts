import { useLayoutEffect, useRef, type RefObject } from "react";
import { CSS_EASINGS, LAYOUT_MOTION, useReducedMotion } from "@/lib/animation";
import { useLayoutMotionReady } from "./layoutAnimation";
import { useLayoutStore } from "./layoutStore";

const FLIP_ANIMATION_ID = "stripe-icon-flip";
/** 新しく来たアイコンの出だしの大きさ。 */
const ARRIVE_SCALE = 0.6;

/**
 * stripe のアイコンが並び直したとき（slot の開閉で band が動く、パネルが
 * 移って詰まる、別の stripe から来る）、直前の位置から滑らせる FLIP。
 * 新しく来たアイコンは小さく弾んで現れる。位置は stripe の root 基準で控える
 * ので、stripe ごと動く（出現・ウィンドウの寸法）ときは反応しない。
 *
 * WAAPI で動かすので、アイコンの inline の transform（同じ stripe 内の並べ替えの
 * プレビュー）とは競合しない。並べ替えのプレビュー中は比べない。
 */
export function useStripeIconFlip(rootRef: RefObject<HTMLElement | null>) {
  const reduced = useReducedMotion();
  const motionReady = useLayoutMotionReady();
  const swapMode = useLayoutStore((s) => s.stripeSwapMode);
  const swapping = swapMode !== null;
  const layoutReplaceSeq = useLayoutStore((s) => s.layoutReplaceSeq);
  const maximized = useLayoutStore((s) => s.maximizedPanelId);
  const skipToken = `${layoutReplaceSeq}|${maximized ?? ""}`;
  const prevRef = useRef<Map<string, { x: number; y: number }> | null>(null);
  const prevSignatureRef = useRef("");
  const prevSkipRef = useRef(skipToken);
  const prevSwapModeRef = useRef(swapMode);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const skipChanged = prevSkipRef.current !== skipToken;
    prevSkipRef.current = skipToken;
    // 同じ stripe 内の並べ替え（axis-locked）のドロップ: プレビューで既に行き先に
    // 見えているので FLIP しない（掛けると元の位置へ巻き戻ってから滑る）。free の
    // ドラッグはプレビューのずらしが無いので、ドロップでも FLIP する。
    const swapDropped =
      prevSwapModeRef.current === "axis-locked" && swapMode === null;
    prevSwapModeRef.current = swapMode;
    if (!root) {
      prevRef.current = null;
      return;
    }
    const base = root.getBoundingClientRect();
    const next = new Map<
      string,
      { x: number; y: number; tx: number; ty: number }
    >();
    const elements = new Map<string, HTMLElement>();
    const signature: string[] = [];
    for (const el of root.querySelectorAll<HTMLElement>("[data-stripe-icon]")) {
      const id = el.dataset.stripeIcon;
      if (!id || el.offsetParent === null) continue;
      next.set(id, settledCenter(el, base));
      elements.set(id, el);
      signature.push(structureKey(el, id));
    }
    const prev = prevRef.current;
    prevRef.current = next;
    // 並び（どの band・折りたたみに居るか）が変わった commit だけ動かす。
    // splitter のドラッグ・ウィンドウの寸法・Zen の出入りで位置だけが変わった
    // ときは、控えるだけにする（アイコンが境界から遅れてついてこない）。
    const joined = signature.join(",");
    const structureChanged = prevSignatureRef.current !== joined;
    prevSignatureRef.current = joined;
    if (
      !prev ||
      prev.size === 0 ||
      !structureChanged ||
      skipChanged ||
      swapping ||
      swapDropped ||
      reduced ||
      !motionReady() ||
      typeof root.animate !== "function"
    ) {
      return;
    }

    for (const [id, pos] of next) {
      const el = elements.get(id)!;
      const before = prev.get(id);
      if (!before) {
        // 別の場所から来た（または新しく置かれた）アイコン。
        cancelFlip(el);
        el.animate(
          [
            { transform: `scale(${ARRIVE_SCALE})`, opacity: 0 },
            { transform: "none", opacity: 1 },
          ],
          {
            id: FLIP_ANIMATION_ID,
            duration: LAYOUT_MOTION.groupEnter * 1000,
            easing: CSS_EASINGS.settle,
          },
        );
        continue;
      }
      // 動いている途中なら、今見えている位置（直前の行き先＋進行中の分）から。
      const dx = before.x + pos.tx - pos.x;
      const dy = before.y + pos.ty - pos.y;
      if (Math.abs(before.x - pos.x) + Math.abs(before.y - pos.y) < 1) continue;
      cancelFlip(el);
      el.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
        {
          id: FLIP_ANIMATION_ID,
          duration: LAYOUT_MOTION.groupEnter * 1000,
          easing: CSS_EASINGS.easeOut,
        },
      );
    }
  });
}

/** アイコンの並びの鍵（どの band の、折りたたみの中か外か）。 */
function structureKey(el: HTMLElement, id: string): string {
  const band = el.closest<HTMLElement>("[data-drop-slot-id]")?.dataset
    .dropSlotId;
  const collapsed = el.closest("[data-stripe-collapsed-cluster]") ? "c" : "o";
  return `${id}@${band ?? ""}:${collapsed}`;
}

/**
 * アイコンの中心の位置（root 基準）。進行中の FLIP の分は差し引き、行き先の
 * 位置で控える（動いている途中の render で FLIP を作り直さない）。並べ替えの
 * プレビューの inline の translate は差し引かない（見えている位置から着地させる）。
 */
function settledCenter(
  el: HTMLElement,
  base: DOMRect,
): { x: number; y: number; tx: number; ty: number } {
  const r = el.getBoundingClientRect();
  let tx = 0;
  let ty = 0;
  if (runningFlip(el)) {
    const t = getComputedStyle(el).transform;
    if (t && t !== "none") {
      const m = new DOMMatrixReadOnly(t);
      tx = m.m41;
      ty = m.m42;
    }
  }
  return {
    x: r.left + r.width / 2 - base.left - tx,
    y: r.top + r.height / 2 - base.top - ty,
    tx,
    ty,
  };
}

function runningFlip(el: HTMLElement): boolean {
  if (typeof el.getAnimations !== "function") return false;
  return el
    .getAnimations()
    .some((a) => a.id === FLIP_ANIMATION_ID && a.playState === "running");
}

/** 進行中の FLIP を止める。中断は巻き戻さず、今の位置から次の FLIP を始める。 */
function cancelFlip(el: HTMLElement) {
  if (typeof el.getAnimations !== "function") return;
  for (const animation of el.getAnimations()) {
    if (animation.id === FLIP_ANIMATION_ID) animation.cancel();
  }
}

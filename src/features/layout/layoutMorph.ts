import { CSS_EASINGS, LAYOUT_MOTION } from "@/lib/animation";

/**
 * 外形のモーフの本体。useLayoutPresetCrossfade が動的に読む（起動時の graph に
 * 入れない）。外形は子を持たない absolute の div で、WAAPI で left/top/width/height
 * を動かす。
 */

export interface MorphRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 新しく現れる・消えるカードの外形の大きさ。 */
const APPEAR_SCALE = 0.96;

function box(r: MorphRect): Keyframe {
  return {
    left: `${r.left}px`,
    top: `${r.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  };
}

/** 外形のモーフを始める。外形を 1 つも出さなかったら false。 */
export function startMorph(
  layer: HTMLElement,
  base: DOMRect,
  rest: ReadonlyMap<string, MorphRect> | null,
  last: ReadonlyMap<string, MorphRect>,
): boolean {
  if (typeof layer.animate !== "function") return false;
  // 連打: 進行中の外形の今の位置を始点にする。
  const first = new Map<string, MorphRect>(rest ?? []);
  for (const outline of Array.from(layer.children) as HTMLElement[]) {
    const key = outline.dataset.layoutMorphOutline;
    // 直前のレイアウトに無いカード（消えかけの外形）は引き継がない。
    if (!key || !rest?.has(key)) continue;
    const r = outline.getBoundingClientRect();
    if (r.width >= 1 && r.height >= 1) {
      first.set(key, {
        left: r.left - base.left,
        top: r.top - base.top,
        width: r.width,
        height: r.height,
      });
    }
  }
  clearOutlines(layer);
  if (first.size === 0) return false;

  const total = LAYOUT_MOTION.morph + LAYOUT_MOTION.contentIn;
  const arrive = LAYOUT_MOTION.morph / total;
  const timing: KeyframeAnimationOptions = {
    duration: total * 1000,
    easing: "linear",
    fill: "forwards",
  };
  const keys = new Set([...first.keys(), ...last.keys()]);
  for (const key of keys) {
    const from = first.get(key);
    const to = last.get(key);
    const outline = document.createElement("div");
    outline.dataset.layoutMorphOutline = key;
    outline.className = "gx-panel";
    outline.style.position = "absolute";
    outline.style.transformOrigin = "center";
    layer.appendChild(outline);
    let keyframes: Keyframe[];
    if (from && to) {
      keyframes = [
        { ...box(from), opacity: 1, offset: 0, easing: CSS_EASINGS.easeOut },
        { ...box(to), opacity: 1, offset: arrive },
        { ...box(to), opacity: 0, offset: 1 },
      ];
    } else if (to) {
      keyframes = [
        {
          ...box(to),
          opacity: 0,
          transform: `scale(${APPEAR_SCALE})`,
          offset: 0,
          easing: CSS_EASINGS.easeOut,
        },
        { ...box(to), opacity: 1, transform: "none", offset: arrive },
        { ...box(to), opacity: 0, transform: "none", offset: 1 },
      ];
    } else {
      keyframes = [
        { ...box(from!), opacity: 1, offset: 0, easing: CSS_EASINGS.easeOut },
        {
          ...box(from!),
          opacity: 0,
          transform: `scale(${APPEAR_SCALE})`,
          offset: arrive,
        },
        {
          ...box(from!),
          opacity: 0,
          transform: `scale(${APPEAR_SCALE})`,
          offset: 1,
        },
      ];
    }
    const animation = outline.animate(keyframes, timing);
    animation.onfinish = () => outline.remove();
  }
  return true;
}

export function clearOutlines(layer: HTMLElement | null) {
  if (!layer) return;
  for (const outline of Array.from(layer.children)) {
    for (const animation of outline.getAnimations?.() ?? []) {
      animation.onfinish = null;
      animation.cancel();
    }
    outline.remove();
  }
}

import { useLayoutEffect, useRef, type RefObject } from "react";
import { useAnimationControls } from "motion/react";
import {
  CSS_EASINGS,
  EASINGS,
  LAYOUT_MOTION,
  useReducedMotion,
} from "@/lib/animation";
import { useLayoutStore } from "./layoutStore";

interface MorphRefs {
  /** 外形の位置の基準（LayoutShell の data-overlay-host）。 */
  hostRef: RefObject<HTMLElement | null>;
  /** 測るカードを持つ grid（data-layout-shell）。 */
  shellRef: RefObject<HTMLElement | null>;
  /** 外形を置く層（host の中、shell の上）。中身は命令的に足し引きする。 */
  layerRef: RefObject<HTMLElement | null>;
  /** Zen から出るときも同じ動きにする。 */
  zenMode?: boolean;
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 新しく現れる・消えるカードの外形の大きさ。 */
const APPEAR_SCALE = 0.96;

/**
 * 外形を控える対象。key はレイアウトをまたいで同じものを指す（panel id、
 * エディタ、各 stripe）。最大化・Zen で隠れているセル（inert）は数えない。
 */
const MORPH_TARGETS: ReadonlyArray<{
  selector: string;
  key: (el: HTMLElement) => string | undefined;
  card: (el: HTMLElement) => Element | null;
}> = [
  {
    selector: "[data-slot-panel]",
    key: (el) => el.dataset.slotPanel && `panel:${el.dataset.slotPanel}`,
    card: (el) => el.closest("[data-drop-slot], [data-center-segment]"),
  },
  {
    selector: '[data-center-segment-kind="editor"]',
    key: () => "editor",
    card: (el) => el,
  },
  {
    selector: "[data-stripe-root]",
    key: (el) => el.dataset.stripeRegion && `stripe:${el.dataset.stripeRegion}`,
    card: (el) => el,
  },
  {
    selector: "[data-center-stripe]",
    key: () => "stripe:center",
    card: (el) => el,
  },
];

function measureCards(shell: HTMLElement, base: DOMRect): Map<string, Rect> {
  const rects = new Map<string, Rect>();
  for (const target of MORPH_TARGETS) {
    for (const el of shell.querySelectorAll<HTMLElement>(target.selector)) {
      if (el.closest("[inert]")) continue;
      const key = target.key(el);
      const card = target.card(el);
      if (!key || !card || rects.has(key)) continue;
      const r = card.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      rects.set(key, {
        left: r.left - base.left,
        top: r.top - base.top,
        width: r.width,
        height: r.height,
      });
    }
  }
  return rects;
}

function box(r: Rect): Keyframe {
  return {
    left: `${r.left}px`,
    top: `${r.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  };
}

/**
 * ① レイアウトの一括の差し替え（プリセットの適用、最大化の解除と切替、Zen から
 * 出る）の動き。外形のモーフ。
 *
 * 新しいレイアウトは即時に確定する（grid は補間しない。1bc28383）。その上に
 * 中身のない外形（カードの面だけ）を重ね、各カードを旧矩形から新矩形へ
 * LAYOUT_MOTION.morph で動かす。外形は子を持たない absolute の div なので、
 * 毎フレームの layout は外形だけで済む。外形が着いたら、shell の中身を
 * LAYOUT_MOTION.contentIn でフェードインし、外形はその間に消える。新しく現れる
 * カードは外形が少し拡大しながら出て、消えるカードは縮みながら消える。
 *
 * 旧矩形はレイアウトが変わるたびに控える（store の変更は React の外で起きるので、
 * 変更前の DOM をイベント時点では測れない）。連打したときは進行中の外形の今の
 * 位置から次へつなぐ（巻き戻さない。以前の 300ms の throttle は廃止）。
 *
 * かつては activePresetId を motion.div の key に与えて subtree ごと remount
 * させていたが、配下の全 TipTap エディタ・パネルを破棄・再生成するため禁止
 * （f642ff39）。shell は mount を保ったまま AnimationControls で opacity だけを
 * 動かす。controls.set の DOM 反映は motion の frameloop (rAF) 経由で同フレームの
 * paint 直前なので、useLayoutEffect で set する。
 *
 * 最大化に入る（null→panel）ときと Zen に入るときは動かさない。そちらは
 * useZoomReveal の clip の展開が担う。
 */
export function useLayoutPresetCrossfade(refs?: MorphRefs) {
  const activePresetId = useLayoutStore((s) => s.activePresetId);
  const layoutReplaceSeq = useLayoutStore((s) => s.layoutReplaceSeq);
  const maximizedPanelId = useLayoutStore((s) => s.maximizedPanelId);
  const layoutLocked = useLayoutStore((s) => s.layoutLocked);
  const initialized = useLayoutStore((s) => s.initialized);
  const zenMode = refs?.zenMode ?? false;
  const reduced = useReducedMotion();
  const controls = useAnimationControls();
  const prevPresetRef = useRef(activePresetId);
  const prevSeqRef = useRef(layoutReplaceSeq);
  const prevZoomRef = useRef(maximizedPanelId);
  const prevZenRef = useRef(zenMode);
  const prevInitializedRef = useRef(initialized);
  const restRectsRef = useRef<Map<string, Rect> | null>(null);

  // 差し替えを検出したら動かす（下の「控える」effect より先に走る）。
  useLayoutEffect(() => {
    const presetChanged =
      prevPresetRef.current !== activePresetId ||
      prevSeqRef.current !== layoutReplaceSeq;
    const zoomChanged = prevZoomRef.current !== maximizedPanelId;
    const zoomEntering = zoomChanged && prevZoomRef.current === null;
    const zenExit = prevZenRef.current && !zenMode;
    const startupHydrationCompleted =
      !prevInitializedRef.current && initialized;
    prevPresetRef.current = activePresetId;
    prevSeqRef.current = layoutReplaceSeq;
    prevZoomRef.current = maximizedPanelId;
    prevZenRef.current = zenMode;
    prevInitializedRef.current = initialized;
    // 初期 hydration は画面上のユーザー操作ではないため演出対象から外し、
    // 保存済みレイアウトの最終状態をそのまま示す。loadPresets() が
    // initialized=false のまま preset id を先に読む二段階更新もここで吸収する。
    if (!initialized || startupHydrationCompleted) return;
    if (!presetChanged && !zenExit && (!zoomChanged || zoomEntering)) return;
    if (reduced || layoutLocked) return;

    const morphed = refs ? startMorph(refs, restRectsRef.current) : false;
    controls.set({ opacity: 0 });
    void controls.start({
      opacity: 1,
      transition: {
        // 外形が動いている間は中身を隠し、着いてからフェードインする。
        delay: morphed ? LAYOUT_MOTION.morph : 0,
        duration: LAYOUT_MOTION.contentIn,
        ease: EASINGS.easeOut,
      },
    });
    // refs は LayoutShell の ref で安定している。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activePresetId,
    layoutReplaceSeq,
    maximizedPanelId,
    zenMode,
    layoutLocked,
    initialized,
    reduced,
    controls,
  ]);

  // 次の差し替えの旧矩形として、確定したカードの矩形を控える。
  useLayoutEffect(() => {
    const host = refs?.hostRef.current;
    const shell = refs?.shellRef.current;
    if (!host || !shell) return;
    restRectsRef.current = measureCards(shell, host.getBoundingClientRect());
  });

  useLayoutEffect(() => {
    const layer = refs?.layerRef;
    return () => clearOutlines(layer?.current ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { crossfadeControls: controls };
}

/** 外形のモーフを始める。外形を 1 つも出さなかったら false。 */
function startMorph(refs: MorphRefs, rest: Map<string, Rect> | null): boolean {
  const host = refs.hostRef.current;
  const shell = refs.shellRef.current;
  const layer = refs.layerRef.current;
  if (!host || !shell || !layer || typeof layer.animate !== "function") {
    return false;
  }
  const base = host.getBoundingClientRect();
  // 連打: 進行中の外形の今の位置を始点にする。
  const first = new Map(rest ?? []);
  for (const outline of Array.from(layer.children) as HTMLElement[]) {
    const key = outline.dataset.layoutMorphOutline;
    if (!key) continue;
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

  const last = measureCards(shell, base);
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

function clearOutlines(layer: HTMLElement | null) {
  if (!layer) return;
  for (const outline of Array.from(layer.children)) {
    for (const animation of outline.getAnimations?.() ?? []) {
      animation.onfinish = null;
      animation.cancel();
    }
    outline.remove();
  }
}

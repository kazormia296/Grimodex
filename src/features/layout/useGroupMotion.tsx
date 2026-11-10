import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { CSS_EASINGS, LAYOUT_MOTION, useReducedMotion } from "@/lib/animation";
import { startClipReveal } from "./clipReveal";
import { useLayoutMotionReady } from "./layoutAnimation";

/** 畳む外形は slot より上（drop zone の z-30 より下）に重ねる。 */
const GHOST_Z_INDEX = 20;

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

type CollapseToward = "start" | "end" | "center";

/** 外形に引き継ぐ面の見た目（カードの class と Glass の属性）。 */
interface Surface {
  className: string;
  glassSurface?: string;
  editorGlass?: string;
}

interface Ghost {
  key: string;
  rect: Rect;
  toward: CollapseToward;
  surface: Surface;
}

interface GroupMotionOptions {
  containerRef: RefObject<HTMLElement | null>;
  /** 直下の子のうち、動かす単位（slot・segment）を選ぶ selector。 */
  itemSelector: string;
  /** 単位の id を読む data 属性名（`data-` を除く camelCase）。 */
  idAttribute: string;
  orientation: "vertical" | "horizontal";
  /** false の間は比べずに矩形だけ控える（閉じる途中、dormant など）。 */
  enabled: boolean;
  /**
   * 変わったら、その commit は比べずに矩形だけ控える。最大化の出入りや
   * プリセット切替のような一括の差し替えは別の動きが担う。
   */
  skipToken: unknown;
}

function relativeRect(el: Element, base: DOMRect): Rect {
  const r = el.getBoundingClientRect();
  return {
    left: r.left - base.left,
    top: r.top - base.top,
    width: r.width,
    height: r.height,
  };
}

/**
 * ⑤ グループ（リージョン内の slot、center の segment）の開閉。
 *
 * 寸法は即時に確定する（flex の配分は補間しない）。そのうえで:
 * - 開いた単位は、縮んだ隣との境界の側から clip で現れる。
 * - 閉じた単位は、直前の矩形に中身のない外形（カードの面だけ）を重ね、
 *   広がった隣と反対の側へ LAYOUT_MOTION.groupExit で畳む。中身は残さない
 *   （panel を余分に mount しない。エディタも外形だけを畳む）。
 * - 広がった隣は、直前の矩形から clip で広げる（clipReveal と同じ FLIP）。
 *
 * 矩形はコンテナ基準で控えるので、リージョンごと動く（引き出し）ときは反応
 * しない。返り値の ghosts をコンテナの中に描く。
 */
export function useGroupMotion({
  containerRef,
  itemSelector,
  idAttribute,
  orientation,
  enabled,
  skipToken,
}: GroupMotionOptions): ReactNode {
  const reduced = useReducedMotion();
  const motionReady = useLayoutMotionReady();
  const prevRef = useRef<{
    order: string[];
    rects: Map<string, Rect>;
    surfaces: Map<string, Surface>;
  } | null>(null);
  const prevSkipRef = useRef(skipToken);
  const cancelsRef = useRef(new Map<string, () => void>());
  const ghostSeqRef = useRef(0);
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const ghostCountRef = useRef(0);
  ghostCountRef.current = ghosts.length;

  // 依存配列を持たない: 毎 commit 後に矩形を控えて比べる。setGhosts は単位が
  // 消えた commit だけで呼ぶので、次の commit では差が無く連鎖しない。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const container = containerRef.current;
    const skipChanged = prevSkipRef.current !== skipToken;
    prevSkipRef.current = skipToken;
    if (!container) {
      prevRef.current = null;
      return;
    }
    const base = container.getBoundingClientRect();
    const elements = new Map<string, HTMLElement>();
    const order: string[] = [];
    const rects = new Map<string, Rect>();
    const surfaces = new Map<string, Surface>();
    for (const el of container.querySelectorAll<HTMLElement>(itemSelector)) {
      if (el.parentElement !== container) continue;
      const id = el.dataset[idAttribute];
      if (!id) continue;
      elements.set(id, el);
      order.push(id);
      rects.set(id, relativeRect(el, base));
      surfaces.set(id, surfaceOf(el));
    }
    const prev = prevRef.current;
    prevRef.current = { order, rects, surfaces };

    const animate =
      enabled &&
      !skipChanged &&
      !reduced &&
      motionReady() &&
      prev !== null &&
      prev.order.length > 0 &&
      order.length > 0;
    if (!animate) {
      // 比べない commit（最大化・Zen・一括の差し替え・動きを減らす）では、
      // 進行中の reveal と外形も止める（新しいレイアウトに古い clip を残さない）。
      if (skipChanged || !enabled || reduced) {
        for (const cancel of cancelsRef.current.values()) cancel();
        cancelsRef.current.clear();
        if (ghostCountRef.current > 0) setGhosts([]);
      }
      return;
    }

    const added = order.filter((id) => !prev.rects.has(id));
    const removed = prev.order.filter((id) => !rects.has(id));
    if (added.length === 0 && removed.length === 0) return;

    const size = (r: Rect) => (orientation === "vertical" ? r.height : r.width);
    const grew = (id: string) => {
      const before = prev.rects.get(id);
      const after = rects.get(id);
      return !!before && !!after && size(after) > size(before) + 1;
    };
    const shrank = (id: string) => {
      const before = prev.rects.get(id);
      const after = rects.get(id);
      return !!before && !!after && size(after) < size(before) - 1;
    };
    const toAbs = (r: Rect) =>
      new DOMRect(base.left + r.left, base.top + r.top, r.width, r.height);
    const reveal = (id: string, first: DOMRect) => {
      const el = elements.get(id);
      if (!el) return;
      cancelsRef.current.get(id)?.();
      cancelsRef.current.set(
        id,
        startClipReveal(el, first, LAYOUT_MOTION.groupEnter),
      );
    };

    // 広がった隣を直前の矩形から広げる。
    for (const id of order) {
      if (grew(id)) reveal(id, toAbs(prev.rects.get(id)!));
    }

    // 開いた単位は、縮んだ隣との境界の側から現れる。
    for (const id of added) {
      const index = order.indexOf(id);
      const after = rects.get(id)!;
      const fromEnd =
        !(index > 0 && shrank(order[index - 1])) &&
        index < order.length - 1 &&
        shrank(order[index + 1]);
      const first =
        orientation === "vertical"
          ? new DOMRect(
              base.left + after.left,
              base.top + after.top + (fromEnd ? after.height : 0),
              after.width,
              0,
            )
          : new DOMRect(
              base.left + after.left + (fromEnd ? after.width : 0),
              base.top + after.top,
              0,
              after.height,
            );
      reveal(id, first);
    }

    // 閉じた単位の外形を、広がった隣と反対の側へ畳む。
    const nextGhosts: Ghost[] = removed.map((id) => {
      const index = prev.order.indexOf(id);
      const before = prev.order
        .slice(0, index)
        .reverse()
        .find((x) => rects.has(x));
      const after = prev.order.slice(index + 1).find((x) => rects.has(x));
      const beforeGrew = !!before && grew(before);
      const afterGrew = !!after && grew(after);
      const toward: CollapseToward =
        beforeGrew && !afterGrew
          ? "end"
          : afterGrew && !beforeGrew
            ? "start"
            : "center";
      ghostSeqRef.current += 1;
      return {
        key: `${id}:${ghostSeqRef.current}`,
        rect: prev.rects.get(id)!,
        toward,
        surface: prev.surfaces.get(id) ?? { className: "gx-panel" },
      };
    });
    if (nextGhosts.length > 0)
      setGhosts((current) => [...current, ...nextGhosts]);
  });

  useLayoutEffect(() => {
    const cancels = cancelsRef.current;
    return () => {
      for (const cancel of cancels.values()) cancel();
      cancels.clear();
    };
  }, []);

  if (ghosts.length === 0) return null;
  return ghosts.map((ghost) => (
    <CollapsingGhost
      key={ghost.key}
      ghost={ghost}
      orientation={orientation}
      onDone={() =>
        setGhosts((current) => current.filter((g) => g.key !== ghost.key))
      }
    />
  ));
}

/**
 * 閉じた単位の外形（カードの面だけ）。直前の矩形から畳んで消える。
 * shadow を切らないよう、畳まない 3 辺は負の inset にする。
 */
function CollapsingGhost({
  ghost,
  orientation,
  onDone,
}: {
  ghost: Ghost;
  orientation: "vertical" | "horizontal";
  onDone: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof el.animate !== "function") {
      onDoneRef.current();
      return;
    }
    const open = "inset(-40px -40px -40px -40px)";
    const closed = collapsedInset(orientation, ghost.toward);
    const animation = el.animate(
      [
        { clipPath: open, opacity: 1 },
        { clipPath: closed, opacity: 0 },
      ],
      {
        duration: LAYOUT_MOTION.groupExit * 1000,
        easing: CSS_EASINGS.easeOut,
        fill: "forwards",
      },
    );
    animation.onfinish = () => onDoneRef.current();
    return () => {
      animation.onfinish = null;
      animation.cancel();
    };
  }, [ghost.toward, orientation]);

  return (
    <div
      ref={ref}
      aria-hidden
      data-group-ghost
      data-ambient-glass-surface={ghost.surface.glassSurface}
      data-editor-fluid-glass={ghost.surface.editorGlass}
      className={`${ghost.surface.className} pointer-events-none absolute`}
      style={{
        left: ghost.rect.left,
        top: ghost.rect.top,
        width: ghost.rect.width,
        height: ghost.rect.height,
        zIndex: GHOST_Z_INDEX,
      }}
    />
  );
}

/**
 * 閉じた単位のカードの面。slot はその要素自身が gx-panel、エディタは中の
 * EditorArea（gx-panel gx-panel--flat）がカード。Glass の属性も引き継ぐ。
 */
function surfaceOf(el: HTMLElement): Surface {
  const card = el.classList.contains("gx-panel")
    ? el
    : el.querySelector<HTMLElement>(".gx-panel");
  if (!card) return { className: "gx-panel" };
  return {
    className: Array.from(card.classList)
      .filter((name) => name.startsWith("gx-panel"))
      .join(" "),
    glassSurface: card.dataset.ambientGlassSurface,
    editorGlass: card.dataset.editorFluidGlass,
  };
}

function collapsedInset(
  orientation: "vertical" | "horizontal",
  toward: CollapseToward,
): string {
  const m = "-40px";
  if (orientation === "vertical") {
    if (toward === "end") return `inset(100% ${m} ${m} ${m})`;
    if (toward === "start") return `inset(${m} ${m} 100% ${m})`;
    return `inset(50% ${m} 50% ${m})`;
  }
  if (toward === "end") return `inset(${m} ${m} ${m} 100%)`;
  if (toward === "start") return `inset(${m} 100% ${m} ${m})`;
  return `inset(${m} 50% ${m} 50%)`;
}

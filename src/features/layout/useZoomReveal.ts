import { useLayoutEffect, useRef, type RefObject } from "react";
import { DURATIONS, useReducedMotion } from "@/lib/animation";
import { startClipReveal } from "./clipReveal";
import type { ZoomRegion } from "./layoutMetrics";
import type { LayoutState } from "./layoutTypes";

const ZOOM_CELLS: ZoomRegion[] = ["left", "right", "center", "bottom"];

/**
 * 最大化（視覚 zoom）突入時の「ズームっぽい」展開演出。
 *
 * grid template の px を毎フレーム補間する案は全 shell の連続 reflow と
 * 「Content は動かない」規律に反するため不採用。代わりに FLIP 的な
 * clip-path reveal を使う: zoom レイアウトは即時に適用し（reflow は 1 回）、
 * 全面化した対象セルを「直前の矩形」に clip してから外側へ開く。中身は
 * 最初から最終位置にレイアウト済みなので、パネルの窓が広がって見えるだけで
 * テキストは動かない（clip-path は composite-only）。
 *
 * - First 矩形は非 zoom 状態の各セルを layout 変化のたびに控える
 *   （store の mutation は React の外で起きるため、変更前 DOM を
 *   イベント時点では測れない）。window リサイズ直後の 1 回だけ僅かに
 *   ズレうるが、reveal の始点が数 px 逸れるだけで実害はない。
 * - 補間は startClipReveal（clipReveal.ts）が inset の 4 数値を rAF で
 *   自前駆動する（DURATIONS.slow / EASINGS.easeOut）。完了・中断とも inline
 *   clip-path を除去するので残留しない（中断は巻き戻さずキャンセル）。
 * - 解除（zoom→null）と zoom 間切替は reveal しない（解除側のフェードは
 *   useLayoutPresetCrossfade が担当）。
 */
export function useZoomReveal(
  zoomRegion: ZoomRegion | null,
  layout: LayoutState,
  shellRef: RefObject<HTMLDivElement | null>,
) {
  const reduced = useReducedMotion();
  const restRectsRef = useRef<Partial<Record<ZoomRegion, DOMRect>>>({});
  const prevZoomRef = useRef<ZoomRegion | null>(zoomRegion);

  useLayoutEffect(() => {
    const prev = prevZoomRef.current;
    prevZoomRef.current = zoomRegion;
    const shell = shellRef.current;
    if (!shell) return;

    if (zoomRegion === null) {
      // 非 zoom 状態のセル矩形を控える（次の zoom enter の First になる）。
      for (const cell of ZOOM_CELLS) {
        const el = shell.querySelector<HTMLElement>(
          `[data-zoom-cell="${cell}"]`,
        );
        if (el) restRectsRef.current[cell] = el.getBoundingClientRect();
      }
      return;
    }

    // zoom 中の再レンダー / zoom 間切替 / reduced motion は演出なし。
    if (prev !== null || reduced) return;

    const el = shell.querySelector<HTMLElement>(
      `[data-zoom-cell="${zoomRegion}"]`,
    );
    const first = restRectsRef.current[zoomRegion];
    if (!el || !first) return;
    return startClipReveal(el, first, DURATIONS.slow);
  }, [zoomRegion, layout, reduced, shellRef]);
}

import { useLayoutEffect, useRef, type RefObject } from "react";
import { cubicBezier } from "motion/react";
import { DURATIONS, EASINGS, useReducedMotion } from "@/lib/animation";
import type { ZoomRegion } from "./layoutMetrics";
import type { LayoutState } from "./layoutTypes";

const ZOOM_CELLS: ZoomRegion[] = ["left", "right", "center", "bottom"];

/**
 * 終端 inset。負値なのは clip を panel の box-shadow より外側に逃がすため
 * （REGION_OPEN_CLIP と同じ意図）。開始値と同じ 4 値で持ち、数値だけを
 * 自前補間する — `inset(-200px)`（1 値ショートハンド）との文字列補間は
 * エンジン/ライブラリによって構造不一致で discrete になる罠があるため、
 * 文字列補間には一切頼らない。
 */
const OPEN_INSET_PX = -200;

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
 * - 補間は inset の 4 数値を rAF で自前駆動する（duration/easing は
 *   DURATIONS.slow / EASINGS.easeOut）。完了・中断とも inline clip-path を
 *   除去するので残留しない（中断は巻き戻さずキャンセル）。
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
    const last = el.getBoundingClientRect();
    if (last.width <= 0 || last.height <= 0) return;

    // 左右リージョンは横方向にだけ開く（縦は元からフル高）。縦もクリップすると
    // 展開演出中にパネル上部の PanelHeader（最大化中は「元に戻す」ボタン）が
    // 一瞬隠れて崩れて見えるため、side は top/bottom をクリップしない。
    const sideRegion = zoomRegion === "left" || zoomRegion === "right";
    const from = {
      top: sideRegion ? 0 : Math.max(0, first.top - last.top),
      right: Math.max(0, last.right - first.right),
      bottom: sideRegion ? 0 : Math.max(0, last.bottom - first.bottom),
      left: Math.max(0, first.left - last.left),
    };
    const ease = cubicBezier(...EASINGS.easeOut);
    const durationMs = DURATIONS.slow * 1000;
    const startedAt = performance.now();
    let raf = 0;

    const apply = (progress: number) => {
      const eased = ease(progress);
      const at = (v: number) => v + (OPEN_INSET_PX - v) * eased;
      el.style.clipPath = `inset(${at(from.top)}px ${at(from.right)}px ${at(
        from.bottom,
      )}px ${at(from.left)}px)`;
    };

    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / durationMs);
      if (progress >= 1) {
        // 完了: 残留 clip を持たない（自前駆動なので書き戻し競合も無い）。
        el.style.clipPath = "";
        raf = 0;
        return;
      }
      apply(progress);
      raf = requestAnimationFrame(tick);
    };

    apply(0);
    raf = requestAnimationFrame(tick);

    return () => {
      // 解除・切替・unmount で発火。中断は巻き戻さずキャンセルし、残留
      // clip を取り除く。
      if (raf !== 0) cancelAnimationFrame(raf);
      el.style.clipPath = "";
    };
  }, [zoomRegion, layout, reduced, shellRef]);
}

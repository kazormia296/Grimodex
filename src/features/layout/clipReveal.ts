import { easeOutFn } from "@/lib/animation";

/**
 * 終端 inset。負値なのは clip を panel の box-shadow より外側に逃がすため
 * （REGION_DRAWER_CLIP と同じ意図）。開始値と同じ 4 値で持ち、数値だけを
 * 自前補間する — `inset(-200px)`（1 値ショートハンド）との文字列補間は
 * エンジン/ライブラリによって構造不一致で discrete になる罠があるため、
 * 文字列補間には一切頼らない。
 */
const OPEN_INSET_PX = -200;

/**
 * clip-path の FLIP。要素は最終位置に即時レイアウト済みとし、直前の矩形
 * `first` に clip してから外側へ開く。中身は最初から最終位置にあるので、
 * 窓が広がって見えるだけでテキストは動かない（clip-path は composite-only）。
 *
 * 完了・中断とも inline clip-path を除去する（settled 状態に clip-path を残すと
 * Backdrop Root になり、配下の Glass が背後の ambient shader を blur できない）。
 * 返り値は中断用。中断は巻き戻さずにキャンセルする。
 */
export function startClipReveal(
  el: HTMLElement,
  first: DOMRect,
  durationS: number,
): () => void {
  const last = el.getBoundingClientRect();
  if (last.width <= 0 || last.height <= 0) return () => {};
  const from = {
    top: Math.max(0, first.top - last.top),
    right: Math.max(0, last.right - first.right),
    bottom: Math.max(0, last.bottom - first.bottom),
    left: Math.max(0, first.left - last.left),
  };
  if (from.top + from.right + from.bottom + from.left < 1) return () => {};

  const durationMs = durationS * 1000;
  const startedAt = performance.now();
  let raf = 0;

  const apply = (progress: number) => {
    const eased = easeOutFn(progress);
    const at = (v: number) => v + (OPEN_INSET_PX - v) * eased;
    el.style.clipPath = `inset(${at(from.top)}px ${at(from.right)}px ${at(
      from.bottom,
    )}px ${at(from.left)}px)`;
  };

  const tick = (now: number) => {
    const progress = Math.min(1, (now - startedAt) / durationMs);
    if (progress >= 1) {
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
    if (raf !== 0) cancelAnimationFrame(raf);
    raf = 0;
    el.style.clipPath = "";
  };
}

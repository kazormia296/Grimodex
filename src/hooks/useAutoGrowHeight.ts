import { useLayoutEffect, type RefObject } from "react";

/**
 * Auto-grow a `<textarea>` (or any element) to fit its content height.
 *
 * Sets `height = scrollHeight` so a `rows={1}` textarea expands as content
 * wraps. Re-fits on three triggers:
 *  1. `syncKey` change — value / font-size / anything the caller knows changes
 *     content height without changing the element's width.
 *  2. mount.
 *  3. **element width change** — observed via ResizeObserver. This is the one a
 *     plain `[value, fontSize]` effect misses: when the font is clamped at a
 *     floor and the container keeps narrowing, the wrap count grows while the
 *     deps stay constant, so the frozen height clips the extra lines. The RO is
 *     width-guarded (`w === lastWidth → bail`) so the height mutation `fit()`
 *     makes — which the RO also sees — can't feed back into an infinite loop.
 */
export function useAutoGrowHeight(
  ref: RefObject<HTMLTextAreaElement | null>,
  syncKey: string | number,
): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    };
    fit(); // mount / syncKey 変化時は同期 fit (フリッカ回避)
    let lastWidth = -1;
    let raf = 0;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? -1;
      if (w === lastWidth) return; // 高さ変化による発火は無視 (幅変化のみ追従)
      lastWidth = w;
      // RO コールバック内で同期的に高さを変えると "ResizeObserver loop" 警告を
      // 誘発するため、次フレームに逃がす (リサイズ追従なので 1 フレーム遅延は不可視)。
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(fit);
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
    // syncKey 変化で再 fit + RO 再設定。ref は安定参照。
  }, [ref, syncKey]);
}

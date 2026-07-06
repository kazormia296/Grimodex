import { useEffect, useState, type RefObject } from "react";

/**
 * ダッシュボードをサマリー/トリアージカードと共存表示してよい最小
 * コンテナ高さ (px)。目安: ヘッダ+ツールバー+フッター(~90) + ダッシュボード
 * 2 列時(~250) + カード(~200)。これ未満では従来どおりステージを排他表示する。
 */
export const STAGE_COEXIST_MIN_HEIGHT = 560;

/**
 * 共存を許す最小コンテナ幅 (px)。ダッシュボードの grid は
 * auto-fill minmax(9.5rem, 1fr) のため、内容幅 ~310px（タイル 2 列 + gap）を
 * 下回ると 1 列に落ちて高さが約 2 倍（~460px）に膨らみ、上の高さ前提が
 * 崩れてリストが 0px に潰れる。2 列以上を保てる幅でのみ共存させる。
 */
export const STAGE_COEXIST_MIN_WIDTH = 330;

/**
 * コンテナがダッシュボード共存に足る大きさ（高さ >= MIN_HEIGHT かつ
 * 幅 >= MIN_WIDTH）かを ResizeObserver で追跡する。
 * ResizeObserver が無い環境（happy-dom 等）では常に false（= 排他表示への
 * フォールバック）。
 */
export function useStageCoexist(ref: RefObject<HTMLElement | null>): boolean {
  const [coexist, setCoexist] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const update = () =>
      setCoexist(
        el.clientHeight >= STAGE_COEXIST_MIN_HEIGHT &&
          el.clientWidth >= STAGE_COEXIST_MIN_WIDTH,
      );
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return coexist;
}

import { useLayoutEffect, useRef } from "react";
import { useAnimationControls } from "motion/react";
import { useReducedMotion } from "@/lib/animation";
import { useLayoutStore } from "./layoutStore";
import {
  PRESET_ANIMATION_DEBOUNCE_MS,
  presetCrossfadeTransition,
} from "./layoutAnimation";

/**
 * プリセット切替時のフェード演出。
 *
 * かつては activePresetId を motion.div の key に与えて subtree ごと remount
 * させる方式だったが、配下の全 TipTap エディタ・パネルの破棄→再生成と
 * 本文/データのフルリロードを毎切替で誘発し、体感フリーズの主因になっていた。
 * 現在は mount を保ったまま AnimationControls で opacity 0→1 を再トリガーする。
 * controls.set の DOM 反映は motion の frameloop (rAF) 経由で「同フレームの
 * paint 直前」に起きる（同期ではない）。useLayoutEffect なら commit と同じ
 * フレーム内にスケジュールされ paint 前に opacity 0 が当たるが、useEffect だと
 * paint 後に走りうるため新レイアウトが 1 フレーム素通しで見えてから暗転する。
 */
export function useLayoutPresetCrossfade() {
  const activePresetId = useLayoutStore((s) => s.activePresetId);
  const layoutLocked = useLayoutStore((s) => s.layoutLocked);
  const reduced = useReducedMotion();
  const controls = useAnimationControls();
  const lastAnimRef = useRef(0);
  const prevPresetRef = useRef(activePresetId);

  useLayoutEffect(() => {
    if (prevPresetRef.current === activePresetId) return;
    prevPresetRef.current = activePresetId;

    const canAnimate =
      !reduced &&
      !layoutLocked &&
      Date.now() - lastAnimRef.current >= PRESET_ANIMATION_DEBOUNCE_MS;
    if (!canAnimate) return;
    lastAnimRef.current = Date.now();

    controls.set({ opacity: 0 });
    void controls.start({
      opacity: 1,
      transition: presetCrossfadeTransition(reduced),
    });
  }, [activePresetId, layoutLocked, reduced, controls]);

  return { crossfadeControls: controls };
}

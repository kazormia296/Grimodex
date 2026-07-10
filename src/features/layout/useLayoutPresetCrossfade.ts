import { useLayoutEffect, useRef } from "react";
import { useAnimationControls } from "motion/react";
import { useReducedMotion } from "@/lib/animation";
import { useLayoutStore } from "./layoutStore";
import {
  PRESET_ANIMATION_DEBOUNCE_MS,
  presetCrossfadeTransition,
} from "./layoutAnimation";

/**
 * レイアウト一括切替（プリセット切替・パネル最大化/解除）時のフェード演出。
 *
 * かつては activePresetId を motion.div の key に与えて subtree ごと remount
 * させる方式だったが、配下の全 TipTap エディタ・パネルの破棄→再生成と
 * 本文/データのフルリロードを毎切替で誘発し、体感フリーズの主因になっていた。
 * 現在は mount を保ったまま AnimationControls で opacity 0→1 を再トリガーする。
 * controls.set の DOM 反映は motion の frameloop (rAF) 経由で「同フレームの
 * paint 直前」に起きる（同期ではない）。useLayoutEffect なら commit と同じ
 * フレーム内にスケジュールされ paint 前に opacity 0 が当たるが、useEffect だと
 * paint 後に走りうるため新レイアウトが 1 フレーム素通しで見えてから暗転する。
 *
 * 最大化（視覚 zoom）の解除・zoom 間切替も「全体レイアウトの一括差し替え」
 * なので同じモーション言語を使う。**突入（null→panel）はフェードしない** —
 * そちらは useZoomReveal の clip-path 展開が担当し、フェードを重ねると
 * 展開の空間的連続性（どこから広がったか）が見えなくなる。
 * geometry を毎フレーム補間する案（grid template の px 補間）は全 shell の
 * 連続 reflow と「Content は動かない」規律への抵触で不採用。プリセット
 * 切替と zoom 解除が同一 commit で同時に起きた場合（applyPreset の
 * 自動解除）もフェードは 1 回。
 */
export function useLayoutPresetCrossfade() {
  const activePresetId = useLayoutStore((s) => s.activePresetId);
  const maximizedPanelId = useLayoutStore((s) => s.maximizedPanelId);
  const layoutLocked = useLayoutStore((s) => s.layoutLocked);
  const initialized = useLayoutStore((s) => s.initialized);
  const reduced = useReducedMotion();
  const controls = useAnimationControls();
  const lastAnimRef = useRef(0);
  const prevPresetRef = useRef(activePresetId);
  const prevZoomRef = useRef(maximizedPanelId);
  const prevInitializedRef = useRef(initialized);

  useLayoutEffect(() => {
    const presetChanged = prevPresetRef.current !== activePresetId;
    const zoomChanged = prevZoomRef.current !== maximizedPanelId;
    const zoomEntering = zoomChanged && prevZoomRef.current === null;
    const startupHydrationCompleted =
      !prevInitializedRef.current && initialized;
    prevPresetRef.current = activePresetId;
    prevZoomRef.current = maximizedPanelId;
    prevInitializedRef.current = initialized;
    // 初期 hydration は画面上のユーザー操作ではないため演出対象から外し、
    // 保存済みレイアウトの最終状態をそのまま示す。loadPresets() が
    // initialized=false のまま preset id を先に読む二段階更新もここで吸収する。
    if (!initialized || startupHydrationCompleted) return;
    if (!presetChanged && (!zoomChanged || zoomEntering)) return;

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
  }, [
    activePresetId,
    maximizedPanelId,
    layoutLocked,
    initialized,
    reduced,
    controls,
  ]);

  return { crossfadeControls: controls };
}

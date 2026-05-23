import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "@/lib/animation";
import { useLayoutStore } from "./layoutStore";
import { PRESET_ANIMATION_DEBOUNCE_MS } from "./layoutAnimation";

export function useLayoutPresetCrossfade() {
  const activePresetId = useLayoutStore((s) => s.activePresetId);
  const layoutLocked = useLayoutStore((s) => s.layoutLocked);
  const reduced = useReducedMotion();
  const lastAnimRef = useRef(0);
  const prevPresetRef = useRef(activePresetId);
  const [crossfadeKey, setCrossfadeKey] = useState(
    () => activePresetId ?? "default",
  );
  const [animateEntry, setAnimateEntry] = useState(false);

  useEffect(() => {
    if (prevPresetRef.current === activePresetId) return;
    prevPresetRef.current = activePresetId;

    const nextKey = activePresetId ?? "default";
    const canAnimate =
      !reduced &&
      !layoutLocked &&
      Date.now() - lastAnimRef.current >= PRESET_ANIMATION_DEBOUNCE_MS;

    if (canAnimate) {
      lastAnimRef.current = Date.now();
    }

    setCrossfadeKey(nextKey);
    setAnimateEntry(canAnimate);
  }, [activePresetId, layoutLocked, reduced]);

  return { crossfadeKey, animateEntry, reduced };
}

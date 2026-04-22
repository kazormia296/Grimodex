import {
  useCallback,
  type MutableRefObject,
  type KeyboardEvent,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { MapMode } from "../types";

const MODES_ORDER: MapMode[] = ["free", "time", "theme", "pov", "place"];

type Rect = { x: number; y: number; w: number; h: number };
type Vec2 = { x: number; y: number };

export function useMapKeyboard(opts: {
  searchVisible: boolean;
  setSearchVisible: (v: boolean) => void;
  focusedNodeId: string | null;
  setFocusedNode: (id: string | null) => void;
  gridSnap: boolean;
  setGridSnap: (v: boolean) => void;
  setMode: (mode: MapMode) => void;
  setPaletteMode: Dispatch<SetStateAction<"default" | "frame" | "connect">>;
  frameDraftRect: Rect | null;
  frameDragStart: MutableRefObject<Vec2 | null>;
  frameDragStartScreen: MutableRefObject<Vec2 | null>;
  setFrameDraftRect: (rect: Rect | null) => void;
  setFrameDraftScreenRect: (rect: Rect | null) => void;
}) {
  const {
    searchVisible,
    setSearchVisible,
    focusedNodeId,
    setFocusedNode,
    gridSnap,
    setGridSnap,
    setMode,
    setPaletteMode,
    frameDraftRect,
    frameDragStart,
    frameDragStartScreen,
    setFrameDraftRect,
    setFrameDraftScreenRect,
  } = opts;

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      const inInput =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement;

      if (e.key === "Escape") {
        // Priority: frame drawing > search > focus > palette
        if (frameDraftRect || frameDragStart.current) {
          setFrameDraftRect(null);
          setFrameDraftScreenRect(null);
          frameDragStart.current = null;
          frameDragStartScreen.current = null;
        } else if (searchVisible) {
          setSearchVisible(false);
        } else if (focusedNodeId) {
          setFocusedNode(null);
        } else {
          setPaletteMode("default");
        }
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        setSearchVisible(true);
        return;
      }

      if (inInput) return;

      // Mode switch: 1-5
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        const modeIdx = parseInt(e.key, 10) - 1;
        if (modeIdx >= 0 && modeIdx < MODES_ORDER.length) {
          setMode(MODES_ORDER[modeIdx]);
          return;
        }
      }

      // Ctrl+G: toggle grid snap
      if ((e.ctrlKey || e.metaKey) && e.key === "g") {
        e.preventDefault();
        setGridSnap(!gridSnap);
        return;
      }

      // F: toggle frame drawing mode
      if (e.key === "f" && !e.ctrlKey && !e.metaKey) {
        setPaletteMode((prev) => (prev === "frame" ? "default" : "frame"));
        return;
      }
    },
    [
      searchVisible,
      setSearchVisible,
      focusedNodeId,
      setFocusedNode,
      gridSnap,
      setGridSnap,
      setMode,
      setPaletteMode,
      frameDraftRect,
      frameDragStart,
      frameDragStartScreen,
      setFrameDraftRect,
      setFrameDraftScreenRect,
    ],
  );

  return { onKeyDown };
}

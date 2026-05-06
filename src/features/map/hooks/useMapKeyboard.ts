import {
  useCallback,
  useRef,
  type MutableRefObject,
  type KeyboardEvent,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { MapMode } from "../types";

const MODES_ORDER: MapMode[] = ["free", "theme"];

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
  onDeleteSelected: () => void;
  onAddSticky: () => void;
  fitView: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;
  selectAll: () => void;
  onPinToggle: () => void;
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
    onDeleteSelected,
    onAddSticky,
    fitView,
    zoomIn,
    zoomOut,
    zoomReset,
    selectAll,
    onPinToggle,
  } = opts;

  const altConnectRef = useRef(false);

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

      // S: add sticky
      if (e.key === "s" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        onAddSticky();
        return;
      }

      // Delete / Backspace: remove selected nodes (hide from board) and edges
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        onDeleteSelected();
        return;
      }

      // E: connect mode (standalone key only)
      if (e.key === "e" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        setPaletteMode("connect");
        return;
      }
      // Alt held: enter connect mode; released via onKeyUp below
      if (e.key === "Alt" && !e.ctrlKey && !e.metaKey) {
        altConnectRef.current = true;
        setPaletteMode("connect");
        return;
      }

      // Ctrl+0: fit view
      if ((e.ctrlKey || e.metaKey) && e.key === "0") {
        e.preventDefault();
        fitView();
        return;
      }

      // Ctrl+= / Ctrl++: zoom in
      if ((e.ctrlKey || e.metaKey) && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        zoomIn();
        return;
      }

      // Ctrl+-: zoom out
      if ((e.ctrlKey || e.metaKey) && e.key === "-") {
        e.preventDefault();
        zoomOut();
        return;
      }

      // Ctrl+1: zoom reset
      if ((e.ctrlKey || e.metaKey) && e.key === "1") {
        e.preventDefault();
        zoomReset();
        return;
      }

      // Ctrl+A: select all
      if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault();
        selectAll();
        return;
      }

      // Ctrl+P: pin toggle
      if ((e.ctrlKey || e.metaKey) && e.key === "p") {
        e.preventDefault();
        onPinToggle();
        return;
      }

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
      onDeleteSelected,
      onAddSticky,
      fitView,
      zoomIn,
      zoomOut,
      zoomReset,
      selectAll,
      onPinToggle,
    ],
  );

  const onKeyUp = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Alt" && altConnectRef.current) {
        altConnectRef.current = false;
        setPaletteMode("default");
      }
    },
    [setPaletteMode],
  );

  return { onKeyDown, onKeyUp };
}

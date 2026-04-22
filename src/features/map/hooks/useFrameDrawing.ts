import { useState, useRef, useCallback } from "react";
import type { XYPosition } from "@xyflow/react";
import type { MapFrame } from "@/db/schema";
import { createFrame } from "../mapApi";

type Rect = { x: number; y: number; w: number; h: number };

export function useFrameDrawing(
  screenToFlowPosition: (pos: { x: number; y: number }) => XYPosition,
  boardId: string | null,
  setFrames: React.Dispatch<React.SetStateAction<MapFrame[]>>,
  setPaletteMode: (mode: "default" | "frame" | "connect") => void,
) {
  const frameDragStart = useRef<XYPosition | null>(null);
  const frameDragStartScreen = useRef<{ x: number; y: number } | null>(null);
  const [frameDraftRect, setFrameDraftRect] = useState<Rect | null>(null);
  const [frameDraftScreenRect, setFrameDraftScreenRect] = useState<Rect | null>(
    null,
  );

  const handleFrameOverlayDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      frameDragStart.current = flowPos;
      frameDragStartScreen.current = {
        x: e.nativeEvent.offsetX,
        y: e.nativeEvent.offsetY,
      };
      setFrameDraftRect({ x: flowPos.x, y: flowPos.y, w: 0, h: 0 });
      setFrameDraftScreenRect({
        x: e.nativeEvent.offsetX,
        y: e.nativeEvent.offsetY,
        w: 0,
        h: 0,
      });
    },
    [screenToFlowPosition],
  );

  const handleFrameOverlayMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!frameDragStart.current || !frameDragStartScreen.current) return;
      const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const dx = flowPos.x - frameDragStart.current.x;
      const dy = flowPos.y - frameDragStart.current.y;
      setFrameDraftRect({
        x: Math.min(flowPos.x, frameDragStart.current.x),
        y: Math.min(flowPos.y, frameDragStart.current.y),
        w: Math.abs(dx),
        h: Math.abs(dy),
      });
      const sx = e.nativeEvent.offsetX;
      const sy = e.nativeEvent.offsetY;
      setFrameDraftScreenRect({
        x: Math.min(sx, frameDragStartScreen.current.x),
        y: Math.min(sy, frameDragStartScreen.current.y),
        w: Math.abs(sx - frameDragStartScreen.current.x),
        h: Math.abs(sy - frameDragStartScreen.current.y),
      });
    },
    [screenToFlowPosition],
  );

  const handleFrameOverlayUp = useCallback(async () => {
    if (!frameDragStart.current || !boardId) return;
    const rect = frameDraftRect;
    frameDragStart.current = null;
    frameDragStartScreen.current = null;
    setFrameDraftRect(null);
    setFrameDraftScreenRect(null);
    if (!rect || rect.w < 40 || rect.h < 40) return;

    const newFrame = await createFrame({
      boardId,
      title: "Frame",
      x: rect.x,
      y: rect.y,
      width: rect.w,
      height: rect.h,
    });
    setFrames((prev) => [...prev, newFrame]);
    setPaletteMode("default");
  }, [boardId, frameDraftRect, setFrames, setPaletteMode]);

  return {
    frameDragStart,
    frameDragStartScreen,
    frameDraftRect,
    setFrameDraftRect,
    frameDraftScreenRect,
    setFrameDraftScreenRect,
    handleFrameOverlayDown,
    handleFrameOverlayMove,
    handleFrameOverlayUp,
  };
}

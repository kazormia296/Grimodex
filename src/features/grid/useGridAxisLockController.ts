import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { gperfMark } from "./gridDndLog";
import {
  computeColumnAxisLockPxOffsets,
  computeSceneAxisLockPxOffsets,
  resolveSceneDragMode,
} from "./gridDndUtils";
import type { SceneDragMode } from "./gridDndUtils";

export interface SceneAxisLockSession {
  mode: SceneDragMode;
  startX: number;
  activeSceneId: string;
  siblingRects: Record<string, { top: number; bottom: number }>;
  orderedSiblings: Array<{ id: string; parentId: string | null }>;
  scrollEl: HTMLElement | null;
  initialScrollTop: number;
}

export interface ColumnAxisLockSession {
  mode: SceneDragMode;
  startY: number;
  activeFolderId: string;
  siblingRects: Record<string, { left: number; right: number }>;
  orderedSiblings: Array<{ id: string; parentId: string | null }>;
  scrollEl: HTMLElement | null;
  initialScrollLeft: number;
}

export interface GridAxisLockControllerResult {
  pointerXRef: MutableRefObject<number>;
  pointerYRef: MutableRefObject<number>;
  lastDragOverKeyRef: MutableRefObject<string>;
  axisLockSessionRef: MutableRefObject<SceneAxisLockSession | null>;
  columnAxisLockSessionRef: MutableRefObject<ColumnAxisLockSession | null>;
  axisLockScrollListenerRef: MutableRefObject<{
    el: HTMLElement;
    fn: () => void;
  } | null>;
  columnAxisLockScrollListenerRef: MutableRefObject<{
    el: HTMLElement;
    fn: () => void;
  } | null>;
  axisLockOffsets: Map<string, number>;
  setAxisLockOffsets: Dispatch<SetStateAction<Map<string, number>>>;
  columnAxisLockOffsets: Map<string, number>;
  setColumnAxisLockOffsets: Dispatch<SetStateAction<Map<string, number>>>;
  axisLockActive: boolean;
  setAxisLockActive: Dispatch<SetStateAction<boolean>>;
  columnAxisLockActive: boolean;
  setColumnAxisLockActive: Dispatch<SetStateAction<boolean>>;
  recomputeAxisLock: MutableRefObject<() => void>;
  recomputeColumnAxisLock: MutableRefObject<() => void>;
  detachAxisLockScrollListener(): void;
  detachColumnAxisLockScrollListener(): void;
}

/** Owns pointer-derived axis-lock state shared by Grid drag start/over/end handlers. */
export function useGridAxisLockController(): GridAxisLockControllerResult {
  const pointerYRef = useRef(0);
  const pointerXRef = useRef(0);
  const lastDragOverKeyRef = useRef("");
  const axisLockSessionRef = useRef<SceneAxisLockSession | null>(null);
  const columnAxisLockSessionRef = useRef<ColumnAxisLockSession | null>(null);
  const [axisLockOffsets, setAxisLockOffsets] = useState<Map<string, number>>(
    () => new Map(),
  );
  const [columnAxisLockOffsets, setColumnAxisLockOffsets] = useState<
    Map<string, number>
  >(() => new Map());
  const [axisLockActive, setAxisLockActive] = useState(false);
  const [columnAxisLockActive, setColumnAxisLockActive] = useState(false);
  const axisLockScrollListenerRef = useRef<{
    el: HTMLElement;
    fn: () => void;
  } | null>(null);
  const columnAxisLockScrollListenerRef = useRef<{
    el: HTMLElement;
    fn: () => void;
  } | null>(null);

  const detachAxisLockScrollListener = () => {
    const registration = axisLockScrollListenerRef.current;
    if (registration) {
      registration.el.removeEventListener("scroll", registration.fn);
      axisLockScrollListenerRef.current = null;
    }
  };
  const detachColumnAxisLockScrollListener = () => {
    const registration = columnAxisLockScrollListenerRef.current;
    if (registration) {
      registration.el.removeEventListener("scroll", registration.fn);
      columnAxisLockScrollListenerRef.current = null;
    }
  };

  const recomputeAxisLock = useRef<() => void>(() => {});
  recomputeAxisLock.current = () => {
    gperfMark("recomputeAxisLock", () => {
      const session = axisLockSessionRef.current;
      if (!session) return;
      const nextMode = resolveSceneDragMode(
        session.mode,
        pointerXRef.current - session.startX,
        120,
      );
      if (nextMode !== session.mode) {
        session.mode = nextMode;
        if (nextMode === "free") {
          detachAxisLockScrollListener();
          setAxisLockActive(false);
          setAxisLockOffsets((previous) =>
            previous.size === 0 ? previous : new Map(),
          );
          return;
        }
      }
      if (session.mode !== "axis-locked") return;
      const scrollDelta = session.scrollEl
        ? session.scrollEl.scrollTop - session.initialScrollTop
        : 0;
      const next = computeSceneAxisLockPxOffsets(
        session.activeSceneId,
        pointerYRef.current + scrollDelta,
        session.orderedSiblings,
        session.siblingRects,
        8,
      );
      setAxisLockOffsets((previous) => {
        if (previous.size !== next.size) return next;
        for (const [id, offset] of next) {
          if (previous.get(id) !== offset) return next;
        }
        return previous;
      });
    });
  };

  const recomputeColumnAxisLock = useRef<() => void>(() => {});
  recomputeColumnAxisLock.current = () => {
    gperfMark("recomputeColumnAxisLock", () => {
      const session = columnAxisLockSessionRef.current;
      if (!session) return;
      const nextMode = resolveSceneDragMode(
        session.mode,
        pointerYRef.current - session.startY,
        120,
      );
      if (nextMode !== session.mode) {
        session.mode = nextMode;
        if (nextMode === "free") {
          detachColumnAxisLockScrollListener();
          setColumnAxisLockActive(false);
          setColumnAxisLockOffsets((previous) =>
            previous.size === 0 ? previous : new Map(),
          );
          return;
        }
      }
      if (session.mode !== "axis-locked") return;
      const scrollDelta = session.scrollEl
        ? session.scrollEl.scrollLeft - session.initialScrollLeft
        : 0;
      const next = computeColumnAxisLockPxOffsets(
        session.activeFolderId,
        pointerXRef.current + scrollDelta,
        session.orderedSiblings,
        session.siblingRects,
        12,
      );
      setColumnAxisLockOffsets((previous) => {
        if (previous.size !== next.size) return next;
        for (const [id, offset] of next) {
          if (previous.get(id) !== offset) return next;
        }
        return previous;
      });
    });
  };

  useEffect(() => {
    const handler = (event: PointerEvent) => {
      pointerXRef.current = event.clientX;
      pointerYRef.current = event.clientY;
      recomputeAxisLock.current();
      recomputeColumnAxisLock.current();
    };
    window.addEventListener("pointermove", handler);
    return () => window.removeEventListener("pointermove", handler);
  }, []);

  return {
    pointerXRef,
    pointerYRef,
    lastDragOverKeyRef,
    axisLockSessionRef,
    columnAxisLockSessionRef,
    axisLockScrollListenerRef,
    columnAxisLockScrollListenerRef,
    axisLockOffsets,
    setAxisLockOffsets,
    columnAxisLockOffsets,
    setColumnAxisLockOffsets,
    axisLockActive,
    setAxisLockActive,
    columnAxisLockActive,
    setColumnAxisLockActive,
    recomputeAxisLock,
    recomputeColumnAxisLock,
    detachAxisLockScrollListener,
    detachColumnAxisLockScrollListener,
  };
}

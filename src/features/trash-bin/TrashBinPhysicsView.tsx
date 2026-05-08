import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { TrashBinItem } from "./TrashBinItem";
import { BodyState, DRAG_THRESHOLD_PX, TrashPhysicsEngine } from "./physics";
import { getBodySize } from "./displayHelpers";
import { useDropTargetRegistry } from "@/store/dropTargetRegistry";
import { useTrashBinStore } from "./trashBinStore";
import { TrashBinPopover } from "./TrashBinPopover";
import type { TrashItemData } from "./types";

export interface PhysicsViewHandle {
  stir(intensity: number): void;
}

interface PhysicsViewProps {
  items: TrashItemData[];
  isLoading: boolean;
  /** Stir ボタンから呼ぶ imperative handle */
  handleRef?: React.MutableRefObject<PhysicsViewHandle | null>;
}

const MAX_DT_MS = 33; // 30fps 下限

export function TrashBinPhysicsView({
  items,
  isLoading,
  handleRef,
}: PhysicsViewProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<TrashPhysicsEngine | null>(null);
  // strict mode で unmount cleanup → remount effect の順に走るため、
  // 関数ボディ側の lazy init では effect 再実行時に null に戻ったままになる。
  // 各 effect/callback で getEngine() 経由で取得することで再生成を保証する。
  const getEngine = useCallback((): TrashPhysicsEngine => {
    if (!engineRef.current) engineRef.current = new TrashPhysicsEngine();
    return engineRef.current;
  }, []);
  const nodesRef = useRef<Map<string, HTMLElement>>(new Map());
  const knownIdsRef = useRef<Set<string>>(new Set());
  const [size, setSize] = useState({ width: 0, floorY: 0 });
  const sizeRef = useRef(size);
  useEffect(() => {
    sizeRef.current = size;
  }, [size]);
  const visibleRef = useRef(true);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef(0);

  const dragStateRef = useRef<{
    pointerId: number;
    itemId: string;
    startClientX: number;
    startClientY: number;
    bodyOffsetX: number;
    bodyOffsetY: number;
    started: boolean;
  } | null>(null);
  const [hoverTargetId, setHoverTargetId] = useState<string | null>(null);
  const [draggingItemId, setDraggingItemId] = useState<string | null>(null);
  const [popoverItemId, setPopoverItemId] = useState<string | null>(null);
  const [popoverAnchor, setPopoverAnchor] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const itemsRef = useRef<Map<string, TrashItemData>>(new Map());
  useEffect(() => {
    itemsRef.current = new Map(items.map((i) => [i.id, i]));
  }, [items]);

  const applyTransform = useCallback((state: BodyState) => {
    const el = nodesRef.current.get(state.id);
    if (!el) return;
    el.style.transform = `translate3d(${state.x}px, ${state.y}px, 0) rotate(${state.rotation}deg)`;
    el.dataset.settled = String(state.isSleeping);
  }, []);

  const tick = useCallback(
    (now: number) => {
      const engine = getEngine();
      if (!visibleRef.current) {
        rafRef.current = null;
        return;
      }
      const dtMs =
        lastTsRef.current === 0
          ? 1000 / 60
          : Math.min(now - lastTsRef.current, MAX_DT_MS);
      lastTsRef.current = now;

      engine.step(dtMs);
      engine.forEachState(applyTransform);

      if (engine.hasUnsettled()) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
      }
    },
    [applyTransform, getEngine],
  );

  const startLoop = useCallback(() => {
    if (rafRef.current !== null) return;
    if (!visibleRef.current) return;
    if (sizeRef.current.width <= 0 || sizeRef.current.floorY <= 0) return;
    lastTsRef.current = 0;
    rafRef.current = requestAnimationFrame(tick);
  }, [tick]);

  const registerNode = useCallback(
    (id: string, el: HTMLElement | null) => {
      if (el === null) {
        nodesRef.current.delete(id);
        return;
      }
      nodesRef.current.set(id, el);
      const state = getEngine().getState(id);
      if (state) applyTransform(state);
    },
    [applyTransform, getEngine],
  );

  // Container 寸法計測 + ResizeObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      const next = { width: rect.width, floorY: rect.height };
      sizeRef.current = next;
      setSize(next);
      const engine = getEngine();
      engine.setBounds(next.width, next.floorY);
      const mutated = engine.clampBodies();
      if (mutated) startLoop();
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [startLoop, getEngine]);

  // 可視性監視
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries[0]?.isIntersecting ?? false;
        const wasVisible = visibleRef.current;
        visibleRef.current = visible;
        if (visible && !wasVisible) startLoop();
      },
      { threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [startLoop]);

  // items 同期: 初回ロードで床積み、以降は y=-h から落下。
  useEffect(() => {
    if (size.width <= 0 || size.floorY <= 0) return;
    const engine = getEngine();
    const currentIds = new Set(items.map((i) => i.id));
    const known = knownIdsRef.current;

    // 削除分
    let removed = false;
    for (const id of known) {
      if (!currentIds.has(id)) {
        engine.removeBody(id);
        removed = true;
      }
    }
    // pickup で下から抜けた場合、上の body が wake されているので落下を進める。
    if (removed) startLoop();

    // 追加分
    const added: TrashItemData[] = [];
    for (const item of items) {
      if (!known.has(item.id) && !engine.hasBody(item.id)) {
        added.push(item);
      }
    }

    if (added.length > 0) {
      const isInitialBatch = known.size === 0;
      if (isInitialBatch) {
        const presetItems = added.map((item) => ({
          id: item.id,
          subKind: item.subKind,
          size: getBodySize(item),
        }));
        engine.placeFloorPreset(presetItems);
        engine.forEachState(applyTransform);
      } else {
        for (const item of added) {
          const state = engine.addBody({
            id: item.id,
            subKind: item.subKind,
            size: getBodySize(item),
            containerWidth: size.width,
            initial: "falling",
          });
          applyTransform(state);
        }
        startLoop();
      }
    }

    knownIdsRef.current = currentIds;
  }, [items, size, startLoop, applyTransform, getEngine]);

  // unmount 時のクリーンアップ
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      engineRef.current?.destroy();
      engineRef.current = null;
    };
  }, []);

  // 攪拌 imperative handle
  useEffect(() => {
    if (!handleRef) return;
    handleRef.current = {
      stir: (intensity) => {
        getEngine().shake(intensity, intensity);
        startLoop();
      },
    };
    return () => {
      if (handleRef.current) handleRef.current = null;
    };
  }, [handleRef, startLoop, getEngine]);

  // ── D&D ハンドラ ─────────────────────────────────
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      const itemEl = target.closest<HTMLElement>("[data-trash-body-id]");
      if (!itemEl) return;
      const itemId = itemEl.dataset.trashBodyId;
      if (!itemId) return;
      const engine = getEngine();
      const state = engine.getState(itemId);
      if (!state) return;
      const containerRect = containerRef.current?.getBoundingClientRect();
      if (!containerRect) return;
      const clientX = e.clientX;
      const clientY = e.clientY;
      const bodyClientX = containerRect.left + state.x;
      const bodyClientY = containerRect.top + state.y;
      dragStateRef.current = {
        pointerId: e.pointerId,
        itemId,
        startClientX: clientX,
        startClientY: clientY,
        bodyOffsetX: clientX - bodyClientX,
        bodyOffsetY: clientY - bodyClientY,
        started: false,
      };
      itemEl.setPointerCapture(e.pointerId);
    },
    [getEngine],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragStateRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      const engine = getEngine();
      const dx = e.clientX - drag.startClientX;
      const dy = e.clientY - drag.startClientY;
      if (!drag.started) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        drag.started = true;
        setDraggingItemId(drag.itemId);
        engine.beginDrag(drag.itemId);
        // 山の下から抜く場合、上に乗っていた sleeping body を落とすため rAF を再起動。
        startLoop();
      }
      const containerRect = containerRef.current?.getBoundingClientRect();
      if (!containerRect) return;
      const tlx = e.clientX - containerRect.left - drag.bodyOffsetX;
      const tly = e.clientY - containerRect.top - drag.bodyOffsetY;
      engine.dragTo(drag.itemId, tlx, tly);
      const state = engine.getState(drag.itemId);
      if (state) applyTransform(state);

      const hover = useDropTargetRegistry
        .getState()
        .hitTest({ x: e.clientX, y: e.clientY });
      const item = itemsRef.current.get(drag.itemId);
      if (hover && item && hover.accepts(item.subKind)) {
        setHoverTargetId(hover.id);
      } else {
        setHoverTargetId(null);
      }
    },
    [applyTransform, getEngine, startLoop],
  );

  const finishDrag = useCallback(
    async (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragStateRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      dragStateRef.current = null;
      setDraggingItemId(null);
      setHoverTargetId(null);

      if (!drag.started) {
        // クリック扱い: Popover を開く
        setPopoverItemId(drag.itemId);
        setPopoverAnchor({ x: e.clientX, y: e.clientY });
        return;
      }

      const engine = getEngine();
      const item = itemsRef.current.get(drag.itemId);
      const target = useDropTargetRegistry
        .getState()
        .hitTest({ x: e.clientX, y: e.clientY });

      const acceptable =
        item && target && target.accepts(item.subKind) ? target : null;

      if (!acceptable || !item) {
        // 元位置に戻す: 投擲速度で動的に戻す
        engine.endDrag(drag.itemId);
        startLoop();
        return;
      }

      const dropPoint = { x: e.clientX, y: e.clientY };
      await acceptable.onDrop(item, dropPoint);
      // pickup が失敗していれば item は trash に残っているので body を再 attach
      if (useTrashBinStore.getState().items.has(item.id)) {
        if (engine.hasBody(drag.itemId)) {
          engine.endDrag(drag.itemId);
          startLoop();
        }
      }
    },
    [startLoop, getEngine],
  );

  // hover ハイライト
  useEffect(() => {
    const lastEl = document.querySelector<HTMLElement>(
      "[data-trash-drop-hover='true']",
    );
    if (lastEl && lastEl.dataset.droptargetId !== hoverTargetId) {
      delete lastEl.dataset.trashDropHover;
    }
    if (hoverTargetId) {
      const el = document.querySelector<HTMLElement>(
        `[data-droptarget-id="${hoverTargetId}"]`,
      );
      if (el) el.dataset.trashDropHover = "true";
    }
  }, [hoverTargetId]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        …
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden touch-none"
      data-testid="trash-bin-physics-view"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
    >
      {items.length === 0 && (
        <div className="flex h-full items-center justify-center px-6 py-12 text-center text-sm text-muted-foreground">
          {t("trashBin.empty")}
        </div>
      )}
      {items.map((item) => (
        <TrashBinItem
          key={item.id}
          item={item}
          registerNode={registerNode}
          isDragging={draggingItemId === item.id}
        />
      ))}

      {popoverItemId && popoverAnchor
        ? (() => {
            const item = itemsRef.current.get(popoverItemId);
            if (!item) return null;
            return (
              <TrashBinPopover
                key={popoverItemId}
                item={item}
                open
                onOpenChange={(open) => {
                  if (!open) {
                    setPopoverItemId(null);
                    setPopoverAnchor(null);
                  }
                }}
                anchorPoint={popoverAnchor}
              >
                <span />
              </TrashBinPopover>
            );
          })()
        : null}
    </div>
  );
}

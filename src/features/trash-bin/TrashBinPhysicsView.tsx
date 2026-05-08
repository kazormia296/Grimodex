import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { TrashBinItem } from "./TrashBinItem";
import {
  applyShake,
  attach,
  createBody,
  detach,
  hasUnsettled,
  PhysicsBody,
  placeFloorPreset,
  stepPhysics,
  wakeNeighbors,
} from "./physics";
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

const MAX_DT = 0.033; // 30fps 下限
const DRAG_THRESHOLD_PX = 5; // 設計書 §5-A / §7

export function TrashBinPhysicsView({
  items,
  isLoading,
  handleRef,
}: PhysicsViewProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const bodiesRef = useRef<Map<string, PhysicsBody>>(new Map());
  const nodesRef = useRef<Map<string, HTMLElement>>(new Map());
  const knownIdsRef = useRef<Set<string>>(new Set());
  // size は state にして、measure() 完了で items useEffect が再実行されるように
  // する (DockView lazy-mount で items 到着が先になるケース対応)。sizeRef は
  // tick() のホットパスから ref で読むためのミラー。
  const [size, setSize] = useState({ width: 0, floorY: 0 });
  const sizeRef = useRef(size);
  useEffect(() => {
    sizeRef.current = size;
  }, [size]);
  const visibleRef = useRef(true);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef(0);

  // D&D 状態 (pointer down → 5px しきい値で drag 開始 → drop or cancel)
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

  const applyTransform = useCallback((body: PhysicsBody) => {
    const el = nodesRef.current.get(body.id);
    if (!el) return;
    el.style.transform = `translate3d(${body.x}px, ${body.y}px, 0) rotate(${body.rotation}deg)`;
    el.dataset.settled = String(body.settled);
  }, []);

  const tick = useCallback(
    (now: number) => {
      if (!visibleRef.current) {
        rafRef.current = null;
        return;
      }
      const dt =
        lastTsRef.current === 0
          ? 1 / 60
          : Math.min((now - lastTsRef.current) / 1000, MAX_DT);
      lastTsRef.current = now;

      const list = Array.from(bodiesRef.current.values());
      const next = stepPhysics(
        list,
        dt,
        sizeRef.current.floorY,
        sizeRef.current.width,
      );
      bodiesRef.current = new Map(next.map((b) => [b.id, b]));
      for (const b of next) applyTransform(b);

      if (hasUnsettled(next)) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
      }
    },
    [applyTransform],
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
      const body = bodiesRef.current.get(id);
      if (body) applyTransform(body);
    },
    [applyTransform],
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
      // 既存 body をはみ出さないよう clamp + wake
      let mutated = false;
      for (const body of bodiesRef.current.values()) {
        const maxX = Math.max(0, next.width - body.width);
        if (body.x > maxX) {
          body.x = maxX;
          mutated = true;
        }
        const maxY = next.floorY - body.height;
        if (body.y > maxY) {
          body.y = maxY;
          mutated = true;
        }
        if (mutated && body.settled) {
          body.settled = false;
          body.settleFrames = 0;
        }
      }
      if (mutated) startLoop();
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [startLoop]);

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
  // size を deps に含めて、ResizeObserver の measure 完了後に再実行されるように。
  useEffect(() => {
    if (size.width <= 0 || size.floorY <= 0) {
      // コンテナ未計測時は size state 更新後の再実行で処理される
      return;
    }
    const currentIds = new Set(items.map((i) => i.id));
    const known = knownIdsRef.current;

    // 削除分
    for (const id of known) {
      if (!currentIds.has(id)) bodiesRef.current.delete(id);
    }

    // 追加分
    const added: TrashItemData[] = [];
    for (const item of items) {
      if (!known.has(item.id) && !bodiesRef.current.has(item.id)) {
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
        const bodies = placeFloorPreset(presetItems, size.width, size.floorY);
        for (const b of bodies) {
          bodiesRef.current.set(b.id, b);
          applyTransform(b);
        }
      } else {
        for (const item of added) {
          const body = createBody({
            id: item.id,
            subKind: item.subKind,
            containerWidth: size.width,
            size: getBodySize(item),
            initial: "falling",
          });
          bodiesRef.current.set(body.id, body);
          const woken = wakeNeighbors(
            body,
            Array.from(bodiesRef.current.values()),
          );
          bodiesRef.current = new Map(woken.map((b) => [b.id, b]));
          applyTransform(body);
        }
        startLoop();
      }
    }

    knownIdsRef.current = currentIds;
  }, [items, size, startLoop, applyTransform]);

  // unmount 時のクリーンアップ
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  // 攪拌 imperative handle (設計書 §7 攪拌)
  useEffect(() => {
    if (!handleRef) return;
    handleRef.current = {
      stir: (intensity) => {
        const list = Array.from(bodiesRef.current.values());
        const shaken = applyShake(list, intensity, intensity);
        bodiesRef.current = new Map(shaken.map((b) => [b.id, b]));
        startLoop();
      },
    };
    return () => {
      if (handleRef.current) handleRef.current = null;
    };
  }, [handleRef, startLoop]);

  // ── D&D ハンドラ (設計書 §5-A) ─────────────────────────────────
  // 5px しきい値で drag 開始 (それ未満で離したら未来の Popover 起動枠)。
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      const itemEl = target.closest<HTMLElement>("[data-trash-body-id]");
      if (!itemEl) return;
      const itemId = itemEl.dataset.trashBodyId;
      if (!itemId) return;
      const body = bodiesRef.current.get(itemId);
      if (!body) return;
      const containerRect = containerRef.current?.getBoundingClientRect();
      if (!containerRect) return;
      // body 内のクリック点 offset (drag 中のマウス追従基準)
      const clientX = e.clientX;
      const clientY = e.clientY;
      const bodyClientX = containerRect.left + body.x;
      const bodyClientY = containerRect.top + body.y;
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
    [],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragStateRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      const dx = e.clientX - drag.startClientX;
      const dy = e.clientY - drag.startClientY;
      if (!drag.started) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        // 5px 超過 → drag 開始: physics から detach
        drag.started = true;
        setDraggingItemId(drag.itemId);
        const body = bodiesRef.current.get(drag.itemId);
        if (body) {
          bodiesRef.current.set(drag.itemId, detach(body));
        }
      }
      // body 位置をマウス追従させる (container 座標系)
      const containerRect = containerRef.current?.getBoundingClientRect();
      if (!containerRect) return;
      const body = bodiesRef.current.get(drag.itemId);
      if (!body) return;
      const next: PhysicsBody = {
        ...body,
        x: e.clientX - containerRect.left - drag.bodyOffsetX,
        y: e.clientY - containerRect.top - drag.bodyOffsetY,
      };
      bodiesRef.current.set(drag.itemId, next);
      applyTransform(next);

      // hit test (panel ハイライト)
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
    [applyTransform],
  );

  const finishDrag = useCallback(
    async (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragStateRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      dragStateRef.current = null;
      setDraggingItemId(null);
      setHoverTargetId(null);

      if (!drag.started) {
        // クリック扱い (5px 未満で離した): Popover を開く (設計書 §5-A)
        setPopoverItemId(drag.itemId);
        setPopoverAnchor({ x: e.clientX, y: e.clientY });
        return;
      }

      const item = itemsRef.current.get(drag.itemId);
      const body = bodiesRef.current.get(drag.itemId);
      const target = useDropTargetRegistry
        .getState()
        .hitTest({ x: e.clientX, y: e.clientY });

      const acceptable =
        item && target && target.accepts(item.subKind) ? target : null;

      if (!acceptable || !item) {
        // 元位置に戻す: detach 解除 + 上から落下し直し感のため settled=false
        if (body) {
          bodiesRef.current.set(drag.itemId, attach(body));
          const woken = wakeNeighbors(
            bodiesRef.current.get(drag.itemId)!,
            Array.from(bodiesRef.current.values()),
          );
          bodiesRef.current = new Map(woken.map((b) => [b.id, b]));
          startLoop();
        }
        return;
      }

      // ドロップ確定: target.onDrop を呼ぶ (useDropTarget が pickup + restorer
      // を統括)。Map ペインはここで transformPoint=screenToFlowPosition を噛ませる。
      const dropPoint = { x: e.clientX, y: e.clientY };
      await acceptable.onDrop(item, dropPoint);
      // pickup が失敗していれば item は trash に残っているので body を再 attach
      if (useTrashBinStore.getState().items.has(item.id)) {
        const survived = bodiesRef.current.get(drag.itemId);
        if (survived) {
          bodiesRef.current.set(drag.itemId, attach(survived));
          startLoop();
        }
      }
      // 成功時は items 配列から消えるので useEffect が body を回収する
    },
    [startLoop],
  );

  // hover ハイライトを registry の対象 panel にも反映する。
  // Phase 6-d で各パネル側が `data-droptarget-id` を持つので、ここでは
  // 該当 DOM に ring class を直接 toggle する。registry に DOM ref が
  // 渡らないのは意図的 (パネル間の双方向依存を避ける)。
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

      {/* クリック (5px 未満) で開く Popover (設計書 §5-A) */}
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

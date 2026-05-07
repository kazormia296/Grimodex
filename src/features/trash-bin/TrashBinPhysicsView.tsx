import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { TrashBinItem } from "./TrashBinItem";
import {
  createBody,
  hasUnsettled,
  PhysicsBody,
  placeFloorPreset,
  stepPhysics,
  wakeNeighbors,
} from "./physics";
import { getBodySize } from "./displayHelpers";
import type { TrashItemData } from "./types";

interface PhysicsViewProps {
  items: TrashItemData[];
  isLoading: boolean;
}

const MAX_DT = 0.033; // 30fps 下限

export function TrashBinPhysicsView({ items, isLoading }: PhysicsViewProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const bodiesRef = useRef<Map<string, PhysicsBody>>(new Map());
  const nodesRef = useRef<Map<string, HTMLElement>>(new Map());
  const knownIdsRef = useRef<Set<string>>(new Set());
  const sizeRef = useRef({ width: 0, floorY: 0 });
  const visibleRef = useRef(true);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef(0);

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
      sizeRef.current = { width: rect.width, floorY: rect.height };
      // 既存 body をはみ出さないよう clamp + wake
      let mutated = false;
      for (const body of bodiesRef.current.values()) {
        const maxX = Math.max(0, sizeRef.current.width - body.width);
        if (body.x > maxX) {
          body.x = maxX;
          mutated = true;
        }
        const maxY = sizeRef.current.floorY - body.height;
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

  // items 同期: 初回ロードで床積み、以降は y=-h から落下
  useEffect(() => {
    if (sizeRef.current.width <= 0 || sizeRef.current.floorY <= 0) {
      // コンテナ未計測時は次の measure 完了後の再描画で再実行される
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
        const bodies = placeFloorPreset(
          presetItems,
          sizeRef.current.width,
          sizeRef.current.floorY,
        );
        for (const b of bodies) {
          bodiesRef.current.set(b.id, b);
          applyTransform(b);
        }
      } else {
        for (const item of added) {
          const body = createBody({
            id: item.id,
            subKind: item.subKind,
            containerWidth: sizeRef.current.width,
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
  }, [items, startLoop, applyTransform]);

  // unmount 時のクリーンアップ
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

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
      className="relative flex-1 overflow-hidden"
      data-testid="trash-bin-physics-view"
    >
      {items.length === 0 && (
        <div className="flex h-full items-center justify-center px-6 py-12 text-center text-sm text-muted-foreground">
          {t("trashBin.empty")}
        </div>
      )}
      {items.map((item) => (
        <TrashBinItem key={item.id} item={item} registerNode={registerNode} />
      ))}
    </div>
  );
}

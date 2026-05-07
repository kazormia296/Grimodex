import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2, Circle } from "lucide-react";
import { useTrashBinStore } from "./trashBinStore";
import { TrashBinListView } from "./TrashBinListView";
import {
  TrashBinPhysicsView,
  type PhysicsViewHandle,
} from "./TrashBinPhysicsView";
import { TrashBinStirButton } from "./TrashBinStirButton";
import { useReducedMotion } from "@/lib/animation";

const PROJECT_ID = "default-project";

export function TrashBinPanel() {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const items = useTrashBinStore((s) => s.items);
  const isCapturing = useTrashBinStore((s) => s.isCapturing);
  const isLoading = useTrashBinStore((s) => s.isLoading);
  const loadItems = useTrashBinStore((s) => s.loadItems);
  const removeItem = useTrashBinStore((s) => s.removeItem);
  const clearAll = useTrashBinStore((s) => s.clearAll);
  const setCapturing = useTrashBinStore((s) => s.setCapturing);

  const physicsHandleRef = useRef<PhysicsViewHandle | null>(null);
  // reduced-motion fallback で「かき混ぜる」= シャッフル順を保持
  const [shuffleSeed, setShuffleSeed] = useState(0);

  useEffect(() => {
    loadItems(PROJECT_ID);
  }, [loadItems]);

  // selector 内で派生配列を生成すると new ref になるため、
  // useMemo で items Map を一度だけ配列化する (`feedback_zustand_selector_new_ref.md`)。
  const sortedItems = useMemo(() => {
    const list = Array.from(items.values()).sort((a, b) =>
      a.deletedAt < b.deletedAt ? 1 : -1,
    );
    if (reducedMotion && shuffleSeed > 0) {
      // Fisher-Yates: 偶然の再発見を残すため shuffle (設計書 §10)
      const arr = [...list];
      let s = shuffleSeed;
      for (let i = arr.length - 1; i > 0; i--) {
        s = (s * 9301 + 49297) % 233280;
        const j = Math.floor((s / 233280) * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    }
    return list;
  }, [items, reducedMotion, shuffleSeed]);

  const handleStir = (intensity: number) => {
    if (reducedMotion) {
      setShuffleSeed((s) => s + Math.floor(intensity));
      return;
    }
    physicsHandleRef.current?.stir(intensity);
  };

  const handleClearAll = () => {
    if (sortedItems.length === 0) return;
    if (!window.confirm(t("trashBin.clearConfirm"))) return;
    void clearAll(PROJECT_ID);
  };

  return (
    <div className="flex h-full flex-col" aria-label={t("trashBin.title")}>
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold">{t("trashBin.title")}</h2>
        <span className="text-xs text-muted-foreground">
          {t("trashBin.count", { count: sortedItems.length })}
        </span>
        <div className="flex-1" />
        <TrashBinStirButton
          onStir={handleStir}
          disabled={sortedItems.length === 0}
        />
        <button
          type="button"
          onClick={() => setCapturing(!isCapturing)}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted"
          title={t("trashBin.pauseToggle")}
          aria-label={t("trashBin.pauseToggle")}
          aria-pressed={!isCapturing}
        >
          <Circle
            className={`h-2.5 w-2.5 ${
              isCapturing
                ? "fill-red-500 text-red-500"
                : "fill-muted-foreground/40 text-muted-foreground/40"
            }`}
          />
          <span>
            {isCapturing ? t("trashBin.recording") : t("trashBin.paused")}
          </span>
        </button>
        <button
          type="button"
          onClick={handleClearAll}
          disabled={sortedItems.length === 0}
          className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
          title={t("trashBin.clearAll")}
          aria-label={t("trashBin.clearAll")}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </header>

      <div className="flex-1 overflow-hidden">
        {reducedMotion ? (
          <div className="h-full overflow-y-auto">
            <TrashBinListView
              items={sortedItems}
              isLoading={isLoading}
              onRemove={removeItem}
            />
          </div>
        ) : (
          <TrashBinPhysicsView
            items={sortedItems}
            isLoading={isLoading}
            handleRef={physicsHandleRef}
          />
        )}
      </div>
    </div>
  );
}
